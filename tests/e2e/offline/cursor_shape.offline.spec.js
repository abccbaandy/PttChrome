// 打字游標的**形狀與幾何**（#cursor）—— 離線守門（真瀏覽器 / 真 CSS / 真 layout）。
//
// 為什麼一定要上 e2e：游標是絕對定位的細長方塊，最終效果由「inline style 的 left/top」
// ×「CSS 的 width/height/transform-origin」×「字級（font-size 是 inline，1em = 一格列高）」
// 三者疊出來，jsdom 量不到任何一項。
//
// 這裡鎖兩件使用者可見的事：
//   1. 游標是**直線**（細長直立），不是底線（2026-08 從 `_` 字元改成方塊，見 main.css #cursor）。
//   2. 直線**完整落在自己那一格內**，不會像舊底線那樣掉到下一列去（舊實作的垂直位置
//      取決於字型的 underscore glyph metrics，反白輸入列上會明顯掉出格子）。
//
// 畫面用 ANSI 直接餵，且刻意選「PTT 自己沒畫游標」的畫面（游標停在空白格），否則會被
// autoHideBlinkCursor 抑制成 display:none（見 blink_cursor.offline.spec.js）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, feedRaw } = require('../helpers/replay');

// 第 10 列（0-based 9）有內容，游標停在第 10 列第 20 欄（0-based x=19）的空白格上。
const CURSOR_ON_BLANK =
  '\x1b[2J\x1b[1;1H  [test board]' +
  '\x1b[10;1Habc' +
  '\x1b[11;1Hdef' +
  '\x1b[10;20H';
const CUR_ROW = 9;
const CUR_COL = 19;

// 量測前先把 body.blink--active 掛上：閃爍相位剛好在「暗」的那半秒時 #cursor 是
// display:none，rect 會全 0（量到的不是位置錯，而是根本沒量到東西）。
async function measure(page, row, col) {
  return page.evaluate(
    ({ row, col }) => {
      document.body.classList.add('blink--active');
      const el = document.getElementById('cursor');
      const cs = getComputedStyle(el);
      const rowEl = (r) =>
        document.querySelector(`#mainContainer [type="bbsrow"][srow="${r}"]`);
      const rect = (e) => {
        const b = e.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, left: b.left, width: b.width, height: b.height };
      };
      return {
        display: cs.display,
        backgroundColor: cs.backgroundColor,
        color: cs.color,
        boxShadow: cs.boxShadow,
        cursor: rect(el),
        row: rect(rowEl(row)),
        nextRow: rect(rowEl(row + 1)),
        chw: window.__app.view.chw,
        chh: window.__app.view.chh,
        scaleY: window.__app.view.scaleY,
        col,
      };
    },
    { row, col }
  );
}

test.describe('打字游標是閃爍直線且不出格（離線）', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
    });
    await feedRaw(page, CURSOR_ON_BLANK);
    await page.waitForTimeout(400); // term_buf 的 30ms notify debounce + render flush
  });

  test('形狀：細長直立（寬約 2px、高＝一格列高），不是底線', async ({ page }) => {
    const m = await measure(page, CUR_ROW, CUR_COL);
    expect(m.display).toBe('block');
    // 直線：寬遠小於高。底線的形狀正好相反（寬一格、高 2~3px）。
    expect(m.cursor.width).toBeGreaterThan(0);
    expect(m.cursor.width).toBeLessThanOrEqual(4);
    expect(m.cursor.height).toBeGreaterThan(m.cursor.width * 3);
    // 高度＝一格列高（1em，font-size 由 setTermFontSize 寫成 inline ＝ chh）。
    expect(Math.abs(m.cursor.height - m.chh)).toBeLessThanOrEqual(1);
    // 方塊本體用 currentColor 上色（顏色仍由 updateCursorPos 的 inline color 決定），
    // 光暈改用 box-shadow（沒有文字了，text-shadow 失效）。
    expect(m.backgroundColor).toBe(m.color);
    expect(m.boxShadow).not.toBe('none');
  });

  test('垂直：整條直線落在游標所在列內，不侵入下一列', async ({ page }) => {
    const m = await measure(page, CUR_ROW, CUR_COL);
    // 先確認量到的是一條有厚度的線 —— 否則下面兩條對 height:0 的元素恆真（舊的
    // `_` 字元游標就是這樣：框是 0 高，畫出來的 glyph 卻在框外）。
    expect(m.cursor.height).toBeGreaterThan(1);
    // 上緣不高於該列列頂、下緣不低於下一列列頂（±2px 吸收 inline box 的 metrics 差）。
    expect(m.cursor.top).toBeGreaterThanOrEqual(m.row.top - 2);
    expect(m.cursor.bottom).toBeLessThanOrEqual(m.nextRow.top + 2);
  });

  test('水平：對齊游標所在的那一格', async ({ page }) => {
    const m = await measure(page, CUR_ROW, CUR_COL);
    expect(Math.abs(m.cursor.left - (m.row.left + m.col * m.chw))).toBeLessThanOrEqual(2);
  });

  // 「字型縮放符合視窗寬度」（fontFitWindowWidth）下，updateCursorPos 會對 #cursor 下
  // transform: scale(sx, sy)。transform-origin 若不是左上角，有高度的直線會垂直位移
  // (h - h*sy)/2 —— 舊的 height:0 元素剛好看不出來，所以這條是新實作特有的坑。
  // 這個 pref 走 onValuesPrefChange（整份值）而不是 onPrefChange，故直接推 view 再重算。
  test('縮放模式（fontFitWindowWidth）：直線仍貼齊該列，沒有被縮放原點推走', async ({ page }) => {
    // 視窗改成不是整數格的尺寸，fit-window-width 才會算出 scale ≠ 1
    // （setTermFontSize 把比例無條件捨去到小數兩位，剛好整除時就是 1）。
    await page.setViewportSize({ width: 1013, height: 717 });
    await page.evaluate(() => {
      window.__app.view.fontFitWindowWidth = true;
      window.__app.onWindowResize();
    });
    await page.waitForTimeout(300);
    const m = await measure(page, CUR_ROW, CUR_COL);
    expect(m.scaleY).not.toBe(1); // 前提成立：真的在縮放
    // 高度跟著 scale 一起放大（＝直線真的被 transform 縮放到，不是漏網之魚）。
    expect(Math.abs(m.cursor.height - m.chh * m.scaleY)).toBeLessThanOrEqual(1);
    // 上緣容差刻意收到 1px：縮放原點若退回預設的 center，直線會往上長出
    // chh*(1-sy)/2（此視窗約 3px）而懸在自己這一列上方 —— 那正是要擋的症狀。
    expect(m.cursor.top).toBeGreaterThanOrEqual(m.row.top - 1);
    expect(m.cursor.bottom).toBeLessThanOrEqual(m.nextRow.top + 2);
  });
});
