// @unit-env browser
// real-input: tests/e2e/offline/recent_articles.offline.spec.js
//   （page.mouse；本檔手捏 click 只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
// 最近讀過＋稍後再讀（P34，src/js/recent_articles.js、docs/recent-articles.md）。鎖：
//   1. 清單：新的在前、同一篇去重（標題互補）、上限丟最舊、壞資料不收。
//   2. 記：只在文章裡、讀得到本篇網址列（findLocalPostAid）才記；同一篇讀很久只記一次，
//      離開再回來排回最前面；開關關掉不記。記的時候一個 byte 都不送（core 沒有送鍵入口）。
//   3. 稍後再讀：右鍵切換收進／移出；從連結收的沒標題，讀到時補上。
//   4. 開回去＝deepLinkController.request（跟指令面板貼網址同一條）。
//   5. 指令面板：空白時稍後再讀在前，打字比對標題／板名；排在看板後面、動作前面。
//   6. 右鍵選單：游標下的文章連結優先，否則本篇；已收就改給「移除」。
//   7. 儀表板：兩區照清單畫，點一列開回去、✕ 只移出清單。
const prefOverride = vi.hoisted(() => ({}));
vi.mock("../../src/js/pref_storage", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, readEffectivePrefs: () => ({ ...real.readEffectivePrefs(), ...prefOverride }) };
});
import { render, fireEvent, act } from "@testing-library/react";
import { DEFAULT_PREFS, NATIVE_SAFE_MODE_KEYS } from "../../src/js/pref_storage";
import {
  RecentArticles,
  RECENT_ARTICLES_KEY,
  RECENT_ARTICLES_LIMIT,
  parseRecentArticles,
  pushEntry,
  articleMatches,
  recentKey,
  resumeLineOf,
  resumeLineFromRecord,
  nextResumeStep,
  RESUME_ARM_MS,
} from "../../src/js/recent_articles";
import { buildPaletteItems } from "../../src/js/command_palette";
import { buildContextMenuEntries } from "../../src/components/ContextMenu/context_menu_entries";
import { readLaterTargetOf } from "../../src/components/ContextMenu";
import { HomeDashboard } from "../../src/components/HomeDashboard";
import { setupI18n, i18n } from "../../src/js/i18n";

beforeAll(() => setupI18n());
afterEach(() => {
  for (const k of Object.keys(prefOverride)) delete prefOverride[k];
});

const A1 = { board: "Gossiping", aid: "1abcDEFG", title: "[問卦] 一" };
const A2 = { board: "Stock", aid: "1zzzYYYY", title: "[心得] 二" };

function memStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    map: m,
  };
}

function fakeCore() {
  const listeners = [];
  const core = {
    buf: {
      pageState: 3,
      addEventListener: (type, fn) => listeners.push(fn),
    },
    view: { _articleTitle: A1.title },
    current: { board: A1.board, aid: A1.aid },
    aidNavigation: { findLocalPostAid: () => core.current },
    deepLinkController: { request: vi.fn(() => "navigating") },
    settle: () => listeners.forEach((fn) => fn()),
  };
  return core;
}

describe("清單", () => {
  test("新的在前、去重、上限、壞資料不收", () => {
    let list = [];
    list = pushEntry(list, { ...A1, at: 1 }, 3);
    list = pushEntry(list, { ...A2, at: 2 }, 3);
    list = pushEntry(list, { ...A1, title: "", at: 3 }, 3);
    expect(list.map((e) => e.aid)).toEqual([A1.aid, A2.aid]);
    // 新紀錄沒標題 ⇒ 沿用舊的
    expect(list[0].title).toBe(A1.title);
    for (let i = 0; i < 5; ++i) list = pushEntry(list, { board: "B" + i, aid: "1aaaaaa" + i, title: "", at: 9 }, 3);
    expect(list.length).toBe(3);

    const parsed = parseRecentArticles(
      JSON.stringify({ recent: [A1, { board: "x y", aid: "1abcDEFG" }, { board: "Ok", aid: "short" }, A1], later: "nope" }),
    );
    expect(parsed.recent.map((e) => e.aid)).toEqual([A1.aid]);
    expect(parsed.later).toEqual([]);
    expect(parseRecentArticles("{bad")).toEqual({ recent: [], later: [] });
  });

  test("指令面板的比對：空白時稍後再讀在前、兩邊都有只列一次；打字比對標題或板名", () => {
    const data = { recent: [A1, A2], later: [A2] };
    expect(articleMatches(data, "", 5).map((e) => [e.aid, e.source])).toEqual([
      [A2.aid, "later"],
      [A1.aid, "recent"],
    ]);
    expect(articleMatches(data, "問卦", 5).map((e) => e.aid)).toEqual([A1.aid]);
    expect(articleMatches(data, "stock", 5).map((e) => e.aid)).toEqual([A2.aid]);
    expect(articleMatches(data, "", 1).length).toBe(1);
  });
});

