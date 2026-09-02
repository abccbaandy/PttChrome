// 列表好讀模式的滑鼠 hover（TermView.onListMouseMove）。直接以 stub `this` 呼叫
// prototype method —— 這條邏輯不碰真 DOM 以外的東西。
//
// 守住 2026-08 滑鼠重新設計的三件事：
//  (1) 總開關關掉 ⇒ 連 hover 都不該有（改版前這條路徑完全不看 useMouseBrowsing）；
//  (2) 防誤觸開啟時 pointer 只給標題欄（col >= 30），關閉則整列都給；hover 列
//      （＝要上底色的列）兩種情況都認整列，底色的**寬度**另由 applyCursorHighlight
//      決定（與可點區同源，見 cursor_highlight.highlightColStart）；
//  (3) 左側退出帶（cols 0..EXIT_COL_END，2026-08 重新加回列表）：停在正文列的
//      左緣時亮提示帶＋back 指標，其餘一律關掉（不關的話從文章切回列表會留殘影）。
import { TermView } from "../../src/js/term_view";
import { LIST_HEADER_ROWS } from "../../src/js/list_window";
import { LIST_TITLE_COL_START } from "../../src/js/comment_parse";
import { EXIT_COL_END } from "../../src/js/mouse_regions";

const TITLE_COL = LIST_TITLE_COL_START + 5;
const AUTHOR_COL = LIST_TITLE_COL_START - 1;
const bodyRow = (idx) => LIST_HEADER_ROWS + idx;

function makeView({
  useMouseBrowsing = true,
  mouseLeftClick = true,
  mouseMisclickGuard = true,
  listRenderMode = "buffer",
  bodyLen = 10,
} = {}) {
  const affordance = [];
  const highlightCalls = [];
  const v = Object.create(TermView.prototype);
  v.mouseLeftClick = mouseLeftClick;
  v.mouseMisclickGuard = mouseMisclickGuard;
  v._listHoverRow = -1;
  v.buf = {
    useMouseBrowsing,
    listRenderMode,
    rows: 24,
    BBSWin: { style: { cursor: "auto" } },
  };
  // 分派一律走 App.activeListSession（buf.listRenderOwner 決定是文章列表還是
  // 看板列表的 session）——term_view 不再直接讀 bbscore.listSession。
  const listSession = {
    // idx >= seq.length ＝ 短板補到 bodyRows 的空白列，沒有文章可 hover
    getListView: () => ({
      seq: Array.from({ length: bodyLen }, (_, i) => 100 + i),
      cursorAbs: 100,
      cursorPos: 0,
    }),
  };
  v.bbscore = {
    listSession,
    activeListSession: () =>
      v.buf.listRenderMode === "buffer" || v.buf.listRenderMode === "frozen"
        ? listSession
        : null,
  };
  v.setExitAffordance = (on) => affordance.push(!!on);
  v.applyCursorHighlight = () => highlightCalls.push(v._listHoverRow);
  return { v, affordance, highlightCalls };
}

