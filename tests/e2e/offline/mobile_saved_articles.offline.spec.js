// 存到本機（P64，docs/saved-articles.md）的手機入口：好讀文章「更多」→「存到本機」（真觸控）。
// 只在 offline-mobile project 跑（Pixel 7 模擬，hasTouch）。唯讀頁本身守在 saved_reader.offline.spec.js。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { startCapture, takeCapture } = require('../helpers/capture');
const { waitPreviewsSettled, waitDialogSettled } = require('../helpers/layout');

const article = loadCassette('stock-huang');
const ITEM = '[data-key="__saveLocal"]';

test.describe('手機：存到本機', () => {
  test('好讀文章「更多」→「存到本機」⇒ 存進本機清單、提示、一個 byte 都不送', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, article, { easyReading: true });
    await waitPreviewsSettled(page);
    await startCapture(page);
    await page.locator('[data-key="__more"]').tap();
    await waitDialogSettled(page, ITEM);
    await page.locator(ITEM).tap();
    await expect
      .poll(() => page.evaluate(() => window.__app.savedArticles.list().then((l) => l.map((m) => m.key))))
      .toEqual(['stock/1g8znzQ3']);
    await expect(page.locator('body')).toContainText(
      await page.evaluate(() => window.__i18n('saved_done'))
    );
    expect(await takeCapture(page)).toBe('');
  });

  test('pref 關掉 ⇒「更多」裡沒有這一項', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true, enableSavedArticles: false });
    await replayCassette(page, article, { easyReading: true });
    await waitPreviewsSettled(page);
    await page.locator('[data-key="__more"]').tap();
    await waitDialogSettled(page, '[data-key="__select"]');
    await expect(page.locator(ITEM)).toHaveCount(0);
  });
});
