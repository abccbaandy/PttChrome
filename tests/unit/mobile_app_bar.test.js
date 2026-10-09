// 手機頂部 App Bar 的標題決策（src/js/mobile_app_bar.js）。docs/mobile.md「App Bar」。
import { appBarFromFacts, sameAppBar, EMPTY_APP_BAR, NEW_MAIL_MARK } from "../../src/js/mobile_app_bar";
import { parseHeaderTitle } from "../../src/js/screen_titles";
import { OWNER_ARTICLE_LIST } from "../../src/js/list_render_owner";
import { boardListContextKind } from "../../src/js/board_list_parse";

const ROWS = 24;
const frame = (rows, extra) => {
  const rowTexts = Array.from({ length: ROWS }, () => "");
  Object.entries(rows).forEach(([i, t]) => (rowTexts[i] = t));
  return { rowTexts, rows: ROWS, curX: 0, curY: 5, inputField: false, listOwner: null, ...extra };
};

const LIST_ROW0 = "【板主:someone】      閒聊 天南地北          看板《Test》";
const LIST_FOOT = " 文章選讀  (y)回應(X)推文(^X)轉錄 ";
const MENU_ROW0 = "【主功能表】               批踢踢實業坊               看板《SYSOP》";
const READ_ROW = "  瀏覽 第 1/2 頁 ( 45%)  目前顯示: 第 1~23 行  (y)回應(X%)推文(h)說明(←)離開 ";

describe("parseHeaderTitle", () => {
  test("col 0 的【X】取 X（去空白）", () => {
    expect(parseHeaderTitle(MENU_ROW0)).toBe("主功能表");
    expect(parseHeaderTitle("【 個人設定 】  批踢踢")).toBe("個人設定");
  });
  test("不在 col 0、沒有【】、空【】 ⇒ null（內文到處都有【】）", () => {
    expect(parseHeaderTitle(" 【主功能表】")).toBeNull();
    expect(parseHeaderTitle("主功能表")).toBeNull();
    expect(parseHeaderTitle("【】")).toBeNull();
    expect(parseHeaderTitle("")).toBeNull();
  });
});

describe("appBarFromFacts", () => {
  test("文章（pageState 3）：標題＝檔頭標題，副標＝看板", () => {
    expect(
      appBarFromFacts(frame({ 23: READ_ROW }), { pageState: 3, articleTitle: "[問卦] 有沒有", articleBoard: "Gossiping" })
    ).toEqual({ kind: "article", title: "[問卦] 有沒有", subtitle: "Gossiping", newMail: false });
  });

  test("文章列表：標題＝看板名（【板主:x】必須先被當成列表，不是選單）", () => {
    expect(appBarFromFacts(frame({ 0: LIST_ROW0, 23: LIST_FOOT }), { pageState: 2 })).toEqual({
      kind: "list", title: "Test", subtitle: "", newMail: false,
    });
  });

  test("列表好讀 session 持有時同樣是列表", () => {
    const f = frame({ 0: LIST_ROW0 }, { listOwner: OWNER_ARTICLE_LIST });
    expect(appBarFromFacts(f, { pageState: 2 })).toMatchObject({ kind: "list", title: "Test" });
  });

  test("主功能表與子選單：row 0 的【X】", () => {
    expect(appBarFromFacts(frame({ 0: MENU_ROW0 }), { pageState: 1 })).toMatchObject({ kind: "menu", title: "主功能表" });
    expect(appBarFromFacts(frame({ 0: "【個人設定】        批踢踢實業坊" }), { pageState: 1 })).toMatchObject({
      kind: "menu", title: "個人設定",
    });
  });

  test("看板列表：kind boards，標題＝row 0 的【X】", () => {
    // 形狀同 tests/unit/board_list_parse.test.js 的 brdScreen（board.c:1462 的列）。
    const rows = {
      0: "【看板列表】 批踢踢實業坊",
      1: "[←][q]回上層 [→][r]閱讀 [↑↓]選擇 [PgUp][PgDn]翻頁 [c]新文章 [/]搜尋 [h]求助",
      2: "   編號   看  板       類別   中   文   敘   述               人氣 板   主",
      23: "  選擇看板    (a)增加看板 (s)進入已知板名 (y)列出全部 (v/V)已讀/未讀",
    };
    for (let i = 0; i < 20; ++i)
      rows[3 + i] = String(i + 1).padStart(7, " ") + "  " + ("Board" + (i + 1)).padEnd(13, " ") + "綜合  ｜閒聊｜ 測試看板";
    const f = { ...frame(rows), curY: 3 };
    expect(boardListContextKind(f)).toMatch(/^brdlist/);
    expect(appBarFromFacts(f, { pageState: 1 })).toMatchObject({ kind: "boards", title: "看板列表" });
  });

  test("認不出的畫面（prompt／編輯器／過渡幀）沿用上一個，不閃爍", () => {
    const prev = { kind: "list", title: "Test", subtitle: "", newMail: false };
    expect(appBarFromFacts(frame({ 0: "請輸入看板名稱：" }), { pageState: 2, prev })).toBe(prev);
    expect(appBarFromFacts(frame({}), {})).toBe(EMPTY_APP_BAR);
    expect(appBarFromFacts(null, { prev })).toBe(prev);
  });

  test("新信件提示（menu.c#redraw_title 的中段）", () => {
    const row0 = "【主功能表】       " + NEW_MAIL_MARK + "        看板《SYSOP》";
    expect(appBarFromFacts(frame({ 0: row0 }), { pageState: 1 }).newMail).toBe(true);
  });
});

test("sameAppBar 比全部欄位", () => {
  const a = { kind: "menu", title: "主功能表", subtitle: "", newMail: false };
  expect(sameAppBar(a, { ...a })).toBe(true);
  expect(sameAppBar(a, { ...a, newMail: true })).toBe(false);
  expect(sameAppBar(a, { ...a, title: "個人設定" })).toBe(false);
});
