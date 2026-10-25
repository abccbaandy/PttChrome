// @unit-env browser
// real-input: tests/e2e/offline/comment_filter.offline.spec.js
// 推文篩選的「只看推文／只看噓文」（P39，docs/comment-filter.md）。
//
// 鎖的症狀：
//   1. 只看噓 ⇒ 推、→ 都收進「略過 N 則」，噓照常；樓號照數；黑名單照黑名單。
//   2. 新格式推文（`[N] id │`）看不出推／噓 ⇒ 不收（認不出就不動）。
//   3. view：setCommentTypeFilter 只吃 推／噓；enhance 的 key 跟帳號篩選不撞（帳號只有英數）。
//   4. 選單：沒篩選時多「只看推文」「只看噓文」，點了呼叫 setCommentTypeFilter；生效中照舊只給「顯示全部」。
//   5. 橫幅文字依種類換。
import { annotateComment, FloorCounter, COMMENT_TYPE_FILTER_PREFIX } from "../../src/js/comment_parse";
import { buildContextMenuEntries } from "../../src/components/ContextMenu/context_menu_entries";
import { splitQuickActions } from "../../src/components/ContextMenu/context_sheet_quick";
import { TermView } from "../../src/js/term_view";
import { setupI18n, i18n } from "../../src/js/i18n";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg } from "./helpers/screen_fixtures";
import { render, screen, act, cleanup } from "@testing-library/react";
import { CommentFilterBar } from "../../src/components/CommentFilterBar";

beforeAll(() => setupI18n());
afterEach(() => {
  unmountAll();
  cleanup();
});

const ts = (s) => s + "                 06/06 16:11";
const BOO = COMMENT_TYPE_FILTER_PREFIX + "噓";
const PUSH = COMMENT_TYPE_FILTER_PREFIX + "推";

describe("annotateComment", () => {
  const ctx = (over) => ({
    blacklist: new Set(["badguy"]),
    showFloorNumbers: true,
    floorCounter: new FloorCounter(),
    commentFilter: BOO,
    ...over,
  });

  test("只看噓：推、→ hidden＋filtered；噓照常；樓號照數；黑名單照黑名單", () => {
    const c = ctx();
    const a = annotateComment(ts("推 aa: 1"), c);
    const b = annotateComment(ts("→ bb: 2"), c);
    const d = annotateComment(ts("噓 cc: 3"), c);
    const e = annotateComment(ts("噓 badguy: 4"), c);
    expect([a.hidden, a.filtered]).toEqual([true, true]);
    expect([b.hidden, b.filtered]).toEqual([true, true]);
    expect([d.hidden, d.filtered]).toEqual([false, undefined]);
    expect(d.floor.seq).toBe(b.floor.seq + 1);
    expect([e.hidden, e.filtered]).toEqual([true, undefined]);
  });

  test("只看推：噓、→ 收起來，推照常", () => {
    const c = ctx({ commentFilter: PUSH });
    expect(annotateComment(ts("推 aa: 1"), c).hidden).toBe(false);
    expect(annotateComment(ts("噓 bb: 2"), c).filtered).toBe(true);
    expect(annotateComment(ts("→ cc: 3"), c).filtered).toBe(true);
  });

  test("帳號篩選照舊（key 不是 type: 開頭就是帳號）", () => {
    const c = ctx({ commentFilter: "aa" });
    expect(annotateComment(ts("推 aa: 1"), c).hidden).toBe(false);
    expect(annotateComment(ts("噓 bb: 2"), c).filtered).toBe(true);
  });
});

