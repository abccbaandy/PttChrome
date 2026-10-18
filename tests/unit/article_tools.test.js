// 文章工具側欄（src/js/article_tools.js、docs/article-tools.md）：好讀累積頁 → 推文統計／
// 推文者排行／圖片牆；側欄什麼時候出現（只在好讀文章、右邊空白放得下）；跳列只捲好讀視口、
// 複製只用免費的網址列 AID（一個 byte 都不送）。推文列照 pttbbs 的版面手寫
// （舊格式 comments.c 的 `推 id: 內容 MM/DD HH:MM`，新格式 post.svc 的 `[n] id ... MM/DD/YYYY HH:MM` ＋ `│` 內容列）。
const prefOverride = vi.hoisted(() => ({}));
vi.mock("../../src/js/pref_storage", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, readEffectivePrefs: () => ({ ...real.readEffectivePrefs(), ...prefOverride }) };
});
import { DEFAULT_PREFS, NATIVE_SAFE_MODE_KEYS } from "../../src/js/pref_storage";
import {
  analyzeArticle,
  articleUrl,
  thumbCandidates,
  urlsInLine,
  ArticleTools,
  ARTICLE_TOOLS_COLLAPSED_KEY,
  IMAGE_LIMIT,
  TOP_USERS,
} from "../../src/js/article_tools";
import { SPLIT_MAX_PANE_PX, SPLIT_MIN_PANE_PX } from "../../src/js/split_reader";
import { HINT_ERROR } from "../../src/js/status_hint";

const push = (type, user, content, time = "09/01 12:00") => (type + " " + user + ": " + content).padEnd(67) + time;
const HEADER = [
  "作者  alice (愛麗絲)                                         看板  Test",
  "標題  [閒聊] 測試文章",
  "時間  Mon Sep  1 12:00:00 2025",
  "─────────────────────────────────────",
];
const ARTICLE = [
  ...HEADER,
  "內文第一行 https://i.imgur.com/abcdefg.jpg",
  "https://pbs.twimg.com/media/FooBar123?format=png&name=orig",
  "影片 https://i.imgur.com/vidvidv.mp4 不算圖",
  "相簿 https://imgur.com/a/album12 不算圖",
  "https://example.com/pic.png 重複 https://example.com/pic.png",
  "https://example.com/logo.svg 不收 svg",
  "--",
  "※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4 (臺灣)",
  "※ 文章網址: https://www.ptt.cc/bbs/Test/M.1786265274.A.5E3.html",
  push("推", "bob", "第一"),
  push("噓", "carol", "不推"),
  push("→", "bob", "補充"),
  push("推", "Alice", "原PO自己推"),
  push("推", "bob", "再推 https://example.com/c.jpg"),
];

describe("urlsInLine／thumbCandidates", () => {
  test("一列裡的網址，標點不算進網址", () => {
    expect(urlsInLine("看 https://a.com/x.jpg，還有 http://b.tw/y")).toEqual(["https://a.com/x.jpg", "http://b.tw/y"]);
    expect(urlsInLine("沒有網址")).toEqual([]);
    expect(urlsInLine("")).toEqual([]);
  });
  test("imgur 單張：先試 m 縮圖再試原圖；相簿／影片不收", () => {
    expect(thumbCandidates("https://i.imgur.com/abcdefg.png", {})).toEqual([
      "https://i.imgur.com/abcdefgm.jpg",
      "https://i.imgur.com/abcdefg.png",
    ]);
    expect(thumbCandidates("https://imgur.com/abcdefg", {})).toEqual([
      "https://i.imgur.com/abcdefgm.jpg",
      "https://i.imgur.com/abcdefg.jpg",
    ]);
    expect(thumbCandidates("https://imgur.com/a/album12", {})).toBe(null);
    expect(thumbCandidates("https://imgur.com/gallery/album12", {})).toBe(null);
    expect(thumbCandidates("https://i.imgur.com/vidvidv.mp4", {})).toBe(null);
    expect(thumbCandidates("https://i.imgur.com/vidvidv.gifv", {})).toBe(null);
  });
  test("twimg：先試 small", () => {
    const c = thumbCandidates("https://pbs.twimg.com/media/FooBar123?format=png&name=orig", {});
    expect(c[0]).toBe("https://pbs.twimg.com/media/FooBar123?format=png&name=small");
    expect(c.length).toBeGreaterThan(1);
  });
  test("直連圖收、svg／tenor 分享頁／一般網頁不收", () => {
    expect(thumbCandidates("https://example.com/a.webp?x=1", {})).toEqual(["https://example.com/a.webp?x=1"]);
    expect(thumbCandidates("https://example.com/logo.svg", {})).toBe(null);
    expect(thumbCandidates("https://tenor.com/abcd.gif", {})).toBe(null);
    expect(thumbCandidates("https://www.ptt.cc/bbs/Test/M.1.A.2.html", {})).toBe(null);
    expect(thumbCandidates("", {})).toBe(null);
  });
});

