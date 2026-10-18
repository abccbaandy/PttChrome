// 閱讀紀錄（reading_record.js）的純邏輯：決策表、比對規則、凍結語意、交易分派。
// 設計見 docs/reading-record.md。畫面擁有者的整合（列表 rebuild 後還原）在
// reading_record_list.test.js。
import {
  RESTORE_TABLE,
  OUTCOMES,
  restorePlan,
  resolveArticleMode,
  listRecordMatches,
  boardListRecordMatches,
  ReadingRecord,
  recordFor
} from "../../src/js/reading_record";
import { externalOriginAnchor } from "../../src/js/aid_navigation";

const ARTICLE_MODES = ["origin", "bottom", "auto", "none"];
const LIST_MODES = ["origin", "none"];

describe("決策表", () => {
  test("每一格都是合法值（功能 × 結果）", () => {
    for (const feature of Object.keys(RESTORE_TABLE)) {
      for (const outcome of OUTCOMES) {
        const p = restorePlan(feature, outcome);
        expect(ARTICLE_MODES).toContain(p.article);
        expect(LIST_MODES).toContain(p.list);
        expect(LIST_MODES).toContain(p.boardList);
      }
    }
  });

  test("不在表上的功能／結果 ⇒ 全部不動（未知就停在 PTT 給的位置）", () => {
    expect(restorePlan("no-such-feature", "done")).toEqual({
      article: "none",
      list: "none",
      boardList: "none",
    });
    expect(restorePlan("long-push", "weird").article).toBe("none");
  });

  test.each([
    // [功能, 結果, 文章, 列表, 看板列表]
    ["long-push", "done", "bottom", "none", "none"],
    ["long-push", "cancel", "origin", "none", "none"],
    ["long-push", "fail", "origin", "none", "none"],
    ["aid-jump", "done", "none", "none", "none"],
    ["aid-back", "done", "origin", "none", "none"],
    ["aid-board-pick", "done", "none", "none", "none"],
    ["aid-board-pick", "cancel", "origin", "none", "none"],
    ["aid-board-pick", "fail", "none", "none", "none"],
    ["article-refresh", "done", "auto", "none", "none"],
    ["deep-link-copy", "done", "origin", "none", "none"],
    ["deep-link-jump", "done", "none", "none", "none"],
    ["list-refresh", "done", "none", "origin", "none"],
    ["list-refresh", "fail", "none", "origin", "none"],
    ["board-list-refresh", "done", "none", "none", "origin"],
    ["mark-read-before", "done", "none", "origin", "none"],
    ["mark-read-before", "fail", "none", "origin", "none"],
    ["mark-all-read", "done", "none", "origin", "none"],
    ["mark-all-read", "fail", "none", "origin", "none"],
    ["board-search", "done", "none", "none", "none"],
    ["board-search", "cancel", "none", "origin", "origin"],
    ["board-search", "fail", "none", "origin", "origin"],
    ["article-search", "done", "none", "none", "none"],
    // 使用者拍板：找不到第一篇未讀時停在翻到的那頁。
    ["unread-jump", "done", "none", "none", "none"],
    ["unread-jump", "fail", "none", "none", "none"],
    // 斷線重連：落在文章 'auto'、落在列表回原處；找不到原文停在列表也回原處。
    ["reconnect-resume", "done", "auto", "origin", "none"],
    ["reconnect-resume", "fail", "none", "origin", "none"],
    ["reconnect-resume", "cancel", "none", "none", "none"],
  ])("%s / %s ⇒ 文章 %s、列表 %s、看板列表 %s", (feature, outcome, a, l, b) => {
    expect(restorePlan(feature, outcome)).toEqual({ article: a, list: l, boardList: b });
  });

  test("'auto'：書籤記著在文末 ⇒ 文末，否則原列", () => {
    expect(resolveArticleMode("auto", { atBottom: true })).toBe("bottom");
    expect(resolveArticleMode("auto", { atBottom: false })).toBe("origin");
    expect(resolveArticleMode("auto", null)).toBe("origin");
    expect(resolveArticleMode("origin", { atBottom: true })).toBe("origin");
  });
});

