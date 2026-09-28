// 手機版面 Phase 1（docs/mobile.md）：tap 不叫鍵盤、按鍵列送鍵、鍵盤鈕。
// 只在 `offline-mobile` project 跑（Pixel 7 模擬：hasTouch + isMobile ⇒
// pointer: coarse、hover: none），`offline` project 以 testIgnore 排除。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassettes, bootOffline, replayCassette } = require('../helpers/replay');

const articles = findCassettes('article');

const inputMode = (page) => page.evaluate(() => document.getElementById('t').getAttribute('inputmode'));
const focusedIsT = (page) => page.evaluate(() => document.activeElement === document.getElementById('t'));
const scrollTop = (page) => page.evaluate(() => window.__app.view.mainDisplay.scrollTop);

test.describe('手機按鍵列（離線重放）', () => {
  test('裝置偵測：模擬手機 ⇒ mobile 模式、#t inputmode=none、按鍵列收合', async ({ page }) => {
    await bootOffline(page, ptt);
    expect(await page.evaluate(() => window.__app.mobile)).toBe(true);
    expect(await inputMode(page)).toBe('none');
    await expect(page.locator('[data-key="__open"]')).toBeVisible();
    await expect(page.locator('[data-key="PageDown"]')).toHaveCount(0);
  });

  test.describe('文章好讀', () => {
    test.skip(!articles.length, '尚無 article cassette');

    test('tap 終端機不切成 text；按鍵列 PgDn 捲動好讀、不搶 #t 焦點；鍵盤鈕切 inputmode', async ({ page }) => {
      test.setTimeout(90000);
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, { enableEasyReading: true });
      await replayCassette(page, articles[0], { easyReading: true });
      await expect
        .poll(() => page.evaluate(() => window.__app.view.mainDisplay.scrollHeight > window.__app.view.mainDisplay.clientHeight + 50))
        .toBe(true);

      // tap 畫面：inputmode 維持 none（tap 不會叫出軟鍵盤）
      const box = await page.locator('#mainContainer').boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + 40);
      expect(await inputMode(page)).toBe('none');

      await page.locator('[data-key="__open"]').tap();
      await page.evaluate(() => window.__app.setInputAreaFocus());
      const before = await scrollTop(page);
      await page.locator('[data-key="PageDown"]').tap();
      await expect.poll(() => scrollTop(page)).toBeGreaterThan(before);
      expect(await focusedIsT(page)).toBe(true);

      await page.locator('[data-key="__keyboard"]').tap();
      expect(await inputMode(page)).toBe('text');
      expect(await focusedIsT(page)).toBe(true);
      await page.locator('[data-key="__keyboard"]').tap();
      expect(await inputMode(page)).toBe('none');
    });
  });
});