describe("analyzeArticle", () => {
  test("推／噓／→ 分開計；推文者依則數排，原PO有標", () => {
    const a = analyzeArticle(ARTICLE, {});
    expect(a.author).toBe("alice");
    expect(a.stats).toEqual({ push: 3, boo: 1, arrow: 1, modern: 0 });
    expect(a.users).toEqual([
      { user: "bob", count: 3, op: false },
      { user: "carol", count: 1, op: false },
      { user: "alice", count: 1, op: true },
    ]);
    expect(a.comments.filter((c) => c.user === "bob").map((c) => c.content)).toEqual([
      "第一",
      "補充",
      "再推 https://example.com/c.jpg",
    ]);
    // row 是累積頁的索引（跳列用）。
    expect(a.comments[0].row).toBe(ARTICLE.indexOf(push("推", "bob", "第一")));
  });
  test("圖片：同網址只收一次，影片／相簿／svg／文章網址不收，推文裡的圖也收", () => {
    const a = analyzeArticle(ARTICLE, {});
    expect(a.images.map((i) => i.url)).toEqual([
      "https://i.imgur.com/abcdefg.jpg",
      "https://pbs.twimg.com/media/FooBar123?format=png&name=orig",
      "https://example.com/pic.png",
      "https://example.com/c.jpg",
    ]);
    expect(a.images[0].row).toBe(4);
  });
  test("新格式推文另計，`│` 內容列接到同一則", () => {
    const lines = [
      ...HEADER,
      "內文",
      "[1] bob                                    1.2.3.4 09/01/2025 12:00",
      "│ 第一段",
      "│ 第二段",
      "[2] carol                                          09/01/2025 12:01",
      "│ 嗨",
      "不是內容列",
    ];
    const a = analyzeArticle(lines, {});
    expect(a.stats).toEqual({ push: 0, boo: 0, arrow: 0, modern: 2 });
    expect(a.comments.map((c) => [c.user, c.content])).toEqual([
      ["bob", "第一段 第二段"],
      ["carol", "嗨"],
    ]);
  });
  test("沒有檔頭 ⇒ 作者 null、沒人被標原PO", () => {
    const a = analyzeArticle(["內文", push("推", "bob", "x")], {});
    expect(a.author).toBe(null);
    expect(a.users).toEqual([{ user: "bob", count: 1, op: false }]);
  });
  test(`圖片最多 ${IMAGE_LIMIT} 張`, () => {
    const lines = Array.from({ length: IMAGE_LIMIT + 10 }, (_, i) => "https://example.com/" + i + ".jpg");
    expect(analyzeArticle(lines, {}).images).toHaveLength(IMAGE_LIMIT);
  });
});

test("articleUrl：AID → ptt.cc 檔名", () => {
  expect(articleUrl("Test", "1gU3wwNZ")).toBe("https://www.ptt.cc/bbs/Test/M.1786265274.A.5E3.html");
  expect(articleUrl(null, "1gU3wwNZ")).toBe(null);
  expect(articleUrl("Test", null)).toBe(null);
  expect(articleUrl("Test", "壞掉")).toBe(null);
});