describe("渲染", () => {
  const LINES = [
    row(seg(" 作者  opuser (原PO)                                     看板  Test")),
    row(seg(" 標題  [心得] 測試")),
    row(seg(" 時間  Sat Jun 14 10:00:00 2025")),
    row(seg("內文")),
    row(seg("推 a1: 一                                             06/14 10:01")),
    row(seg("→ a2: 二                                             06/14 10:02")),
    row(seg("噓 a3: 三                                             06/14 10:03")),
    row(seg("推 a4: 四                                             06/14 10:04")),
    row(seg("噓 a5: 五                                             06/14 10:05")),
  ];
  const props = (commentFilter, lines = LINES) => ({
    lines,
    enableLinkInlinePreview: false,
    enableLinkHoverPreview: false,
    enhance: {
      pageState: 3,
      blacklist: new Set(),
      titleBlacklist: [],
      showFloorNumbers: true,
      highlightAuthor: true,
      articleAuthor: "opuser",
      easyReading: true,
      dropHidden: true,
      commentFilter,
    },
  });
  const pushers = (m) =>
    [...m.container.querySelectorAll('span[type="bbsrow"][data-pusher]')].map((n) =>
      n.getAttribute("data-pusher"),
    );
  const skipped = (n) => i18n("commentFilter_skipped").replace("{n}", String(n));
  const skips = (m) =>
    [...m.container.querySelectorAll(".commentFilterSkip")].map((n) => n.textContent);

  test("只看噓：只留噓文，前面的推／→ 收成「略過 N 則」", () => {
    const m = mountScreen(props(BOO));
    expect(pushers(m)).toEqual(["a3", "a5"]);
    expect(skips(m)).toEqual([skipped(2), skipped(1)]);
  });

  test("只看推：只留推文", () => {
    const m = mountScreen(props(PUSH));
    expect(pushers(m)).toEqual(["a1", "a4"]);
    expect(skips(m)).toEqual([skipped(2), skipped(1)]);
  });

  test("新格式推文看不出推／噓 ⇒ 不收", () => {
    const lines = [
      ...LINES.slice(0, 4),
      row(seg("[1] a1 06/14/2025 10:01")),
      row(seg("│ 新格式內容")),
      row(seg("推 a2: 舊格式                                         06/14 10:02")),
    ];
    const m = mountScreen(props(BOO, lines));
    const text = m.container.textContent;
    expect(text).toContain("新格式內容");
    expect(skips(m)).toEqual([skipped(1)]);
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

  test("setCommentTypeFilter 只吃 推／噓；生效後帶 type 與 key、展開歸零", () => {
    const v = makeView();
    expect(v.setCommentTypeFilter("→", 0)).toBe(false);
    expect(v.setCommentTypeFilter("x", 0)).toBe(false);
    expect(v.redraw).not.toHaveBeenCalled();
    expect(v.setCommentTypeFilter("噓", 0)).toBe(true);
    expect(v.activeCommentFilter()).toMatchObject({ type: "噓", key: BOO, userid: null, expanded: [] });
    v.toggleCommentFilterSkip("推 a1");
    v.setCommentTypeFilter("推", 0);
    expect(v.activeCommentFilter()).toMatchObject({ type: "推", key: PUSH, expanded: [] });
  });

  test("帳號篩選的 key 就是帳號（小寫）", () => {
    const v = makeView();
    v.setCommentFilter("Friend", false, 0);
    expect(v.activeCommentFilter()).toMatchObject({ key: "friend", userid: "friend", type: null });
  });

  test("不在好讀文章 ⇒ 不設", () => {
    const v = makeView();
    v.buf.pageState = 2;
    expect(v.setCommentTypeFilter("噓", 0)).toBe(false);
  });
});

describe("選單", () => {
  const BASE = { normalEnabled: true, onMenuSelect: () => {} };
  const target = { pusher: "friend", op: "opuser", row: 4, active: false };

  test("沒篩選：多「只看推文」「只看噓文」，點了送出對應 key", () => {
    const calls = [];
    const entries = buildContextMenuEntries({
      ...BASE,
      onMenuSelect: (k) => calls.push(k),
      commentFilterTarget: target,
    });
    const push = entries.find((e) => e.key === "filterCommentPush");
    const boo = entries.find((e) => e.key === "filterCommentBoo");
    expect(push.label).toBe(i18n("cmenu_filterCommentPush"));
    expect(boo.label).toBe(i18n("cmenu_filterCommentBoo"));
    push.onClick({});
    boo.onClick({});
    expect(calls).toEqual(["filterCommentPush", "filterCommentBoo"]);
  });

  test("生效中只給「顯示全部推文」", () => {
    const k = buildContextMenuEntries({ ...BASE, commentFilterTarget: { active: true } }).map((e) => e.key);
    expect(k).not.toContain("filterCommentPush");
    expect(k).not.toContain("filterCommentBoo");
  });

  test("手機長按：兩項留在下面清單（上排圖示鈕名額給常用的）", () => {
    const entries = buildContextMenuEntries({ ...BASE, commentFilterTarget: target });
    const { quick, rest } = splitQuickActions(entries);
    const restKeys = rest.map((e) => e.key);
    expect(quick.map((e) => e.key)).not.toContain("filterCommentBoo");
    expect(restKeys).toContain("filterCommentPush");
    expect(restKeys).toContain("filterCommentBoo");
  });
});

describe("橫幅", () => {
  const fakeView = (filter) => {
    let fn = null;
    return {
      onCommentFilterChange: (f) => {
        fn = f;
        f(filter);
        return () => {};
      },
      emit: (f) => fn(f),
      clearCommentFilter: vi.fn(),
    };
  };

  test("只看噓／只看推／帳號：文字各自不同", () => {
    const view = fakeView({ type: "噓", userid: null, op: false });
    render(<CommentFilterBar pttchrome={{ view }} />);
    expect(screen.getByText(i18n("commentFilter_bannerBoo"))).toBeTruthy();
    act(() => view.emit({ type: "推", userid: null, op: false }));
    expect(screen.getByText(i18n("commentFilter_bannerPush"))).toBeTruthy();
    act(() => view.emit({ type: null, userid: "friend", op: false }));
    expect(screen.getByText(i18n("commentFilter_banner").replace("{id}", "friend"))).toBeTruthy();
  });
});
