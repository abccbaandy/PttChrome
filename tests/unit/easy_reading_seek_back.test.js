// seekBack：好讀文章已累積到文末後，使用者在 functionMode 用 `:N` 指定行／`;N` 指定頁／
// 原生搜尋把 PTT 的頁指標**往回**移到已累積的範圍內。
//
// 舊版（修前）：classifyPageTransition 回 backward，但 decideAccumulateBranch 沒有這個
// 分支 → 走 append；resolvePageOverlap 把 k 夾成 maxK ⇒ 一列都沒加，**但 _accEndRow 被
// 設成落地頁的結尾（倒退）**⇒ 自動翻頁從落地處送 PageDown，每一頁都用倒退的基準算重疊
// ⇒ 已累積的內容被重複接到長頁尾巴（使用者看到「一直被捲到其他位置」）。
//
// 本檔用真的 TermView.prototype.accumulatePageLines ＋真的 parseStatusRow／去重函式，
// 以 pmore 的分頁形狀（PageDown：S' == E，末頁被 maxdisps 夾住）逐幀餵。
import { TermView } from "../../src/js/term_view";
import { EasyReading } from "../../src/js/easy_reading";
import { rowToText } from "../../src/js/comment_parse";

const ROWS = 24;
const CONTENT = ROWS - 1; // 狀態列以外的列數
const TOTAL = 111; // 文章總行數（檔案行＝顯示列，無斷行）
const LAST_START = TOTAL - CONTENT + 1; // maxdisps：末頁從 89 開始

const cells = (text) => {
  const row = [];
  for (let i = 0; i < 80; ++i) row.push({ ch: text[i] || " ", isLeadByte: false });
  return row;
};

function statusText(start, end) {
  const pct = end >= TOTAL ? 100 : Math.floor((end * 100) / TOTAL);
  return `  瀏覽 第 1/5 頁 (${String(pct).padStart(3)}%)  目前顯示: 第 ${start}~${end} 行  (y)回應(X%)推文(h)說明(←)離開 `;
}

// pmore 在第 start 行時畫出來的畫面（含狀態列）
function screen(start) {
  const s = Math.min(start, LAST_START);
  const e = Math.min(s + CONTENT - 1, TOTAL);
  const texts = [];
  for (let l = s; l < s + CONTENT; ++l) texts.push(l <= TOTAL ? `article line ${l}` : "");
  texts.push(statusText(s, e));
  return texts;
}

function makeView() {
  const view = Object.create(TermView.prototype);
  const buf = {
    rows: ROWS,
    cols: 80,
    cur_y: ROWS - 1,
    cur_x: 79,
    lines: [],
    pageLines: [],
    prevPageState: 0,
    easyReadingPendingReset: false,
    getRowText(r) {
      return rowToText(this.lines[r]);
    },
  };
  view.buf = buf;
  view.mainContainer = null;
  view._accEndRow = null;
  view._lastAccumulatedSig = null;
  view._articleInstanceId = 0;
  view._mirrorStatusRowToFooter = () => {};
  return view;
}

function paint(view, start) {
  view.buf.lines = screen(start).map(cells);
  view.accumulatePageLines();
  // term_view.redraw 每個渲染幀結尾寫 prevPageState（文章頁＝3）
  view.buf.prevPageState = 3;
}

const texts = (view) => view.buf.pageLines.map((r) => rowToText(r).replace(/\s+$/, ""));

function readToEnd(view) {
  paint(view, 1);
  for (let s = CONTENT; s < LAST_START; s += CONTENT - 1) paint(view, s);
  paint(view, LAST_START);
}

