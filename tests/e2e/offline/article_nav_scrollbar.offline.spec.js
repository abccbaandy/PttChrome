// 文章導覽軸顯示時，終端機右緣只能有一條捲軸（src/js/article_nav.js、docs/article-tools.md
// 「文章導覽軸」）。症狀：原生捲軸（.main::-webkit-scrollbar 那條灰的）與導覽軸的滑塊並排，
// 兩個滑塊各在不同位置。
//
// 為什麼獨立成一支：Playwright 的 headless Chromium 預設帶 `--hide-scrollbars`（同
// mouse_scrollbar.offline.spec.js），原生捲軸根本畫不出來，這條會恆綠。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitPreviewsSettled } = require('../helpers/layout');
const { nativeScrollbarPeak } = require('../helpers/article_nav');

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const article = loadCassette('stock-huang');

async function boot(page, prefs) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootOffline(page, ptt, { articleNav: true });
  await ptt.applyPrefs(page, Object.assign({ enableEasyReading: true }, prefs || {}));
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);
}

test('導覽軸顯示中 ⇒ 原生捲軸隱形（寬度照留，終端機不位移）', async ({ page }) => {
  test.setTimeout(90000);
  await boot(page);
  await expect(page.locator('#articleNav')).toBeVisible();
  const peak = await nativeScrollbarPeak(page);
  expect(peak, '原生捲軸沒有佔寬（--hide-scrollbars 沒拿掉？）').not.toBeNull();
  expect(peak).toBeLessThanOrEqual(12);
});

test('pref 關（沒有導覽軸）⇒ 原生捲軸照常顯示', async ({ page }) => {
  test.setTimeout(90000);
  await boot(page, { enableArticleNav: false });
  await expect(page.locator('#mainContainer')).toContainText('morrislek');
  expect(await nativeScrollbarPeak(page)).toBeGreaterThan(40);
});
