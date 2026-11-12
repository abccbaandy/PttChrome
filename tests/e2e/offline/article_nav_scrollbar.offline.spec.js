// 文章導覽軸顯示時，終端機右緣只能有一條捲軸（src/js/article_nav.js、docs/article-tools.md
// 「文章導覽軸」）。症狀：原生捲軸（.main::-webkit-scrollbar 那條灰的）與導覽軸的滑塊並排，
// 兩個滑塊各在不同位置。
// 而且原生的那條要**整個不畫**（display:none），不能只是透明：自訂捲軸由主執行緒畫，捲動時
// 每幀連同 .main 整層重畫（實機每幀 1.3～2.1 ms，docs/handoff/android-battery-drain.md U9）。
// 拿掉後空出的寬度要補回去：導覽軸一出現一消失，內容寬度（放大態圖片高度、手機換行點）不變。
//
// 為什麼獨立成一支：Playwright 的 headless Chromium 預設帶 `--hide-scrollbars`（同
// mouse_scrollbar.offline.spec.js），原生捲軸根本畫不出來，這條會恆綠。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitPreviewsSettled } = require('../helpers/layout');
const { nativeScrollbarPeak, layoutWithAndWithoutNav } = require('../helpers/article_nav');

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const article = loadCassette('stock-huang');

async function boot(page, prefs) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootOffline(page, ptt, { articleNav: true });
  await ptt.applyPrefs(page, Object.assign({ enableEasyReading: true }, prefs || {}));
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);
}

test('導覽軸顯示中 ⇒ 原生捲軸不畫（不佔寬），內容寬度與沒有導覽軸時相同', async ({ page }) => {
  test.setTimeout(90000);
  await boot(page);
  await expect(page.locator('#articleNav')).toBeVisible();
  expect(await nativeScrollbarPeak(page)).toBeNull();
  const { on, off } = await layoutWithAndWithoutNav(page, ptt);
  expect(on.gutter, '原生捲軸還在（只是透明的話捲動時照樣每幀重畫）').toBe(0);
  expect(off.gutter, '原生捲軸沒有佔寬（--hide-scrollbars 沒拿掉？）').toBeGreaterThan(4);
  expect(on.outer).toBe(off.outer);
  expect(on.content).toBe(off.content);
  expect(on.inner).toBe(off.inner);
  expect(on.scrollHeight).toBe(off.scrollHeight);
});

test('pref 關（沒有導覽軸）⇒ 原生捲軸照常顯示', async ({ page }) => {
  test.setTimeout(90000);
  await boot(page, { enableArticleNav: false });
  await expect(page.locator('#mainContainer')).toContainText('morrislek');
  expect(await nativeScrollbarPeak(page)).toBeGreaterThan(40);
});
