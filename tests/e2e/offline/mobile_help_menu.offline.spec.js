// 說明選單好讀（手機）：同一個控制器，外殼換成 bottom sheet。只在 offline-mobile project 跑
// （Pixel 7 模擬：hasTouch + isMobile）。合成畫面見 helpers/help_menu.js。
// 守 unit 摸不到的：真 CSS 下每項是觸控目標高度、sheet 內容可捲到最後一項、真觸控 tap
// 送出的鍵。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');
const { ITEMS, drawHelpPage } = require('../helpers/help_menu');
const { scrollIntoViewStable, waitRectStable, waitDialogSettled } = require('../helpers/layout');

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
    const b = await scrollIntoViewStable(page, `[data-sheet="help"] [data-help-item="${idx}"]`);
    await page.touchscreen.tap(b.left + b.width / 2, b.top + b.height / 2);
    const expected = HOME + PGDN.repeat(Math.floor(idx / perPage)) + DOWN.repeat(idx % perPage) + '\r';
    await expect.poll(() => peekCapture(page)).toBe(expected);
    expect(await takeCapture(page)).toBe(expected);
    await expect(items(page)).toHaveCount(0);
  });

  test('「離開」按鈕 ⇒ 送 q', async ({ page }) => {
    // sheet 剛從第一頁長到全部項目、還在 slide-up：量到的是動畫中的位置，tap 會落空。
    const b = await waitRectStable(page, '[data-sheet="help"] [data-help-close]');
    await page.touchscreen.tap(b.left + b.width / 2, b.top + b.height / 2);
    await expect.poll(() => peekCapture(page)).toBe('q');
    expect(await takeCapture(page)).toBe('q');
    await expect(items(page)).toHaveCount(0);
  });
});

// 入口：手機的卡片／好讀文章畫面會收起底列，原生的 (h)說明 點不到 ⇒ 「更多」裡的「操作說明」。
// 底列帶 (h)說明 的任一畫面（這裡用我的最愛的 footer，pttbbs psb.c 的 vs_footer 版型）。
async function drawFavFooter(page) {
  await page.evaluate(() => {
    const u2b = (str) =>
      [...str]
        .map((ch) => {
          const c = ch.charCodeAt(0);
          return c < 0x80
            ? ch
            : String.fromCharCode(window.lib.u2bArray[2 * c]) +
                String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
        })
        .join('');
    const rows = window.__app.buf.rows;
    window.__app.onData(
      '\x1b[H\x1b[2J\x1b[1;1H\x1b[7m' + u2b('【我的最愛】') + '\x1b[m' +
        '\x1b[' + rows + ';1H\x1b[7m' + u2b(' 我的最愛  (a)增加看板 (d)刪除 (g)新增目錄    (h)說明 ') + '\x1b[m'
    );
  });
  await page.waitForFunction(() => {
    const buf = window.__app.buf;
    return !buf.timerUpdate && !buf._settleTimer && buf.getRowText(buf.rows - 1, 0, buf.cols).includes('(h)');
  });
}

test.describe('說明選單入口（手機「更多」）', () => {
  test('底列有 (h)說明：更多 → 操作說明 ⇒ 送 h；PTT 畫出說明選單 ⇒ sheet 出現', async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await drawFavFooter(page);
    await startCapture(page);
    await page.locator('[data-key="__more"]').tap();
    const help = page.locator('[data-sheet="more"] [data-key="__help"]');
    await expect(help).toBeVisible();
    await waitDialogSettled(page, '[data-sheet="more"] [data-key="__help"]');
    await help.tap();
    await expect.poll(() => peekCapture(page)).toBe('h');
    await takeCapture(page);
    const { perPage } = await drawHelpPage(page, 1);
    await expect(items(page)).toHaveCount(perPage);
  });
});
