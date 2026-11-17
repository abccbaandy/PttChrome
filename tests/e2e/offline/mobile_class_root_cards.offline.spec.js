// 手機分類看板根目錄大按鈕（P99）：主功能表按 C 進去那一層的群組畫成大按鈕，上方寫死的
// ANSI 圖收起，tap 送原生「移游標＋⏎」（同主功能表／精華區卡片）。
// 只在 offline-mobile project 跑（Pixel 7：hasTouch＋isMobile）。
// 畫面照 mbbsd/board.c 的 IN_CLASSROOT 版型（同 tests/unit/fixtures/class_root_rows.js）合成：
// 手機列數由視窗決定，狀態列要畫在最後一列。
//
// unit（class_root_card.test.js、parse_failure_degrade.test.js、ptt_src_screens.test.js）守解析、
// 指紋與 DOM；這裡守 unit 摸不到的：surface 對帳真的切到按鈕、真 CSS 下的高度、真觸控 tap 送出的鍵、
// 游標不在群組列上不送、PTT 開輸入欄時退回格線。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');
const { startCapture, expectOnlyFence } = require('../helpers/capture');
const { scrollIntoViewStable } = require('../helpers/layout');

const MENU_CARD_PX = 44;
const TITLE = '【分類看板】                       新批踢踢';
const ART = [
  '                                                              ◣  ╭—●',
  '                                                    ╬—   ◢█⊙██◣╤',
  '     ︿︿︿︿︿︿︿︿                               ║ ◣◢███▼▼▼║',
  '                                                       ◤◥███▲▲▲ ║',
  '                                  ︿︿︿︿︿︿︿︿    │   ◥████◤ ║',
  '                                                      ╫——  ◤      —＋',
];
// desc＝「名稱＋多個空白＋說明」同一欄（util/initbbs.c 的預設群組就是這樣寫），板主欄留白。
const GROUPS = [
  ['◎市民廣場     報告站長  PTT咬我', ''],
  ['◎臺灣大學     臺大, 臺科大, 師大', ''],
  ['◎政治大學     政大與其他學校', ''],
];
const FOOTER = ' 分類看板  (m)加入最愛 (v)已讀/未讀 (t)標記 (y)只列最愛     (←)回上層 (h)說明';
const FIRST = 7; // 第一個群組在第 7 列（board.c header_lines 7）

// cursorRow：游標停在哪一列（0 起算；預設第一個群組）。prompt：在底列上一列開輸入欄。
async function drawClassRoot(page, { cursorRow = FIRST, prompt = false } = {}) {
  await page.evaluate(
    ({ TITLE, ART, GROUPS, FOOTER, FIRST, cursorRow, prompt }) => {
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
      const width = (s) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) < 0x80 ? 1 : 2), 0);
      const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
      const rows = window.__app.buf.rows;
      const REV = '\x1b[7m';
      const OFF = '\x1b[0m';
      let d = '\x1b[H\x1b[2J';
      d += '\x1b[1;1H' + REV + u2b(pad(TITLE, 80)) + OFF;
      ART.forEach((t, i) => {
        d += '\x1b[' + (i + 2) + ';1H' + u2b(t);
      });
      GROUPS.forEach(([desc, bm], i) => {
        const y = FIRST + i;
        let col = String(i + 1).padStart(7) + ' ' + '  ';
        if (y === cursorRow) col = '> ' + col.slice(2);
        d += '\x1b[' + (y + 1) + ';1H' + u2b('          ' + col + pad(desc, 40) + ' ' + bm);
      });
      d += '\x1b[' + rows + ';1H' + REV + u2b(pad(FOOTER, 80)) + OFF;
      if (prompt) {
        const label = '請輸入看板名稱: ';
        d += '\x1b[' + (rows - 1) + ';1H' + u2b(label) + REV + ' '.repeat(20) + OFF;
        d += '\x1b[' + (rows - 1) + ';' + (width(label) + 1) + 'H';
      } else {
        d += '\x1b[' + (cursorRow + 1) + ';11H';
      }
      window.__app.onData(d);
    },
    { TITLE, ART, GROUPS, FOOTER, FIRST, cursorRow, prompt }
  );
  await waitScreenSettled(page, { 0: '分類看板', [FIRST]: '市民廣場' });
  // 柵欄：這一幀的 surface 對帳已跑過，再判「有／沒有」按鈕。
  await page.waitForFunction(() => !window.__app.buf.timerUpdate && !window.__app.buf._settleTimer);
}

