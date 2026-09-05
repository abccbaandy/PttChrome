// 「點空白處關框」的端到端守護 —— 離線重放，真瀏覽器、真渲染、完整 boot 鏈。
//
// 判斷本身是純函式（tests/unit/screen_dismiss.test.js）、接線也有 unit
// （tests/unit/screen_dismiss_click.test.js）。這裡上 e2e 的理由只有一個：
// **真的有沒有一個 byte 送上線**。中間隔著 clientToPos 的座標換算、window 上的
// mouse_click、view._send 的 `if (this.conn)`，unit 三層都是假的。
//
// 畫面用 feedRaw 合成（不需要真 PTT、也不需要 cassette）：pressanykey 與
// vgetstring 輸入欄的指紋都在**最後一列**，其餘 23 列自己畫成純文字 ⇒ 沒有連結、
// 沒有推文列、沒有內嵌預覽，點下去只會落到關框那條路，斷言不會被別的優先權吃掉。
//
// pttbbs 出處逐條在 src/js/screen_dismiss.js 的檔頭。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  bootOffline,
  feedRaw,
  findCassette,
  replayCassette,
} = require('../helpers/replay');

// ---- 合成畫面（latin1；中文以 Big5 位元組直接寫死）----------------------------
//
// include/vtuikit.h:39-42
//   VMSG_PAUSE       " 請按任意鍵繼續 "  → 20 bdd0abf6a5f4b74ec1e4c47ec4f2 20
//   VMSG_PAUSE_PAD   "▄"                → a2 65
//   VMSG_MSG_PREFIX  " ◆ "              → 20 a1bb 20
//   VMSG_MSG_FLOAT   " [按任意鍵繼續]"  → 20 5b abf6a5f4b74ec1e4c47ec4f2 5d
const PAUSE_TEXT = ' \xbd\xd0\xab\xf6\xa5\xf4\xb7\x4e\xc1\xe4\xc4\x7e\xc4\xf2 ';
const PAUSE_PAD = '\xa2\x65';
const VMSG_PREFIX = ' \xa1\xbb ';
const VMSG_FLOAT = ' \x5b\xab\xf6\xa5\xf4\xb7\x4e\xc1\xe4\xc4\x7e\xc4\xf2\x5d';
// mbbsd/bbs.c:3098 " 確定[y/N]:"（vans → vgetstring，**輸入欄開著**）
const CONFIRM_TEXT = ' \xbd\x54\xa9\x77[y/N]:';

// 23 列可辨識的純文字 ＋ 指定的最後一列。cursorAt 是 1-based 的 ANSI 座標。
function screen(lastRow, cursorAt) {
  let out = '\x1b[2J\x1b[H';
  for (let r = 1; r <= 23; ++r) {
    out += '\x1b[' + r + ';1H' + ('offline row ' + r).padEnd(78, '.');
  }
  out += '\x1b[24;1H' + lastRow;
  out += '\x1b[' + cursorAt[0] + ';' + cursorAt[1] + 'H';
  return out;
}

// vshowmsg(NULL)：`▄` 填滿、正中央 VMSG_PAUSE。游標停在該列（move(b_lines,0)）。
// **整列不可以超過 80 格**：超出就自動換行 ⇒ 終端機捲一列，合成畫面整個位移
// （這一條踩過，症狀是 row 0 變成 'offline row 2'、pause 文字被截掉）。
// 15×2 格 padding ＋ 16 格文字 ＝ 76 格。
const PRESS_ANY_KEY = screen(
  PAUSE_PAD.repeat(15) + PAUSE_TEXT + PAUSE_PAD.repeat(15),
  [24, 1]
);
// vmsg("抱歉, 禁止推薦") 型的橫幅。
const VMSG_BANNER = screen(
  VMSG_PREFIX + 'no can do' + ' '.repeat(40) + VMSG_FLOAT,
  [24, 1]
);
// vgetstring：prompt ＋ 反白輸入欄（VCLR_INPUT_FIELD = ESC[0;7m），游標落在欄內。
const INPUT_FIELD = screen(
  CONFIRM_TEXT + '\x1b[30;47m' + ' '.repeat(30) + '\x1b[m',
  [24, 13]
);
// 沒有框的一般畫面（pmore 之外的普通底列）。游標 park 在右下角。
const NO_FRAME = screen('offline footer without any frame'.padEnd(79, ' '), [
  24, 80,
]);

