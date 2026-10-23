// 文章導覽軸在手機（src/js/article_nav.js、docs/article-tools.md「文章導覽軸」）：終端機佔滿螢幕寬，
// 軸疊在推文時間的最後一個字上 ⇒ 比照手機原生捲軸，平常隱藏、也不接觸控；捲動時才出現、可以抓。
// 素材 stock-huang（49 則推文的長文）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitPreviewsSettled, waitScrollStable } = require('../helpers/layout');

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