describe("列表紀錄的比對（認不出 ⇒ 不還原）", () => {
  const rec = { board: "C_Chat", mode: "plain", cursorNum: 350026 };
  const ok = { board: "C_Chat", mode: "plain", cursorNum: 350026 };

  test("同板＋同編號空間＋游標仍在發起那一篇 ⇒ 還原", () => {
    expect(listRecordMatches(rec, ok)).toBe(true);
  });

  test.each([
    ["換板", { board: "Gossiping" }],
    ["落地在搜尋結果（另一個編號空間）", { mode: "select" }],
    ["游標被移走", { cursorNum: 350029 }],
    ["落點沒有游標編號（置底列）", { cursorNum: null }],
    ["落地讀不出板名", { board: null }],
  ])("突變：%s ⇒ 不還原", (_name, patch) => {
    expect(listRecordMatches(rec, Object.assign({}, ok, patch))).toBe(false);
  });

  test("返回錨（matchBoardOnly）：只比板與編號空間，游標由 getkeep 決定", () => {
    const back = Object.assign({}, rec, { matchBoardOnly: true });
    expect(listRecordMatches(back, Object.assign({}, ok, { cursorNum: 1 }))).toBe(true);
    expect(listRecordMatches(back, Object.assign({}, ok, { board: "X" }))).toBe(false);
    expect(listRecordMatches(back, Object.assign({}, ok, { mode: "select" }))).toBe(false);
  });

  test("看板列表：同變體＋游標仍在那一列", () => {
    const b = { variant: "fav", cursorNum: 12 };
    expect(boardListRecordMatches(b, { variant: "fav", cursorNum: 12 })).toBe(true);
    expect(boardListRecordMatches(b, { variant: "class", cursorNum: 12 })).toBe(false);
    expect(boardListRecordMatches(b, { variant: "fav", cursorNum: 13 })).toBe(false);
    expect(boardListRecordMatches(b, null)).toBe(false);
  });
});

// 假畫面：好讀文章讀到第 lineIndex 列。
function articleCore({ lineIndex = 42.5, enabled = true, atBottom = false } = {}) {
  const view = {
    _articleBoard: "C_Chat",
    chh: 20,
    mainDisplay: { scrollHeight: 2000, scrollTop: atBottom ? 1500 : 100, clientHeight: 500 },
    currentLineIndex: vi.fn(() => lineIndex),
  };
  const er = {
    _enabled: enabled,
    _functionMode: false,
    easyReadingReachedPageEnd: atBottom,
    requestScrollRestore: vi.fn(),
    requestScrollToBottom: vi.fn(),
  };
  const buf = {
    pageState: 3,
    rows: 24,
    cols: 80,
    getRowText: () => "  瀏覽 第 1/3 頁 ( 30%)  目前顯示: 第 01~23 行",
  };
  return { core: { view, easyReading: er, buf, sendMachineBytes: vi.fn() }, view, er };
}

describe("ReadingRecord：量測與凍結", () => {
  test("文章：列索引（含列內比例）、看板、在不在文末", () => {
    const { core } = articleCore({ lineIndex: 12.375 });
    const cur = new ReadingRecord(core).current();
    expect(cur.article).toEqual({
      kind: "article",
      board: "C_Chat",
      lineIndex: 12.375,
      atBottom: false,
      easy: true,
    });
  });

  test("好讀已讀到文末且捲到底 ⇒ atBottom", () => {
    const { core } = articleCore({ atBottom: true });
    expect(new ReadingRecord(core).current().article.atBottom).toBe(true);
  });

  test("原生 pmore：atBottom 看狀態列 100%，easy=false", () => {
    const { core } = articleCore({ enabled: false });
    core.buf.getRowText = () => "  瀏覽 第 2/2 頁 (100%)  目前顯示: 第 24~40 行";
    const a = new ReadingRecord(core).current().article;
    expect(a.atBottom).toBe(true);
    expect(a.easy).toBe(false);
  });

  // 取代散在各功能裡的「採樣要在 _enterFunctionMode 之前」：鏡像那一幀的 redraw
  // 會把 scrollTop 歸零，之後再問也要拿到切進去那一刻的位置。
  test("凍結：鏡像期間回切進去那一刻的位置；離開鏡像後恢復現場量", () => {
    const { core, view, er } = articleCore({ lineIndex: 88.25 });
    const rr = new ReadingRecord(core);
    rr.freeze("article");
    er._functionMode = true;
    view.currentLineIndex.mockReturnValue(0); // 鏡像畫面：scrollTop 已歸零
    expect(rr.current().article.lineIndex).toBe(88.25);
    expect(rr.begin("long-push").article.lineIndex).toBe(88.25);
    er._functionMode = false;
    view.currentLineIndex.mockReturnValue(3);
    expect(rr.current().article.lineIndex).toBe(3);
  });

  test("列表／看板列表的凍結只在擁有者仍處於 functionMode 時有效", () => {
    const ls = { state: "functionMode", readingPosition: () => null };
    const rr = new ReadingRecord({ listSession: ls });
    rr.freeze("list", { kind: "list", board: "C_Chat", topNum: 10 });
    expect(rr.current().list.topNum).toBe(10);
    ls.state = "active";
    expect(rr.current().list).toBe(null);
  });

  test("recordFor：假 core 沒掛也會建一個並重用；沒有 core 給空的（呼叫端免判 null）", () => {
    const core = {};
    const a = recordFor(core);
    expect(a).toBeInstanceOf(ReadingRecord);
    expect(recordFor(core)).toBe(a);
    const none = recordFor(null);
    expect(none.current()).toEqual({ article: null, list: null, boardList: null });
    expect(() => none.releaseExternal()).not.toThrow();
  });
});

