// 手機 bottom sheet（docs/mobile.md「Bottom sheet」，components/MobileSheet）：「更多」、
// 長按選單、搜尋在手機上的外殼。只在 offline-mobile project 跑（Pixel 7 模擬）。
//
// unit（mobile_toolbar.test.jsx／context_sheet.test.jsx／history_back_guard.test.js）守分支；
// 這裡守 unit 摸不到的：真觸控點遮罩不會漏成「點終端機」送鍵、系統返回（真 popstate）
// 只收 sheet 不送 ←、搜尋 sheet 的輸入框真的拿到焦點。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');
const { drawMainMenu } = require('../helpers/main_menu');
const { waitRectStable } = require('../helpers/layout');

const byKey = (page, k) => page.locator(`[data-key="${k}"]`);
const sheet = (page, k) => page.locator(`[data-sheet="${k}"]`);

async function collectSent(page) {
  await page.evaluate(() => {
    window.__sent = [];
    window.__stubWSSent = (s) => window.__sent.push(s);
  });
}
const sentText = (page) => page.evaluate(() => (window.__sent || []).join(''));

async function bootMenu(page) {
  await bootOffline(page, ptt);
  // 滑鼠瀏覽開著：點到終端機（選單大按鈕）會送鍵 ⇒ 「遮罩點擊漏出去」才測得出來。
  await ptt.applyPrefs(page, { useMouseBrowsing: true, mouseLeftClick: true });
  await drawMainMenu(page);
  await page.waitForFunction(() => window.__app.view.menuCards === true);
}

test.describe('手機 bottom sheet', () => {
  test('更多：開著＝modal；點遮罩（壓在選單按鈕上）只收 sheet，不送任何鍵', async ({ page }) => {
    await bootMenu(page);
    await byKey(page, '__more').tap();
    await expect(sheet(page, 'more')).toBeVisible();
    expect(await page.evaluate(() => window.__app.modalShown)).toBe(true);

    // 遮罩上、正下方是一顆選單大按鈕的位置（sheet 動畫停了再量）
    const card = await waitRectStable(page, '#mainContainer .menuCard');
    const sheetBox = await waitRectStable(page, '[data-sheet="more"]');
    const y = card.top + card.height / 2;
    expect(y).toBeLessThan(sheetBox.top);
    await collectSent(page);
    await page.touchscreen.tap(card.left + card.width / 2, y);
    await expect(sheet(page, 'more')).toHaveCount(0);
    expect(await sentText(page)).toBe('');
    await expect.poll(() => page.evaluate(() => window.__app.modalShown)).toBe(false);
  });

  test('系統返回（popstate）＝收起 sheet，不送 ←、不出逃生提示', async ({ page }) => {
    await bootMenu(page);
    await byKey(page, '__more').tap(); // 這一下也是 user activation ⇒ sentinel 疊上
    await expect(sheet(page, 'more')).toBeVisible();
    await page.waitForFunction(() => !!(window.history.state && window.history.state.pttchromeBackGuard));
    await collectSent(page);
    await page.goBack();
    await expect(sheet(page, 'more')).toHaveCount(0);
    expect(await sentText(page)).not.toContain('\x1b[D');
    expect(await page.evaluate(() => !!window.__app)).toBe(true);
    // sentinel 補回來了：下一次返回照常送 ←（不會被當成逃生而離站）
    await page.waitForFunction(() => !!(window.history.state && window.history.state.pttchromeBackGuard));
  });

  test('搜尋：從底部導覽開成 sheet，輸入框拿到焦點；遮罩收起後焦點回終端機', async ({ page }) => {
    await bootMenu(page);
    await byKey(page, '__search').tap();
    await expect(sheet(page, 'search')).toBeVisible();
    const input = sheet(page, 'search').locator('input[name="searchKeyword"]');
    await expect(input).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheet(page, 'search')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.activeElement === document.getElementById('t')))
      .toBe(true);
  });

  test('拖曳把手往下拉＝收起', async ({ page }) => {
    await bootMenu(page);
    await byKey(page, '__more').tap();
    await expect(sheet(page, 'more')).toBeVisible(); // Drawer 內容是非同步掛上的
    // slide-up 動畫中量到的是還在視窗外的位置 ⇒ 等版面穩定再量。
    const b = await waitRectStable(page, '[data-sheet="more"] [data-sheet-handle]');
    const x = b.left + b.width / 2;
    const y = b.top + b.height / 2;
    // 觸控拖曳：CDP 觸控事件（real_input 的規範：瀏覽器負責的手勢不手捏 DOM 事件）。
    const cdp = await page.context().newCDPSession(page);
    const pt = (yy) => [{ x, y: yy }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(y) });
    for (let d = 20; d <= 160; d += 20)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(y + d) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(sheet(page, 'more')).toHaveCount(0);
  });
});
