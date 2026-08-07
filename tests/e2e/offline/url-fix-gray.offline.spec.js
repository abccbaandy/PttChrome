// URL 修復的 gray 候選閘門 —— 離線重放守門（真瀏覽器 / 真渲染 / 零網路）。
// 回歸來源：`...a modern Call of Duty. It does not.` 被修成 https://Duty.It
// （`it` = 義大利 ccTLD，剛好也是英文單字；見 src/js/url_fix.js 檔頭）。
//
// 素材注入手法（與 bare-domain-link.offline.spec.js 的差異，踩兩次才過）：
// 修復連結是**另起一行**渲染，只在好讀模式出現（LinkSegmentBuilder 的
// enableLinkInlinePreview gate），所以不能像裸網域那樣用原生模式驗。而好讀是把
// 畫面**累積**進 buf.pageLines 再整份 render 的，注入時有兩個坑：
//   1) enterEasyReading() 本身不 render，要等下一次 term_buf notify 才會
//      accumulate + render；只呼叫它然後斷言 → pageLines 恆為 0、全部假綠。
//   2) accumulatePageLines 有「完整回應閘門」（term_view.js#1256）：**游標必須
//      park 在右下角**才算完整幀，否則只 render 不 accumulate → 寫進去的列永遠
//      進不了 pageLines。故餵完內容要補一個 ESC[<rows>;<cols>H。
// 因此流程是：原生重放進文章第一頁 → enterEasyReading() → 一次餵完測試列＋游標
// park → 好讀把「含測試列的當前畫面」累積進去並 render。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  findCassette,
  bootOffline,
  replayCassette,
  feedRaw,
} = require('../helpers/replay');

const cassette = findCassette('article');

// 三種形狀寫進相鄰三列，一次驗完（進好讀後就不能再改畫面了）。
const PROSE = 'The goal was to match a modern Call of Duty. It does not.'; // gray
const WITH_PATH = 'pic at example.com /badpath.jpg here'; // 非 gray（有路徑）
const SPACED = 'site at www . a .com here'; // gray（真的被空白打斷）

const FIXED_PATH = 'https://example.com/badpath.jpg';
const FIXED_SPACED = 'https://www.a.com/';
const FIXED_PROSE = 'https://duty.it/';

// 進好讀 → 一次餵完三列測試內容（＋游標 park）→ 等 accumulate/render flush。
async function setupRows(page) {
  await page.evaluate(() => window.__app.easyReading.enterEasyReading());
  await page.waitForTimeout(200);
  const { rows, cols } = await page.evaluate(() => ({
    rows: window.__app.buf.rows,
    cols: window.__app.buf.cols,
  }));
  const blank = ' '.repeat(cols - 1);
  const at = (r, text) => `\x1b[${r};1H${blank}\x1b[${r};1H${text}`;
  await feedRaw(
    page,
    at(10, PROSE) + at(11, WITH_PATH) + at(12, SPACED) + `\x1b[${rows};${cols}H`
  );
  await page.waitForTimeout(800);
}

const fixedHrefs = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.fixedUrlLine a')).map((a) => a.href)
  );

// 只對「真的被空白打斷」的那筆答 true，散文答 false —— 驗的是放行/不放行都走得通。
const STUB_LM = () => {
  const session = {
    prompt: (text) => {
      window.__lmPrompts = (window.__lmPrompts || 0) + 1;
      const link = text.indexOf('www . a .com') >= 0;
      return Promise.resolve(JSON.stringify({ link }));
    },
    clone: () => Promise.resolve(session),
    destroy: () => {},
  };
  window.LanguageModel = {
    availability: () => Promise.resolve('available'),
    create: () => Promise.resolve(session),
  };
};

test.describe('URL 修復 gray 候選（離線重放）', () => {
  if (!cassette) {
    test.skip('尚無 article cassette', () => {});
    return;
  }

  test('AI 關閉（預設）：句號誤判不修，有路徑的修復照舊', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      enableAutoFixUrl: true,
      enableAi: false,
    });
    await replayCassette(page, cassette, { easyReading: false });
    await setupRows(page);

    // 正對照：非 gray 的修復一定要在（否則下面兩條「不在」的斷言是假綠）。
    const hrefs = await fixedHrefs(page);
    expect(hrefs).toContain(FIXED_PATH);
    expect(hrefs).not.toContain(FIXED_PROSE);
    expect(hrefs).not.toContain(FIXED_SPACED);
  });

  test('AI 判 true → 放行；判 false 的仍然不修', async ({ page }) => {
    test.setTimeout(90000);
    await page.addInitScript(STUB_LM);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      enableAutoFixUrl: true,
      enableAi: true,
      enableUrlAi: true,
    });
    await replayCassette(page, cassette, { easyReading: false });
    await setupRows(page);

    // 規則層不畫 gray，AI 判決回來才出現 → poll 等最終狀態。
    await expect
      .poll(() => fixedHrefs(page), { timeout: 15000 })
      .toContain(FIXED_SPACED);
    const hrefs = await fixedHrefs(page);
    expect(hrefs).toContain(FIXED_PATH);
    expect(hrefs).not.toContain(FIXED_PROSE);
    expect(await page.evaluate(() => window.__lmPrompts || 0)).toBeGreaterThan(0);
  });

  test('AI 總開關關閉 → 子選項開著也不推論（等同純規則）', async ({ page }) => {
    test.setTimeout(90000);
    await page.addInitScript(STUB_LM);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      enableAutoFixUrl: true,
      enableAi: false,
      enableUrlAi: true,
    });
    await replayCassette(page, cassette, { easyReading: false });
    await setupRows(page);
    await page.waitForTimeout(1500); // 給「若真有推論早該回來」的餘裕

    const hrefs = await fixedHrefs(page);
    expect(hrefs).toContain(FIXED_PATH);
    expect(hrefs).not.toContain(FIXED_PROSE);
    expect(hrefs).not.toContain(FIXED_SPACED);
    expect(await page.evaluate(() => window.__lmPrompts || 0)).toBe(0);
  });

  test('沒有 Prompt API → 等同 AI 關閉（不生出假連結）', async ({ page }) => {
    test.setTimeout(90000);
    await page.addInitScript(() => {
      delete window.LanguageModel;
    });
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      enableAutoFixUrl: true,
      enableAi: true,
      enableUrlAi: true, // 開著也一樣：availability 不支援 → 沒有判決 → 不放行
    });
    await replayCassette(page, cassette, { easyReading: false });
    await setupRows(page);
    await page.waitForTimeout(1500);

    const hrefs = await fixedHrefs(page);
    expect(hrefs).toContain(FIXED_PATH);
    expect(hrefs).not.toContain(FIXED_PROSE);
    expect(hrefs).not.toContain(FIXED_SPACED);
  });
});
