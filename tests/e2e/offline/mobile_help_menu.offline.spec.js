// 說明選單好讀（手機）：同一個控制器，外殼換成 bottom sheet。只在 offline-mobile project 跑
// （Pixel 7 模擬：hasTouch + isMobile）。合成畫面見 helpers/help_menu.js。
// 守 unit 摸不到的：真 CSS 下每項是觸控目標高度、sheet 內容可捲到最後一項、真觸控 tap
// 送出的鍵。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');
const { ITEMS, drawHelpPage } = require('../helpers/help_menu');

const HOME = '\x1b[1~';
const PGDN = '\x1b[6~';
const DOWN = '\x1b[B';
const TOUCH_MIN_PX = 44;

const items = (page) => page.locator('[data-sheet="help"] [data-help-item]');

test.describe('說明選單好讀（手機 bottom sheet）', () => {
  test.beforeEach(async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await startCapture(page);
    const { perPage } = await drawHelpPage(page, 1);
    await expect(items(page)).toHaveCount(perPage);
    await expect.poll(() => peekCapture(page)).toBe(PGDN);
    await takeCapture(page);
    await drawHelpPage(page, 2);
    await expect(items(page)).toHaveCount(ITEMS.length);
  });

  test('每項至少 44px 高；tap 最後一項（捲到才看得到）⇒ 送對應的鍵', async ({ page }) => {
    const heights = await items(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(TOUCH_MIN_PX);
    const perPage = (await page.evaluate(() => window.__app.buf.rows)) - 3;
    const idx = ITEMS.length - 1;
    const last = items(page).nth(idx);
    await last.scrollIntoViewIfNeeded();
    const b = await last.boundingBox();
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    const expected = HOME + PGDN.repeat(Math.floor(idx / perPage)) + DOWN.repeat(idx % perPage) + '\r';
    await expect.poll(() => peekCapture(page)).toBe(expected);
    expect(await takeCapture(page)).toBe(expected);
    await expect(items(page)).toHaveCount(0);
  });

  test('「離開」按鈕 ⇒ 送 q', async ({ page }) => {
    const btn = page.locator('[data-sheet="help"] [data-help-close]');
    const b = await btn.boundingBox();
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await expect.poll(() => peekCapture(page)).toBe('q');
    expect(await takeCapture(page)).toBe('q');
    await expect(items(page)).toHaveCount(0);
  });
});
