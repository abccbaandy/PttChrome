// 說明選單好讀（docs/help-menu.md）：PTT 新版 h 說明（分頁游標選單）在好讀開著時改成
// 一次列出全部頁的彈窗。合成畫面見 helpers/help_menu.js（版型照 psb.c）。
//
// unit（help_menu.test.js／help_menu_modal.test.jsx）守解析、送鍵與元件分派；這裡守 unit
// 摸不到的：真 boot 鏈下 settle → 控制器 → 彈窗、背景 PgDn 補頁的線上往返、真滑鼠點擊與
// 真鍵盤送出的 bytes、彈窗開著時鍵盤不漏給終端機。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');
const { startCapture, peekCapture, takeCapture, expectOnlyFence } = require('../helpers/capture');
const { ITEMS, drawHelpPage, drawOtherScreen } = require('../helpers/help_menu');

const HOME = '\x1b[1~';
const PGDN = '\x1b[6~';
const DOWN = '\x1b[B';

const items = (page) => page.locator('[data-help-item]');

// h 的畫面出現 → 彈窗開、送一個 PgDn 補第 2 頁 → 畫第 2 頁 → 全部列出。
async function openFull(page) {
  const { perPage } = await drawHelpPage(page, 1);
  await expect(items(page)).toHaveCount(perPage);
  await expect.poll(() => peekCapture(page)).toBe(PGDN);
  await takeCapture(page);
  await drawHelpPage(page, 2);
  await expect(items(page)).toHaveCount(ITEMS.length);
  await expect(page.locator('[data-help-loading]')).toHaveCount(0);
  return perPage;
}

test.describe('說明選單好讀（桌機）', () => {
  test.beforeEach(async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await startCapture(page);
  });

  test('兩頁合併列出；點第 2 頁的「線上使用者」⇒ Home＋PgDn＋↓…＋Enter，之後不再彈', async ({ page }) => {
    const perPage = await openFull(page);
    const idx = ITEMS.findIndex((s) => s.startsWith('(^U)'));
    await items(page).nth(idx).click();
    const expected = HOME + PGDN.repeat(Math.floor(idx / perPage)) + DOWN.repeat(idx % perPage) + '\r';
    await expect.poll(() => peekCapture(page)).toBe(expected);
    expect(await takeCapture(page)).toBe(expected);
    await expect(items(page)).toHaveCount(0);
    // 執行鍵途中 server 還會畫幾張說明幀（Home／PgDn 的回應）：不可以再彈出來。
    await drawHelpPage(page, 2, { cursor: idx });
    await drawOtherScreen(page);
    await expect(items(page)).toHaveCount(0);
    expect(await takeCapture(page)).toBe('');
  });

  test('鍵盤：↓↓ Enter 執行第 3 項；彈窗開著時按鍵不漏給終端機', async ({ page }) => {
    await openFull(page);
    await expect(items(page).first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(items(page).nth(2)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => peekCapture(page)).toBe(HOME + DOWN.repeat(2) + '\r');
    expect(await takeCapture(page)).toBe(HOME + DOWN.repeat(2) + '\r');
  });

  test('Esc 離開 ⇒ 送 q（同原生）', async ({ page }) => {
    await openFull(page);
    await page.keyboard.press('Escape');
    await expect.poll(() => peekCapture(page)).toBe('q');
    expect(await takeCapture(page)).toBe('q');
    await expect(items(page)).toHaveCount(0);
  });

  test('「原生畫面」⇒ 收起彈窗、Home 回第 1 頁，之後按鍵直接給 PTT', async ({ page }) => {
    await openFull(page);
    await page.locator('[data-help-native]').click();
    await expect(items(page)).toHaveCount(0);
    await expect.poll(() => peekCapture(page)).toBe(HOME);
    await takeCapture(page);
    // 原生說明選單的 Home 回應：不再彈出。
    await drawHelpPage(page, 1);
    await expect(items(page)).toHaveCount(0);
    await expectOnlyFence(page, () => page.keyboard.press('j'), 'j', '原生說明選單收鍵');
  });

  test('好讀關著 ⇒ 不彈、不送 PgDn（原生說明選單照常）', async ({ page }) => {
    await ptt.applyPrefs(page, { enableEasyReading: false });
    await drawHelpPage(page, 1);
    await expectOnlyFence(page, () => page.keyboard.press('j'), 'j', '好讀關著');
    await expect(items(page)).toHaveCount(0);
  });
});