describe("控制器", () => {
  test("文章裡讀得到網址列才記；同一篇只記一次；離開再回來排回最前面", () => {
    const core = fakeCore();
    const st = memStorage();
    const ra = new RecentArticles(core, st);
    const changes = [];
    ra.onChange((d) => changes.push(d.recent.map((e) => e.aid)));
    core.current = null;
    core.settle();
    expect(ra.state.recent).toEqual([]);
    core.current = { board: A1.board, aid: A1.aid };
    core.settle();
    core.settle();
    expect(changes).toEqual([[A1.aid]]);
    expect(ra.state.recent[0]).toMatchObject({ board: A1.board, aid: A1.aid, title: A1.title });
    expect(JSON.parse(st.getItem(RECENT_ARTICLES_KEY)).recent.length).toBe(1);

    core.current = { board: A2.board, aid: A2.aid };
    core.view._articleTitle = A2.title;
    core.settle();
    core.buf.pageState = 2; // 回列表
    core.settle();
    core.buf.pageState = 3;
    core.current = { board: A1.board, aid: A1.aid };
    core.view._articleTitle = A1.title;
    core.settle();
    expect(ra.state.recent.map((e) => e.aid)).toEqual([A1.aid, A2.aid]);
  });

  test("開關關掉 ⇒ 不記；預設開、不在安全模式名單", () => {
    expect(DEFAULT_PREFS.enableRecentArticles).toBe(true);
    expect(NATIVE_SAFE_MODE_KEYS).not.toContain("enableRecentArticles");
    prefOverride.enableRecentArticles = false;
    const core = fakeCore();
    const ra = new RecentArticles(core, memStorage());
    core.settle();
    expect(ra.state.recent).toEqual([]);
  });

  test("上限 30 篇", () => {
    const core = fakeCore();
    const ra = new RecentArticles(core, memStorage());
    for (let i = 0; i < RECENT_ARTICLES_LIMIT + 5; ++i)
      ra.noteRead({ board: "B", aid: "1aaaa" + String(i).padStart(3, "0"), title: "t" + i });
    expect(ra.state.recent.length).toBe(RECENT_ARTICLES_LIMIT);
    expect(ra.state.recent[0].title).toBe("t34");
  });

  test("稍後再讀：切換收進／移出；從連結收的沒標題，讀到時補上；別的分頁寫的讀得到", () => {
    const core = fakeCore();
    const st = memStorage();
    const ra = new RecentArticles(core, st);
    const k = recentKey(A1.board, A1.aid);
    expect(ra.toggleLater({ board: A1.board, aid: A1.aid, title: "" })).toBe(true);
    expect(ra.isLater(k)).toBe(true);
    core.settle(); // 讀到這篇
    expect(ra.state.later[0].title).toBe(A1.title);
    expect(ra.toggleLater({ board: A1.board, aid: A1.aid })).toBe(false);
    expect(ra.isLater(k)).toBe(false);
    expect(ra.toggleLater({ board: "bad board", aid: "x" })).toBeNull();

    st.setItem(RECENT_ARTICLES_KEY, JSON.stringify({ recent: [], later: [A2] }));
    expect(ra.isLater(recentKey(A2.board, A2.aid))).toBe(true);
    expect(ra.removeLater(recentKey(A2.board, A2.aid))).toBe(true);
    expect(ra.state.later).toEqual([]);
  });

  test("開回去 ＝ deep link（看板＋AID）；request 不收 ⇒ false", () => {
    const core = fakeCore();
    const ra = new RecentArticles(core, memStorage());
    expect(ra.open(A2)).toBe(true);
    expect(core.deepLinkController.request).toHaveBeenCalledWith({ board: A2.board, aid: A2.aid });
    core.deepLinkController.request.mockReturnValueOnce(null);
    expect(ra.open(A2)).toBe(false);
  });
});

