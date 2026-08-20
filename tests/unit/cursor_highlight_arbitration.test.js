// 游標底色的「誰最後動誰贏」仲裁（TermView.applyCursorHighlight）。
// 直接以 stub `this` 呼叫 prototype method，比照 list_hover_gating.test.js。
//
// 守住 2026-08 的 bug：滑鼠底色開啟時，鍵盤游標移動底色不跟著動。
// 滑鼠列是黏著狀態（列表好讀的 _listHoverRow 根本沒有任何一處會在鍵盤操作時清掉），
// 舊規則又是「滑鼠恆勝」⇒ 底色永遠釘在最後 hover 的那一列。
//
// 鍵盤沒有事件可掛（游標是 server 畫的），故以「游標列變了」推導；模式切換時兩套
// 列號意義不同，不算移動。
import { TermView } from "../../src/js/term_view";
import { LIST_HEADER_ROWS } from "../../src/js/list_window";
import { LIST_TITLE_COL_START } from "../../src/js/comment_parse";

function makeView({ listRenderMode = "native" } = {}) {
  const applied = [];
  const v = Object.create(TermView.prototype);
  v.highlightBG = 2;
  v.keyboardCursorHighlight = true;
  v.useEasyReadingMode = false;
  v.mouseLeftClick = true;
  v.mouseMisclickGuard = true;
  // 建構子預設（term_view.js）
  v._highlightMover = "mouse";
  v._highlightMode = null;
  v._lastCursorRow = -1;
  v._listCursorRow = 8;
  v._listHoverRow = -1;
  v.buf = {
    listRenderMode,
    pageState: 2,
    cur_y: 5,
    rows: 24,
    useMouseBrowsing: true,
    highlightCursor: true,
    nowHighlight: -1,
    BBSWin: { style: { cursor: "auto" } },
  };
  v.componentScreen = { setCursorHighlight: (h) => applied.push(h.row) };
  return { v, applied };
}

describe("applyCursorHighlight：原生畫面", () => {
  test("滑鼠停過某列後，鍵盤游標移動 ⇒ 底色跟著鍵盤走", () => {
    const { v, applied } = makeView();
    v.buf.nowHighlight = 11;
    v.applyCursorHighlight("mouse");
    expect(applied).toEqual([11]);

    // 使用者按了方向鍵：server 重畫，hover 列還黏在 11
    v.buf.cur_y = 6;
    v.applyCursorHighlight();
    expect(applied[applied.length - 1]).toBe(6);
  });

  test("鍵盤搶走之後，滑鼠再動 ⇒ 底色跳回滑鼠列", () => {
    const { v, applied } = makeView();
    v.buf.nowHighlight = 11;
    v.applyCursorHighlight("mouse");
    v.buf.cur_y = 6;
    v.applyCursorHighlight();
    v.applyCursorHighlight("mouse");
    expect(applied[applied.length - 1]).toBe(11);
  });

  test("游標列沒變的幀不算鍵盤移動：hover 底色留在原地", () => {
    const { v, applied } = makeView();
    v.buf.nowHighlight = 11;
    v.applyCursorHighlight("mouse");
    v.applyCursorHighlight();
    v.applyCursorHighlight();
    expect(applied).toEqual([11, 11, 11]);
  });

  test("底色顏色仍取自 highlightBG（不可回頭寫死 b2）", () => {
    const { v } = makeView();
    const seen = [];
    v.componentScreen = { setCursorHighlight: (h) => seen.push(h) };
    v.highlightBG = 7;
    v.buf.nowHighlight = 11;
    v.applyCursorHighlight("mouse");
    expect(seen[0]).toEqual({
      row: 11,
      cls: "b7",
      col: LIST_TITLE_COL_START,
    });
  });

  // 底色範圍＝可點區範圍（使用者 2026-08 定案），且**不分來源** —— 鍵盤游標與滑鼠
  // hover 共用同一個寬度，兩種光棒不一樣長只會讓人以為畫面壞了。
  test("底色起始欄跟著防誤觸走，鍵盤來源也是同一個寬度", () => {
    const { v } = makeView();
    const seen = [];
    v.componentScreen = { setCursorHighlight: (h) => seen.push(h) };

    v.buf.nowHighlight = 11;
    v.applyCursorHighlight("mouse");
    expect(seen[seen.length - 1].col).toBe(LIST_TITLE_COL_START);

    // 鍵盤搶走底色：列變了，寬度不變。
    v.buf.cur_y = 6;
    v.applyCursorHighlight();
    expect(seen[seen.length - 1]).toEqual({
      row: 6,
      cls: "b2",
      col: LIST_TITLE_COL_START,
    });

    v.mouseMisclickGuard = false;
    v.applyCursorHighlight("mouse");
    expect(seen[seen.length - 1].col).toBe(0);
  });

  test("總開關關掉就沒有誤觸要防：底色回到整列", () => {
    const { v } = makeView();
    const seen = [];
    v.componentScreen = { setCursorHighlight: (h) => seen.push(h) };
    v.buf.useMouseBrowsing = false;
    v.buf.cur_y = 6;
    v.applyCursorHighlight();
    expect(seen[seen.length - 1].col).toBe(0);
  });
});

