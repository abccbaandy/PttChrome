// @unit-env browser
// real-input: tests/e2e/offline/comment_filter.offline.spec.js
// 推文篩選（P29，docs/comment-filter.md）：好讀文章「只看這個人／只看原 PO」。
//
// 鎖的症狀：
//   1. 不是那個人的推文跟黑名單同一套藏起來（hidden＋filtered），樓號照數（不重編）。
//   2. 連續被篩掉的推文收成一條「略過 N 則」（N ＝被篩掉的則數，不含續行與黑名單）。
//   3. 只在好讀生效；篩選進 annotationsKey；沒設篩選時畫面跟以前一樣（沒有細線）。
//   4. view：換文章就清掉；離開文章時不生效；setCommentFilter 把點的那一列放回原位。
//   5. 右鍵選單：沒篩選時「只看這個人」＋「只看原 PO」，生效中只給「顯示全部推文」。
import {
  annotateComment,
  FloorCounter,
} from "../../src/js/comment_parse";
import {
  applyCommentFilterSkips,
  computeAnnotations,
} from "../../src/js/screen_annotations";
import { annotationsKey } from "../../src/js/screen_annotate_cache";
import { buildContextMenuEntries } from "../../src/components/ContextMenu/context_menu_entries";
import { TermView } from "../../src/js/term_view";
import { setupI18n, i18n } from "../../src/js/i18n";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg } from "./helpers/screen_fixtures";

beforeAll(() => setupI18n());
afterEach(unmountAll);

const ts = (s) => s + "                 06/06 16:11";

describe("annotateComment", () => {
  const ctx = (over) => ({
    blacklist: new Set(["badguy"]),
    showFloorNumbers: true,
    floorCounter: new FloorCounter(),
    highlightAuthor: true,
    articleAuthor: "opuser",
    commentFilter: "friend",
    ...over,
  });

  test("別人的推文 hidden＋filtered；那個人的照常；樓號照數", () => {
    const c = ctx();
    const a = annotateComment(ts("推 other: 1"), c);
    const b = annotateComment(ts("推 friend: 2"), c);
    const d = annotateComment(ts("推 badguy: 3"), c);
    expect([a.hidden, a.filtered]).toEqual([true, true]);
    expect([b.hidden, b.filtered]).toEqual([false, undefined]);
    expect(b.floor.seq).toBe(a.floor.seq + 1);
    // 黑名單照黑名單（不算進「略過」）
    expect([d.hidden, d.filtered]).toEqual([true, undefined]);
  });

  test("沒有篩選 ⇒ 跟以前一樣", () => {
    const a = annotateComment(ts("推 other: 1"), ctx({ commentFilter: null }));
    expect([a.hidden, a.filtered]).toEqual([false, undefined]);
  });
});

describe("applyCommentFilterSkips", () => {
  test("每一串連續被藏的列，第一列標 filterSkip＝被篩掉的則數", () => {
    const h = (o) => ({ hidden: true, pusher: "x", userid: "x", ...o });
    const result = [
      null, // 內文
      h({ filtered: true }),
      { hidden: true, modernBody: true, filtered: true }, // 續行不算則數
      h({ filtered: true }),
      { pusher: "friend", userid: "friend", hidden: false },
      h({}), // 只有黑名單 ⇒ 不收
      { pusher: "friend", userid: "friend", hidden: false },
      h({}),
      h({ filtered: true }),
    ];
    applyCommentFilterSkips(result);
    expect(result.map((a) => (a && a.filterSkip) || 0)).toEqual([0, 2, 0, 0, 0, 0, 0, 1, 0]);
  });

  test("P38 展開：key＝那串第一列的文字；被篩掉的列看得到（filterShown），黑名單照藏；再跑一次不換物件", () => {
    const h = (o) => ({ hidden: true, pusher: "x", userid: "x", ...o });
    const texts = ["內文", "推 a1", "推 bad", "推 a2", "推 friend", "推 a3"];
    const result = [
      null,
      h({ filtered: true }),
      h({}), // 黑名單
      h({ filtered: true }),
      { pusher: "friend", userid: "friend", hidden: false },
      h({ filtered: true }),
    ];
    applyCommentFilterSkips(result, ["推 a1"], texts);
    expect(result[1]).toMatchObject({ filterExpanded: 2, filterSkipKey: "推 a1", hidden: false, filterShown: true });
    expect(result[1].filterSkip).toBeUndefined();
    expect(result[2].hidden).toBe(true);
    expect(result[3]).toMatchObject({ hidden: false, filterShown: true });
    // 沒展開的那串照舊收成細線
    expect(result[5]).toMatchObject({ filterSkip: 1, filterSkipKey: "推 a3", hidden: true });
    // 前沿快路徑：下一幀拿到的前綴已經展開過，同一串、同一批物件
    const before = result.slice();
    applyCommentFilterSkips(result, ["推 a1"], texts);
    expect(result.every((a, i) => a === before[i])).toBe(true);
  });
});

