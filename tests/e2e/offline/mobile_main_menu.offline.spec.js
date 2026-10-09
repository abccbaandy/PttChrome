// 手機版面 Phase 5（docs/mobile.md「Phase 5」）：選單（主功能表與子選單）的選單項畫成大按鈕，
// ANSI 圖／標題／狀態列維持縮小的 80 欄格線。只在 offline-mobile project 跑
// （Pixel 7 模擬：hasTouch + isMobile）。合成畫面見 helpers/main_menu.js。
//
// unit（tests/unit/menu_card.test.js）守渲染與點擊分派；這裡守 unit 摸不到的：
// 真 CSS 下按鈕真的有 44px 高、surface 對帳真的切到 menu、真觸控 tap 送出的鍵。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');
const { startCapture, expectOnlyFence } = require('../helpers/capture');
const {
  drawMainMenu,
  drawUserMenu,
  USER_MENU,
  FIRST_ITEM_ROW,
  CURSOR_ROW,
  ITEMS,
} = require('../helpers/main_menu');

const MENU_CARD_PX = 44;

test.describe('手機主功能表大按鈕', () => {
  test.beforeEach(async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { useMouseBrowsing: true, mouseLeftClick: true });
    await drawMainMenu(page);
    await page.waitForFunction(() => window.__app.view.menuCards === true);
  });

  test('選單項是 44px 高的按鈕；ANSI 圖仍是格線列', async ({ page }) => {
    const m = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#mainContainer .menuCard'));
      const art = document.querySelector('#mainContainer [type="bbsrow"][srow="5"]');
      return {
        mainClass: window.__app.view.mainDisplay.classList.contains('mobileMenu'),
        rows: cards.map((c) => Number(c.getAttribute('data-menu-row'))),
        heights: cards.map((c) => c.getBoundingClientRect().height),
        fontSize: parseFloat(getComputedStyle(cards[0].querySelector('.menuCardBody')).fontSize),
        artIsCard: art.classList.contains('menuCard'),
        artHeight: art.getBoundingClientRect().height,
        chh: window.__app.view.chh,
      };
    });
    expect(m.mainClass).toBe(true);
    expect(m.rows).toEqual(ITEMS.map((_, i) => FIRST_ITEM_ROW + i));
    for (const h of m.heights) expect(Math.abs(h - MENU_CARD_PX)).toBeLessThan(1);
    expect(m.fontSize).toBe(16);
    expect(m.artIsCard).toBe(false);
    expect(Math.abs(m.artHeight - m.chh)).toBeLessThan(1);
  });

  test('tap (M) 按鈕 ⇒ 送「↓↓＋Enter」；tap ANSI 圖什麼都不送', async ({ page }) => {
    await startCapture(page);
    const art = page.locator('#mainContainer [type="bbsrow"][srow="6"]');
    await art.scrollIntoViewIfNeeded();
    const a = await art.boundingBox();
    await page.touchscreen.tap(a.x + a.width / 2, a.y + a.height / 2);
    await page.waitForFunction(() => !window.__app.dblclickTimer, null, { timeout: 5000 });
    const card = page.locator(`#mainContainer [data-menu-row="${CURSOR_ROW + 2}"]`);
    await expectOnlyFence(
      page,
      async () => {
        await card.scrollIntoViewIfNeeded();
        const b = await card.boundingBox();
        await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      },
      '\x1b[B\x1b[B\r',
      'tap (M)'
    );
  });

  test('子選單（個人設定區）也是大按鈕；tap (V) ⇒ 送「↓↓＋Enter」', async ({ page }) => {
    await drawUserMenu(page);
    await page.waitForFunction(
      (n) => document.querySelectorAll('#mainContainer .menuCard').length === n,
      USER_MENU.items.length
    );
    const card = page.locator(`#mainContainer [data-menu-row="${FIRST_ITEM_ROW + 2}"]`);
    expect(Math.abs((await card.boundingBox()).height - MENU_CARD_PX)).toBeLessThan(1);
    await startCapture(page);
    await expectOnlyFence(
      page,
      async () => {
        await card.scrollIntoViewIfNeeded();
        const b = await card.boundingBox();
        await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      },
      '\x1b[B\x1b[B\r',
      'tap (V)'
    );
  });

  test('離開主功能表（換成一般畫面）⇒ 退回格線', async ({ page }) => {
    await page.evaluate(() => window.__app.onData('\x1b[H\x1b[2J\x1b[1;1Hplain screen'));
    await page.waitForFunction(() => window.__app.view.menuCards === false);
    expect(await page.locator('#mainContainer .menuCard').count()).toBe(0);
  });
});