describe("applyCursorHighlight：列表好讀模式", () => {
  test("hover 黏著、虛擬游標列移動 ⇒ 底色跟著鍵盤走（本次 bug 的主要症狀）", () => {
    const { v, applied } = makeView({ listRenderMode: "buffer" });
    v._listHoverRow = 15;
    v.applyCursorHighlight("mouse");
    expect(applied).toEqual([15]);

    v._listCursorRow = 9;
    v.applyCursorHighlight();
    expect(applied[applied.length - 1]).toBe(9);

    v.applyCursorHighlight("mouse");
    expect(applied[applied.length - 1]).toBe(15);
  });

  test("模式切換造成的列號變動不算鍵盤移動", () => {
    const { v, applied } = makeView();
    v.buf.nowHighlight = 11;
    v.applyCursorHighlight("mouse");
    expect(applied).toEqual([11]);

    // 原生 cur_y=5 → 列表好讀虛擬游標列 8：兩套列號，不該被當成使用者移動游標
    v.buf.listRenderMode = "buffer";
    v._listHoverRow = 15;
    v.applyCursorHighlight();
    expect(applied[applied.length - 1]).toBe(15);
  });
});

describe("onListMouseMove 與仲裁的銜接", () => {
  function listView() {
    const { v } = makeView({ listRenderMode: "buffer" });
    const calls = [];
    v.bbscore = {
      listSession: {
        getWindowView: () => ({
          body: Array.from({ length: 20 }, (_, i) => 100 + i),
        }),
      },
    };
    v.setExitAffordance = () => {};
    v.applyCursorHighlight = (src) => calls.push(src);
    return { v, calls };
  }

  test("鍵盤正持有底色時，滑鼠在同一列內移動也要重新套用（不可早退）", () => {
    const { v, calls } = listView();
    v._listHoverRow = LIST_HEADER_ROWS + 2;
    v._highlightMover = "keyboard";
    v.onListMouseMove(LIST_HEADER_ROWS + 2, LIST_TITLE_COL_START + 5);
    expect(calls).toEqual(["mouse"]);
    expect(v._highlightMover).toBe("mouse");
  });

  test("滑鼠本來就持有底色時，同一列內移動仍不重複套用", () => {
    const { v, calls } = listView();
    v._listHoverRow = LIST_HEADER_ROWS + 2;
    v._highlightMover = "mouse";
    v.onListMouseMove(LIST_HEADER_ROWS + 2, LIST_TITLE_COL_START + 5);
    expect(calls).toEqual([]);
  });
});
