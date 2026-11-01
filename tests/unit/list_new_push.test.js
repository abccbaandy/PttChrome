// 文章列表的「+N」（src/js/new_comments.js#listNewPush、docs/new-comments.md「列表的 +N」）：
// 讀完時記下推噓分＋作者＋主題，列表上推文數欄是精確數字、作者＋主題對得上唯一一筆紀錄時，
// 顯示多出來的分數。一個 byte 都不送。
const prefOverride = vi.hoisted(() => ({}));
vi.mock("../../src/js/pref_storage", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, readEffectivePrefs: () => ({ ...real.readEffectivePrefs(), ...prefOverride }) };
});
import { DEFAULT_PREFS, NATIVE_SAFE_MODE_KEYS } from "../../src/js/pref_storage";
import {
  CommentScanner,
  NewComments,
  NEW_COMMENTS_KEY,
  saveSeen,
  loadSeen,
  boardRecords,
  listNewPush,
  listRecommendValue,
  postDateOfAid,
} from "../../src/js/new_comments";
import { annotationsKey } from "../../src/js/screen_annotate_cache";

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

// pttbbs bbs.c#readdoent 的欄位：%7d 序號、空白、type、推文數 2 格、日期 %-6.5s、作者 %-13.12s、標題。
function listRow(num, push, author, title, o = {}) {
  return (
    String(num).padStart(7) + " " + (o.type || " ") + push.padStart(2) + (o.date || "10/22").padStart(5) + " " + author.padEnd(13) + (o.mark || "□") + " " + title
  );
}

const push = (id, text, type = "推") => (type + " " + id + ": " + text).padEnd(67) + " 10/20 12:00";
const META = [
  "作者  alice (Alice) 看板 Test",
  "標題  Re: [閒聊] 測試",
  "",
  push("fake", "內文裡的假推文"),
  "--",
  "※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4",
  "※ 文章網址: https://www.ptt.cc/bbs/Test/M.1700000000.A.ABC.html",
];

beforeEach(() => {
  for (const k of Object.keys(prefOverride)) delete prefOverride[k];
});

describe("推噓分：推 +1、噓 -1、→ 0（pttbbs post.c 改 .DIR recommend 的規則）", () => {
  test("只算 meta 列之後的推文", () => {
    const s = new CommentScanner();
    META.concat([push("aax", "1"), push("bbx", "2"), push("ccx", "3", "噓"), push("ddx", "4", "→")]).forEach((t) => s.feed(t));
    expect(s.count).toBe(4);
    expect(s.score).toBe(1);
  });
});

describe("列表推文數欄 → 精確分數", () => {
  test.each([
    [" 5", 5],
    ["12", 12],
    ["99", 99],
    ["爆", null],
    ["XX", null],
    ["X5", null],
    ["  ", null], // 0 與 -1～-10 都畫成空白
    ["--", null], // 鎖文
  ])("%j → %j", (raw, v) => expect(listRecommendValue(raw)).toBe(v));
});

