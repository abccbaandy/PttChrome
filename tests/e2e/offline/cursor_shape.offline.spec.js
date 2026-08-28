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
        scaleX: window.__app.view.scaleX,
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
    // 垂直：直接跟該列**實際量到的** rect 比，容差 1px。
    // 舊的格線公式垂直原點用 chh*rows，但 `.main` 實際高 chh*rows+10 且
    // transform-origin 是 center ⇒ 系統性誤差 5*(1-scaleY) px（scaleY=1.4 約 2px）。
    // 水平方向那個 +10 剛好在兩式間抵消，所以只有垂直會漂。
    expect(Math.abs(m.cursor.top - m.row.top)).toBeLessThanOrEqual(1);
    expect(m.cursor.bottom).toBeLessThanOrEqual(m.nextRow.top + 1);
    // 水平同樣貼齊該格。
    expect(Math.abs(m.cursor.left - (m.row.left + m.col * m.chw * m.scaleX))).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 游標座標系 vs `.main` 的捲動座標系（離線）
//
// `#cursor` 是 `#BBSWindow`（position:fixed）下的**絕對定位**元素，位置由
// term_view.convertMN2XYEx 的格線公式（firstGridOffset + chh）算出，**不受 `.main`
// 的 scrollTop 影響**；而它要貼齊的那一列在 `#mainContainer` 裡，**會**跟著 `.main`
// 捲動。兩個座標系只要一脫鉤，游標就會掉出該列 —— 使用者看到的症狀是「推文時閃爍
// 直線戳出反白輸入匡」。
//
// 上面那組 describe 刻意關掉好讀，所以這條路徑（好讀 → 按 X 推文 → functionMode
// 原生鏡像）一直沒有守門。這裡守兩層：
//   1. functionMode 的原生鏡像畫面**不可捲動** —— 進 functionMode 的
//      hideEasyReadingOverlaysKeepPage() 必須清掉 accumulatePageLines 留下的
//      `#mainContainer` paddingBottom，否則 `.main` 還有 chh-10 px 可捲，滑鼠滾輪
//      （App.mouse_scroll 在 pageState 3 直接放行給瀏覽器）就會把輸入列捲上去。
//   2. 就算真的捲了，游標也要跟著該列走（updateCursorPos 扣掉 scrollTop）。
const ART_FOOTER =
  '  瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~22 行  (y)回應(X%)推文(h)說明(←)離開 ';

// 用 app 自己的 Big5 轉碼表把 Unicode 轉成 latin1 bytes 再餵進 App.onData
// （PTT 是 Big5；string_util.u2b 的同一套查表，見 main.jsx 載入的 conv/*.bin）。
async function feedBig5(page, text) {
  await page.evaluate((t) => {
    let out = '';
    for (let i = 0; i < t.length; ++i) {
      const c = t.charAt(i);
      if (c < '\x80') {
        out += c;
        continue;
      }
      const pos = t.charCodeAt(i);
      const hi = window.lib.u2bArray[2 * pos];
      const lo = window.lib.u2bArray[2 * pos + 1];
      out += hi || lo ? String.fromCharCode(hi) + String.fromCharCode(lo) : '\xFF\xFD';
    }
    window.__app.onData(out);
  }, text);
}

// 一整頁文章。末列是 pmore 狀態列（term_buf.setPageState → pageState 3），並在
// (rows-1, cols-1) park 游標 —— accumulatePageLines 的「完整回應幀」閘門要求它。
function articleFrame({ rows, cols }) {
  let s = '\x1b[2J\x1b[1;1H作者 someuser (nick) 看板 Test';
  s += '\x1b[2;1H標題 [測試] 游標幾何';
  s += '\x1b[3;1H時間 Wed Aug 19 21:47:28 2026';
  for (let r = 5; r <= rows - 1; ++r) s += `\x1b[${r};1H第 ${r} 行 body line ${r}`;
  s += `\x1b[${rows};1H` + ART_FOOTER;
  s += `\x1b[${rows};${cols}H`;
  return s;
}

// 推文輸入提示（pttbbs mbbsd/bbs.c#do_add_recommend：move(b_lines,0) + getdata(b_lines,0,…)
// ⇒ 永遠是最後一列）。「→ someid: 」佔 11 欄，游標停在第 12 欄。
function pushPromptFrame({ rows }) {
  return `\x1b[${rows};1H\x1b[K→ someid: \x1b[${rows};12H`;
}

async function dims(page) {
  return page.evaluate(() => ({
    rows: window.__app.buf.rows,
    cols: window.__app.buf.cols,
  }));
}

