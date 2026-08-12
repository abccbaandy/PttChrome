// 閃爍底線抑制（autoHideBlinkCursor）—— 離線守門（真瀏覽器 / 真 CSS / 零網路）。
//
// 為什麼一定要上 e2e：抑制的最終效果是「#cursor 的 computed display」，而顯示權由
// **兩層**決定 —— inline style（term_view._applyCursorVisibility）疊上每秒 toggle
// `body.blink--active` 的 CSS 規則（main.css）。unit 只驗得到 inline style 那層，
// 驗不到「兩層疊起來使用者到底看不看得到」。
//
// 畫面用 ANSI 直接餵，完全複製 pttbbs `mbbsd/stuff.c#cursor_show` 的序列：
//     move(row, col); outs(">"); move(row, col);
// —— 印完游標記號後把終端機游標移回同一格。這正是判定依據。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, feedRaw } = require('../helpers/replay');

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

// 取樣 #cursor 的 computed display（每 100ms 一次，窗口涵蓋 ≥2 次閃爍 toggle，
// 閃爍週期 1s，見 pttchrome.jsx 的 timerEverySec）。回傳看過的所有值。
async function observeCursor(page, ms = 2600) {
  return page.evaluate(async (ms) => {
    const el = document.getElementById('cursor');
    const seen = new Set();
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      seen.add(getComputedStyle(el).display);
      await new Promise((r) => setTimeout(r, 100));
    }
    return [...seen];
  }, ms);
}

test.describe('PTT 有游標時隱藏閃爍底線（離線）', () => {
  test('預設開啟：PTT 畫了 > 的列表畫面，底線完全不顯示', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
    });
    // 預設值就該是開的（pref_storage DEFAULT_PREFS），不 hardcode 期望值。
    expect(await ptt.getPref(page, 'autoHideBlinkCursor')).toBe(true);

    await feedRaw(page, LIST_ROW_WITH_CURSOR);
    await page.waitForTimeout(400); // term_buf 的 30ms notify debounce + render flush
    expect(await observeCursor(page)).toEqual(['none']);
  });

  test('同一個設定下，沒有 PTT 游標的畫面（輸入框）底線照舊閃爍', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
    });

    await feedRaw(page, PLAIN_ROW_NO_CURSOR);
    await page.waitForTimeout(400);
    expect(await observeCursor(page)).toContain('block');
  });

  test('同一次連線內，游標移進／移出 > 那一格會即時切換', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
    });

    await feedRaw(page, LIST_ROW_WITH_CURSOR);
    await page.waitForTimeout(400);
    expect(await observeCursor(page)).toEqual(['none']);

    // 離開列表進到輸入狀態：游標移到空白格 → 底線回來
    await feedRaw(page, PLAIN_ROW_NO_CURSOR);
    await page.waitForTimeout(400);
    expect(await observeCursor(page)).toContain('block');

    // 再回列表 → 又消失
    await feedRaw(page, LIST_ROW_WITH_CURSOR);
    await page.waitForTimeout(400);
    expect(await observeCursor(page)).toEqual(['none']);
  });

  test('設定關閉 → 列表畫面底線照舊閃爍（兩個游標同框）', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
      autoHideBlinkCursor: false,
    });

    await feedRaw(page, LIST_ROW_WITH_CURSOR);
    await page.waitForTimeout(400);
    expect(await observeCursor(page)).toContain('block');
  });
});
