// 列表好讀模式的滑鼠 hover（TermView.onListMouseMove）。直接以 stub `this` 呼叫
// prototype method —— 這條邏輯不碰真 DOM 以外的東西。
//
// 守住 2026-08 滑鼠重新設計的三件事：
//  (1) 總開關關掉 ⇒ 連 hover 都不該有（改版前這條路徑完全不看 useMouseBrowsing）；
//  (2) pointer 只給標題欄（col >= 30），但**底色跟著整列走** —— 兩者條件刻意不同，
//      與原生一致，否則左半邊完全沒反應會像壞掉；
//  (3) 列表模式一律關掉文章的左側退出提示帶（不然從文章切回列表會留殘影）。
import { TermView } from "../../src/js/term_view";
import { LIST_HEADER_ROWS } from "../../src/js/list_window";
import { LIST_TITLE_COL_START } from "../../src/js/comment_parse";

const TITLE_COL = LIST_TITLE_COL_START + 5;
const AUTHOR_COL = LIST_TITLE_COL_START - 1;
const bodyRow = (idx) => LIST_HEADER_ROWS + idx;

function makeView({
  useMouseBrowsing = true,
  mouseLeftClick = true,
  listRenderMode = "buffer",
  bodyLen = 10,
} = {}) {
  const affordance = [];
  const highlightCalls = [];
  const v = Object.create(TermView.prototype);
  v.mouseLeftClick = mouseLeftClick;
  v._listHoverRow = -1;
  v.buf = {
    useMouseBrowsing,
    listRenderMode,
    rows: 24,
    BBSWin: { style: { cursor: "auto" } },
  };
  v.bbscore = {
    listSession: {
      // body[idx] == null ＝ 短頁的空白補列
      getWindowView: () => ({
        body: Array.from({ length: 20 }, (_, i) => (i < bodyLen ? 100 + i : null)),
      }),
    },
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

  test("每一次移動都關掉文章的左側退出提示帶", () => {
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