test.describe('游標與畫面共用同一個垂直座標系（離線）', () => {
  test('好讀→推文（functionMode 原生鏡像）：畫面沒有可捲距離', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      enableEasyReadingList: false,
    });

    const d = await dims(page);
    await feedBig5(page, articleFrame(d));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__app.easyReading.enterEasyReading());
    await page.waitForTimeout(400);

    // 前提：好讀累積頁替 footer overlay 保留了一列底部 padding。
    expect(
      await page.evaluate(() => document.getElementById('mainContainer').style.paddingBottom)
    ).toBe('1em');

    // 按 X 推文 → functionMode，畫面換成原生 24 列鏡像。
    await page.evaluate(() => window.__app.easyReading._enterFunctionMode());
    await feedBig5(page, pushPromptFrame(d));
    await page.waitForTimeout(400);

    const m = await page.evaluate(() => {
      const main = window.__app.view.mainDisplay;
      return {
        functionMode: !!window.__app.buf.easyReadingFunctionMode,
        scrollHeight: main.scrollHeight,
        clientHeight: main.clientHeight,
        paddingBottom: document.getElementById('mainContainer').style.paddingBottom,
      };
    });
    expect(m.functionMode).toBe(true); // 前提成立：真的在原生鏡像
    // 固定 24 列的鏡像畫面不該有任何可捲距離：捲一下就把輸入列移開，而絕對定位的
    // #cursor 不會跟著動。
    expect(m.scrollHeight).toBeLessThanOrEqual(m.clientHeight);
  });

  // **不呼叫 updateCursorPos**：這正是 865b828 之後仍會發生的殘留症狀 —— 捲動不產生
  // term_buf 更新（滾輪／觸控板／瀏覽器對焦捲動都不會重繪），所以「重算時扣掉 scrollTop」
  // 這種補償永遠慢一步，游標就停在原地直到下一次按鍵。游標與列同在 `.main` 內、共用
  // 同一個捲動座標系之後，這件事變成結構上不可能發生。
  test('純捲動（不重繪）也不能把游標與它那一列拆開', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
    });

    const d = await dims(page);
    // 原生固定 24 列畫面，游標停在末列輸入位置。
    await feedBig5(page, articleFrame(d));
    await feedBig5(page, pushPromptFrame(d));
    await page.waitForTimeout(400);

    // 人為讓 `.main` 可捲並捲到底（模擬任何殘留 padding / 使用者滾輪），**不重繪**。
    const m = await page.evaluate((row) => {
      document.body.classList.add('blink--active');
      const view = window.__app.view;
      document.getElementById('mainContainer').style.paddingBottom = '3em';
      view.mainDisplay.scrollTop = 9999;
      const rect = (e) => {
        const b = e.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, left: b.left, height: b.height };
      };
      const rowEl = document.querySelector(
        `#mainContainer [type="bbsrow"][srow="${row}"]`
      );
      return {
        scrollTop: view.mainDisplay.scrollTop,
        cursor: rect(document.getElementById('cursor')),
        row: rect(rowEl),
        chh: view.chh,
      };
    }, d.rows - 1);

    expect(m.scrollTop).toBeGreaterThan(0); // 前提成立：真的捲動了
    // 游標整條必須落在它那一列裡（±2px 吸收 inline box metrics 差）。
    expect(m.cursor.top).toBeGreaterThanOrEqual(m.row.top - 2);
    expect(m.cursor.bottom).toBeLessThanOrEqual(m.row.top + m.chh + 2);
  });

  // React 19 在 root container 首次 mount 時會做 `container.textContent = ''`
  // （react-dom-client 的 HostRoot mutation commit）。`#cursor` 若直接放進 React 的
  // root container，第一次 render 就會被清掉 —— 所以 React 有自己的容器
  // （`#screenRoot`），`#cursor` 是它的兄弟。
  test('React 首次 render 之後，#cursor 仍然活在 .main 裡', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await feedRaw(page, CURSOR_ON_BLANK);
    await page.waitForTimeout(400);

    const m = await page.evaluate(() => {
      const el = document.getElementById('cursor');
      const screen = document.getElementById('mainContainer');
      return {
        exists: !!el,
        parentClass: el ? el.parentElement.className : null,
        // 螢幕內容與游標必須在同一個捲動容器底下
        sharedScroller: !!el && !!screen && el.closest('.main') === screen.closest('.main'),
      };
    });
    expect(m.exists).toBe(true);
    expect(m.parentClass).toBe('main');
    expect(m.sharedScroller).toBe(true);
  });

  // 好讀累積長頁：畫面第 N 列與格線第 N 列毫無關係，游標的格線座標在那裡沒有意義
  // （舊實作把它畫在視窗的 cur_y 列上，等於飄在任意內文上）。文章內的輸入情境一律
  // 走 functionMode 原生鏡像（_onKeyDownProcessUI 對任何單字元鍵先 _enterFunctionMode），
  // 所以長頁幀直接隱藏游標，不會影響打字。
  test('好讀累積長頁（非格線幀）：游標隱藏', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      enableEasyReadingList: false,
    });

    const d = await dims(page);
    await feedBig5(page, articleFrame(d));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__app.easyReading.enterEasyReading());
    await page.waitForTimeout(400);

    const m = await page.evaluate(() => {
      document.body.classList.add('blink--active');
      return {
        gridRender: window.__app.view._gridRender,
        display: getComputedStyle(document.getElementById('cursor')).display,
      };
    });
    expect(m.gridRender).toBe(false); // 前提成立：真的在非格線幀
    expect(m.display).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// 症狀本身：推文時游標必須落在 PTT 畫的**反白輸入帶**裡（離線）
