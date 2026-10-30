// 主功能表的動態看板不是提示列也不是選單項：裡面的 `(G)`、`[P]` 不可以變成功能鍵按鈕，
// 以 `(A)` 開頭的行不可以被當成選單項（點了送 ↑↓＋Enter 落到別的項目）。
//
// menu.c#adbanner 在選單（主功能表與子選單）的 row 1 起 out_lines(SHM->notes[i], 11)：
// 動態看板／點歌是別人寫的 ANSI 圖。footer_keys.functionKeyRows 以前對 pageState 1 一律掃
// row 1（列表的提示列在那裡）⇒ 動態看板裡的括號字變成按鈕，點下去就在選單上送那個鍵
// （主功能表 G＝離站、休閒聊天區 P＝切換呼叫器）。menu_items.parseMenuItemRow 只看列文字
// 形狀 ⇒ 動態看板某行以 `(A)` 開頭就變成可點的選單項（手機是大按鈕），點下去游標從選單項
// 往上移、在選單上繞一圈落到別的項目再 Enter。
//
// 素材：upstream pttbbs 原始碼產的主功能表（tests/unit/fixtures/ptt_src_screens/main_menu.json；
// 產畫面的假 SHM 沒有動態看板），row 1 再照 adbanner 的畫法（move(1,0) 起寫）補一段內容。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootScenario, waitScreenSettled } = require('../helpers/replay');
const { nextFrames, waitClickSettled } = require('../helpers/real_input');
const fx = require('../../unit/fixtures/ptt_src_screens/main_menu.json');

const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');
const menu = fx.frames.find((f) => f.name === 'menu').bytes;
// ESC[2;1H＝row 1, col 0（adbanner 的 move(1, 0)）。
const BANNER =
  '\x1b[2;1H\x1b[1;33m   Song for you: press (G) now, [P] later   \x1b[m' +
  '\x1b[4;1H   (A) Banner event: leave a message   ';
const cassette = {
  meta: { mode: 'scenario', scenario: 'menu-banner', prefs: {} },
  cols: fx.cols,
  rows: fx.rows,
  steps: [{ on: 'start', recv: b64(menu + BANNER) }],
};

const fnKeysOnRow = (page, row) =>
  page.evaluate(
    (r) =>
      Array.from(document.querySelectorAll(`#mainContainer [data-row="${r}"] a.fnKey`)).map((a) =>
        a.getAttribute('data-fnkey')
      ),
    row
  );

test('主功能表：動態看板的括號字不變成按鈕、(A) 開頭的行不是選單項，點了都不送鍵；底列 (h)說明 照常', async ({ page }) => {
  await bootScenario(page, ptt, cassette, {
    prefs: { useMouseBrowsing: true, mouseLeftClick: true, mouseFunctionKeys: true, mouseEdgePaging: false },
  });
  await waitScreenSettled(page, { 1: 'Song for you', 3: 'Banner event', 23: '主選單' });
  expect(await page.evaluate(() => window.__app.buf.isMenuScreen())).toBe(true);

  expect(await fnKeysOnRow(page, 1)).toEqual([]);
  expect((await fnKeysOnRow(page, 23)).length).toBeGreaterThan(0);

  // 點 row 1 的 `(G)` 那一格、row 3 的 `(A)` 與後面的文字（左 7 欄是退出帶，要點在它右邊才是
  // 「選單項」）：一個鍵都不送。
  for (const [row, label] of [[1, '(G)'], [3, '(A)'], [3, 'event']]) {
    const p = await page.evaluate(
      ([r, l]) => {
        const v = window.__app.view;
        const col = window.__app.buf.getRowText(r, 0, 80).indexOf(l) + 1;
        return {
          x: parseFloat(v.firstGridOffset.left) + v.chw * (col + 0.5),
          y: parseFloat(v.firstGridOffset.top) + v.chh * (r + 0.5),
        };
      },
      [row, label]
    );
    await page.mouse.move(p.x, p.y);
    await nextFrames(page);
    await page.mouse.down();
    await page.mouse.up();
    await waitClickSettled(page);
  }
  expect(await page.evaluate(() => window.__replay.sent.slice())).toEqual([]);
});
