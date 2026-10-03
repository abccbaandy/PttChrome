// 閃爍游標抑制（autoHideBlinkCursor）—— 離線守門（真瀏覽器 / 真 CSS / 零網路）。
// （游標本身的形狀／幾何在 cursor_shape.offline.spec.js，這裡只管「看不看得到」。）
//
// 為什麼一定要上 e2e：抑制的最終效果是「#cursor 的 computed display」，而顯示權由
// **兩層**決定 —— inline style（term_view._applyCursorVisibility）疊上每秒切換
// `#cursor.cursor--blink-on` 的 visibility CSS 規則（main.css）。unit 只驗得到 inline
// style 那層，驗不到「兩層疊起來使用者到底看不看得到」。
//
// 檔尾另有一組省電不變量（body.blink--active 只在畫面有閃爍字時才掛）的真 timer／真 CSS 版。
//
// 畫面用 ANSI 直接餵，完全複製 pttbbs `mbbsd/stuff.c#cursor_show` 的序列：
//     move(row, col); outs(">"); move(row, col);
// —— 印完游標記號後把終端機游標移回同一格。這正是判定依據。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, feedRaw, waitScreenSettled } = require('../helpers/replay');

// PTT 畫游標：在第 5 列列首印 '>'，游標停回同一格。
const LIST_ROW_WITH_CURSOR =
  '\x1b[2J\x1b[1;1H  [test board]' +
  '\x1b[5;1H> 350024 + 2 6/14 someuser   R: [test] hello' +
  '\x1b[5;1H';

// 沒有游標記號的畫面：游標停在一般空白格（輸入框／編輯器就是這個形狀）。
const PLAIN_ROW_NO_CURSOR =
  '\x1b[2J\x1b[1;1H  [test board]' +
  '\x1b[5;1H  350024 + 2 6/14 someuser   R: [test] hello' +
  '\x1b[10;20H';

// 取樣 #cursor 看不看得到（每 100ms 一次，窗口涵蓋 ≥2 次閃爍 toggle，閃爍週期 1s，
// 見 pttchrome.jsx 的 timerEverySec）。display:none 記成 'none'，否則記 visibility
// （閃爍相位）。回傳看過的所有值。
async function observeCursor(page, ms = 2600) {
  return page.evaluate(async (ms) => {
    const el = document.getElementById('cursor');
    const seen = new Set();
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const cs = getComputedStyle(el);
      seen.add(cs.display === 'none' ? 'none' : cs.visibility);
      await new Promise((r) => setTimeout(r, 100));
    }
    return [...seen];
  }, ms);
}

test.describe('PTT 有游標時隱藏閃爍游標（離線）', () => {
  test('預設開啟：PTT 畫了 > 的列表畫面，閃爍游標完全不顯示', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
    });
    // 預設值就該是開的（pref_storage DEFAULT_PREFS），不 hardcode 期望值。
    expect(await ptt.getPref(page, 'autoHideBlinkCursor')).toBe(true);

    await feedRaw(page, LIST_ROW_WITH_CURSOR);
    await waitScreenSettled(page);
    expect(await observeCursor(page)).toEqual(['none']);
  });

  test('同一個設定下，沒有 PTT 游標的畫面（輸入框）游標照舊閃爍', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
    });

    await feedRaw(page, PLAIN_ROW_NO_CURSOR);
    await waitScreenSettled(page);
    expect(await observeCursor(page)).toContain('visible');
  });

  test('同一次連線內，游標移進／移出 > 那一格會即時切換', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
    });

    await feedRaw(page, LIST_ROW_WITH_CURSOR);
    await waitScreenSettled(page);
    expect(await observeCursor(page)).toEqual(['none']);

    // 離開列表進到輸入狀態：游標移到空白格 → 閃爍游標回來
    await feedRaw(page, PLAIN_ROW_NO_CURSOR);
    await waitScreenSettled(page);
    expect(await observeCursor(page)).toContain('visible');

    // 再回列表 → 又消失
    await feedRaw(page, LIST_ROW_WITH_CURSOR);
    await waitScreenSettled(page);
    expect(await observeCursor(page)).toEqual(['none']);
  });

  test('設定關閉 → 列表畫面游標照舊閃爍（兩個游標同框）', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
      autoHideBlinkCursor: false,
    });

    await feedRaw(page, LIST_ROW_WITH_CURSOR);
    await waitScreenSettled(page);
    expect(await observeCursor(page)).toContain('visible');
  });
});

// ---------------------------------------------------------------------------
// 省電不變量（真 timer／真 CSS）：閃爍只動 #cursor 自己；body.blink--active（會讓整棵樹
// 做一次樣式失效）只在畫面上真的有 SGR 5 閃爍字時才掛。unit 守邏輯
// （tests/unit/blink_phase.test.js），這裡守「真的每秒 tick 時也是這樣」。
const SCREEN_WITH_BLINK_TEXT =
  '\x1b[2J\x1b[1;1H  [test board]' +
  '\x1b[3;1H\x1b[5;31mBLINK\x1b[m' +
  '\x1b[10;20H';

// 取樣 ms 毫秒，回傳 { cursor: 看過的 visibility, body: 看過的 body.blink--active }。
async function observePhase(page, ms = 2600) {
  return page.evaluate(async (ms) => {
    const el = document.getElementById('cursor');
    const cursor = new Set();
    const body = new Set();
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      cursor.add(getComputedStyle(el).visibility);
      body.add(document.body.classList.contains('blink--active'));
      await new Promise((r) => setTimeout(r, 100));
    }
    return { cursor: [...cursor].sort(), body: [...body].sort() };
  }, ms);
}

test.describe('閃爍相位的省電不變量（離線）', () => {
  test('沒有閃爍字：游標照常明暗交替，body.blink--active 從頭到尾不掛', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
    });

    await feedRaw(page, PLAIN_ROW_NO_CURSOR);
    await waitScreenSettled(page);
    const seen = await observePhase(page);
    expect(seen.cursor).toEqual(['hidden', 'visible']);
    expect(seen.body).toEqual([false]);
  });

  test('有閃爍字：body.blink--active 照常交替（閃爍字仍會閃）', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
    });

    await feedRaw(page, SCREEN_WITH_BLINK_TEXT);
    await waitScreenSettled(page);
    // 前提：渲染鏈真的掛上了閃爍 class
    expect(await page.evaluate(() => !!document.querySelector('#mainContainer [class*="qq"]'))).toBe(true);
    const seen = await observePhase(page);
    expect(seen.body).toEqual([false, true]);
  });
});