describe("seekBack：往回跳不得污染累積頁", () => {
  test("前提：逐頁累積到文末＝每行恰好一次", () => {
    const view = makeView();
    readToEnd(view);
    const t = texts(view);
    expect(t).toHaveLength(TOTAL);
    expect(t[0]).toBe("article line 1");
    expect(t[TOTAL - 1]).toBe(`article line ${TOTAL}`);
    expect(view._accEndRow).toBe(TOTAL);
  });

  test("REGRESSION：:41 跳回中段 → pageLines／_accEndRow 不動，並回報落地列", () => {
    const view = makeView();
    readToEnd(view);
    const before = texts(view);
    paint(view, 41);
    expect(texts(view)).toEqual(before);
    expect(view._accEndRow).toBe(TOTAL); // 修前：63（倒退）
    expect(view.buf.easyReadingSeekBack).toMatchObject({ row: 40, landingStart: 41 });
  });

  test("REGRESSION：跳回後自動翻頁一路走回文末，內容不得重複", () => {
    const view = makeView();
    readToEnd(view);
    const before = texts(view);
    // 沒有 realign 的慢路徑：從落地處一頁一頁 PageDown（S' == E）
    for (let s = 41; s < LAST_START; s += CONTENT - 1) paint(view, s);
    paint(view, LAST_START);
    expect(texts(view)).toEqual(before); // 修前：尾巴多出重複段落
    expect(view._accEndRow).toBe(TOTAL);
  });

  test("跳回第一頁（:1）也是 seekBack，不得重建或倒退", () => {
    const view = makeView();
    readToEnd(view);
    const before = texts(view);
    paint(view, 1);
    expect(texts(view)).toEqual(before);
    expect(view._accEndRow).toBe(TOTAL);
    expect(view.buf.easyReadingSeekBack).toMatchObject({ row: 0 });
  });

  test("realign 落地（:<accEndRow>）＝ continuation：零新增列，旗標清掉", () => {
    const view = makeView();
    readToEnd(view);
    const before = texts(view);
    paint(view, 41);
    paint(view, TOTAL); // pmore 把 :111 夾到 maxdisps（末頁 89~111）
    expect(texts(view)).toEqual(before);
    expect(view.buf.easyReadingSeekBack).toBeNull();
  });

  test("文章還沒累積完時往回跳：realign 後照常接續累積到文末、無重複", () => {
    const view = makeView();
    paint(view, 1);
    paint(view, 23);
    paint(view, 45); // 已累積到 67
    paint(view, 10); // 往回跳
    expect(view._accEndRow).toBe(67);
    expect(view.buf.easyReadingSeekBack).toMatchObject({ row: 9 });
    paint(view, 67); // realign :67 落地
    paint(view, 89);
    const t = texts(view);
    expect(t).toHaveLength(TOTAL);
    expect(new Set(t).size).toBe(TOTAL);
  });

  test("落地畫面在長頁裡找不到（內容對不上）⇒ 不升旗標、不動累積", () => {
    const view = makeView();
    readToEnd(view);
    const before = texts(view);
    const alien = screen(41).map((t, i) => (i < CONTENT ? `other ${i}` : t));
    view.buf.lines = alien.map(cells);
    view.accumulatePageLines();
    expect(texts(view)).toEqual(before);
    expect(view._accEndRow).toBe(TOTAL);
    expect(view.buf.easyReadingSeekBack).toBeFalsy();
  });
});

// resume（離開 prompt 回到文章頁）時：PTT 被 goto／搜尋移走了 ⇒ 捲到跳轉目的地；
// 否則（推文、回應這類沒移動指標的）還原進 functionMode 前的捲動位置。
describe("functionMode resume 的捲動", () => {
  function makeER({ seek }) {
    const disp = { scrollTop: 0, offsetTop: 0, offsetParent: null };
    const rowEls = {};
    const mainContainer = {
      querySelector(sel) {
        const m = /srow="(\d+)"/.exec(sel);
        return m ? rowEls[m[1]] || null : null;
      },
    };
    // 第 40 列在內容座標 900px（行內圖片讓高度不均，不是 40*chh）
    rowEls["40"] = { offsetTop: 900, offsetParent: disp };
    const termBuf = {
      addEventListener() {},
      rows: ROWS,
      cols: 80,
      cur_y: ROWS - 1,
      cur_x: 79,
      pageState: 3,
      pageLines: new Array(TOTAL).fill([]),
      lineChangeds: new Array(ROWS).fill(false),
      getRowText: (r) => (r === ROWS - 1 ? statusText(41, 63) : ""),
      notify() {
        // 真實流程：這次 notify 的 accumulatePageLines 判 seekBack 並升旗標
        if (seek) this.easyReadingSeekBack = seek;
      },
    };
    const er = new EasyReading({}, { mainDisplay: disp, mainContainer, chh: 20 }, termBuf);
    er._functionMode = true;
    er._savedScrollTop = 1234;
    return { er, disp, termBuf };
  }

  test("goto／搜尋往回跳 ⇒ 捲到落地列（量 DOM 節點，不是 row*chh）", () => {
    const { er, disp } = makeER({ seek: { row: 40, landingStart: 41 } });
    er._evalFunctionModeExit();
    expect(er._functionMode).toBe(false);
    expect(disp.scrollTop).toBe(900);
  });

  test("指標沒動（推文／回應）⇒ 還原原本的捲動位置", () => {
    const { er, disp } = makeER({ seek: null });
    er._evalFunctionModeExit();
    expect(disp.scrollTop).toBe(1234);
  });

  test("落地列的節點不存在（被黑名單整列拿掉且附近都沒有）⇒ 退回原位置", () => {
    const { er, disp } = makeER({ seek: { row: 70, landingStart: 71 } });
    er._evalFunctionModeExit();
    expect(disp.scrollTop).toBe(1234);
  });

  test("同一筆 seek 只捲一次（之後推文 resume 不會又被拉回去）", () => {
    const seek = { row: 40, landingStart: 41 };
    const { er, disp, termBuf } = makeER({ seek });
    er._evalFunctionModeExit();
    expect(disp.scrollTop).toBe(900);
    disp.scrollTop = 3000; // 使用者捲走
    er._functionMode = true;
    er._savedScrollTop = 3000;
    termBuf.notify = () => {}; // 這次沒有新的 seekBack，舊旗標還在（realign 未落地）
    er._evalFunctionModeExit();
    expect(disp.scrollTop).toBe(3000);
  });
});
