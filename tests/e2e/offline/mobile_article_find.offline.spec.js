// 手機文章內找字（P75，src/js/article_find.js、components/ArticleFind）。
// 只在 offline-mobile project 跑（Pixel 7 模擬，hasTouch）。入口用真觸控（tap），打字用真鍵盤。
// 守 unit 摸不到的：真版面下找字列在 App Bar 下面、輸入框打的字不送給 PTT、跳到的那一處真的
// 捲進畫面（好讀分塊裡也一樣）、標亮真的掛上瀏覽器的 Highlight、✕ 收起後全清。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { startCapture, takeCapture } = require('../helpers/capture');
const { waitPreviewsSettled, waitDialogSettled, waitRectStable } = require('../helpers/layout');

const article = loadCassette('stock-huang');
const ITEM = '[data-key="__findText"]';
const BAR = '[data-article-find]';
const QUERY = '推';

async function openFind(page, prefs = {}) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, { enableEasyReading: true, ...prefs });
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);
  await startCapture(page);
  await page.locator('[data-key="__more"]').tap();
  await waitDialogSettled(page, ITEM);
  await page.locator(ITEM).tap();
  await waitDialogSettled(page, BAR);
}

// 畫面列（沒被藏的）裡 QUERY 出現幾次：跟找字列的計數對照。
const expectedTotal = (page) =>
  page.evaluate((q) => {
    let n = 0;
    for (const el of document.querySelectorAll('#mainContainer [data-type="bbsline"]')) {
      if (el.closest('[hidden]')) continue;
      n += el.textContent.split(q).length - 1;
    }
    return n;
  }, QUERY);

test.describe('手機：文章內找字', () => {
  test('「更多」→「找字」：打字標亮、下一個捲進畫面、✕ 收起全清，一個 byte 都不送', async ({ page }) => {
    test.setTimeout(90000);
    await openFind(page);
    await expect(page.locator(`${BAR} input`)).toBeFocused();
    expect(await page.evaluate(() => window.__app.modalShown)).toBe(true);

    // 找字列在 App Bar 正下方。
    const bar = await page.locator(BAR).boundingBox();
    expect(bar.y).toBeGreaterThanOrEqual(47);

    await page.keyboard.type(QUERY);
    const total = await expectedTotal(page);
    expect(total).toBeGreaterThan(3);
    await expect(page.locator('[data-article-find-count]')).toHaveText(`1/${total}`);
    expect(await page.evaluate(() => CSS.highlights.get('pttFind').size)).toBe(total - 1);

    // 下一個 ×3：目前這一處的 Range 在畫面裡、沒被找字列或底部工具列蓋住。
    for (let i = 0; i < 3; i++) await page.locator('[data-article-find-next]').tap();
    await expect(page.locator('[data-article-find-count]')).toHaveText(`4/${total}`);
    await waitRectStable(page, BAR);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const [r] = CSS.highlights.get('pttFindCurrent');
          const rect = r.getBoundingClientRect();
          const barBottom = document.querySelector('[data-article-find]').getBoundingClientRect().bottom;
          return rect.height > 0 && rect.top >= barBottom && rect.bottom <= window.innerHeight - 48;
        })
      )
      .toBe(true);

    await page.locator('[data-article-find-close]').tap();
    await expect(page.locator(BAR)).toHaveCount(0);
    expect(await page.evaluate(() => CSS.highlights.has('pttFind') || CSS.highlights.has('pttFindCurrent'))).toBe(false);
    expect(await page.evaluate(() => window.__app.modalShown)).toBe(false);
    expect(await takeCapture(page)).toBe('');
  });

  test('開關關掉 ⇒「更多」沒有「找字」', async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true, mobileFindInArticle: false });
    await replayCassette(page, article, { easyReading: true });
    await waitPreviewsSettled(page);
    await page.locator('[data-key="__more"]').tap();
    await waitDialogSettled(page, '[data-key="__selectText"]');
    await expect(page.locator(ITEM)).toHaveCount(0);
  });
});
