// @unit-env browser
// 搜尋關鍵字記憶（本機）：↑ 叫回的順序與去重是行為的一部分；不可混進 pref（會同步）。
import {
  MAX_SEARCH_HISTORY,
  SEARCH_HISTORY_KEY,
  addSearchEntry,
  readSearchHistory,
  rememberSearch,
  removeSearchEntry,
  clearSearchKind,
  forgetSearch,
  forgetSearchKind,
} from "../../src/js/search_history";
// pref_storage.js 的 PREF_STORAGE_KEY（未 export）：同步與匯出只碰這一把。
const PREF_STORAGE_KEY = "pttchrome.pref.v1";

beforeEach(() => {
  window.localStorage.clear();
});

describe("addSearchEntry", () => {
  test("最新的排最前面、各種類分開記", () => {
    let h = addSearchEntry(null, "title", "問卦");
    h = addSearchEntry(h, "title", "新聞");
    h = addSearchEntry(h, "author", "abc");
    expect(h.title).toEqual(["新聞", "問卦"]);
    expect(h.author).toEqual(["abc"]);
    expect(h.push).toEqual([]);
  });
  test("重複的往前提，不佔兩格", () => {
    let h = addSearchEntry(null, "title", "a1");
    h = addSearchEntry(h, "title", "b2");
    h = addSearchEntry(h, "title", "a1");
    expect(h.title).toEqual(["a1", "b2"]);
  });
  test("上限 MAX_SEARCH_HISTORY，最舊的掉出去", () => {
    let h = null;
    for (let i = 0; i < MAX_SEARCH_HISTORY + 5; ++i) h = addSearchEntry(h, "board", "B" + i);
    expect(h.board).toHaveLength(MAX_SEARCH_HISTORY);
    expect(h.board[0]).toBe("B" + (MAX_SEARCH_HISTORY + 4));
  });
  test("空字串與未知種類不記", () => {
    const h = addSearchEntry(addSearchEntry(null, "title", "  "), "bogus", "x");
    expect(h.title).toEqual([]);
    expect(h.bogus).toBeUndefined();
  });
});

describe("刪除", () => {
  test("刪一筆：只動那一類的那一筆", () => {
    let h = addSearchEntry(null, "title", "a1");
    h = addSearchEntry(h, "title", "b2");
    h = addSearchEntry(h, "author", "a1");
    const next = removeSearchEntry(h, "title", "a1");
    expect(next.title).toEqual(["b2"]);
    expect(next.author).toEqual(["a1"]);
    expect(h.title).toEqual(["b2", "a1"]); // 不改原物件
  });
  test("清一類：其他種類不受影響", () => {
    let h = addSearchEntry(null, "title", "a1");
    h = addSearchEntry(h, "board", "C_Chat");
    const next = clearSearchKind(h, "title");
    expect(next.title).toEqual([]);
    expect(next.board).toEqual(["C_Chat"]);
  });
  test("落地：forgetSearch／forgetSearchKind 寫回 localStorage", () => {
    rememberSearch("title", "x1");
    rememberSearch("title", "x2");
    rememberSearch("author", "y");
    forgetSearch("title", "x1");
    expect(readSearchHistory().title).toEqual(["x2"]);
    forgetSearchKind("title");
    expect(readSearchHistory().title).toEqual([]);
    expect(readSearchHistory().author).toEqual(["y"]);
  });
});

describe("儲存", () => {
  test("round-trip，且 key 不是 pref（不同步、不進匯出）", () => {
    rememberSearch("title", "問卦");
    expect(readSearchHistory().title).toEqual(["問卦"]);
    expect(SEARCH_HISTORY_KEY).not.toBe(PREF_STORAGE_KEY);
    expect(window.localStorage.getItem(PREF_STORAGE_KEY) || "").not.toContain("問卦");
  });
  test("壞掉的 JSON ⇒ 空記憶，不 throw", () => {
    window.localStorage.setItem(SEARCH_HISTORY_KEY, "{oops");
    expect(readSearchHistory()).toEqual({ title: [], author: [], push: [], board: [] });
  });
  test("localStorage 丟例外 ⇒ 不 throw", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => rememberSearch("title", "x")).not.toThrow();
    spy.mockRestore();
  });
});
