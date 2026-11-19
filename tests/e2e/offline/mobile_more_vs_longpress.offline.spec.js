// 手機「長按 vs 更多」的分工（docs/mobile.md「長按 vs 更多」）：長按選單只放跟長按位置有關的
// 項目，跟位置無關的（本篇稍後閱讀、複製本篇連結、長推文、貼上、指令面板、設定…）在工具列「更多」。
// 只在 offline-mobile project 跑（Pixel 7 模擬，hasTouch）。入口用真觸控（tap）與真右鍵
// （page.mouse；觸控長按桌機 Chromium 做不出來，見 tests/e2e/README.md「真輸入」）。
// 守 unit 摸不到的：真的好讀文章裡 ContextMenu 算出來的出現條件（本篇 AID、長推文判準）、
// 「更多」在真手機高度一屏放得下、分享子頁真的切得過去又切得回來。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { startCapture, takeCapture } = require('../helpers/capture');
const { waitPreviewsSettled, waitDialogSettled } = require('../helpers/layout');
const { rightClickElement } = require('../helpers/real_input');

const article = loadCassette('stock-huang');
const byKey = (page, k) => page.locator(`[data-key="${k}"]`);
const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);
const CONTEXT_SHEET = '[data-sheet="context"]';

async function openArticle(page) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, { enableEasyReading: true });
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);
}

async function openMore(page) {
  await byKey(page, '__more').tap();
  await waitDialogSettled(page, '[data-key="__select"]');
}

test.describe('手機：長按 vs 更多', () => {
  test('文章「更多」：稍後閱讀／長推文／貼上／指令面板在圖示格；複製本篇連結收進「分享」子頁', async ({ page }) => {
    test.setTimeout(90000);
    await openArticle(page);
    await openMore(page);
    const grid = page.locator('[data-more-grid]');
    for (const k of ['__readLater', '__longPush', '__paste', '__commandPalette', '__share'])
      await expect(grid.locator(`[data-key="${k}"]`)).toBeVisible();
    await expect(page.locator('[data-panel="more"] [data-copy-link-row]')).toHaveCount(0);

    await byKey(page, '__share').tap();
    await waitDialogSettled(page, '[data-panel="share"]');
    await expect(byKey(page, '__shareSystem')).toBeVisible();
    await expect(page.locator('[data-panel="share"] [data-copy-link]')).toHaveCount(3);
    // 預覽從畫面上的文章網址列算（零送鍵）：AID 那一列看得到本篇代碼。
    await expect(page.locator('[data-panel="share"] [data-copy-link="aid"]')).toContainText('(Stock)');

    await page.locator('[data-share-back]').tap();
    await waitDialogSettled(page, '[data-key="__select"]');
    await expect(page.locator('[data-panel="share"]')).toHaveCount(0);
  });

  test('「更多」→「稍後閱讀」收本篇，一個 byte 都不送；再開「更多」同一格變「移出稍後」', async ({ page }) => {
    test.setTimeout(90000);
    await openArticle(page);
    await startCapture(page);
    await openMore(page);
    await expect(byKey(page, '__readLater')).toHaveText(await label(page, 'mobileMoreShort_readLater'));
    await byKey(page, '__readLater').tap();
    await expect(page.locator('[data-panel="more"]')).toHaveCount(0);
    await openMore(page);
    await expect(byKey(page, '__readLater')).toHaveText(await label(page, 'mobileMoreShort_removeReadLater'));
    expect(await takeCapture(page)).toBe('');
  });

  test('長按：推文列給位置相關的項目、不給跟位置無關的；一段普通內文沒有任何項目 ⇒ 不開選單', async ({ page }) => {
    test.setTimeout(90000);
    await openArticle(page);
    await page.evaluate(() => {
      document.querySelector('#mainContainer [data-pusher]').setAttribute('data-e2e-comment', '1');
    });
    await rightClickElement(page, '[data-e2e-comment]');
    const menu = page.locator(CONTEXT_SHEET);
    await expect(menu.locator('[data-cmenu="filterCommentUser"]')).toBeVisible();
    for (const k of ['readLater', 'longPush', 'settings', 'paste', 'commandPalette', 'saveLocal', 'copyArticleLinkRow'])
      await expect(menu.locator(`[data-cmenu="${k}"]`)).toHaveCount(0);
    await page.goBack();
    await expect(menu).toHaveCount(0);

    // 選取文字頁關掉，長按內文就沒有任何位置相關的項目。
    await ptt.applyPrefs(page, { mobileSelectTextPage: false });
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#mainContainer [data-type="bbsline"]')].filter(
        (r) =>
          !r.matches('[data-pusher]') &&
          !r.querySelector('[data-pusher], a, img') &&
          r.textContent.trim().length > 6
      );
      rows[8].setAttribute('data-e2e-plain', '1');
    });
    await rightClickElement(page, '[data-e2e-plain]');
    await expect.poll(() => page.evaluate(() => window.__app.contextMenuShown)).toBe(false);
    await expect(menu).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.modalShown)).toBe(false);
  });

  test('真手機高度（412×839）：文章「更多」一屏放得下，不用捲', async ({ page }) => {
    test.setTimeout(90000);
    await openArticle(page);
    await page.setViewportSize({ width: 412, height: 839 });
    await openMore(page);
    const m = await page.evaluate(() => {
      const sc = document.querySelector('[data-sheet="more"] .mobileSheetScroll');
      return { scrollH: sc.scrollHeight, clientH: sc.clientHeight };
    });
    expect(m.scrollH).toBeLessThanOrEqual(m.clientH + 1);
  });
});
