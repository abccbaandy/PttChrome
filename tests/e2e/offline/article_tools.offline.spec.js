// 文章工具側欄（src/js/article_tools.js、docs/article-tools.md）：好讀讀文章 ⇒ 終端機右邊
// 的空白放一條側欄（AID、推文統計、推文者排行、圖片牆）；點一則推文只捲好讀的視口、
// 一個 byte 都不送；滾輪捲側欄不翻文章；放不下、原生 pmore、pref 關就不出現。
// 只有真瀏覽器驗得出來：側欄真的落在終端機右邊的空白（不蓋字）、點側欄不搶 #t 焦點也不
// 變成點終端機、跳列真的把那一列捲進視野、滾輪被側欄吃下。素材 stock-huang（49 則推文，
// 好讀 golden 守在 easy-reading.offline.spec.js）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { startCapture, takeCapture } = require('../helpers/capture');
const { waitPreviewsSettled, waitRectStable } = require('../helpers/layout');

const article = loadCassette('stock-huang');
// 16:9 桌機最大化視窗的可視區：預設「固定終端機大小」左右各剩約 155px。
const WIDE = { width: 1920, height: 960 };
const NARROW = { width: 1280, height: 800 };

const tools = (page) => page.locator('#articleTools');

async function boot(page, viewport, prefs, opts = {}) {
  await page.setViewportSize(viewport);
  await bootOffline(page, ptt, { articleTools: true });
  // mergeSameAuthorComments:false ⇒ 每則推文各自一列，跳列的目的地量得到（合併塊的行為
  // 守在 comment_merge.offline.spec.js）。
  await ptt.applyPrefs(
    page,
    Object.assign({ enableEasyReading: true, mergeSameAuthorComments: false }, prefs || {})
  );
  await replayCassette(page, article, { easyReading: opts.easyReading !== false });
  await waitPreviewsSettled(page);
  await page.evaluate(() => window.__app.setInputAreaFocus());
}

const statOf = async (page, kind) =>
  Number(((await page.locator(`[data-tools-stats] [data-kind="${kind}"]`).textContent()) || '').replace(/\D+/g, ''));

test.describe('文章工具側欄', () => {
  test('好讀文章 ⇒ 側欄出現在終端機右邊的空白：AID、推文數跟素材一致', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, WIDE);
    await expect(tools(page)).toBeVisible();
    await expect(page.locator('[data-tools-info]')).toContainText('#1g8znzQ3');
    const total = (await statOf(page, 'push')) + (await statOf(page, 'boo')) + (await statOf(page, 'arrow'));
    expect(total).toBe(article.meta.commentCount);
    // 不蓋終端機：側欄左緣在終端機右緣之後。
    const paneBox = await waitRectStable(page, '#articleTools');
    const termBox = await waitRectStable(page, '#BBSWindow > .main');
    expect(paneBox.left).toBeGreaterThanOrEqual(termBox.left + termBox.width);
    await expect(page.locator('#t')).toBeFocused();
  });

  test('點推文者 ⇒ 列出他的推文；點一則 ⇒ 好讀捲到那一列，不送鍵、不搶焦點', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, WIDE, { useMouseBrowsing: true, mouseLeftClick: true });
    await expect(tools(page)).toBeVisible();
    // 好讀讀完會停在文末；先捲回頂端，跳到推文才看得出位移。
    await page.evaluate(() => (window.__app.view.mainDisplay.scrollTop = 0));
    await startCapture(page);
    const user = page.locator('[data-tools-user]').first();
    await user.click();
    await expect(user).toHaveAttribute('data-selected', '');
    const comment = page.locator('[data-tools-comment]').first();
    const row = Number(await comment.getAttribute('data-tools-comment'));
    await comment.click();
    await expect.poll(() => page.evaluate(() => window.__app.view.mainDisplay.scrollTop)).toBeGreaterThan(0);
    const target = `#mainContainer [type="bbsrow"][srow="${row}"]`;
    const rowBox = await waitRectStable(page, target);
    const viewBox = await waitRectStable(page, '#BBSWindow > .main');
    expect(rowBox.top).toBeGreaterThanOrEqual(viewBox.top - 1);
    expect(rowBox.top).toBeLessThan(viewBox.top + viewBox.height);
    expect(await takeCapture(page)).toBe('');
    await expect(page.locator('#t')).toBeFocused();
  });

  test('滾輪在側欄上 ⇒ 捲側欄，文章不捲、不送鍵', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, { width: 1920, height: 400 }, { useMouseBrowsing: true });
    await expect(tools(page)).toBeVisible();
    // 推文者清單點開一個人、展開圖片牆 ⇒ 側欄內容比 400px 高，真的有東西可捲。
    await page.locator('[data-tools-user]').first().click();
    await page.locator('[data-tools-images-toggle]').click();
    const body = page.locator('#articleTools .toolsBody');
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    const before = await page.evaluate(() => window.__app.view.mainDisplay.scrollTop);
    await startCapture(page);
    const box = await waitRectStable(page, '#articleTools .toolsBody');
    await page.mouse.move(box.left + box.width / 2, box.top + box.height / 2);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__app.view.mainDisplay.scrollTop)).toBe(before);
    expect(await takeCapture(page)).toBe('');
  });

  test('收起 ⇒ 只剩右緣的把手；按把手 ⇒ 展開', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, WIDE);
    await page.locator('[data-tools-collapse]').click();
    await expect(page.locator('[data-tools-stats]')).toHaveCount(0);
    await expect(page.locator('[data-tools-expand]')).toBeVisible();
    await page.locator('[data-tools-expand]').click();
    await expect(page.locator('[data-tools-stats]')).toBeVisible();
    await expect(page.locator('#t')).toBeFocused();
  });

  test('視窗不夠寬 ⇒ 不出現', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, NARROW);
    expect(await page.evaluate(() => window.__app.buf.pageLines.length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__app.articleTools.state.visible)).toBe(false);
    await expect(tools(page)).toHaveCount(0);
  });

  test('原生 pmore（好讀關）⇒ 不出現', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, WIDE, { enableEasyReading: false }, { easyReading: false });
    expect(await page.evaluate(() => window.__app.buf.pageState)).toBe(3);
    await expect(tools(page)).toHaveCount(0);
  });

  test('pref 關 ⇒ 不出現', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, WIDE, { enableArticleTools: false });
    expect(await page.evaluate(() => window.__app.buf.pageLines.length)).toBeGreaterThan(0);
    await expect(tools(page)).toHaveCount(0);
  });
});
