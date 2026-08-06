// 裸網域自動連結 —— 離線重放守門（真瀏覽器 / 真渲染 / 零網路）。
// 用 cassette 進到「閱讀文章」狀態（computeAnnotations 只在 pageState=3 跑偵測），
// 再把測試用的內文列直接餵進 App.onData 覆寫該列 —— 素材裡不見得有裸網域，但
// 真實的 parser→termBuf→<Screen> 渲染鏈完全沒有被繞過。
//
// 驗四件事：
//   1) 規則層：indiegametw.com 原位變成 a.bareDomainLink（**原生模式**，不加行）。
//   2) 有 scheme 的正常連結仍走原本的 .y 路徑，不被裸網域偵測搶走。
//   3) AI 複核判 false → 該連結被撤掉（單向收縮的接線）。
//   4) 沒有 Prompt API（其他瀏覽器）→ 連結原封保留，行為與純規則完全相同。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  findCassette,
  bootOffline,
  replayCassette,
  feedRaw,
} = require('../helpers/replay');

const cassette = findCassette('article');

// 覆寫第 10 列（文章內文區）為指定 ASCII 文字，並等 term_buf 的 30ms notify
// debounce + render flush 走完。
async function writeRow(page, text) {
  await feedRaw(page, '\x1b[10;1H' + ' '.repeat(79));
  await feedRaw(page, '\x1b[10;1H' + text);
  await page.waitForTimeout(400);
}

// 回答 link:false 的 stub —— 記錄問了幾次，供「真的有送出推論」斷言。
const STUB_LM_FALSE = () => {
  const session = {
    prompt: () => {
      window.__lmPrompts = (window.__lmPrompts || 0) + 1;
      return Promise.resolve(JSON.stringify({ link: false }));
    },
    clone: () => Promise.resolve(session),
    destroy: () => {},
  };
  window.LanguageModel = {
    availability: () => Promise.resolve('available'),
    create: () => Promise.resolve(session),
  };
};

test.describe('裸網域自動連結（離線重放）', () => {
  if (!cassette) {
    test.skip('尚無 article cassette', () => {});
    return;
  }

  test('規則層：原生模式下裸網域原位可點，一般連結不受影響', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableBareDomainLink: true,
      enableUrlAi: false,
    });
    await replayCassette(page, cassette, { easyReading: false });

    await writeRow(page, 'go indiegametw.com now');
    const link = page.locator('a.bareDomainLink');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText('indiegametw.com');
    await expect(link).toHaveAttribute('href', 'https://indiegametw.com');
    await expect(link).toHaveAttribute('target', '_blank');
    // 原生 24 列 grid：不得多出 fixedUrls 那種額外行。
    await expect(page.locator('.fixedUrlLine')).toHaveCount(0);

    // 有 scheme 的連結仍由 uriRegEx 處理（.y），不會被裸網域偵測重複標記。
    await writeRow(page, 'see https://example.com/a here');
    await expect(page.locator('a.bareDomainLink')).toHaveCount(0);
    await expect(page.locator('a.y')).not.toHaveCount(0);
  });

  test('設定關閉 → 完全不偵測', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableBareDomainLink: false,
    });
    await replayCassette(page, cassette, { easyReading: false });

    await writeRow(page, 'go indiegametw.com now');
    await expect(page.locator('a.bareDomainLink')).toHaveCount(0);
  });

  test('AI 複核判 false → 撤掉該連結（單向收縮）', async ({ page }) => {
    test.setTimeout(90000);
    await page.addInitScript(STUB_LM_FALSE);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableAi: true,
      enableBareDomainLink: true,
      enableUrlAi: true,
    });
    await replayCassette(page, cassette, { easyReading: false });

    await writeRow(page, 'go indiegametw.com now');
    // 規則先畫出連結，AI 判決回來後才撤掉 → 用 poll 等最終狀態。
    await expect
      .poll(() => page.locator('a.bareDomainLink').count(), { timeout: 15000 })
      .toBe(0);
    expect(await page.evaluate(() => window.__lmPrompts || 0)).toBeGreaterThan(0);
  });

  // 總閘門：AI 分頁的 enableAi 關掉時，子選項就算是 true 也完全不生效
  // （term_view.js 的 `enableAi && ...` AND）。與上一條共用會判 false 的 stub，
  // 差別只在 enableAi —— 連結留著＋一次推論都沒送出。
  test('AI 總開關關閉 → 子選項開著也不推論（行為等同純規則）', async ({ page }) => {
    test.setTimeout(90000);
    await page.addInitScript(STUB_LM_FALSE);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableAi: false,
      enableBareDomainLink: true,
      enableUrlAi: true,
    });
    await replayCassette(page, cassette, { easyReading: false });

    await writeRow(page, 'go indiegametw.com now');
    await page.waitForTimeout(1500); // 給「若真有推論早該回來」的餘裕
    await expect(page.locator('a.bareDomainLink')).toHaveCount(1);
    expect(await page.evaluate(() => window.__lmPrompts || 0)).toBe(0);
  });

  test('沒有 Prompt API → 連結原封保留（行為等同純規則）', async ({ page }) => {
    test.setTimeout(90000);
    await page.addInitScript(() => {
      delete window.LanguageModel;
    });
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableAi: true,
      enableBareDomainLink: true,
      enableUrlAi: true, // 開著也一樣：availability 不支援 → 一律 fallback 保留
    });
    await replayCassette(page, cassette, { easyReading: false });

    await writeRow(page, 'go indiegametw.com now');
    await page.waitForTimeout(1500); // 給「就算真有推論也早該回來」的餘裕
    await expect(page.locator('a.bareDomainLink')).toHaveCount(1);
  });
});
