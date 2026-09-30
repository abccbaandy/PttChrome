// 手機版面 Phase 1（docs/mobile.md）：tap 不叫鍵盤、按鍵列送鍵、鍵盤鈕。
// 只在 `offline-mobile` project 跑（Pixel 7 模擬：hasTouch + isMobile ⇒
// pointer: coarse、hover: none），`offline` project 以 testIgnore 排除。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassettes, bootOffline, replayCassette } = require('../helpers/replay');
const { waitRectStable } = require('../helpers/layout');

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

// 浮動可拖曳（docs/mobile.md「按鍵列」）。拖曳邏輯在 tests/unit/mobile_keypad.test.jsx；
// 這裡鎖真瀏覽器裡 pointer capture＋fixed 定位真的會動、位置存進 localStorage、不出視窗。
const keypadRect = (page) =>
  page.evaluate(() => {
    const r = document.getElementById('mobileKeypad').getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });

test('展開後拖把手 ⇒ 按鍵列跟著移動、位置存進 localStorage、不出視窗', async ({ page }) => {
  test.setTimeout(60000);
  await bootOffline(page, ptt);
  await page.locator('[data-key="__open"]').click();
  const handle = page.locator('[data-key="__drag"]');
  await expect(handle).toBeVisible();
  // 展開後按鍵列會重新夾回視窗內（useLayoutEffect）：等位置停了再量、再拖。
  await waitRectStable(page, '#mobileKeypad');
  const before = await keypadRect(page);
  const h = await waitRectStable(page, '[data-key="__drag"]');
  const x = h.left + h.width / 2;
  const y = h.top + h.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 40, y - 80, { steps: 6 });
  await page.mouse.up();

  const after = await keypadRect(page);
  expect(before.top - after.top).toBeGreaterThan(60);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pttchrome.mobileKeypadPos')));
  expect(saved.bottom).toBeGreaterThan(60);

  // 往外拖超出視窗 ⇒ 夾在視窗內。
  const h2 = await waitRectStable(page, '[data-key="__drag"]');
  await page.mouse.move(h2.left + 5, h2.top + 5);
  await page.mouse.down();
  await page.mouse.move(h2.left - 2000, h2.top - 2000, { steps: 6 });
  await page.mouse.up();
  const clamped = await keypadRect(page);
  const vp = page.viewportSize();
  expect(clamped.left).toBeGreaterThanOrEqual(-0.5);
  expect(clamped.top).toBeGreaterThanOrEqual(-0.5);
  expect(clamped.right).toBeLessThanOrEqual(vp.width + 0.5);
});
