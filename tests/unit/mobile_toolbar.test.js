// 手機底部工具列的「這個畫面能做什麼」決策表（src/js/mobile_toolbar.js）。
import {
  toolbarContextFromFacts,
  sameToolbarContext,
  EMPTY_TOOLBAR_CONTEXT,
  TOOLBAR_KEYS,
  THREAD_NAV_KEYS,
  toolbarSlots,
  TOOLBAR_SLOT_COUNT,
  hasHelpHint,
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
  // 手機上卡片／好讀文章／選單大按鈕會收起底列，原生的 (h)說明 點不到（使用者 2026-10-18）。
  test("操作說明（更多）：底列有 (h)說明／(h)按鍵說明 就給；prompt 開著、主功能表、說明選單本身不給", () => {
    const FAV = " 我的最愛  (a)增加看板 (d)刪除 (g)新增目錄 (M)移動位置 (v)已讀/未讀    (h)說明";
    const MENU = " 主選單   世界郵政日   10/9 週五 13:31 | someone | 線上24764人     (h)說明 ";
    const PMORE = "  瀏覽 第 1/2 頁 ( 45%)  目前顯示: 第 1~23 行  (h)按鍵說明 ←[q]離開 ";
    expect(toolbarContextFromFacts(frame({ 23: FAV }), 2).help).toBe(true);
    // 主功能表：sheet 再多一列就蓋住整個選單（mobile_sheet.offline「點遮罩」那條守的版面）
    expect(toolbarContextFromFacts(frame({ 0: "【主功能表】", 23: MENU }), 1).help).toBe(false);
    expect(hasHelpHint(MENU)).toBe(true);
    expect(toolbarContextFromFacts(frame({ 23: READ_ROW }), 3).help).toBe(true);
    expect(hasHelpHint(PMORE)).toBe(true);
    expect(toolbarContextFromFacts({ ...frame({ 23: FAV }), inputField: true }, 2).help).toBe(false);
    expect(
      hasHelpHint(" 操作說明  [第 1/2 頁] (PgUp)上頁 (PgDn)下頁 (Enter)執行 (h)小天使  (q/←)離開")
    ).toBe(false);
    expect(toolbarContextFromFacts(frame({ 23: "搜尋標題: " }), 3).help).toBe(false);
    expect(EMPTY_TOOLBAR_CONTEXT.help).toBe(false);
    expect(TOOLBAR_KEYS.help).toEqual({ key: "h" });
  });
  test("跳到第一篇未讀（更多）：只有文章列表；prompt 開著、文章、主功能表不給", () => {
    expect(toolbarContextFromFacts(frame(LIST), 2).unreadJump).toBe(true);
    expect(toolbarContextFromFacts({ ...frame(LIST), inputField: true }, 2).unreadJump).toBe(false);
    expect(toolbarContextFromFacts(frame({ 23: READ_ROW }), 3).unreadJump).toBe(false);
    expect(toolbarContextFromFacts(frame({ 0: "【主功能表】    批踢踢實業坊" }), 1).unreadJump).toBe(false);
    expect(EMPTY_TOOLBAR_CONTEXT.unreadJump).toBe(false);
  });
  test("設為全部已讀（更多）：只有文章列表；prompt 開著、文章、主功能表不給", () => {
    expect(toolbarContextFromFacts(frame(LIST), 2).markAllRead).toBe(true);
    expect(toolbarContextFromFacts({ ...frame(LIST), inputField: true }, 2).markAllRead).toBe(false);
    expect(toolbarContextFromFacts(frame({ 23: READ_ROW }), 3).markAllRead).toBe(false);
    expect(toolbarContextFromFacts(frame({ 0: "【主功能表】    批踢踢實業坊" }), 1).markAllRead).toBe(false);
    expect(EMPTY_TOOLBAR_CONTEXT.markAllRead).toBe(false);
  });
  test("全選／圖片上傳（更多）：主功能表不給，列表與文章給", () => {
    expect(toolbarContextFromFacts(frame({ 0: "【主功能表】    批踢踢實業坊" }), 1).contentTools).toBe(false);
    expect(toolbarContextFromFacts(frame(LIST), 2).contentTools).toBe(true);
    expect(toolbarContextFromFacts(frame({ 23: READ_ROW }), 3).contentTools).toBe(true);
    expect(EMPTY_TOOLBAR_CONTEXT.contentTools).toBe(false);
  });
  test("送鍵表：具名鍵都在 term_keyboard.KeyMap；其餘是單字元", () => {
    const all = [...Object.values(TOOLBAR_KEYS).map((k) => k.key), ...THREAD_NAV_KEYS.map((k) => k.key)];
    for (const k of all) expect(k.length === 1 || k in KeyMap).toBe(true);
    expect(TOOLBAR_KEYS.post).toEqual({ key: "p", mods: { altKey: true } });
  });
  test("重整：與 F5 同一個判準（screen_refresh）；沒連線不給", () => {
    const on = { connected: true, articleBoard: "Test" };
    expect(toolbarContextFromFacts(frame({ 23: READ_ROW }), 3, on).refresh).toBe(true);
    expect(toolbarContextFromFacts(frame(LIST), 2, on).refresh).toBe(true);
    expect(toolbarContextFromFacts(frame({ 23: READ_ROW }), 3, { articleBoard: "Test" }).refresh).toBe(false);
    expect(toolbarContextFromFacts(frame({ 23: MAIL_ROW }), 3, on).refresh).toBe(false);
    expect(toolbarContextFromFacts(frame({ 0: "【主功能表】    批踢踢實業坊" }), 1, on).refresh).toBe(false);
  });
  test("到底（End）：文章／信件／文章列表；主功能表與 prompt 不給", () => {
    expect(toolbarContextFromFacts(frame({ 23: READ_ROW }), 3).end).toBe(true);
    expect(toolbarContextFromFacts(frame({ 23: MAIL_ROW }), 3).end).toBe(true);
    expect(toolbarContextFromFacts(frame(LIST), 2).end).toBe(true);
    expect(toolbarContextFromFacts({ ...frame(LIST), inputField: true }, 2).end).toBe(false);
    expect(toolbarContextFromFacts(frame({ 0: "【主功能表】    批踢踢實業坊" }), 1).end).toBe(false);
    expect(TOOLBAR_KEYS.end).toEqual({ key: "End" });
  });
  test("toolbarSlots：固定 6 格，第 3～6 格永遠是重整／到底／按鍵／更多", () => {
    const tail = ["refresh", "end", "keys", "more"];
    expect(toolbarSlots(toolbarContextFromFacts(frame({ 23: READ_ROW }), 3))).toEqual(["push", "reply", ...tail]);
    expect(toolbarSlots(toolbarContextFromFacts(frame({ 23: MAIL_ROW }), 3))).toEqual([null, "reply", ...tail]);
    expect(toolbarSlots(toolbarContextFromFacts(frame(LIST), 2))).toEqual(["search", "post", ...tail]);
    expect(toolbarSlots(toolbarContextFromFacts(frame({ 0: "【主功能表】    批踢踢實業坊" }), 1))).toEqual([
      "search",
      null,
      ...tail,
    ]);
    expect(toolbarSlots(EMPTY_TOOLBAR_CONTEXT)).toEqual([null, null, ...tail]);
    expect(toolbarSlots(EMPTY_TOOLBAR_CONTEXT).length).toBe(TOOLBAR_SLOT_COUNT);
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