// P49：開回去接著上次讀到的地方。
describe("接著上次讀到的地方", () => {
  // 好讀文章：視窗頂端在第 line 列；mainDisplay 量 atBottom（離底超過兩列＝沒到底）。
  function readingCore() {
    const core = fakeCore();
    core.view._articleInstanceId = 1;
    core.view.chh = 20;
    core.view.line = 0;
    core.view.currentLineIndex = () => core.view.line;
    core.view.mainDisplay = { scrollTop: 0, scrollHeight: 5000, clientHeight: 400 };
    core.easyReading = {
      _enabled: true,
      _functionMode: false,
      easyReadingReachedPageEnd: false,
      _pendingScrollRestore: null,
      requestScrollRestore: vi.fn(),
      cancelScrollRestore: vi.fn(),
    };
    core.aidNavigation.active = false;
    core.aidNavigation.currentPostAid = () => core.landed;
    core.landed = null;
    return core;
  }

  afterEach(() => {
    document.getElementById("recentResume")?.remove();
  });

  test("純函式：位置正規化、讀到文末不記、落地決策", () => {
    expect(resumeLineOf(0.5)).toBeNull();
    expect(resumeLineOf(42.12345)).toBe(42.123);
    expect(resumeLineOf(NaN)).toBeNull();
    expect(resumeLineFromRecord({ easy: true, atBottom: false, lineIndex: 30 })).toBe(30);
    expect(resumeLineFromRecord({ easy: true, atBottom: true, lineIndex: 30 })).toBeNull();
    expect(resumeLineFromRecord({ easy: false, atBottom: false, lineIndex: 30 })).toBeNull();

    const base = { ageMs: 100, navActive: false, pageState: 3, inst: 2, armedInst: 1, easy: true, key: "b/x", landedKey: "b/x" };
    expect(nextResumeStep(base)).toBe("apply");
    expect(nextResumeStep({ ...base, navActive: true })).toBe("wait");
    expect(nextResumeStep({ ...base, inst: 1 })).toBe("wait"); // 還是出發那篇
    expect(nextResumeStep({ ...base, pageState: 2 })).toBe("wait"); // 跳文失敗停在列表
    expect(nextResumeStep({ ...base, easy: false })).toBe("wait"); // 好讀還沒接手
    expect(nextResumeStep({ ...base, landedKey: "b/y" })).toBe("drop"); // 落在別篇
    expect(nextResumeStep({ ...base, landedKey: null })).toBe("drop"); // 認不出
    expect(nextResumeStep({ ...base, ageMs: RESUME_ARM_MS + 1 })).toBe("drop");
  });

  test("捲動停下來記位置：只改那一筆的 line、不換順序、不通知清單；讀到文末清掉；重讀一次不洗掉", () => {
    const core = readingCore();
    const st = memStorage();
    const ra = new RecentArticles(core, st);
    core.settle(); // 記下 A1
    ra.noteRead(A2);
    const k1 = recentKey(A1.board, A1.aid);
    const changes = [];
    ra.onChange(() => changes.push(1));

    core.view.line = 37.5;
    expect(ra.samplePosition()).toBe(true);
    expect(ra.state.recent.map((e) => e.aid)).toEqual([A2.aid, A1.aid]);
    expect(ra.savedLine(k1)).toBe(37.5);
    expect(JSON.parse(st.getItem(RECENT_ARTICLES_KEY)).recent[1].line).toBe(37.5);
    expect(changes).toEqual([]);

    // 再讀一次同一篇（noteRead 不帶位置）⇒ 位置留著
    ra.noteRead(A1);
    expect(ra.savedLine(k1)).toBe(37.5);

    // 讀到文末 ⇒ 下次從頭
    core.easyReading.easyReadingReachedPageEnd = true;
    core.view.mainDisplay.scrollTop = 4600;
    expect(ra.samplePosition()).toBe(true);
    expect(ra.savedLine(k1)).toBeNull();
    expect(JSON.parse(st.getItem(RECENT_ARTICLES_KEY)).recent[0]).not.toHaveProperty("line");
  });

  test("離開文章那一幀、原生鏡像、還原還沒落地、換了一篇 ⇒ 不記", () => {
    const core = readingCore();
    const ra = new RecentArticles(core, memStorage());
    core.settle();
    const k1 = recentKey(A1.board, A1.aid);
    core.view.line = 50;
    ra.samplePosition();
    core.view.line = 0;

    core.buf._settleTimer = 1; // 畫面還在變（列表那一幀剛到）
    expect(ra.samplePosition()).toBe(false);
    core.buf._settleTimer = null;
    core.easyReading._functionMode = true;
    expect(ra.samplePosition()).toBe(false);
    core.easyReading._functionMode = false;
    core.easyReading._pendingScrollRestore = { lineIndex: 50 };
    expect(ra.samplePosition()).toBe(false);
    core.easyReading._pendingScrollRestore = null;
    core.view._articleInstanceId = 2; // 下一篇還沒讀到網址列
    expect(ra.samplePosition()).toBe(false);
    core.view._articleInstanceId = 1;
    core.buf.pageState = 2;
    expect(ra.samplePosition()).toBe(false);
    expect(ra.savedLine(k1)).toBe(50);

    // 開關關掉也不記
    core.buf.pageState = 3;
    prefOverride.resumeRecentArticles = false;
    expect(ra.samplePosition()).toBe(false);
    expect(ra.savedLine(k1)).toBe(50);
  });

  test("開回去：落在同一篇才交給好讀還原，頂端提示「回到開頭」收回還原、捲回頂端", () => {
    expect(DEFAULT_PREFS.resumeRecentArticles).toBe(true);
    expect(NATIVE_SAFE_MODE_KEYS).not.toContain("resumeRecentArticles");
    const core = readingCore();
    const ra = new RecentArticles(core, memStorage());
    core.settle();
    core.view.line = 80;
    ra.samplePosition();

    core.buf.pageState = 2; // 回到列表，從指令面板開回去
    core.settle();
    expect(ra.open(A1)).toBe(true);
    core.aidNavigation.active = true;
    core.settle();
    expect(core.easyReading.requestScrollRestore).not.toHaveBeenCalled();

    // 落地：新的一篇、跳文落地記下的就是 A1
    core.aidNavigation.active = false;
    core.buf.pageState = 3;
    core.view._articleInstanceId = 2;
    core.landed = { board: A1.board, aid: A1.aid };
    core.settle();
    core.settle();
    expect(core.easyReading.requestScrollRestore.mock.calls).toEqual([[80]]);
    const toast = document.getElementById("recentResume");
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toContain(i18n("recent_resumeHint"));

    core.view.mainDisplay.scrollTop = 300;
    fireEvent.click(toast.querySelector("button"));
    expect(core.easyReading.cancelScrollRestore).toHaveBeenCalled();
    expect(core.view.mainDisplay.scrollTop).toBe(0);
    expect(toast.hidden).toBe(true);
  });

  test("落在別篇、沒讀到一半、開關關掉 ⇒ 不捲", () => {
    const core = readingCore();
    const ra = new RecentArticles(core, memStorage());
    core.settle();
    core.view.line = 80;
    ra.samplePosition();
    core.buf.pageState = 2;
    core.settle();

    ra.open(A1);
    core.buf.pageState = 3;
    core.view._articleInstanceId = 2;
    core.landed = { board: A2.board, aid: A2.aid };
    core.settle();
    expect(core.easyReading.requestScrollRestore).not.toHaveBeenCalled();

    ra.open(A2); // 沒有位置
    core.view._articleInstanceId = 3;
    core.settle();
    expect(core.easyReading.requestScrollRestore).not.toHaveBeenCalled();

    prefOverride.resumeRecentArticles = false;
    ra.open(A1);
    core.view._articleInstanceId = 4;
    core.landed = { board: A1.board, aid: A1.aid };
    core.settle();
    expect(core.easyReading.requestScrollRestore).not.toHaveBeenCalled();
  });
});