describe("listNewPush：對列表的一列", () => {
  const records = [{ author: "alice", subject: "[閒聊] 測試", score: 3 }];

  test("同作者同主題、推文數變多 ⇒ 差值", () => {
    expect(listNewPush(records, listRow(100, "8", "alice", "[閒聊] 測試", { mark: "R:" }))).toBe(5);
  });
  test("沒變多（或變少）⇒ 不顯示", () => {
    expect(listNewPush(records, listRow(100, "3", "alice", "[閒聊] 測試"))).toBeNull();
    expect(listNewPush(records, listRow(100, "2", "alice", "[閒聊] 測試"))).toBeNull();
  });
  test("爆／空白 ⇒ 不顯示（不精確）", () => {
    expect(listNewPush(records, listRow(100, "爆", "alice", "[閒聊] 測試"))).toBeNull();
    expect(listNewPush(records, listRow(100, "", "alice", "[閒聊] 測試"))).toBeNull();
  });
  test("作者或主題對不上 ⇒ 不顯示", () => {
    expect(listNewPush(records, listRow(100, "8", "bob", "[閒聊] 測試"))).toBeNull();
    expect(listNewPush(records, listRow(100, "8", "alice", "[閒聊] 別的"))).toBeNull();
  });
  test("列表標題被截成 … 也認得", () => {
    const long = [{ author: "alice", subject: "[閒聊] 這是一個非常非常非常非常非常非常長的標題後面還有很多字", score: 1 }];
    expect(listNewPush(long, listRow(100, "4", "alice", "[閒聊] 這是一個非常非常非常非常非常非常長的…"))).toBe(3);
  });
  test("同作者同主題讀過好幾篇 ⇒ 分不出是哪一篇，不顯示", () => {
    const two = records.concat([{ author: "alice", subject: "[閒聊] 測試", score: 1 }]);
    expect(listNewPush(two, listRow(100, "8", "alice", "[閒聊] 測試"))).toBeNull();
  });
  // 只讀過其中一篇時，同一人同一串的另一篇（原文／另一篇回文）身分一模一樣：舊碼把讀過那篇的
  // 分數套到沒讀過的那篇，冒出一個假的 +N。紀錄多存發文日期（AID 的時間戳＝.DIR 的 date 欄），
  // 日期不同就不是同一篇。
  test("同作者同主題、但發文日期不同的另一篇（沒讀過）⇒ 不顯示", () => {
    const dated = [{ author: "alice", subject: "[閒聊] 測試", score: 3, date: "10/20" }];
    expect(listNewPush(dated, listRow(101, "8", "alice", "[閒聊] 測試", { mark: "R:", date: "10/22" }))).toBeNull();
    expect(listNewPush(dated, listRow(100, "8", "alice", "[閒聊] 測試", { date: "10/20" }))).toBe(5);
  });
  test("月份一位數：列表印成 %2d/%02d（' 1/05'）也對得上", () => {
    const dated = [{ author: "alice", subject: "[閒聊] 測試", score: 3, date: "1/05" }];
    expect(listNewPush(dated, listRow(100, "8", "alice", "[閒聊] 測試", { date: "1/05" }))).toBe(5);
  });
  test("刪除文、表頭這類不是文章列 ⇒ 不顯示", () => {
    expect(listNewPush(records, listRow(100, "8", "-", "(本文已被刪除) [alice]"))).toBeNull();
    expect(listNewPush(records, "   編號    日 期 作  者       文  章  標  題")).toBeNull();
  });
});

