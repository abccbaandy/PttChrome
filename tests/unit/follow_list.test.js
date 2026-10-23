// @unit-env browser
// 關注名單（P33，pref followList／followTitleList／enableFollowList）：只改顯示的「反向黑名單」。
//
// 鎖的症狀：
//   1. 判準跟黑名單同一套（list_row_filter#followHit）：作者 id 精確、標題關鍵字子字串。
//   2. 文章列表：關注的列帶 data-list-followed（格線列與手機卡片都帶）；**黑名單優先**（被擋的列
//      不會被標成關注），刪除列不標，名單空 ⇒ 一列都不帶。
//   3. 推文：關注的人的 id 格包 commentByFollow；優先序「我」＞原PO＞關注。
//   4. 開關接線：onPrefChange 把名單送到 view，enableFollowList 關掉時 enhance 拿到 null。
//   5. 右鍵「加入關注」跟「加入作者黑名單」同一個目標，已在名單 ⇒ 反灰。
import { followHit } from "../../src/js/list_row_filter";
import {
  annotateComment,
  FloorCounter,
  parseBlacklist,
  parseTitleBlacklist,
} from "../../src/js/comment_parse";
import { annotationsKey } from "../../src/js/screen_annotate_cache";
import { buildContextMenuEntries } from "../../src/components/ContextMenu/context_menu_entries";
import { setupI18n } from "../../src/js/i18n";
import { App } from "../../src/js/pttchrome";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg } from "./helpers/screen_fixtures";

beforeAll(() => setupI18n());
afterEach(unmountAll);

describe("followHit", () => {
  const row = (author, title) =>
    ` 350024 + 2 6/14 ${(author + "            ").slice(0, 12)}${title}`;

  test("作者 id 精確（不分大小寫）、標題關鍵字子字串；都沒中 ⇒ null", () => {
    const authors = parseBlacklist("GoodGuy\nfriend");
    const kw = parseTitleBlacklist("心得");
    expect(followHit(row("goodguy", "□ [問題] 隨便"), authors, [])).not.toBeNull();
    expect(followHit(row("goodguy2", "□ [問題] 隨便"), authors, [])).toBeNull();
    expect(followHit(row("other", "□ [心得] 好文"), new Set(), kw)).not.toBeNull();
    expect(followHit(row("other", "□ [問題] 隨便"), authors, kw)).toBeNull();
  });
});

describe("推文 id 上色（annotateComment）", () => {
  const ts = (s) => s + "                 06/06 16:11";
  const ctx = (over) => ({
    blacklist: new Set(),
    showFloorNumbers: false,
    floorCounter: new FloorCounter(),
    highlightAuthor: true,
    articleAuthor: "opuser",
    followAuthors: new Set(["friend"]),
    ...over,
  });

  test("關注的人 ⇒ id 範圍＋authorIdKind follow", () => {
    const a = annotateComment(ts("推 friend: 讚"), ctx());
    expect([a.authorIdStart, a.authorIdEnd, a.authorIdKind]).toEqual([3, 9, "follow"]);
    expect(annotateComment(ts("推 other: 讚"), ctx()).authorIdStart).toBeUndefined();
  });

  test("優先序：「我」＞原PO＞關注", () => {
    const followed = new Set(["friend", "opuser"]);
    const mine = annotateComment(ts("推 friend: 讚"), ctx({ followAuthors: followed, selfId: "friend" }));
    expect(mine.authorIdKind).toBe("self");
    const op = annotateComment(ts("→ opuser: 回"), ctx({ followAuthors: followed }));
    expect(op.authorIdStart).toBe(3);
    expect(op.authorIdKind).toBeUndefined(); // 原PO 的樣式
    // 原PO 高亮關掉 ⇒ 原PO 也在關注名單就標關注
    const opOff = annotateComment(ts("→ opuser: 回"), ctx({ followAuthors: followed, highlightAuthor: false }));
    expect(opOff.authorIdKind).toBe("follow");
  });

  test("黑名單優先：同時在黑名單 ⇒ 藏起來，不標關注", () => {
    const a = annotateComment(ts("推 friend: 讚"), ctx({ blacklist: new Set(["friend"]) }));
    expect(a.authorIdStart).toBeUndefined();
  });

  test("沒有名單（undefined）⇒ 跟以前一樣", () => {
    expect(annotateComment(ts("推 friend: 讚"), ctx({ followAuthors: undefined })).authorIdStart).toBeUndefined();
  });
});

