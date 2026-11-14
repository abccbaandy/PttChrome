// 跳到第一篇未讀的畫面回饋（P83／P84，docs/unread-jump.md「過程回饋」）：真 F7、真 Esc、
// 真滑鼠點「取消」。server 是頁面裡的假 PTT 列表（helpers/fake_board.js，照 read.c 的翻頁
// 規則回應），列表好讀的凍結交易（游標同步腿 → End → PgUp… → 跳號 → 落地即回好讀）整段跑真的。
//
// 板子：1～200 篇、150 以後未讀、游標在 100 ⇒ End（181～200）→ PgUp（161～180）→ PgUp
// （141～160，149～145 連續已讀＝走進已讀區）→ 跳 150。未讀 200～150 共 51 篇。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');
const { installFakeBoard, jumpsAfterEnd, listCursorNum } = require('../helpers/fake_board');

const BOARD = { total: 200, unreadFrom: 150, cursor: 100 };

async function engage(page, prefs, delayMs) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, { easyReadingListPrefetchCount: 0, ...prefs });
  await installFakeBoard(page, { ...BOARD, delayMs });
  if (prefs.enableEasyReadingList !== false) {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const app = window.__app;
          return app.listSession.state === 'active' && app.buf.listRenderMode === 'buffer' && app.commandQueue.idle;
        })
      )
      .toBe(true);
  } else {
    // 要等**靜置**，不是只等字：起始那幀的 settle 若落在 F7 送出之後，End 的 expect 會拿它
    // 來判（游標 100 剛好在那頁最後一列，endLanded 認得）⇒ 讀成「沒有未讀」。
    await waitScreenSettled(page, { 2: '編號', 23: '文章選讀' });
  }
  await page.evaluate(() => window.__app.setInputAreaFocus());
}

const fakeKeys = (page) => page.evaluate(() => window.__fakeBoardKeys.slice());
const busyDim = (page) => page.evaluate(() => document.body.classList.contains('unreadJumpBusy'));

test.describe('跳到第一篇未讀：過程回饋', () => {
  test('好讀列表：找的過程出現進度卡、列表調暗；落地後畫「以下未讀 51 篇」，按鍵就收', async ({ page }) => {
    await engage(page, { enableEasyReadingList: true }, 150);
    await page.keyboard.press('F7');

    const card = page.locator('.unreadJumpProgress');
    await expect(card).toBeVisible();
    await expect(card).toContainText('正在找第一篇未讀…');
    expect(await busyDim(page)).toBe(true);
    // 凍結交易會開右下「讀取中…」：有進度卡時不疊那一顆。
    await expect(page.locator('.ListLoadingHint')).toBeHidden();

    await expect(page.locator('.ListHint')).toContainText('已跳到第一篇未讀 #150');
    await expect(card).toHaveCount(0);
    expect(await busyDim(page)).toBe(false);
    expect(await listCursorNum(page)).toBe(150);
    // 進度只來自讀過的頁：送鍵序列跟沒有回饋時一樣（End、PgUp×2、跳號）。
    const keys = await fakeKeys(page);
    const end = keys.indexOf('\x1b[4~');
    expect(keys.slice(end, end + 4)).toEqual(['\x1b[4~', '\x1b[5~', '\x1b[5~', '150\r']);

    const layer = page.locator('.unreadJumpDividerLayer');
    await expect(layer).toBeVisible();
    await expect(layer.locator('.unreadJumpDividerLabel')).toHaveText('以下未讀 51 篇');
    // 線貼在游標那一列（第 150 篇）的上緣。
    const geo = await page.evaluate(() => {
      const row = window.__app.view._listCursorRow;
      const el = document.querySelector('#mainContainer [data-type="bbsline"][data-row="' + row + '"]');
      const line = document.querySelector('.unreadJumpDivider').getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { text: el.textContent, rowTop: r.top, lineTop: line.top };
    });
    expect(geo.text).toMatch(/(^|\D)150(\D|$)/);
    expect(Math.abs(geo.lineTop - (geo.rowTop - 1))).toBeLessThanOrEqual(1);

    await page.keyboard.press('ArrowDown');
    await expect(layer).toHaveCount(0);
  });

  test('好讀列表：找的過程按 Esc ＝取消，回到原本那篇（第 100 篇）', async ({ page }) => {
    await engage(page, { enableEasyReadingList: true }, 200);
    await page.keyboard.press('F7');
    const card = page.locator('.unreadJumpProgress');
    await expect(card).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card.locator('.unreadJumpTitle')).toHaveText('正在取消…');
    await expect(page.locator('.ListHint')).toContainText('已取消，回到原本的位置');
    expect(await jumpsAfterEnd(page)).toEqual(['100\r']);
    expect(await listCursorNum(page)).toBe(100);
    await expect(card).toHaveCount(0);
    expect(await busyDim(page)).toBe(false);
    await expect(page.locator('.unreadJumpDividerLayer')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.__app.listSession.state === 'active' && window.__app.buf.listRenderMode === 'buffer'))
      .toBe(true);
  });

  test('原生列表：不調暗；用滑鼠點「取消」也回到原本那篇', async ({ page }) => {
    await engage(page, { enableEasyReadingList: false }, 200);
    await page.keyboard.press('F7');
    const card = page.locator('.unreadJumpProgress');
    await expect(card).toBeVisible();
    expect(await busyDim(page)).toBe(false);
    await card.locator('.unreadJumpCancel').click();
    await expect(page.locator('.ListHint')).toContainText('已取消，回到原本的位置');
    expect(await jumpsAfterEnd(page)).toEqual(['100\r']);
    expect(await page.evaluate(() => window.__fakeBoard.cur)).toBe(100);
    // 原生不畫分界、取消也不畫。
    await expect(page.locator('.unreadJumpDividerLayer')).toHaveCount(0);
    // 取消鈕不搶焦點：之後的鍵照常進終端機。
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('t');
  });

  test('兩個開關都關掉 ⇒ 跟以前一樣：沒有進度卡、沒有分界，仍跳到 150', async ({ page }) => {
    await engage(page, { enableEasyReadingList: true, unreadJumpProgress: false, unreadJumpDivider: false }, 150);
    await page.keyboard.press('F7');
    await expect(page.locator('.ListHint')).toContainText('已跳到第一篇未讀 #150');
    expect(await listCursorNum(page)).toBe(150);
    await expect(page.locator('.unreadJumpProgress')).toHaveCount(0);
    await expect(page.locator('.unreadJumpDividerLayer')).toHaveCount(0);
  });
});