describe("紀錄：讀完時多存推噓分＋作者＋主題", () => {
  test("saveSeen 帶 info ⇒ boardRecords 讀得到；舊格式紀錄照樣 loadSeen、但列表不用", () => {
    const st = memStorage();
    saveSeen(st, "test/AAA", 4, 1, null, { score: 2, author: "Alice", subject: "[閒聊] 測試" });
    saveSeen(st, "test/BBB", 7, 2);
    saveSeen(st, "other/CCC", 1, 3, null, { score: 1, author: "bob", subject: "x" });
    expect(loadSeen(st, "test/AAA")).toBe(4);
    expect(loadSeen(st, "test/BBB")).toBe(7);
    const all = JSON.parse(st.getItem(NEW_COMMENTS_KEY));
    expect(boardRecords(all, "Test")).toEqual([{ author: "alice", subject: "[閒聊] 測試", score: 2 }]);
  });

  test("好讀讀到文末 ⇒ 記下推噓分與檔頭的作者＋主題（Re: 去掉）", () => {
    const st = memStorage();
    const lines = META.concat([push("aax", "1"), push("bbx", "2", "噓"), push("ccx", "3")]);
    const listeners = {};
    const core = {
      buf: {
        pageState: 3,
        pageLines: lines,
        cols: 80,
        getRowText: (r, a, b, src) => (src || lines)[r],
        addEventListener: (n, fn) => (listeners[n] = fn),
      },
      easyReading: { _enabled: true, easyReadingReachedPageEnd: true },
      view: { _articleBoard: "Test", _articleAuthor: "alice", _articleTitle: "Re: [閒聊] 測試" },
      aidNavigation: { findLocalPostAid: () => ({ aid: "#1ABC" }) },
    };
    new NewComments(core, st);
    listeners.screenSettled();
    expect(JSON.parse(st.getItem(NEW_COMMENTS_KEY))["test/#1ABC"].slice(2)).toEqual([1, "alice", "[閒聊] 測試"]);
  });

  test("AID 讀得出時間戳 ⇒ 多記發文日期（台灣時間，與列表日期欄同格式）", () => {
    const st = memStorage();
    const lines = META.concat([push("aax", "1")]);
    const listeners = {};
    const core = {
      buf: { pageState: 3, pageLines: lines, cols: 80, getRowText: (r, a, b, src) => (src || lines)[r], addEventListener: (n, fn) => (listeners[n] = fn) },
      easyReading: { _enabled: true, easyReadingReachedPageEnd: true },
      view: { _articleBoard: "Test", _articleAuthor: "alice", _articleTitle: "[閒聊] 測試" },
      // M.1700000000.A.ABC：2023-11-14 22:13:20 UTC ＝ 台灣 11/15 06:13
      aidNavigation: { findLocalPostAid: () => ({ aid: "1bK_40gy" }) },
    };
    new NewComments(core, st);
    listeners.screenSettled();
    const all = JSON.parse(st.getItem(NEW_COMMENTS_KEY));
    expect(all["test/1bK_40gy"][5]).toBe("11/15");
    expect(boardRecords(all, "Test")).toEqual([{ author: "alice", subject: "[閒聊] 測試", score: 1, date: "11/15" }]);
  });

  test("postDateOfAid：列表日期欄的格式（月不補零、日補零），認不出 ⇒ null", () => {
    expect(postDateOfAid("1bK_40gy")).toBe("11/15");
    expect(postDateOfAid("1bbqQ001")).toBe("1/05"); // M.1704412800：2024-01-05 08:00 台灣
    expect(postDateOfAid("#1ABC")).toBeNull();
    expect(postDateOfAid(null)).toBeNull();
  });

  test("只開列表 +N、新推文標記關著也照記", () => {
    prefOverride.markNewComments = false;
    const st = memStorage();
    const lines = META.concat([push("aax", "1")]);
    const listeners = {};
    const core = {
      buf: { pageState: 3, pageLines: lines, cols: 80, getRowText: (r, a, b, src) => (src || lines)[r], addEventListener: (n, fn) => (listeners[n] = fn) },
      easyReading: { _enabled: true, easyReadingReachedPageEnd: true },
      view: { _articleBoard: "Test", _articleAuthor: "alice", _articleTitle: "[閒聊] 測試" },
      aidNavigation: { findLocalPostAid: () => ({ aid: "#1ABC" }) },
    };
    new NewComments(core, st);
    listeners.screenSettled();
    expect(loadSeen(st, "test/#1ABC")).toBe(1);
  });
});

describe("listBadge：term_view 畫文章列表時問", () => {
  const core = () => ({ buf: { addEventListener: () => {} } });

  test("有紀錄 ⇒ { key, fn }；同一份原文 key 不變，紀錄一變 key 就換（進 annotationsKey）", () => {
    const st = memStorage();
    saveSeen(st, "test/AAA", 4, 1, null, { score: 2, author: "alice", subject: "[閒聊] 測試" });
    const nc = new NewComments(core(), st);
    const a = nc.listBadge("Test");
    expect(a.fn(listRow(1, "6", "alice", "[閒聊] 測試"))).toBe(4);
    expect(nc.listBadge("Test").key).toBe(a.key);
    saveSeen(st, "test/AAA", 5, 2, null, { score: 6, author: "alice", subject: "[閒聊] 測試" });
    const b = nc.listBadge("Test");
    expect(b.key).not.toBe(a.key);
    expect(b.fn(listRow(1, "6", "alice", "[閒聊] 測試"))).toBeNull();
    const k = (key) => annotationsKey({ enhance: { listNewPushKey: key } }).sig;
    expect(k(a.key)).not.toBe(k(b.key));
  });

  test("pref 關、認不出看板、這板沒有紀錄 ⇒ null", () => {
    const st = memStorage();
    saveSeen(st, "test/AAA", 4, 1, null, { score: 2, author: "alice", subject: "[閒聊] 測試" });
    const nc = new NewComments(core(), st);
    expect(nc.listBadge(null)).toBeNull();
    expect(nc.listBadge("Other")).toBeNull();
    prefOverride.listNewPushCount = false;
    expect(nc.listBadge("Test")).toBeNull();
  });

  test("預設開、不送鍵 ⇒ 不在安全模式名單內", () => {
    expect(DEFAULT_PREFS.listNewPushCount).toBe(true);
    expect(NATIVE_SAFE_MODE_KEYS).not.toContain("listNewPushCount");
  });
});