// ---- 送出收集器（與 mouse.offline.spec.js 同一套 hook）-----------------------
async function startCapture(page) {
  await page.evaluate(() => {
    window.__sentLog = [];
    window.__stubWSSent = (s) => window.__sentLog.push(s);
  });
}
async function takeCapture(page) {
  return page.evaluate(() => {
    const out = window.__sentLog.join('');
    window.__sentLog = [];
    return out;
  });
}

// 終端機第 (col,row) 格的畫面座標（取格子中心，避開邊界的 ±0.5 誤差）。
// 與 mouse.offline.spec.js 同一份公式，來源是 view.firstGridOffset / chw / chh。
async function cellXY(page, col, row) {
  return page.evaluate(
    ({ c, r }) => {
      const v = window.__app.view;
      return {
        x: parseFloat(v.firstGridOffset.left) + v.chw * (c + 0.5),
        y: parseFloat(v.firstGridOffset.top) + v.chh * (r + 0.5),
      };
    },
    { c: col, r: row }
  );
}
async function clickCell(page, col, row) {
  const { x, y } = await cellXY(page, col, row);
  await page.mouse.click(x, y);
}

async function boot(page, prefs) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(
    page,
    Object.assign(
      {
        enableEasyReading: false,
        enableEasyReadingList: false,
        useMouseBrowsing: true,
        mouseLeftClick: true,
      },
      prefs || {}
    )
  );
}

// 餵一幀合成畫面並等它**畫出來**。
//
// 停止條件刻意是 DOM（最後一列渲染出來的文字），不是 buf.getRowText：
// `TermChar.isLeadByte` 是在 term_buf.updateCharAttr 裡設的，而那支只在 notify
// （30ms debounce）→ redraw 的路上跑一次 ⇒ **feedRaw 剛回來時 getRowText 還吐
// 原始 Big5 位元組**（`½Ð«ö¥ô·NÁäÄ~Äò`），拿它當就緒判準會在畫面還沒轉碼時就放行，
// 後面的點擊於是打在「還沒有框」的那一幀上（這個坑實際踩過，症狀是送出 0 byte）。
// 產品端沒有這個問題：使用者的點擊永遠發生在重畫之後。
async function paint(page, raw, lastRowContains) {
  await feedRaw(page, raw);
  await page.waitForFunction(
    (needle) => {
      const el = document.querySelector('#mainContainer [data-row="23"]');
      return !!el && el.textContent.indexOf(needle) >= 0;
    },
    lastRowContains
  );
}

