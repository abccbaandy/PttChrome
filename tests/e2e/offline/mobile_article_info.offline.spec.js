// 手機文章資訊（P102，src/js/article_tools.js#mobileInfo、components/ArticleInfoSheet）。
// 只在 offline-mobile project 跑（Pixel 7 模擬，hasTouch）。入口用真觸控（tap）。
// 守 unit 摸不到的：真的好讀累積頁算出來的數字跟 analyzeArticle 一致、點人之後真的套上「只看他」
// 的篩選、原生 pmore 沒有這一項，整段一個 byte 都不送。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { startCapture, takeCapture } = require('../helpers/capture');
const { waitPreviewsSettled, waitDialogSettled } = require('../helpers/layout');

const article = loadCassette('stock-huang');
const ITEM = '[data-key="__articleInfo"]';
const PANEL = '[data-panel="articleInfo"]';

async function openMore(page, prefs = {}) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, { enableEasyReading: true, ...prefs });
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);
  await page.locator('[data-key="__more"]').tap();
  await waitDialogSettled(page, '[data-key="__selectText"]');
}

test.describe('手機：文章資訊', () => {
  test('「更多」→「文章資訊」：推噓數字、推文最多的人；點人＝只看他的推文，一個 byte 都不送', async ({ page }) => {
    test.setTimeout(90000);
    await openMore(page);
    await startCapture(page);
    await page.locator(ITEM).tap();
    await waitDialogSettled(page, PANEL);
    const expected = await page.evaluate(() => window.__app.articleTools.mobileInfo());
    expect(expected.comments).toBeGreaterThan(3);
    const stats = page.locator(PANEL + ' .articleInfoCounts');
    await expect(stats.locator('[data-kind="push"]')).toContainText(String(expected.stats.push));
    await expect(stats.locator('[data-kind="boo"]')).toContainText(String(expected.stats.boo));
    const users = page.locator(PANEL + ' [data-info-user]');
    await expect(users).toHaveCount(expected.users.length);
    await page.screenshot({ path: test.info().outputPath('article-info.png') });

    const top = expected.users[0].user;
    await users.first().tap();
    await expect(page.locator(PANEL)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window.__app.view.activeCommentFilter() || {}).userid)).toBe(top);
    // 手機上看得到篩選橫幅，可以自己取消。
    await expect(page.locator('#commentFilterBar')).toBeVisible();
    expect(await takeCapture(page)).toBe('');
  });

  test('「‹ 文章資訊」回到「更多」', async ({ page }) => {
    await openMore(page);
    await page.locator(ITEM).tap();
    await waitDialogSettled(page, PANEL);
    await page.locator('[data-info-back]').tap();
    await waitDialogSettled(page, '[data-key="__selectText"]');
    await expect(page.locator(PANEL)).toHaveCount(0);
  });

  test('開關關掉 ⇒「更多」沒有這一項', async ({ page }) => {
    await openMore(page, { mobileArticleInfo: false });
    await expect(page.locator(ITEM)).toHaveCount(0);
  });

  test('原生 pmore（好讀關）⇒「更多」沒有這一項', async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: false });
    await replayCassette(page, article, { easyReading: false });
    await page.locator('[data-key="__more"]').tap();
    await waitDialogSettled(page, '[data-key="__select"]');
    await expect(page.locator(ITEM)).toHaveCount(0);
  });
});