// ── 控制器：假 App ─────────────────────────────────────────────────────────
function makeCore({ side = 600, mobile = false, easy = true, functionMode = false, lines = ARTICLE } = {}) {
  const listeners = {};
  const hints = [];
  const scrolls = [];
  let acc = lines.slice();
  let pageState = 3;
  const core = {
    mobile,
    buf: {
      rows: 24,
      cols: 80,
      get pageState() {
        return pageState;
      },
      get pageLines() {
        return acc;
      },
      getRowText: (r, _c0, _c1, a) => a[r],
      addEventListener: (name, fn) => (listeners[name] = fn),
    },
    view: {
      mainDisplay: { getBoundingClientRect: () => ({ right: 1000 - side }) },
      _articleBoard: "Test",
      flashListHint: (m, ms, level) => hints.push({ m, level }),
    },
    easyReading: {
      _enabled: easy,
      _functionMode: functionMode,
      scrollToArticleRow: (row) => {
        scrolls.push(row);
        return true;
      },
    },
    aidNavigation: { findLocalPostAid: () => ({ board: "Test", aid: "1gU3wwNZ" }) },
  };
  const tools = new ArticleTools(core);
  const settle = () => listeners.screenSettled();
  return {
    core,
    tools,
    hints,
    scrolls,
    settle,
    setLines: (l) => (acc = l),
    setPageState: (s) => (pageState = s),
  };
}

