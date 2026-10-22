// 新推文標記（src/js/new_comments.js、docs/new-comments.md）：推文的數法＝樓層的數法、讀完才記、
// 重開時找出第一則新推文那一列；標註層把它標在那一列（或它所在的合併塊）上。
const prefOverride = vi.hoisted(() => ({}));
vi.mock("../../src/js/pref_storage", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, readEffectivePrefs: () => ({ ...real.readEffectivePrefs(), ...prefOverride }) };
});
import { DEFAULT_PREFS, NATIVE_SAFE_MODE_KEYS } from "../../src/js/pref_storage";
import {
  CommentScanner,
  NewComments,
  articleKey,
  loadSeen,
  saveSeen,
  NEW_COMMENTS_KEY,
} from "../../src/js/new_comments";
import { applyNewCommentsMark } from "../../src/js/screen_annotations";
import { annotationsKey } from "../../src/js/screen_annotate_cache";

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    raw: m,
  };
}

// 推文列：「推 id: 內容 … 日期」（comment_parse.parseComment 的形狀）。
const push = (id, text, type = "推") => (type + " " + id + ": " + text).padEnd(67) + " 10/20 12:00";
const ARTICLE = [
  "作者  alice (Alice) 看板 Test",
  "標題  [閒聊] 測試",
  "時間  Mon Oct 20 12:00:00 2026",
  "",
  "內文",
  push("fake", "內文裡的假推文"),
  "--",
  "※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4",
  "※ 文章網址: https://www.ptt.cc/bbs/Test/M.1700000000.A.ABC.html",
];
const withComments = (n) => ARTICLE.concat(Array.from({ length: n }, (_, i) => push("u" + i, "第 " + (i + 1) + " 則")));

describe("CommentScanner：與樓層同一個數法", () => {
  test("只算 meta 列之後的推文；第 k 則在哪一列", () => {
    const s = new CommentScanner();
    withComments(3).forEach((t) => s.feed(t));
    expect(s.count).toBe(3);
    // 上次看到 1 則 ⇒ 第 2 則（ARTICLE 之後第 2 列）
    expect(s.rowAfter(1)).toBe(ARTICLE.length + 1);
    expect(s.rowAfter(0)).toBe(ARTICLE.length);
    expect(s.rowAfter(3)).toBeNull();
    expect(s.rowAfter(null)).toBeNull();
  });
  test("沒有 meta 列（數不準）⇒ 0 則，不標", () => {
    const s = new CommentScanner();
    [push("a", "x"), push("b", "y")].forEach((t) => s.feed(t));
    expect(s.count).toBe(0);
    expect(s.rowAfter(0)).toBeNull();
  });
});

describe("紀錄（localStorage，只在這個瀏覽器）", () => {
  test("存讀；看板不分大小寫", () => {
    const st = memStorage();
    expect(articleKey("Test", "1abcDEFG")).toBe("test/1abcDEFG");
    expect(articleKey(null, "x")).toBeNull();
    saveSeen(st, "test/a", 5, 1);
    expect(loadSeen(st, "test/a")).toBe(5);
    expect(loadSeen(st, "test/b")).toBeNull();
  });
  test("超過上限丟最久的", () => {
    const st = memStorage();
    saveSeen(st, "a", 1, 10, 2);
    saveSeen(st, "b", 1, 20, 2);
    saveSeen(st, "c", 1, 30, 2);
    expect(Object.keys(JSON.parse(st.getItem(NEW_COMMENTS_KEY)))).toEqual(["b", "c"]);
  });
  test("壞掉的資料 ⇒ 當作沒有", () => {
    const st = memStorage();
    st.setItem(NEW_COMMENTS_KEY, "{not json");
    expect(loadSeen(st, "a")).toBeNull();
  });
});

test("預設開；一個 byte 都不送 ⇒ 不在安全模式名單內", () => {
  expect(DEFAULT_PREFS.markNewComments).toBe(true);
  expect(NATIVE_SAFE_MODE_KEYS).not.toContain("markNewComments");
});

// ── 控制器：假 App ─────────────────────────────────────────────────────────
function makeCore(storage) {
  let settled = null;
  const easyReading = { _enabled: true, _functionMode: false, _reverse: null, easyReadingReachedPageEnd: false };
  const core = {
    easyReading,
    buf: {
      cols: 80,
      pageState: 3,
      pageLines: [],
      getRowText: (r, s, e, lines) => lines[r],
      addEventListener: (name, fn) => name === "screenSettled" && (settled = fn),
    },
    view: { _articleBoard: "Test" },
    aidNavigation: {
      findLocalPostAid() {
        return core.buf.pageLines.some((t) => t.includes("文章網址")) ? { aid: "1ABCDEFG" } : null;
      },
    },
  };
  const nc = new NewComments(core, storage);
  const show = (lines, atEnd) => {
    core.buf.pageLines = lines;
    easyReading.easyReadingReachedPageEnd = !!atEnd;
    const row = nc.rowFor(lines);
    settled();
    return row;
  };
  return { core, nc, show, easyReading };
}

