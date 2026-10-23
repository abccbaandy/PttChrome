// 文章導覽軸（src/js/article_nav.js、docs/article-tools.md「文章導覽軸」）：好讀文章終端機右緣
// 的細軸。unit（article_nav.test.js）釘死標記與幾何；這裡守真瀏覽器才看得到的：
//   - 軸真的貼在終端機右緣、「推」那一格點下去真的捲到第一則推文；
//   - 用滑鼠在軸上拖，好讀視口真的跟著捲，而且一個 byte 都沒送給 PTT；
//   - 原生 pmore（好讀關）、pref 關都不出現。
// 素材 stock-huang（49 則推文的長文）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { startCapture, takeCapture } = require('../helpers/capture');
const { waitPreviewsSettled, waitRectStable, waitScrollStable } = require('../helpers/layout');

const article = loadCassette('stock-huang');
const nav = (page) => page.locator('#articleNav');
const scrollTop = (page) => page.evaluate(() => window.__app.view.mainDisplay.scrollTop);

async function boot(page, prefs, opts = {}) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootOffline(page, ptt, { articleNav: true });
  await ptt.applyPrefs(page, Object.assign({ enableEasyReading: true }, prefs || {}));
  await replayCassette(page, article, { easyReading: opts.easyReading !== false });
  await waitPreviewsSettled(page);
}

test.describe('文章導覽軸', () => {
  test('貼在終端機右緣；點「推」⇒ 捲到第一則推文；拖曳 ⇒ 視口跟著捲，不送鍵', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await expect(nav(page)).toBeVisible();
    const term = await waitRectStable(page, '#BBSWindow > .main');
    const rail = await waitRectStable(page, '#articleNav');
    expect(Math.abs(rail.left + rail.width - (term.left + term.width))).toBeLessThanOrEqual(1);

    await startCapture(page);
    const chip = nav(page).locator('[data-nav-kind="comments"]');
    await expect(chip).toBeVisible();
    const row = Number(await chip.getAttribute('data-nav-row'));
    await chip.click();
    await waitScrollStable(page, '#BBSWindow > .main');
    // 第一則推文那一列落在視口頂端附近。
    const target = await waitRectStable(page, `#mainContainer [type="bbsrow"][srow="${row}"]`);
    expect(Math.abs(target.top - term.top)).toBeLessThanOrEqual(target.height + 1);

    // 拖到軸的最上面 ⇒ 回到文章開頭；再拖到 3/4 ⇒ 往下捲。從 1/5 處按下（避開中段的「推」）。
    const box = await nav(page).boundingBox();
    const x = box.x + box.width / 2;
    await page.mouse.move(x, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(x, box.y + 1, { steps: 4 });
    await waitScrollStable(page, '#BBSWindow > .main');
    expect(await scrollTop(page)).toBe(0);
    await page.mouse.move(x, box.y + box.height * 0.75, { steps: 4 });
    await page.mouse.up();
    await waitScrollStable(page, '#BBSWindow > .main');
    expect(await scrollTop(page)).toBeGreaterThan(0);
    expect(await takeCapture(page)).toBe('');
  });

  test('原生 pmore（好讀關）⇒ 不出現', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, { enableEasyReading: false }, { easyReading: false });
    await expect(page.locator('#mainContainer')).toContainText('morrislek');
    await expect(nav(page)).toHaveCount(0);
  });

  test('pref 關 ⇒ 不出現', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, { enableArticleNav: false });
    await expect(page.locator('#mainContainer')).toContainText('morrislek');
    await expect(nav(page)).toHaveCount(0);
  });
});
