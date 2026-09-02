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

// 樣式層預設（cursorRowBrighten）是「提亮」，但這一檔驗的是**仲裁**（哪一列贏），
// 與樣式無關 ⇒ 預設用底色樣式建 stub，好讓斷言直接比對既有的 bN 字串。
// 樣式層本身的行為另外一個 describe 驗。
function makeView({ listRenderMode = "native", styles } = {}) {
  const applied = [];
  const v = Object.create(TermView.prototype);
  v.highlightBG = 2;
  v.cursorRowBrighten = false;
  v.cursorRowBackground = true;
  Object.assign(v, styles || {});
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
    // 真 TermBuf 的輸入框偵測（見 term_buf.isCursorOnInputField）。預設關，
    // 想模擬「PTT 開著輸入框」的幀就改成回 true。
    isCursorOnInputField: () => false,
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
    const listSession = {
      getListView: () => ({
        seq: Array.from({ length: 20 }, (_, i) => 100 + i),
        cursorAbs: 100,
        cursorPos: 0,
      }),
    };
    v.bbscore = { listSession, activeListSession: () => listSession };
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

// 2026-08 回歸：看板列表按 s 叫出「搜尋全站看板」時 prompt 那一列被上底色。
// pageState 黏在 2（prompt 只重畫 row 0/1），而 vgetstring 把游標移進反白輸入欄
// ⇒ 鍵盤來源判定成立。view 這一層負責把事實餵給決策層，這裡守的是那條接線。
describe("applyCursorHighlight：PTT 開著輸入框", () => {
  test("原生畫面：鍵盤與滑鼠來源都不上色", () => {
    const { v, applied } = makeView();
    v.buf.isCursorOnInputField = () => true;
    v.buf.cur_y = 1; // vgetstring 把游標移進 row 1 的輸入欄
    v.applyCursorHighlight();
    expect(applied[applied.length - 1]).toBe(-1);

    v.buf.nowHighlight = 11;
    v.applyCursorHighlight("mouse");
    expect(applied[applied.length - 1]).toBe(-1);
  });

  test("輸入框關掉後底色照舊回來", () => {
    const { v, applied } = makeView();
    v.buf.isCursorOnInputField = () => true;
    v.applyCursorHighlight();
    expect(applied[applied.length - 1]).toBe(-1);

    v.buf.isCursorOnInputField = () => false;
    v.applyCursorHighlight();
    expect(applied[applied.length - 1]).toBe(5);
  });

  test("列表好讀：server 真游標停在反白格也不影響虛擬視窗的光棒", () => {
    const { v, applied } = makeView({ listRenderMode: "buffer" });
    v.buf.isCursorOnInputField = () => true;
    v.applyCursorHighlight();
    expect(applied[applied.length - 1]).toBe(8);
  });
});

// 樣式層（pref cursorRowBrighten / cursorRowBackground）：與「哪一列」正交，
// 兩種可疊、可全關。全關時**整條跳過**（送 NO_CURSOR_HIGHLIGHT），不是送一個
// 沒有樣式的 class —— 否則 Screen 會為了一個看不見的變化重畫。
describe("applyCursorHighlight：樣式層", () => {
  const seenOf = (v) => {
    const seen = [];
    v.componentScreen = { setCursorHighlight: (h) => seen.push(h) };
    return seen;
  };

  test("預設（提亮開、底色關）：cls 只有 cursorBrighten，沒有背景 class", () => {
    const { v } = makeView({
      styles: { cursorRowBrighten: true, cursorRowBackground: false },
    });
    const seen = seenOf(v);
    v.buf.nowHighlight = 11;
    v.applyCursorHighlight("mouse");
    expect(seen[seen.length - 1]).toEqual({
      row: 11,
      cls: "cursorBrighten",
      col: LIST_TITLE_COL_START,
    });
  });

  test("兩種樣式同時開 ⇒ 疊在同一列，顏色仍取自 highlightBG", () => {
    const { v } = makeView({
      styles: { cursorRowBrighten: true, cursorRowBackground: true },
    });
    v.highlightBG = 7;
    const seen = seenOf(v);
    v.buf.nowHighlight = 11;
    v.applyCursorHighlight("mouse");
    expect(seen[seen.length - 1].cls).toBe("cursorBrighten b7");
  });

  test("兩種樣式都關 ⇒ 整條跳過（row -1），即使那一列本來要上色", () => {
    const { v } = makeView({
      styles: { cursorRowBrighten: false, cursorRowBackground: false },
    });
    const seen = seenOf(v);
    v.buf.nowHighlight = 11;
    v.applyCursorHighlight("mouse");
    expect(seen[seen.length - 1].row).toBe(-1);
  });
});