let store;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal("window", {
    innerWidth: 1000,
    addEventListener: () => {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ArticleTools：何時出現", () => {
  test("好讀文章、右邊放得下 ⇒ 出現，帶統計、排行、圖片、AID 網址", () => {
    const { tools, settle } = makeCore();
    settle();
    expect(tools.state).toMatchObject({
      visible: true,
      width: SPLIT_MAX_PANE_PX,
      board: "Test",
      aid: "1gU3wwNZ",
      url: "https://www.ptt.cc/bbs/Test/M.1786265274.A.5E3.html",
      author: "alice",
      stats: { push: 3, boo: 1, arrow: 1, modern: 0 },
    });
    expect(tools.state.users[0]).toEqual({ user: "bob", count: 3, op: false });
    expect(tools.state.images).toHaveLength(4);
  });
  test.each([
    ["原生 pmore（好讀關）", { easy: false }],
    ["好讀的功能鍵模式（交給原生）", { functionMode: true }],
    ["手機", { mobile: true }],
    ["右邊空白放不下", { side: SPLIT_MIN_PANE_PX - 1 }],
    ["累積頁是空的", { lines: [] }],
  ])("%s ⇒ 不出現", (_l, opts) => {
    const { tools, settle } = makeCore(opts);
    settle();
    expect(tools.state.visible).toBe(false);
  });
  test("離開文章 ⇒ 收起", () => {
    const t = makeCore();
    t.settle();
    t.setPageState(2);
    t.settle();
    expect(t.tools.state.visible).toBe(false);
  });
  test("pref 關 ⇒ 下一次 settle 收起", () => {
    const t = makeCore();
    t.settle();
    prefOverride.enableArticleTools = false;
    try {
      t.settle();
      expect(t.tools.state.visible).toBe(false);
    } finally {
      delete prefOverride.enableArticleTools;
    }
  });
  test("預設開；不送鍵，所以不在安全模式名單內", () => {
    expect(DEFAULT_PREFS.enableArticleTools).toBe(true);
    expect(NATIVE_SAFE_MODE_KEYS).not.toContain("enableArticleTools");
  });
  test(`推文者排行最多 ${TOP_USERS} 人`, () => {
    const lines = [...HEADER, ...Array.from({ length: TOP_USERS + 3 }, (_, i) => push("推", "user" + i, "x"))];
    const { tools, settle } = makeCore({ lines });
    settle();
    expect(tools.state.users).toHaveLength(TOP_USERS);
  });
});

describe("ArticleTools：累積頁長大／換文章", () => {
  test("往下讀長出新推文 ⇒ 統計跟著更新，已選的人清單也更新", () => {
    const t = makeCore();
    t.settle();
    t.tools.selectUser("bob");
    expect(t.tools.state.selectedComments).toHaveLength(3);
    t.setLines([...ARTICLE, push("推", "bob", "又來")]);
    t.settle();
    expect(t.tools.state.stats.push).toBe(4);
    expect(t.tools.state.selectedComments.map((c) => c.content).pop()).toBe("又來");
  });
  test("換一篇（首列變了）⇒ 從頭重算，選的人不在新文章裡就取消", () => {
    const t = makeCore();
    t.settle();
    t.tools.selectUser("carol");
    t.setLines(["作者  dave (D)                                       看板  Test", "標題  另一篇", push("推", "erin", "嗨")]);
    t.settle();
    expect(t.tools.state).toMatchObject({ author: "dave", selectedUser: null, selectedComments: [] });
    expect(t.tools.state.users).toEqual([{ user: "erin", count: 1, op: false }]);
  });
  test("同一頁再 settle（沒長）⇒ 不重算、不通知", () => {
    const t = makeCore();
    t.settle();
    const fn = vi.fn();
    t.tools.onChange(fn);
    fn.mockClear();
    t.settle();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("ArticleTools：操作（一個 byte 都不送）", () => {
  test("選人 ⇒ 只列他的推文；再點一次 ⇒ 取消；大小寫不分", () => {
    const { tools, settle } = makeCore();
    settle();
    tools.selectUser("Bob");
    expect(tools.state.selectedUser).toBe("bob");
    expect(tools.state.selectedComments.map((c) => c.type)).toEqual(["推", "→", "推"]);
    tools.selectUser("bob");
    expect(tools.state).toMatchObject({ selectedUser: null, selectedComments: [] });
  });
  test("跳列 ⇒ easyReading.scrollToArticleRow；不在好讀文章裡 ⇒ 不動", () => {
    const t = makeCore();
    t.settle();
    expect(t.tools.jumpTo(12)).toBe(true);
    expect(t.scrolls).toEqual([12]);
    t.setPageState(2);
    expect(t.tools.jumpTo(5)).toBe(false);
    expect(t.scrolls).toEqual([12]);
  });
  test("複製網址／AID ⇒ clipboard，成功給提示；沒有 clipboard ⇒ 錯誤提示", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const t = makeCore();
    t.settle();
    expect(await t.tools.copyUrl()).toBe(true);
    expect(await t.tools.copyAid()).toBe(true);
    expect(writeText.mock.calls.map((c) => c[0])).toEqual([
      "https://www.ptt.cc/bbs/Test/M.1786265274.A.5E3.html",
      "#1gU3wwNZ",
    ]);
    expect(t.hints.map((h) => h.level)).toEqual([undefined, undefined]);
    vi.stubGlobal("navigator", {});
    expect(await t.tools.copyUrl()).toBe(false);
    expect(t.hints.pop().level).toBe(HINT_ERROR);
  });
  test("clipboard 被拒 ⇒ 錯誤提示", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.reject(new Error("denied")) } });
    const t = makeCore();
    t.settle();
    expect(await t.tools.copyAid()).toBe(false);
    expect(t.hints.pop().level).toBe(HINT_ERROR);
  });
  test("沒有 AID（網址列還沒出現）⇒ 網址／AID 都是 null，複製給錯誤提示", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
    const t = makeCore();
    t.core.aidNavigation.findLocalPostAid = () => null;
    t.settle();
    expect(t.tools.state).toMatchObject({ aid: null, url: null });
    expect(await t.tools.copyUrl()).toBe(false);
  });
  test("收起記在 localStorage，下一個控制器沿用", () => {
    const t = makeCore();
    t.tools.setCollapsed(true);
    expect(store.get(ARTICLE_TOOLS_COLLAPSED_KEY)).toBe("1");
    expect(makeCore().tools.state.collapsed).toBe(true);
    t.tools.setCollapsed(false);
    expect(store.has(ARTICLE_TOOLS_COLLAPSED_KEY)).toBe(false);
  });
});