test.describe('點空白處關框（離線合成畫面）', () => {
  test('pressanykey 的框：點空白處送出空白鍵', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await paint(page, PRESS_ANY_KEY, '請按任意鍵繼續');

    await startCapture(page);
    await clickCell(page, 40, 10);
    await page.waitForTimeout(200);
    // **一定要是空白鍵**：`\f`(Ctrl-L) 會被 io.c#system_key_hook 吃掉（不算按鍵），
    // 用它關框會整串位移一格。
    expect(await takeCapture(page)).toBe(' ');
  });

  test('vmsg 橫幅（ ◆ … [按任意鍵繼續]）同樣送空白鍵', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await paint(page, VMSG_BANNER, '[按任意鍵繼續]');

    await startCapture(page);
    await clickCell(page, 40, 10);
    await page.waitForTimeout(200);
    expect(await takeCapture(page)).toBe(' ');
  });

  test('vgetstring 輸入欄：點空白處送 Ctrl-C（取消）', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await paint(page, INPUT_FIELD, '確定[y/N]:');
    // 前提要成立才算數：這一幀真的被判成「輸入欄開著」。
    expect(
      await page.evaluate(() => window.__app.buf.isCursorOnInputField())
    ).toBe(true);

    await startCapture(page);
    await clickCell(page, 40, 10);
    await page.waitForTimeout(200);
    expect(await takeCapture(page)).toBe('\x03');
  });

  test('REGRESSION：點在游標那一列一個 byte 都不送（D2）', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await paint(page, INPUT_FIELD, '確定[y/N]:');
    expect(await page.evaluate(() => window.__app.buf.cur_y)).toBe(23);

    await startCapture(page);
    await clickCell(page, 40, 23);
    await page.waitForTimeout(200);
    // 那一列是使用者正在打的字（pressanykey 的橫幅也在那一列）。
    expect(await takeCapture(page)).toBe('');
  });

  test('NEGATIVE：沒有框時點畫面一個 byte 都不送（最重要的一條）', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await boot(page);
    await paint(page, NO_FRAME, 'offline footer');

    await startCapture(page);
    await clickCell(page, 40, 10);
    await clickCell(page, 40, 5);
    await page.waitForTimeout(250);
    // 沒有「安全鍵」可送：Ctrl-C 在文章列表會清標記清單（read.c:950）、
    // 空白鍵在文章裡是翻頁。判不出框就必須什麼都不做。
    expect(await takeCapture(page)).toBe('');
  });

  test('滑鼠左鍵 pref 關掉 ⇒ 關框也不生效（D1：沿用既有 pref）', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await boot(page, { mouseLeftClick: false });
    await paint(page, PRESS_ANY_KEY, '請按任意鍵繼續');

    await startCapture(page);
    await clickCell(page, 40, 10);
    await page.waitForTimeout(200);
    expect(await takeCapture(page)).toBe('');
  });

  test('框開著時滑鼠指標換成 pointer（整片畫面都可點）', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await paint(page, PRESS_ANY_KEY, '請按任意鍵繼續');

    const { x, y } = await cellXY(page, 40, 10);
    await page.mouse.move(x, y);
    await page.waitForTimeout(100);
    expect(
      await page.evaluate(() => window.__app.buf.BBSWin.style.cursor)
    ).toBe('pointer');
    // 底色**不上**：框在時下方整片是殘影，上底色會讓人以為那裡可以點。
    expect(await page.evaluate(() => window.__app.buf.nowHighlight)).toBe(-1);
  });
});

// §4.4 的硬需求：輸入欄開著時**一顆功能鍵按鈕都不准畫**。
//
// `[Y/n]`（bbs.c:3060 小天使）與 ` 確定[y/N]:`（bbs.c:3098）都畫在最後一列
// ＝ functionKeyRows 會掃的那一列。複合鍵一放開它們就變成兩顆按鈕 —— 但
// vans/getdata 是**整行輸入**（vgets 要 Enter），點 `Y` 只會把字打進欄位、
// 不會送出，使用者會以為壞掉。gate 在 term_view 的兩處（靜態守護
// tests/unit/fnkeys_input_field_gate.test.js），這裡驗真的沒畫出來。
test.describe('輸入欄開著時不畫功能鍵按鈕（離線重放）', () => {
  const article = findCassette('article');
  if (!article) {
    test.skip('尚無 article cassette；先 yarn record:cassette', () => {});
  }

  test('文章 footer 本來有按鈕，開了輸入欄之後一顆都不剩', async ({ page }) => {
    test.setTimeout(90000);
    if (!article) return;
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      useMouseBrowsing: true,
      mouseLeftClick: true,
      mouseFunctionKeys: true,
    });
    await replayCassette(page, article, { easyReading: false });

    const count = () =>
      page.evaluate(
        () => document.querySelectorAll('#mainContainer a.fnKey').length
      );
    expect(await count()).toBeGreaterThan(0);

    // 把最後一列換成 vans 的 `[y/N]` 提示 ＋ 反白輸入欄，游標落在欄內。
    await feedRaw(
      page,
      '\x1b[24;1H\x1b[K' +
        CONFIRM_TEXT +
        '\x1b[30;47m' +
        ' '.repeat(20) +
        '\x1b[m\x1b[24;13H'
    );
    await page.waitForFunction(() => window.__app.buf.isCursorOnInputField());
    await page.waitForTimeout(250);

    // 點 `Y` 只會把字打進欄位、不會送出 ⇒ 這種畫面一顆按鈕都不該有。
    expect(await count()).toBe(0);
  });
});