describe("渲染接線", () => {
  const listLine = (type, author, title) =>
    row(seg(` 350024 ${type} 2 6/14 ${(author + "            ").slice(0, 12)}${title}`));
  const LIST = [
    row(seg("【板主:someone】     看板《Test》")),
    row(seg("[←]離開 [→]閱讀")),
    row(seg("   編號    日 期 作  者       文  章  標  題")),
    listLine("+", "friend", "□ [問題] 關注的作者"),
    listLine("+", "other", "□ [心得] 關注的關鍵字"),
    listLine("+", "other", "□ [問題] 普通"),
    listLine("+", "badguy", "□ [心得] 黑名單優先"),
    row(seg("   350030     6/14 -            □ (本文已被刪除) [friend]")),
    row(seg("  文章選讀  (y)回應(X)推文(^X)轉錄")),
  ];
  const listProps = (over) => ({
    lines: LIST,
    enableLinkInlinePreview: false,
    enableLinkHoverPreview: false,
    enhance: {
      pageState: 2,
      blacklist: new Set(["badguy"]),
      titleBlacklist: [],
      followAuthors: new Set(["friend", "badguy"]),
      followTitleKeywords: ["心得"],
      ...over,
    },
  });
  const followedRows = (m) =>
    [...m.container.querySelectorAll("[data-list-followed]")].map((n) => n.getAttribute("srow"));

  test("文章列表：作者／關鍵字命中的列帶 data-list-followed；黑名單、刪除列不帶", () => {
    expect(followedRows(mountScreen(listProps()))).toEqual(["3", "4"]);
  });

  test("名單空（或開關關掉 ⇒ term_view 給 null）⇒ 一列都不帶", () => {
    expect(followedRows(mountScreen(listProps({ followAuthors: null, followTitleKeywords: null })))).toEqual([]);
    expect(followedRows(mountScreen(listProps({ followAuthors: new Set(), followTitleKeywords: [] })))).toEqual([]);
  });

  test("手機卡片也帶", () => {
    const m = mountScreen(
      listProps({
        listEasyReading: true,
        easyReading: true,
        listCards: "article",
        listScroll: { bodyStart: 3, viewportPx: 320, scrollable: true },
      }),
    );
    const cards = [...m.container.querySelectorAll(".listCard[data-list-followed]")];
    expect(cards.length).toBe(2);
  });

  test("改名單 ⇒ 標註快取失效（進 annotationsKey）", () => {
    const key = (e) => annotationsKey({ enhance: e }).sig;
    expect(key({ followAuthors: new Set(["a"]) })).not.toBe(key({ followAuthors: new Set(["b"]) }));
    expect(key({ followTitleKeywords: ["a"] })).not.toBe(key({ followTitleKeywords: ["b"] }));
  });

  test("文章：關注的推文者 id 包 commentByFollow", () => {
    const m = mountScreen({
      lines: [
        row(seg(" 作者  opuser (原PO)                                     看板  Test")),
        row(seg(" 標題  [心得] 測試")),
        row(seg(" 時間  Sat Jun 14 10:00:00 2025")),
        row(seg("內文")),
        row(seg("推 friend: 讚                                         06/14 10:01")),
        row(seg("推 other: 嗯                                          06/14 10:02")),
      ],
      enableLinkInlinePreview: false,
      enableLinkHoverPreview: false,
      enhance: {
        pageState: 3,
        blacklist: new Set(),
        titleBlacklist: [],
        followAuthors: new Set(["friend"]),
        highlightAuthor: true,
        articleAuthor: "opuser",
      },
    });
    const marked = [...m.container.querySelectorAll(".commentByFollow")].map((n) => n.textContent);
    expect(marked).toEqual(["friend"]);
  });
});

describe("設定接線", () => {
  test("預設：開關開、名單空", () => {
    expect(DEFAULT_PREFS.enableFollowList).toBe(true);
    expect(DEFAULT_PREFS.followList).toBe("");
    expect(DEFAULT_PREFS.followTitleList).toBe("");
  });

  test("onPrefChange 把名單與開關送到 view，並重畫", () => {
    const app = Object.create(App.prototype);
    const redraws = [];
    app.view = { redraw: (f) => redraws.push(f) };
    app.onPrefChange("followList", "Friend\nbuddy");
    app.onPrefChange("followTitleList", "心得");
    app.onPrefChange("enableFollowList", false);
    expect([...app.view.followAuthors].sort()).toEqual(["buddy", "friend"]);
    expect(app.view.followTitleKeywords).toEqual(["心得"]);
    expect(app.view.enableFollowList).toBe(false);
    expect(redraws).toEqual([true, true, true]);
  });
});

describe("右鍵「加入關注」", () => {
  const BASE = { normalEnabled: true, authorBlacklistId: "friend", authorFollowEnabled: true, onMenuSelect: () => {} };
  const entry = (p) => buildContextMenuEntries(p).find((e) => e.key === "addAuthorFollow");

  test("有作者目標 ⇒ 有項目，點下去走 onMenuSelect('addAuthorFollow')", () => {
    const calls = [];
    const item = entry({ ...BASE, onMenuSelect: (k) => calls.push(k) });
    expect(item.label).toContain("friend");
    item.onClick({});
    expect(calls).toEqual(["addAuthorFollow"]);
  });

  test("已在名單 ⇒ 反灰；開關關、沒有作者目標 ⇒ 沒有", () => {
    expect(entry({ ...BASE, authorFollowExists: true }).disabled).toBe(true);
    expect(entry({ ...BASE, authorFollowEnabled: false })).toBeUndefined();
    expect(entry({ ...BASE, authorBlacklistId: null })).toBeUndefined();
  });
});
