// 手機底部工具列的「這個畫面能做什麼」決策表（src/js/mobile_toolbar.js）。
import {
  toolbarContextFromFacts,
  sameToolbarContext,
  EMPTY_TOOLBAR_CONTEXT,
  TOOLBAR_KEYS,
  THREAD_NAV_KEYS,
} from "../../src/js/mobile_toolbar";
import { KeyMap } from "../../src/js/term_keyboard";

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
    expect(toolbarContextFromFacts(frame({ 23: READ_ROW }), 3)).toMatchObject({ push: true, search: [] });
  });
  test("站內信 pager ⇒ 不給推（信件的 X 是別的鍵）", () => {
    expect(toolbarContextFromFacts(frame({ 23: MAIL_ROW }), 3).push).toBe(false);
  });
  test("prompt 幀沿用舊 pageState 3 ⇒ 不給推", () => {
    expect(toolbarContextFromFacts(frame({ 23: "搜尋標題: " }), 3).push).toBe(false);
  });
  test("文章列表 ⇒ 四種搜尋，沒有推", () => {
    expect(toolbarContextFromFacts(frame(LIST), 2)).toMatchObject({
      push: false,
      search: ["title", "author", "push", "board"],
    });
  });
  test("同一次計算帶出 App Bar 標題（mobile_app_bar.js）", () => {
    expect(toolbarContextFromFacts(frame(LIST), 2).appBar).toMatchObject({ kind: "list", title: "Test" });
    expect(
      toolbarContextFromFacts(frame({ 23: READ_ROW }), 3, { articleTitle: "[問卦] 測試", articleBoard: "Gossiping" })
        .appBar
    ).toMatchObject({ kind: "article", title: "[問卦] 測試", subtitle: "Gossiping" });
  });
  test("主功能表 ⇒ 只有看板搜尋", () => {
    expect(toolbarContextFromFacts(frame({ 0: "【主功能表】    批踢踢實業坊" }), 1).search).toEqual([
      "board",
    ]);
  });
  test("文章：回文／分享／文章導覽；信件：只有回文（label 回信）", () => {
    expect(toolbarContextFromFacts(frame({ 23: READ_ROW }), 3)).toMatchObject({
      push: true, reply: true, mail: false, share: true, threadNav: true, post: false,
    });
    expect(toolbarContextFromFacts(frame({ 23: MAIL_ROW }), 3)).toMatchObject({
      push: false, reply: true, mail: true, share: false, threadNav: false, post: false,
    });
  });
  test("prompt 幀（沿用 pageState 3）⇒ 文章動作全收", () => {
    expect(toolbarContextFromFacts(frame({ 23: "搜尋標題: " }), 3)).toMatchObject({
      push: false, reply: false, share: false, threadNav: false,
    });
  });
  test("文章列表 ⇒ 發文；游標在輸入欄（prompt 開著）時不給", () => {
    expect(toolbarContextFromFacts(frame(LIST), 2).post).toBe(true);
    expect(toolbarContextFromFacts({ ...frame(LIST), inputField: true }, 2).post).toBe(false);
    expect(toolbarContextFromFacts(frame({ 0: "【主功能表】    批踢踢實業坊" }), 1).post).toBe(false);
  });
  test("送鍵表：具名鍵都在 term_keyboard.KeyMap；其餘是單字元", () => {
    const all = [...Object.values(TOOLBAR_KEYS).map((k) => k.key), ...THREAD_NAV_KEYS.map((k) => k.key)];
    for (const k of all) expect(k.length === 1 || k in KeyMap).toBe(true);
    expect(TOOLBAR_KEYS.post).toEqual({ key: "p", mods: { altKey: true } });
  });
  test("沒有 buf ⇒ 空", () => {
    expect(toolbarContextFromFacts(null, 3)).toBe(EMPTY_TOOLBAR_CONTEXT);
  });
});

test("sameToolbarContext：內容相同就相同（不必每次 settle 重 render）", () => {
  expect(sameToolbarContext({ push: true, search: ["a"] }, { push: true, search: ["a"] })).toBe(true);
  expect(sameToolbarContext({ push: true, search: [] }, { push: false, search: [] })).toBe(false);
  expect(sameToolbarContext({ push: false, search: ["a"] }, { push: false, search: ["a", "b"] })).toBe(false);
  const bar = (title) => ({ kind: "list", title, subtitle: "", newMail: false });
  expect(
    sameToolbarContext({ push: false, search: [], appBar: bar("A") }, { push: false, search: [], appBar: bar("A") })
  ).toBe(true);
  // 只有標題變（換看板）也要通知，否則 App Bar 停在上一個看板。
  expect(
    sameToolbarContext({ push: false, search: [], appBar: bar("A") }, { push: false, search: [], appBar: bar("B") })
  ).toBe(false);
});