describe("指令面板", () => {
  const ctx = (over) => ({
    searchKinds: ["board", "title"],
    quickBoards: { recent: ["Stock"], favorites: [] },
    recentArticles: { recent: [A1], later: [A2] },
    title: (k) => i18n(k),
    ...over,
  });

  test("空白：看板 → 稍後再讀 → 最近讀過 → 動作；開文走 article（deep link 同一條）", () => {
    const items = buildPaletteItems("", ctx());
    const kinds = items.map((it) => it.kind + ":" + (it.source || ""));
    expect(kinds.slice(0, 3)).toEqual(["board:recent", "article:later", "article:recent"]);
    expect(items[1].target).toEqual({ board: A2.board, aid: A2.aid });
    expect(items[1].title).toBe(A2.title);
  });

  test("打字只留標題／板名對得上的；關掉（null）就不列", () => {
    const hit = buildPaletteItems("問卦", ctx()).filter((it) => it.kind === "article");
    expect(hit.map((it) => it.target.aid)).toEqual([A1.aid]);
    expect(buildPaletteItems("", ctx({ recentArticles: null })).some((it) => it.kind === "article")).toBe(false);
  });
});

describe("右鍵選單", () => {
  const pttchrome = (later) => ({
    recentArticles: { isLater: (k) => later.includes(k) },
    view: { _articleTitle: A1.title },
  });
  const on = { enableRecentArticles: true };

  test("游標下的文章連結優先，否則本篇；已收 ⇒ saved；關掉 ⇒ null", () => {
    expect(readLaterTargetOf(pttchrome([]), on, { board: A2.board, aid: A2.aid }, A1)).toEqual({
      board: A2.board,
      aid: A2.aid,
      title: "",
      saved: false,
    });
    expect(readLaterTargetOf(pttchrome([recentKey(A1.board, A1.aid)]), on, null, A1)).toMatchObject({
      aid: A1.aid,
      title: A1.title,
      saved: true,
    });
    expect(readLaterTargetOf(pttchrome([]), on, null, null)).toBeNull();
    expect(readLaterTargetOf(pttchrome([]), { enableRecentArticles: false }, null, A1)).toBeNull();
  });

  test("沒收 ⇒「稍後再讀」；已收 ⇒「從稍後再讀移除」", () => {
    const calls = [];
    const entries = (saved) =>
      buildContextMenuEntries({
        normalEnabled: true,
        onMenuSelect: (k) => calls.push(k),
        readLaterTarget: { ...A1, saved },
      });
    const add = entries(false).find((e) => e.key === "readLater");
    expect(add.label).toBe(i18n("cmenu_readLater"));
    add.onClick({});
    entries(true).find((e) => e.key === "removeReadLater").onClick({});
    expect(calls).toEqual(["readLater", "removeReadLater"]);
    expect(buildContextMenuEntries({ normalEnabled: true, onMenuSelect: () => {} }).some((e) => e.key === "readLater")).toBe(
      false,
    );
  });
});