describe("onListMouseMove", () => {
  test("停在標題欄的文章列：pointer + 上底色", () => {
    const { v, highlightCalls } = makeView();
    v.onListMouseMove(bodyRow(2), TITLE_COL);
    expect(v.buf.BBSWin.style.cursor).toBe("pointer");
    expect(v._listHoverRow).toBe(bodyRow(2));
    expect(highlightCalls).toEqual([bodyRow(2)]);
  });

  test("防誤觸關閉：作者欄也給 pointer（整列可點）", () => {
    const { v, highlightCalls } = makeView({ mouseMisclickGuard: false });
    v.onListMouseMove(bodyRow(2), AUTHOR_COL);
    expect(v.buf.BBSWin.style.cursor).toBe("pointer");
    expect(v._listHoverRow).toBe(bodyRow(2));
    expect(highlightCalls).toEqual([bodyRow(2)]);
  });

  test("總開關關掉 ⇒ 防誤觸也不生效（但整列本來就沒有 hover）", () => {
    const { v } = makeView({ useMouseBrowsing: false });
    v.onListMouseMove(bodyRow(2), AUTHOR_COL);
    expect(v.buf.BBSWin.style.cursor).toBe("auto");
    expect(v._listHoverRow).toBe(-1);
  });

  test("停在作者欄：不給 pointer，但整列照樣上底色", () => {
    const { v, highlightCalls } = makeView();
    v.onListMouseMove(bodyRow(2), AUTHOR_COL);
    expect(v.buf.BBSWin.style.cursor).toBe("auto");
    expect(v._listHoverRow).toBe(bodyRow(2));
    expect(highlightCalls).toEqual([bodyRow(2)]);
  });

  test("左鍵功能關閉：底色仍在，只是不再提示可點", () => {
    const { v } = makeView({ mouseLeftClick: false });
    v.onListMouseMove(bodyRow(2), TITLE_COL);
    expect(v.buf.BBSWin.style.cursor).toBe("auto");
    expect(v._listHoverRow).toBe(bodyRow(2));
  });

  test("總開關關閉：連 hover 都沒有", () => {
    const { v, highlightCalls } = makeView({ useMouseBrowsing: false });
    v.onListMouseMove(bodyRow(2), TITLE_COL);
    expect(v.buf.BBSWin.style.cursor).toBe("auto");
    expect(v._listHoverRow).toBe(-1);
    expect(highlightCalls).toEqual([]);
  });

  test("frozen（開文交易進行中）：不接受互動", () => {
    const { v } = makeView({ listRenderMode: "frozen" });
    v.onListMouseMove(bodyRow(2), TITLE_COL);
    expect(v._listHoverRow).toBe(-1);
  });

  test("header / footer / 短頁補列：沒有 hover", () => {
    const { v } = makeView({ bodyLen: 3 });
    [
      [0, TITLE_COL],
      [2, TITLE_COL],
      [bodyRow(9), TITLE_COL], // 只有 3 篇，第 9 格是 filler
    ].forEach(([row, col]) => {
      v.onListMouseMove(row, col);
      expect(v._listHoverRow).toBe(-1);
    });
  });

  test("停在標題／作者欄時退出提示帶一律關掉", () => {
    const { v, affordance } = makeView();
    v.onListMouseMove(bodyRow(1), TITLE_COL);
    v.onListMouseMove(bodyRow(1), AUTHOR_COL);
    expect(affordance).toEqual([false, false]);
  });

  test("同一列內移動不重複觸發重繪", () => {
    const { v, highlightCalls } = makeView();
    v.onListMouseMove(bodyRow(1), TITLE_COL);
    v.onListMouseMove(bodyRow(1), TITLE_COL + 3);
    expect(highlightCalls).toEqual([bodyRow(1)]);
  });
});

describe("左側退出帶（2026-08 重新加回列表）", () => {
  test("停在正文列的左 7 欄：亮提示帶 ＋ back 指標", () => {
    for (let col = 0; col < EXIT_COL_END; ++col) {
      const { v, affordance } = makeView();
      v.onListMouseMove(bodyRow(2), col);
      expect(affordance).toEqual([true]);
      expect(v.buf.BBSWin.style.cursor).toContain("back");
    }
  });

  test("退出帶上不上底色（與文章一致）：從有底色的列移進去要收掉", () => {
    const { v, highlightCalls } = makeView();
    v.onListMouseMove(bodyRow(2), TITLE_COL);
    expect(v._listHoverRow).toBe(bodyRow(2));
    v.onListMouseMove(bodyRow(2), 0);
    expect(v._listHoverRow).toBe(-1);
    expect(highlightCalls).toEqual([bodyRow(2), -1]);
  });

  test("第 7 欄起不再是退出帶", () => {
    const { v, affordance } = makeView();
    v.onListMouseMove(bodyRow(2), EXIT_COL_END);
    expect(affordance).toEqual([false]);
  });

  test("**不看**防誤觸（固定手勢，不是欄位判定）", () => {
    const { v, affordance } = makeView({ mouseMisclickGuard: false });
    v.onListMouseMove(bodyRow(2), 0);
    expect(affordance).toEqual([true]);
  });

  test("header / footer / 短頁補列的左緣不是退出帶（那幾列有功能鍵按鈕）", () => {
    const { v, affordance } = makeView({ bodyLen: 3 });
    [0, 2, 23, bodyRow(9)].forEach((row) => v.onListMouseMove(row, 0));
    expect(affordance).toEqual([false, false, false, false]);
  });

  test("左鍵功能關閉：提示帶與 back 指標都不給", () => {
    const { v, affordance } = makeView({ mouseLeftClick: false });
    v.onListMouseMove(bodyRow(2), 0);
    expect(affordance).toEqual([false]);
    expect(v.buf.BBSWin.style.cursor).toBe("auto");
  });

  test("總開關關閉：連退出帶都沒有", () => {
    const { v, affordance } = makeView({ useMouseBrowsing: false });
    v.onListMouseMove(bodyRow(2), 0);
    expect(affordance).toEqual([false]);
    expect(v.buf.BBSWin.style.cursor).toBe("auto");
  });

  test("離開退出帶要關掉提示帶（不然留殘影）", () => {
    const { v, affordance } = makeView();
    v.onListMouseMove(bodyRow(2), 0);
    v.onListMouseMove(bodyRow(2), TITLE_COL);
    expect(affordance).toEqual([true, false]);
  });
});