describe("NewComments：讀完才記，重開時標第一則新推文", () => {
  test("第一次讀：不標；讀到文末記下推文數", () => {
    const st = memStorage();
    const { show } = makeCore(st);
    expect(show(withComments(2), false)).toBeNull();
    expect(loadSeen(st, "test/1ABCDEFG")).toBeNull();
    expect(show(withComments(3), true)).toBeNull();
    expect(loadSeen(st, "test/1ABCDEFG")).toBe(3);
  });
  test("重開：多了兩則 ⇒ 第 4 則那一列；讀完更新紀錄，但這一次的標線不動", () => {
    const st = memStorage();
    saveSeen(st, "test/1ABCDEFG", 3, 1);
    const { show } = makeCore(st);
    expect(show(withComments(5), true)).toBe(ARTICLE.length + 3);
    expect(loadSeen(st, "test/1ABCDEFG")).toBe(5);
    expect(show(withComments(5), true)).toBe(ARTICLE.length + 3);
  });
  test("沒有新推文 ⇒ 不標", () => {
    const st = memStorage();
    saveSeen(st, "test/1ABCDEFG", 3, 1);
    expect(makeCore(st).show(withComments(3), true)).toBeNull();
  });
  test("換文章（首列變了）⇒ 重來，用新的那篇的紀錄", () => {
    const st = memStorage();
    saveSeen(st, "test/1ABCDEFG", 1, 1);
    const { show, core } = makeCore(st);
    expect(show(withComments(2), true)).toBe(ARTICLE.length + 1);
    const other = withComments(2).map((t, i) => (i === 0 ? "作者  bob (Bob) 看板 Test" : t));
    core.aidNavigation.findLocalPostAid = () => ({ aid: "1ZZZZZZZ" });
    expect(show(other, false)).toBeNull();
  });
  test("反向讀取中 ⇒ 不標、不記；接合後從頭重掃", () => {
    const st = memStorage();
    saveSeen(st, "test/1ABCDEFG", 1, 1);
    const { show, easyReading } = makeCore(st);
    easyReading._reverse = {};
    expect(show(withComments(3), true)).toBeNull();
    expect(loadSeen(st, "test/1ABCDEFG")).toBe(1);
    easyReading._reverse = null;
    expect(show(withComments(3), true)).toBe(ARTICLE.length + 1);
  });
  test("切原生（functionMode）時不記", () => {
    const st = memStorage();
    const { show, easyReading } = makeCore(st);
    easyReading._functionMode = true;
    show(withComments(3), true);
    expect(loadSeen(st, "test/1ABCDEFG")).toBeNull();
  });
  test("pref 關 ⇒ 不標也不記（列表 +N 也關著時；那邊開著就照記，見 list_new_push.test.js）", () => {
    const st = memStorage();
    saveSeen(st, "test/1ABCDEFG", 1, 1);
    prefOverride.markNewComments = false;
    prefOverride.listNewPushCount = false;
    try {
      expect(makeCore(st).show(withComments(3), true)).toBeNull();
      expect(loadSeen(st, "test/1ABCDEFG")).toBe(1);
    } finally {
      delete prefOverride.markNewComments;
      delete prefOverride.listNewPushCount;
    }
  });
});

describe("applyNewCommentsMark：標在哪一列", () => {
  test("就是那一列；不動其他列的物件", () => {
    const a = { userid: "a" };
    const b = { userid: "b" };
    const result = [a, b];
    applyNewCommentsMark(result, { newCommentsRow: 1 });
    expect(result[0]).toBe(a);
    expect(result[1]).toEqual({ userid: "b", newCommentsStart: true });
    expect(b.newCommentsStart).toBeUndefined();
    expect(result.newCommentsRow).toBe(1);
  });
  test("被合併進同作者推文塊 ⇒ 標在塊的第一列", () => {
    const result = [{ userid: "a" }, { userid: "a", mergedIntoComment: 0 }];
    applyNewCommentsMark(result, { newCommentsRow: 1 });
    expect(result[0].newCommentsStart).toBe(true);
    expect(result.newCommentsRow).toBe(0);
  });
  test("黑名單藏起來的推文看不到線 ⇒ 往後找第一則看得到的", () => {
    const result = [{ userid: "x", hidden: true }, { userid: "b" }];
    applyNewCommentsMark(result, { newCommentsRow: 0 });
    expect(result[1].newCommentsStart).toBe(true);
  });
  test("沒有／超出範圍 ⇒ 什麼都不做", () => {
    const result = [{ userid: "a" }];
    applyNewCommentsMark(result, { newCommentsRow: null });
    applyNewCommentsMark(result, { newCommentsRow: 5 });
    expect(result[0].newCommentsStart).toBeUndefined();
    expect(result.newCommentsRow).toBeUndefined();
  });
});

test("annotationsKey：newCommentsRow 變了 ⇒ 快取鍵變（那一幀全量重算）", () => {
  const k = (row) => annotationsKey({ enhance: { pageState: 3, easyReading: true, newCommentsRow: row } });
  expect(k(null)).not.toEqual(k(12));
  expect(k(12)).toEqual(k(12));
});
