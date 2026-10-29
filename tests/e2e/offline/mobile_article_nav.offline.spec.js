// 文章導覽軸在手機（src/js/article_nav.js、docs/article-tools.md「文章導覽軸」）：終端機佔滿螢幕寬，
// 軸疊在推文時間的最後一個字上 ⇒ 比照手機原生捲軸，平常隱藏、也不接觸控；捲動時才出現、可以抓。
// 素材 stock-huang（49 則推文的長文）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitPreviewsSettled, waitScrollStable } = require('../helpers/layout');
const { commentMarkDrift, nativeScrollbarPeak } = require('../helpers/article_nav');

// 預設的 `--hide-scrollbars` 會讓原生捲軸畫不出來（同 article_nav_scrollbar.offline.spec.js）。
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const article = loadCassette('stock-huang');
const nav = (page) => page.locator('#articleNav');

test('手機：平常隱藏不接觸控；捲動後出現，點「推」跳到第一則推文', async ({ page }) => {
  test.setTimeout(90000);
  await bootOffline(page, ptt, { articleNav: true });
  await ptt.applyPrefs(page, { enableEasyReading: true });
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);
  await expect(page.locator('body')).toHaveClass(/mobile-layout/);
  await expect(nav(page)).toHaveClass(/articleNav--idle/);
  expect(await nav(page).evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

  // 捲一下（手指在內文上滑）⇒ 醒來。
  const main = await page.locator('#BBSWindow > .main').boundingBox();
  await page.mouse.move(main.x + main.width / 2, main.y + main.height / 2);
  await page.mouse.wheel(0, 200);
  await waitScrollStable(page, '#BBSWindow > .main');
  await expect(nav(page)).not.toHaveClass(/articleNav--idle/);
  const chip = nav(page).locator('[data-nav-kind="comments"]');
  const row = Number(await chip.getAttribute('data-nav-row'));
  await chip.tap();
  await waitScrollStable(page, '#BBSWindow > .main');
  const top = await page.evaluate((r) => {
    const el = document.querySelector(`#mainContainer [type="bbsrow"][srow="${r}"]`);
    const m = document.querySelector('#BBSWindow > .main').getBoundingClientRect();
    return el.getBoundingClientRect().top - m.top;
  }, row);
  expect(Math.abs(top)).toBeLessThan(40);
});

// 症狀同桌機：「推」標在列號比例上，離推文區起點差一大截（手機換行版面一列折成好幾行、
// 加上行內圖片，列高更不均）；右緣兩條捲軸。
test('手機：「推」與滑塊同一把尺；原生捲軸不重複', async ({ page }) => {
  test.setTimeout(90000);
  await bootOffline(page, ptt, { articleNav: true });
  await ptt.applyPrefs(page, { enableEasyReading: true });
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);

  const main = await page.locator('#BBSWindow > .main').boundingBox();
  await page.mouse.move(main.x + main.width / 2, main.y + main.height / 2);
  await page.mouse.wheel(0, 200);
  await waitScrollStable(page, '#BBSWindow > .main');
  await nav(page).locator('[data-nav-kind="comments"]').tap();
  await waitScrollStable(page, '#BBSWindow > .main');
  await waitPreviewsSettled(page);
  await expect.poll(async () => (await commentMarkDrift(page)).drift, { timeout: 5000 }).toBeLessThanOrEqual(2);

  const peak = await nativeScrollbarPeak(page);
  expect(peak, '原生捲軸沒有佔寬（--hide-scrollbars 沒拿掉？）').not.toBeNull();
  expect(peak).toBeLessThanOrEqual(12);
});