describe("ReadingRecord：交易分派", () => {
  test("長推文送完 ⇒ 文末；取消 ⇒ 原列", () => {
    const { core, er } = articleCore({ lineIndex: 30.5 });
    const rr = new ReadingRecord(core);
    const bm = rr.begin("long-push");
    rr.end(bm, "done");
    expect(er.requestScrollToBottom).toHaveBeenCalledTimes(1);
    rr.end(bm, "cancel");
    expect(er.requestScrollRestore).toHaveBeenCalledWith(30.5);
  });

  test("文章重新整理：在文末 ⇒ 文末；原生 pmore 在文末 ⇒ 原生 End", () => {
    const easy = articleCore({ atBottom: true });
    const rr = new ReadingRecord(easy.core);
    rr.end(rr.begin("article-refresh"), "done");
    expect(easy.er.requestScrollToBottom).toHaveBeenCalledTimes(1);

    const nat = articleCore({ enabled: false });
    nat.core.buf.getRowText = () => "  瀏覽 第 2/2 頁 (100%)  目前顯示: 第 24~40 行";
    const rr2 = new ReadingRecord(nat.core);
    rr2.end(rr2.begin("article-refresh"), "done");
    expect(nat.core.sendMachineBytes).toHaveBeenCalledWith("\x1b[4~");
    expect(nat.er.requestScrollRestore).not.toHaveBeenCalled();
  });

  test("原生 pmore 量的原列沒有意義（pmore 沒有跳行入口）⇒ 不還原", () => {
    const nat = articleCore({ enabled: false, lineIndex: 7 });
    const rr = new ReadingRecord(nat.core);
    rr.end(rr.begin("deep-link-copy"), "done");
    expect(nat.er.requestScrollRestore).not.toHaveBeenCalled();
  });

  test("列表交易：決策表說 origin 才交給擁有者，送出（換板）不還原", () => {
    const owner = { requestViewportRestore: vi.fn() };
    const rr = new ReadingRecord({});
    const list = { kind: "list", board: "C_Chat", mode: "plain", topNum: 5, cursorNum: 9 };
    const bm = rr.begin("board-search", { list: list, listOwner: owner });
    rr.end(bm, "done");
    expect(owner.requestViewportRestore).not.toHaveBeenCalled();
    rr.end(bm, "cancel");
    expect(owner.requestViewportRestore).toHaveBeenCalledWith(list);
  });

  test("only：只處理指定的那種畫面", () => {
    const { core, er } = articleCore();
    const owner = { requestViewportRestore: vi.fn() };
    core.listSession = Object.assign(owner, { state: "active", readingPosition: () => ({ board: "C_Chat", topNum: 1 }) });
    const rr = new ReadingRecord(core);
    const bm = { feature: "long-push", article: { lineIndex: 9 }, list: { board: "C_Chat", topNum: 1 } };
    rr.end(bm, "cancel", { only: "list" });
    expect(er.requestScrollRestore).not.toHaveBeenCalled();
  });

  test("身後的列表：只交一次（rebuild 取走後就不再出現）", () => {
    const rr = new ReadingRecord({});
    rr.noteBehindList({ board: "C_Chat", topNum: 3 });
    expect(rr.peekBehindList().topNum).toBe(3);
    expect(rr.takeBehindList().topNum).toBe(3);
    expect(rr.takeBehindList()).toBe(null);
  });

  test("releaseExternal：兩個列表 session 都交回靜置探針", () => {
    const core = {
      listSession: { endExternalNavigation: vi.fn() },
      boardListSession: { endExternalNavigation: vi.fn() },
    };
    new ReadingRecord(core).releaseExternal();
    expect(core.listSession.endExternalNavigation).toHaveBeenCalled();
    expect(core.boardListSession.endExternalNavigation).toHaveBeenCalled();
  });
});

describe("deep link 外部跳轉的返回錨（externalOriginAnchor）", () => {
  const list = { kind: "list", board: "C_Chat", mode: "plain", topNum: 350010, cursorNum: 350026 };

  test("從文章列表出發 ⇒ 看板錨，帶著列表視野", () => {
    const a = externalOriginAnchor({ list: list }, "Gossiping");
    expect(a).toMatchObject({ kind: "board", board: "C_Chat", aid: null, list: list });
  });

  test.each([
    ["搜尋結果（獨立編號空間）", { list: Object.assign({}, list, { mode: "select" }) }, "Gossiping"],
    ["跳往同一個板（# 會覆寫 getkeep 游標）", { list: list }, "c_chat"],
    ["主功能表／看板列表（沒有列表紀錄）", { list: null }, "Gossiping"],
    ["看板身分是標題列（板名被 server 省略）", { list: Object.assign({}, list, { board: "【板主:x】" }) }, "Gossiping"],
  ])("%s ⇒ 沒有返回", (_name, bm, target) => {
    expect(externalOriginAnchor(bm, target)).toBe(null);
  });
});
