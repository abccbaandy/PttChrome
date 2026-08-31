import { cursorOffsets } from "../../src/js/cursor_anchor";

// #cursor 的位置決策。核心不變量：**有真實列節點就以它為錨**，不要相信 cur_y*chh。
// 症狀端見 tests/e2e/offline/cursor_shape.offline.spec.js（推文反白帶）。
const BASE = { cur_x: 10, cur_y: 5, cols: 80, rows: 24, chw: 12, chh: 24 };

describe("cursorOffsets", () => {
  it("有列節點時垂直錨在它的 offsetTop，不是 cur_y*chh", () => {
    // 這一列被前面某列撐高了 7px（標註／字型／padding 都可能造成）
    const g = cursorOffsets({ ...BASE, row: { offsetTop: 5 * 24 + 7, offsetLeft: 0 } });
    expect(g.visible).toBe(true);
    expect(g.anchored).toBe(true);
    expect(g.top).toBe(127);
    expect(g.top).not.toBe(BASE.cur_y * BASE.chh);
  });

  it("水平以列節點左緣為基準加上欄位偏移", () => {
    const g = cursorOffsets({ ...BASE, row: { offsetTop: 120, offsetLeft: 4 } });
    expect(g.left).toBe(4 + 10 * 12);
  });

  it("量不到列節點就退回舊算術（不是變成 0）", () => {
    const g = cursorOffsets({ ...BASE, row: null });
    expect(g.visible).toBe(true);
    expect(g.anchored).toBe(false);
    expect(g.top).toBe(5 * 24);
    expect(g.left).toBe(10 * 12);
  });

  it("列節點的 offset 不是有限數也退回算術（防呆）", () => {
    const g = cursorOffsets({ ...BASE, row: { offsetTop: NaN, offsetLeft: 0 } });
    expect(g.anchored).toBe(false);
    expect(g.top).toBe(5 * 24);
  });

  // PTT 偶爾把 cur_x 送成 cols。舊版在這裡 early-return ⇒ 游標仍然可見卻停在
  // 上一次的座標；必須改成「藏起來」。
  it("cur_x 超界 → 不可見", () => {
    expect(cursorOffsets({ ...BASE, cur_x: 80, row: null }).visible).toBe(false);
  });

  it("cur_y 超界 → 不可見", () => {
    expect(cursorOffsets({ ...BASE, cur_y: 24, row: null }).visible).toBe(false);
  });

  it("負座標／格線尺寸缺失 → 不可見（不丟例外）", () => {
    expect(cursorOffsets({ ...BASE, cur_x: -1, row: null }).visible).toBe(false);
    expect(cursorOffsets({ ...BASE, cols: 0, row: null }).visible).toBe(false);
    expect(cursorOffsets({ ...BASE, rows: undefined, row: null }).visible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// paintedRowsAreBufRows：「這一幀畫出去的 srow 是不是 buf 的列號」。
//
// srow ＝ 傳給 <Screen> 的 lines index，而 term_view 的七條 render 分支餵的來源
// 不同：buf.lines（原生／文章好讀 functionMode 鏡像／防黑守門鏡像／列表好讀的
// windowLines==null fallback）的 srow 就是 buf 列號；列表好讀視窗（header 快取
// 3 列＋整段序列＋footer，全是 cloneRow 快照）與好讀累積長頁（buf.pageLines）
// 都不是——拿 buf.cur_y 去 querySelector 會撈到一列毫無關係的節點。
//
// 判準刻意是**逐列參考相等**而不是「宣告自己是哪種模式」：模式旗標
//（buf.listRenderMode / _functionMode）在重繪之前就被寫好，用它解讀上一幀留下來
// 的 DOM 一定有窗口期會說謊（list_session._enterFunctionMode 先設 'native' →
// showCursor() → 才 _forceRedraw()）。
// ---------------------------------------------------------------------------
import { paintedRowsAreBufRows } from "../../src/js/cursor_anchor";

const bufLines = (n = 24) => Array.from({ length: n }, (_, i) => ({ row: i }));

describe("paintedRowsAreBufRows", () => {
  it("原生／鏡像分支：畫的就是 buf.lines（slice 後元素同參考）→ true", () => {
    const buf = bufLines();
    expect(paintedRowsAreBufRows(buf.slice(), buf, 24)).toBe(true);
  });

  it("列表好讀視窗即使剛好 24 列也要 false（長度擋不住，靠逐列參考）", () => {
    const buf = bufLines();
    // 剛 seed 的視窗：header 3 列快取 + body 20 列 clone + footer，恰好 24 列，
    // 但每一列都是 cloneRow 快照，沒有一列是 buf.lines[i]。
    const clone = (r) => ({ ...r });
    const win = [
      clone(buf[0]), clone(buf[1]), clone(buf[2]),
      ...buf.slice(3, 23).map(clone),
      clone(buf[23]),
    ];
    expect(win.length).toBe(24); // 前提：長度檢查在此情境下無效
    expect(paintedRowsAreBufRows(win, buf, 24)).toBe(false);
  });

  it("只要有一列不是同一個物件就 false（不做內容比對）", () => {
    const buf = bufLines();
    const mixed = buf.slice();
    mixed[7] = { ...buf[7] }; // 內容相同、參考不同
    expect(paintedRowsAreBufRows(mixed, buf, 24)).toBe(false);
  });

  it("好讀累積長頁（buf.pageLines，列數不等於 rows）→ false", () => {
    const buf = bufLines();
    expect(paintedRowsAreBufRows(bufLines(300), buf, 24)).toBe(false);
    expect(paintedRowsAreBufRows(buf.slice(0, 20), buf, 24)).toBe(false);
  });

  it("缺參數／rows 無效 → false（fail-safe，退回 fallback 錨點）", () => {
    const buf = bufLines();
    expect(paintedRowsAreBufRows(null, buf, 24)).toBe(false);
    expect(paintedRowsAreBufRows(buf.slice(), null, 24)).toBe(false);
    expect(paintedRowsAreBufRows(buf.slice(), buf, 0)).toBe(false);
    expect(paintedRowsAreBufRows(buf.slice(), buf, undefined)).toBe(false);
  });
});