//
// 上面那幾條守的是「游標貼齊它那一列」，用的是列節點的矩形——但列節點的矩形本身
// 就是被測 code 拿來定位的東西，兩邊同源。這一組改成鎖使用者真正看到的事：
// 游標在不在那條黑字白底的帶子裡。帶子是 server 用 ESC[30;47m 畫出來的，
// 在 DOM 裡是 `.b7`（bg 索引 7）的 span，與游標的定位路徑完全無關。
//
// pttbbs mbbsd/bbs.c#do_add_recommend：輸入列固定在最後一列，「→ someid: 」佔 11 欄
// ⇒ 游標停在第 12 欄（0-based 11），反白帶從第 11 欄起 49 格。
const PUSH_PROMPT_COL = 11;
const PUSH_BAND_COLS = 49;

function pushPromptReverseFrame({ rows }) {
  return (
    `\x1b[${rows};1H\x1b[K` +
    '\x1b[1;37m→\x1b[m someid: ' +
    '\x1b[30;47m' + ' '.repeat(PUSH_BAND_COLS) + '\x1b[m' +
    `\x1b[${rows};${PUSH_PROMPT_COL + 1}H`
  );
}

// #cursor 與反白帶（.b7）的矩形。量之前掛 blink--active，否則暗相位量到全 0。
async function measureBand(page, row) {
  return page.evaluate((row) => {
    document.body.classList.add('blink--active');
    const rect = (e) => {
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
    };
    const rowEl = document.querySelector(
      `#mainContainer [type="bbsrow"][srow="${row}"]`
    );
    return {
      cursorDisplay: getComputedStyle(document.getElementById('cursor')).display,
      cursor: rect(document.getElementById('cursor')),
      band: rect(rowEl && rowEl.querySelector('.b7')),
      row: rect(rowEl),
    };
  }, row);
}

function expectCursorInsideBand(m) {
  expect(m.cursorDisplay).not.toBe('none'); // 前提：游標真的看得到
  expect(m.band).not.toBe(null); // 前提：反白帶真的畫出來了
  // ±1px 吸收 subpixel；再多就是真的戳出去了。
  expect(m.cursor.left).toBeGreaterThanOrEqual(m.band.left - 1);
  expect(m.cursor.right).toBeLessThanOrEqual(m.band.right + 1);
  expect(m.cursor.top).toBeGreaterThanOrEqual(m.band.top - 1);
  expect(m.cursor.bottom).toBeLessThanOrEqual(m.band.bottom + 1);
}