const cardCount = (page) => page.locator('#mainContainer .classRootCard').count();

async function tapRow(page, row) {
  const b = await scrollIntoViewStable(page, `#mainContainer [data-menu-row="${row}"]`);
  await page.touchscreen.tap(b.left + b.width / 2, b.top + b.height / 2);
}

test.describe('手機分類看板根目錄大按鈕', () => {
  test.beforeEach(async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { useMouseBrowsing: true, mouseLeftClick: true });
  });

  test('群組是 44px 高的大按鈕、ANSI 圖收起；tap 第三個 ⇒ 送「↓↓＋Enter」', async ({ page }) => {
    await drawClassRoot(page);
    await page.waitForFunction(() => document.querySelectorAll('#mainContainer .classRootCard').length === 3);
    const m = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#mainContainer .classRootCard'));
      return {
        menuCards: window.__app.view.menuCards,
        rows: cards.map((c) => Number(c.getAttribute('data-menu-row'))),
        heights: cards.map((c) => c.getBoundingClientRect().height),
        names: cards.map((c) => c.querySelector('.menuCardName').textContent),
        descs: cards.map((c) => c.querySelector('.classRootCardDesc').textContent),
        artH: [1, 2, 3, 4, 5, 6].map(
          (y) => document.querySelector(`#mainContainer [type="bbsrow"][srow="${y}"]`).getBoundingClientRect().height
        ),
      };
    });
    expect(m.menuCards).toBe(true);
    expect(m.rows).toEqual([7, 8, 9]);
    for (const h of m.heights) expect(Math.abs(h - MENU_CARD_PX)).toBeLessThan(1);
    expect(m.names).toEqual(['市民廣場', '臺灣大學', '政治大學']);
    expect(m.descs).toEqual(['報告站長  PTT咬我', '臺大, 臺科大, 師大', '政大與其他學校']);
    expect(m.artH).toEqual([0, 0, 0, 0, 0, 0]);

    await startCapture(page);
    await expectOnlyFence(page, () => tapRow(page, 9), '\x1b[B\x1b[B\r', 'tap 第三個群組');
  });

  // _sendRowEnter 用 cur_y 算 ↑↓ 次數：游標不在群組列上時送出去，⏎ 會進到別的群組。
  test('游標不在群組列上 ⇒ tap 不送；回到群組列 ⇒ 照常', async ({ page }) => {
    await drawClassRoot(page, { cursorRow: 15 });
    await page.waitForFunction(() => document.querySelectorAll('#mainContainer .classRootCard').length === 3);
    await startCapture(page);
    await tapRow(page, 8);
    await drawClassRoot(page);
    await expectOnlyFence(page, () => tapRow(page, 8), '\x1b[B\r', '游標回到群組列後 tap 第二個');
  });

  test('開關關掉 ⇒ 照舊格線、沒有按鈕', async ({ page }) => {
    await ptt.applyPrefs(page, { mobileClassRootCards: false });
    await drawClassRoot(page);
    expect(await cardCount(page)).toBe(0);
    expect(await page.evaluate(() => window.__app.view.menuCards)).toBe(false);
  });

  test('PTT 開輸入欄（底列 caption 還在）⇒ 退回格線，輸入欄看得到', async ({ page }) => {
    await drawClassRoot(page);
    await page.waitForFunction(() => document.querySelectorAll('#mainContainer .classRootCard').length === 3);
    await drawClassRoot(page, { prompt: true });
    await expect.poll(() => cardCount(page)).toBe(0);
    const h = await page.evaluate(() => {
      const rows = window.__app.buf.rows;
      return document.querySelector(`#mainContainer [type="bbsrow"][srow="${rows - 2}"]`).getBoundingClientRect().height;
    });
    expect(h).toBeGreaterThan(0);
  });
});