describe("儀表板", () => {
  const fakeHome = () => ({
    state: { visible: true, fetching: false, boards: [], savedAt: null, recents: [], newMail: false },
    onChange(fn) {
      fn(this.state);
      return () => {};
    },
    applyPendingViewport: () => {},
  });

  test("兩區照清單畫；點一列開回去；✕ 只移出清單；關掉就不畫", () => {
    const core = fakeCore();
    const st = memStorage({ [RECENT_ARTICLES_KEY]: JSON.stringify({ recent: [A1, A2], later: [A2] }) });
    const ra = new RecentArticles(core, st);
    const view = { flashListHint: vi.fn() };
    const { unmount } = render(<HomeDashboard pttchrome={{ homeDashboard: fakeHome(), recentArticles: ra, view }} />);
    const rows = (src) =>
      [...document.querySelectorAll(`[data-home-articles="${src}"] [data-home-article]`)].map((n) =>
        n.getAttribute("data-home-article"),
      );
    expect(rows("later")).toEqual([recentKey(A2.board, A2.aid)]);
    expect(rows("recent")).toEqual([recentKey(A1.board, A1.aid), recentKey(A2.board, A2.aid)]);
    expect(document.querySelector(`[data-home-article="${recentKey(A1.board, A1.aid)}"]`).textContent).toContain(A1.title);

    fireEvent.click(document.querySelector(`[data-home-articles="recent"] [data-home-article]`));
    expect(core.deepLinkController.request).toHaveBeenCalledWith({ board: A1.board, aid: A1.aid });

    core.deepLinkController.request.mockReturnValueOnce(null);
    fireEvent.click(document.querySelector(`[data-home-articles="recent"] [data-home-article]`));
    expect(view.flashListHint).toHaveBeenCalledWith(i18n("recent_failed"), 3000);

    act(() => {
      fireEvent.click(document.querySelector("[data-home-article-remove]"));
    });
    expect(document.querySelector('[data-home-articles="later"]')).toBeNull();
    expect(ra.state.recent.length).toBe(2);
    unmount();

    prefOverride.enableRecentArticles = false;
    render(<HomeDashboard pttchrome={{ homeDashboard: fakeHome(), recentArticles: ra, view }} />);
    expect(document.querySelector("[data-home-articles]")).toBeNull();
  });
});