test.describe('推文：游標落在反白輸入帶裡（離線）', () => {
  test('好讀 → X 推文（functionMode 原生鏡像）：游標在反白帶內', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      enableEasyReadingList: false,
    });

    const d = await dims(page);
    await feedBig5(page, articleFrame(d));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__app.easyReading.enterEasyReading());
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__app.easyReading._enterFunctionMode());
    await feedBig5(page, pushPromptReverseFrame(d));
    await page.waitForTimeout(400);

    expect(await page.evaluate(() => !!window.__app.buf.easyReadingFunctionMode)).toBe(true);
    expectCursorInsideBand(await measureBand(page, d.rows - 1));
  });

  // **這條在修改前必紅。** 游標的垂直位置曾是 `cur_y * chh` 的算術模型，而畫面上那一列
  // 的真實位置是 layout 的結果：只要有任何一列的 line box 被撐大（標註、inline-block 的
  // baseline、#mainContainer 多的 padding、字型還沒落地…），兩者就脫鉤、游標整批下不去。
  // 這裡直接把游標列之上的某一列撐高，模擬「任何一種撐高的原因」，**不重繪**，
  // 只叫 updateCursorPos ——它必須讀到新的 layout。
  test('上方列被撐高（不重繪）：游標仍在反白帶內', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
    });

    const d = await dims(page);
    await feedBig5(page, articleFrame(d));
    await feedBig5(page, pushPromptReverseFrame(d));
    await page.waitForTimeout(400);

    const before = await measureBand(page, d.rows - 1);
    expectCursorInsideBand(before); // 前提：撐高之前本來就是好的

    await page.evaluate(() => {
      const row = document.querySelector('#mainContainer [type="bbsrow"][srow="5"]');
      row.style.paddingTop = '9px';
      window.__app.view.updateCursorPos();
    });

    const after = await measureBand(page, d.rows - 1);
    // 前提成立：帶子真的被推下去了（不然這條測試什麼都沒測到）
    expect(after.band.top - before.band.top).toBeGreaterThan(5);
    expectCursorInsideBand(after);
  });

  // 等寬格線的字寬契約：一列 80 欄的實際寬度必須等於 cols * chw。
  // Windows 走 local MingLiu，macOS 沒有 —— 那裡整個契約押在 bundled webfont
  // SymMingLiu（ASCII advance 正好 0.5em）。字型沒落地時 ASCII 退回系統 monospace，
  // 整列橫向偏掉而游標的欄位算術不會跟著偏。
  test('格線字寬契約：一列的實際寬度 == cols * chw', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await feedRaw(page, CURSOR_ON_BLANK); // 第 10 列是純 ASCII（abc + 空白補滿）
    await page.waitForTimeout(400);

    const m = await page.evaluate((row) => ({
      fontLoaded: document.fonts.check('26px SymMingLiu'),
      lineWidth: document
        .querySelector(`#mainContainer [type="bbsrow"][srow="${row}"] [data-type="bbsline"]`)
        .getBoundingClientRect().width,
      cols: window.__app.buf.cols,
      chw: window.__app.view.chw,
      scaleX: window.__app.view.scaleX,
    }), CUR_ROW);

    expect(m.fontLoaded).toBe(true);
    expect(Math.abs(m.lineWidth - m.cols * m.chw * m.scaleX)).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 注音輸入匡 #t（本專案自己畫的那個 double 邊框；OS 的候選字清單錨在它上面）。
//
// 它住在 `.main` **外面**（#BBSWindow 底下，見 index.html），舊實作因此另有一套格線
// 公式 convertMN2XYEx —— 那套**完全不扣 .main.scrollTop**，捲動後整個偏掉。現在改成
// 錨在該列真正被畫出來的節點的 getBoundingClientRect()，捲動與縮放天然含在裡面。
async function measureInputBox(page, row) {
  return page.evaluate((row) => {
    const view = window.__app.view;
    view.input.style.width = '40px'; // 避免右邊界 clamp 介入這次量測
    view.onCompositionStart({});
    const rect = (e) => {
      const b = e.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left };
    };
    const rowEl = document.querySelector(
      `#mainContainer [type="bbsrow"][srow="${row}"]`
    );
    return {
      bshow: view.input.getAttribute('bshow'),
      input: rect(view.input),
      row: rect(rowEl),
      cur_x: window.__app.buf.cur_x,
      chw: view.chw,
      scaleX: view.scaleX,
      scrollTop: view.mainDisplay.scrollTop,
    };
  }, row);
}

function expectInputAlignedToCell(m) {
  expect(m.bshow).toBe('1');
  // 左緣貼齊該格
  expect(Math.abs(m.input.left - (m.row.left + m.cur_x * m.chw * m.scaleX)))
    .toBeLessThanOrEqual(1);
  // 垂直緊貼該列（塞得下就在下方、塞不下翻到上方，兩者都以該列為基準）
  const below = Math.abs(m.input.top - m.row.bottom);
  const above = Math.abs(m.input.bottom - m.row.top);
  expect(Math.min(below, above)).toBeLessThanOrEqual(2);
}

test.describe('注音輸入匡 #t 錨在該格（離線）', () => {
  test('推文列上開始 composition：#t 貼齊游標那一格', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
    });

    const d = await dims(page);
    await feedBig5(page, articleFrame(d));
    await feedBig5(page, pushPromptReverseFrame(d));
    await page.waitForTimeout(400);

    expectInputAlignedToCell(await measureInputBox(page, d.rows - 1));
  });

  // 舊的 convertMN2XYEx 在這裡必偏 scrollTop px（它只認 firstGridOffset）。
  test('`.main` 已捲動時 #t 仍貼齊該格', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
    });

    const d = await dims(page);
    await feedBig5(page, articleFrame(d));
    await feedBig5(page, pushPromptReverseFrame(d));
    await page.waitForTimeout(400);

    // 人為讓 `.main` 可捲並捲到底（模擬任何殘留 padding／使用者滾輪）。
    await page.evaluate(() => {
      document.getElementById('mainContainer').style.paddingBottom = '3em';
      window.__app.view.mainDisplay.scrollTop = 9999;
    });

    const m = await measureInputBox(page, d.rows - 1);
    expect(m.scrollTop).toBeGreaterThan(0); // 前提成立：真的捲動了
    expectInputAlignedToCell(m);
  });
});