describe("渲染", () => {
  const LINES = [
    row(seg(" 作者  opuser (原PO)                                     看板  Test")),
    row(seg(" 標題  [心得] 測試")),
    row(seg(" 時間  Sat Jun 14 10:00:00 2025")),
    row(seg("內文")),
    row(seg("推 a1: 一                                             06/14 10:01")),
    row(seg("推 a2: 二                                             06/14 10:02")),
    row(seg("推 friend: 三                                         06/14 10:03")),
    row(seg("推 a3: 四                                             06/14 10:04")),
    row(seg("推 friend: 五                                         06/14 10:05")),
  ];
  const props = (commentFilter, easyReading = true) => ({
    lines: LINES,
    enableLinkInlinePreview: false,
    enableLinkHoverPreview: false,
    enhance: {
      pageState: 3,
      blacklist: new Set(),
      titleBlacklist: [],
      showFloorNumbers: true,
      highlightAuthor: true,
      articleAuthor: "opuser",
      easyReading,
      dropHidden: easyReading,
      commentFilter,
    },
  });
  const pushers = (m) =>
    [...m.container.querySelectorAll('span[type="bbsrow"][data-pusher]')].map((n) =>
      n.getAttribute("data-pusher"),
    );
  const skips = (m) =>
    [...m.container.querySelectorAll(".commentFilterSkip")].map((n) => n.textContent);

  test("只留那個人的推文，其他收成「略過 N 則」", () => {
    const m = mountScreen(props("friend"));
    expect(pushers(m)).toEqual(["friend", "friend"]);
    const skipped = (n) => i18n("commentFilter_skipped").replace("{n}", String(n));
    expect(skips(m)).toEqual([skipped(2), skipped(1)]);
    // 細線不是 bbsrow（選取複製、閱讀紀錄找 bbsrow 的都略過它）
    expect(m.container.querySelector(".commentFilterSkip").getAttribute("type")).toBeNull();
  });

  test("篩選中不合併同作者推文（留下來的全是同一人，會被併成一整塊、跨過「略過」）", () => {
    const p = props("friend");
    p.enhance.mergeSameAuthorComments = true;
    const m = mountScreen(p);
    expect(pushers(m)).toEqual(["friend", "friend"]);
    expect(skips(m).length).toBe(2);
    // 順序：略過 2 → friend → 略過 1 → friend
    const order = [...m.container.querySelectorAll('.commentFilterSkip, span[type="bbsrow"][data-pusher]')].map(
      (n) => (n.classList.contains("commentFilterSkip") ? "skip" : n.getAttribute("data-pusher")),
    );
    expect(order).toEqual(["skip", "friend", "skip", "friend"]);
  });

  test("P38 點細線 ⇒ 呼叫 onCommentFilterToggle(key)；展開後「收起 N 則」在那串上面、被篩掉的推文看得到", () => {
    const calls = [];
    const p = props("friend");
    p.enhance.onCommentFilterToggle = (key) => calls.push(key);
    const m = mountScreen(p);
    const first = m.container.querySelector(".commentFilterSkip");
    expect(first.tagName).toBe("BUTTON");
    expect(first.getAttribute("aria-expanded")).toBe("false");
    // real-input: tests/e2e/offline/comment_filter.offline.spec.js
    first.click();
    // key＝那串第一列（a1 那則）的文字
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/^推 a1: 一 +06\/14 10:01/);

    const q = props("friend");
    q.enhance.onCommentFilterToggle = p.enhance.onCommentFilterToggle;
    q.enhance.commentFilterExpanded = [calls[0]];
    m.update(q);
    expect(pushers(m)).toEqual(["a1", "a2", "friend", "friend"]);
    const collapse = i18n("commentFilter_collapse").replace("{n}", "2");
    const skipped = i18n("commentFilter_skipped").replace("{n}", "1");
    expect(skips(m)).toEqual([collapse, skipped]);
    const order = [...m.container.querySelectorAll('.commentFilterSkip, span[type="bbsrow"][data-pusher]')].map(
      (n) => (n.classList.contains("commentFilterSkip") ? "skip" : n.getAttribute("data-pusher")),
    );
    expect(order).toEqual(["skip", "a1", "a2", "friend", "skip", "friend"]);
    expect(m.container.querySelector(".commentFilterSkip").getAttribute("aria-expanded")).toBe("true");
    // 展開出來的別人推文標淡色 class；只看的那個人不標
    const shown = [...m.container.querySelectorAll(".commentFilterShown")];
    expect(shown.length).toBe(2);
    const key2 = (e) => annotationsKey({ enhance: { commentFilter: "a", commentFilterExpanded: e } }).sig;
    expect(key2([])).not.toBe(key2(["x"]));
  });

  test("沒有篩選 ⇒ 全部推文、沒有細線", () => {
    const m = mountScreen(props(null));
    expect(pushers(m)).toEqual(["a1", "a2", "friend", "a3", "friend"]);
    expect(skips(m)).toEqual([]);
  });

  test("切換篩選 ⇒ 當場重畫（進 annotationsKey）", () => {
    const m = mountScreen(props(null));
    m.update(props("a3"));
    expect(pushers(m)).toEqual(["a3"]);
    m.update(props(null));
    expect(pushers(m)).toEqual(["a1", "a2", "friend", "a3", "friend"]);
    const key = (f) => annotationsKey({ enhance: { commentFilter: f } }).sig;
    expect(key("a")).not.toBe(key("b"));
  });

  test("不是好讀 ⇒ 不篩（原生 24 列不動）", () => {
    const { annotations } = computeAnnotations(
      LINES,
      props("friend", false).enhance,
      null,
      false,
      {},
      {},
      {},
      null,
      null,
    );
    expect(annotations.some((a) => a && a.filtered)).toBe(false);
  });
});

