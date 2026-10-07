// 手機底部工具列的「這個畫面能做什麼」決策表（src/js/mobile_toolbar.js）。
import {
  toolbarContextFromFacts,
  sameToolbarContext,
  EMPTY_TOOLBAR_CONTEXT,
} from "../../src/js/mobile_toolbar";

const ROWS = 24;
const frame = (rows) => {
  const rowTexts = Array.from({ length: ROWS }, () => "");
  Object.entries(rows).forEach(([i, t]) => (rowTexts[i] = t));
  return { rowTexts, rows: ROWS, curX: 0, curY: 5, inputField: false, listOwner: null };
};

const READ_ROW =
  "  瀏覽 第 1/2 頁 ( 45%)  目前顯示: 第 1~23 行  (y)回應(X%)推文(h)說明(←)離開 ";
const MAIL_ROW =
  "  瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~18 行  (y)回信 (h)說明 (←/q)離開 ";
const LIST = { 0: " 【板主:none】看板《Test》", 23: " 文章選讀  (y)回應(X)推文(^X)轉錄 " };

describe("toolbarContextFromFacts", () => {
  test("文章（pager 狀態列）⇒ 推，沒有搜尋", () => {
    expect(toolbarContextFromFacts(frame({ 23: READ_ROW }), 3)).toEqual({ push: true, search: [] });
  });
  test("站內信 pager ⇒ 不給推（信件的 X 是別的鍵）", () => {
    expect(toolbarContextFromFacts(frame({ 23: MAIL_ROW }), 3).push).toBe(false);
  });
  test("prompt 幀沿用舊 pageState 3 ⇒ 不給推", () => {
    expect(toolbarContextFromFacts(frame({ 23: "搜尋標題: " }), 3).push).toBe(false);
  });
  test("文章列表 ⇒ 四種搜尋，沒有推", () => {
    expect(toolbarContextFromFacts(frame(LIST), 2)).toEqual({
      push: false,
      search: ["title", "author", "push", "board"],
    });
  });
  test("主功能表 ⇒ 只有看板搜尋", () => {
    expect(toolbarContextFromFacts(frame({ 0: "【主功能表】    批踢踢實業坊" }), 1).search).toEqual([
      "board",
    ]);
  });
  test("沒有 buf ⇒ 空", () => {
    expect(toolbarContextFromFacts(null, 3)).toBe(EMPTY_TOOLBAR_CONTEXT);
  });
});

test("sameToolbarContext：內容相同就相同（不必每次 settle 重 render）", () => {
  expect(sameToolbarContext({ push: true, search: ["a"] }, { push: true, search: ["a"] })).toBe(true);
  expect(sameToolbarContext({ push: true, search: [] }, { push: false, search: [] })).toBe(false);
  expect(sameToolbarContext({ push: false, search: ["a"] }, { push: false, search: ["a", "b"] })).toBe(false);
});