describe("view 狀態", () => {
  const makeView = () => {
    const v = Object.create(TermView.prototype);
    v._commentFilter = null;
    v._commentFilterListeners = new Set();
    v._emittedCommentFilter = null;
    v._articleInstanceId = 3;
    v.useEasyReadingMode = true;
    v.buf = { pageState: 3, pageLines: [] };
    v.redraw = vi.fn();
    v.mainDisplay = null;
    v.mainContainer = null;
    return v;
  };

  test("設定 ⇒ 生效、通知、重畫；換文章（id 變）⇒ 不生效；離開文章 ⇒ 不生效", () => {
    const v = makeView();
    const seen = [];
    v.onCommentFilterChange((f) => seen.push(f && f.userid));
    expect(v.setCommentFilter("Friend", false, 5)).toBe(true);
    expect(v.redraw).toHaveBeenCalledWith(true);
    expect(v.activeCommentFilter()).toMatchObject({ userid: "friend", op: false });
    expect(seen).toEqual([null, "friend"]);
    v.buf.pageState = 2;
    expect(v.activeCommentFilter()).toBeNull();
    v.buf.pageState = 3;
    v._articleInstanceId = 4;
    expect(v.activeCommentFilter()).toBeNull();
  });

  test("P38 toggleCommentFilterSkip：展開／收起一串，重畫；換篩選就歸零；沒篩選不動", () => {
    const v = makeView();
    expect(v.toggleCommentFilterSkip("推 a1")).toBe(false);
    v.setCommentFilter("friend", false, 0);
    v.redraw.mockClear();
    expect(v.toggleCommentFilterSkip("推 a1")).toBe(true);
    expect(v.redraw).toHaveBeenCalledWith(true);
    const first = v.activeCommentFilter().expanded;
    expect(first).toEqual(["推 a1"]);
    v.toggleCommentFilterSkip("推 a3");
    v.toggleCommentFilterSkip("推 a1");
    // 每次都是新陣列（annotationsKey 靠內容，舊陣列不被改）
    expect(first).toEqual(["推 a1"]);
    expect(v.activeCommentFilter().expanded).toEqual(["推 a3"]);
    v.setCommentFilter("other", false, 0);
    expect(v.activeCommentFilter().expanded).toEqual([]);
  });

  test("不在好讀文章 ⇒ 不設", () => {
    const v = makeView();
    v.useEasyReadingMode = false;
    expect(v.setCommentFilter("friend", false, 0)).toBe(false);
    expect(v.redraw).not.toHaveBeenCalled();
  });

  test("clearCommentFilter ⇒ 清掉、重畫、通知", () => {
    const v = makeView();
    v._topRowNode = () => null;
    v.setCommentFilter("friend", true, 0);
    const seen = [];
    v.onCommentFilterChange((f) => seen.push(f && f.userid));
    v.clearCommentFilter();
    expect(v.activeCommentFilter()).toBeNull();
    expect(seen).toEqual(["friend", null]);
  });
});

describe("右鍵選單", () => {
  const BASE = { normalEnabled: true, onMenuSelect: () => {} };
  const keys = (p) => buildContextMenuEntries({ ...BASE, ...p }).map((e) => e.key);

  test("沒篩選：只看這個人＋只看原 PO（原PO 解析不到就只有前者）", () => {
    const calls = [];
    const entries = buildContextMenuEntries({
      ...BASE,
      onMenuSelect: (k) => calls.push(k),
      commentFilterTarget: { pusher: "friend", op: "opuser", row: 4, active: false },
    });
    const user = entries.find((e) => e.key === "filterCommentUser");
    expect(user.label).toContain("friend");
    user.onClick({});
    entries.find((e) => e.key === "filterCommentOp").onClick({});
    expect(calls).toEqual(["filterCommentUser", "filterCommentOp"]);
    expect(keys({ commentFilterTarget: { pusher: "friend", op: null, active: false } })).not.toContain(
      "filterCommentOp",
    );
  });

  test("生效中只給「顯示全部推文」；沒有目標就都沒有", () => {
    const k = keys({ commentFilterTarget: { active: true } });
    expect(k).toContain("clearCommentFilter");
    expect(k).not.toContain("filterCommentUser");
    expect(keys({})).not.toContain("filterCommentUser");
  });

  test("預設開", () => {
    expect(DEFAULT_PREFS.enableCommentFilter).toBe(true);
  });
});
