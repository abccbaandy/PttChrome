// @unit-env browser
// 搜尋彈窗的純邏輯（src/js/article_search.js）：攔截判準、prompt 指紋、送出序列。
//
// 守的症狀：
//   1. PTT 原生的輸入記憶被列表好讀的跳號污染 ⇒ / ? a Z 改開彈窗（使用者回報：
//      ↑ 叫回來全是文章編號）。
//   2. 搜尋鍵沒被 PTT 接受時，關鍵字的字母**絕不**可以落回列表按鍵（a/Z/s 全是指令）
//      ⇒ 第二步只在 prompt 真的出現後才送。
//   3. 沒開成彈窗就不准吞鍵。
import { loadBig5Tables } from "./helpers/load_big5_tables";
import {
  availableSearchKinds,
  buildSearchSteps,
  isSearchPromptFrame,
  normalizeSearchText,
  searchKindOfKey,
  SEARCH_INFLIGHT_MAX_MS,
  shouldInterceptSearchKey,
  submitSearch,
  tryOpenSearchModal,
} from "../../src/js/article_search";
import { CommandQueue } from "../../src/js/command_queue";
import { BoardListSession } from "../../src/js/board_list_session";
import { serializedOpHint } from "../../src/js/serialized_op_gate";
import { writeValues, readValuesWithDefault } from "../../src/js/pref_storage";

beforeAll(() => {
  loadBig5Tables();
});

beforeEach(() => {
  localStorage.clear();
});

const ROWS = 24;
const blank = () => Array.from({ length: ROWS }, () => "");

function articleList(over) {
  const rowTexts = blank();
  rowTexts[0] = " 【板主:none】看板《Test》";
  rowTexts[23] = " 文章選讀  (y)回應(X)推文(^X)轉錄 ";
  return { rowTexts, rows: ROWS, curX: 0, curY: 5, inputField: false, listOwner: null, ...over };
}
function boardList() {
  const rowTexts = blank();
  rowTexts[0] = "【看板列表】 批踢踢實業坊";
  rowTexts[1] =
    "[←][q]回上層 [→][r]閱\讀 [↑↓]選擇 [PgUp][PgDn]翻頁 [c]新文章 [/]搜尋 [h]求助";
  rowTexts[2] =
    "   編號   看  板       類別   中   文   敘   述               人氣 板   主";
  rowTexts[23] = "  選擇看板    (m)加入/移出最愛 (y)只列最愛 (v/V)已讀/未讀 ";
  return { rowTexts, rows: ROWS, curX: 0, curY: 3, inputField: false, listOwner: null };
}
function mainMenu() {
  const rowTexts = blank();
  rowTexts[0] = "【主功能表】                       批踢踢實業坊";
  return { rowTexts, rows: ROWS, curX: 0, curY: 10, inputField: false, listOwner: null };
}
function promptFrame(row, text, curY) {
  const f = articleList();
  f.rowTexts[row] = text;
  f.curY = curY;
  return f;
}

describe("searchKindOfKey", () => {
  test("/ ? a Z s 對到種類；小寫 z（精華區）不攔", () => {
    expect(searchKindOfKey("/")).toBe("title");
    expect(searchKindOfKey("?")).toBe("title");
    expect(searchKindOfKey("a")).toBe("author");
    expect(searchKindOfKey("Z")).toBe("push");
    expect(searchKindOfKey("s")).toBe("board");
    expect(searchKindOfKey("z")).toBeNull();
    expect(searchKindOfKey("S")).toBeNull();
    expect(searchKindOfKey("A")).toBeNull();
  });
});

describe("availableSearchKinds", () => {
  test("文章列表：四種全開", () => {
    expect(availableSearchKinds(articleList())).toEqual(["title", "author", "push", "board"]);
  });
  test("列表好讀接管中（listOwner）同樣算文章列表", () => {
    const f = articleList({ listOwner: "article-list" });
    f.rowTexts[23] = "";
    expect(availableSearchKinds(f)).toHaveLength(4);
  });
  test("看板列表與主功能表：只有看板", () => {
    expect(availableSearchKinds(boardList())).toEqual(["board"]);
    expect(availableSearchKinds(mainMenu())).toEqual(["board"]);
  });
  test("已有 prompt 開著（游標在輸入欄）⇒ 無", () => {
    expect(availableSearchKinds(articleList({ inputField: true }))).toEqual([]);
  });
  test("其他畫面（文章等）⇒ 無", () => {
    const f = { rowTexts: blank(), rows: ROWS, curY: 23, inputField: false };
    f.rowTexts[23] = "  瀏覽 第 1/2 頁 ( 45%)  目前顯示: 第 1~23 行  (y)回應(X%)推文(h)說明(←)離開 ";
    expect(availableSearchKinds(f)).toEqual([]);
    expect(availableSearchKinds(null)).toEqual([]);
  });
});

describe("shouldInterceptSearchKey", () => {
  const prefs = { searchKeyOpensModal: true };
  test("文章列表按 / → 攔", () => {
    expect(shouldInterceptSearchKey({ key: "/", prefs, facts: articleList() })).toBe(true);
  });
  test.each([
    ["文章列表", articleList],
    ["看板列表", boardList],
    ["主功能表", mainMenu],
  ])("%s按 s（切看板）→ 攔", (_n, make) => {
    expect(shouldInterceptSearchKey({ key: "s", prefs, facts: make() })).toBe(true);
  });
  test("看板列表按 a／Z 不攔（那裡只有看板搜尋）", () => {
    expect(shouldInterceptSearchKey({ key: "a", prefs, facts: boardList() })).toBe(false);
    expect(shouldInterceptSearchKey({ key: "Z", prefs, facts: boardList() })).toBe(false);
  });
  test("其他畫面（非主功能表的選單等）按 s 不攔", () => {
    const f = { rowTexts: blank(), rows: ROWS, curY: 5, inputField: false };
    f.rowTexts[0] = "【分類看板】";
    expect(shouldInterceptSearchKey({ key: "s", prefs, facts: f })).toBe(false);
  });
  test.each([
    ["pref 關掉", { key: "/", prefs: { searchKeyOpensModal: false }, facts: articleList() }],
    ["帶 Ctrl", { key: "a", ctrlKey: true, prefs, facts: articleList() }],
    ["帶 Alt", { key: "a", altKey: true, prefs, facts: articleList() }],
    ["看板列表的 /（是看板中文關鍵字，另一種 prompt）", { key: "/", prefs, facts: boardList() }],
    ["prompt 開著時打的 a 是內容", { key: "a", prefs, facts: articleList({ inputField: true }) }],
    ["非搜尋鍵", { key: "x", prefs, facts: articleList() }],
  ])("%s → 不攔", (_n, opts) => {
    expect(shouldInterceptSearchKey(opts)).toBe(false);
  });
});

describe("isSearchPromptFrame（pttbbs read.c#ask_filter_predicate 的字串）", () => {
  test.each([
    ["title", "搜尋標題: abc"],
    ["title", "增加條件 標題: "],
    ["author", "搜尋作者: "],
    ["author", "增加條件 作者: "],
    ["push", "搜尋推文數高於多少 (<0則搜噓文數) 的文章: "],
    ["push", "增加條件 推文數: "],
  ])("%s 認得「%s」", (kind, text) => {
    expect(isSearchPromptFrame(kind, promptFrame(23, text, 23))).toBe(true);
  });
  test("看板：第 1 列兩段式 prompt", () => {
    const f = promptFrame(1, "請輸入看板名稱(按空白鍵自動搜尋): ", 1);
    expect(isSearchPromptFrame("board", f)).toBe(true);
  });
  test("字對了但游標不在那一列 ⇒ 不算", () => {
    expect(isSearchPromptFrame("title", promptFrame(23, "搜尋標題: ", 5))).toBe(false);
  });
  test("跳號 prompt 不是搜尋 prompt", () => {
    expect(isSearchPromptFrame("title", promptFrame(23, " 跳至第幾項: ", 23))).toBe(false);
  });
});

describe("normalizeSearchText", () => {
  test("推文數只收非零整數（PTT 端 atoi==0 當取消）", () => {
    expect(normalizeSearchText("push", " 10 ")).toBe("10");
    expect(normalizeSearchText("push", "-5")).toBe("-5");
    expect(normalizeSearchText("push", "0")).toBe("");
    expect(normalizeSearchText("push", "abc")).toBe("");
  });
  test("看板名稱只收 ASCII（namecomplete 是 VGET_ASCII_ONLY）", () => {
    expect(normalizeSearchText("board", "C_Chat")).toBe("C_Chat");
    expect(normalizeSearchText("board", "八卦")).toBe("");
  });
  test("空白一律不送", () => {
    expect(normalizeSearchText("title", "   ")).toBe("");
  });
  // read.c#ask_filter_predicate 的 getdata 欄寬：推文數 7、作者 IDLEN+1(13)、標題
  // TTLEN(64)；vgetstring 最多收「欄寬 − 1」個 byte，多打的只會響 bell 被丟掉 ⇒
  // 送出去的條件跟使用者輸入的不一樣（-123456 → -12345）。超過就不送，讓彈窗擋下。
  test("超過 server 輸入欄寬的不送（推文數 6 字、作者 12 字、標題 63 bytes）", () => {
    expect(normalizeSearchText("push", "-12345")).toBe("-12345");
    expect(normalizeSearchText("push", "-123456")).toBe("");
    expect(normalizeSearchText("push", "123456")).toBe("123456");
    expect(normalizeSearchText("push", "1234567")).toBe("");
    expect(normalizeSearchText("author", "abcdefghijkl")).toBe("abcdefghijkl");
    expect(normalizeSearchText("author", "abcdefghijklm")).toBe("");
    // 標題按 Big5 byte 算：全形 2 bytes。
    expect(normalizeSearchText("title", "測".repeat(31) + "a")).toBe("測".repeat(31) + "a");
    expect(normalizeSearchText("title", "測".repeat(32))).toBe("");
  });
});

describe("buildSearchSteps", () => {
  test("兩步：搜尋鍵 → 關鍵字（Big5）＋Enter", () => {
    const steps = buildSearchSteps("title", "問卦");
    expect(steps.map((s) => s.kind)).toEqual(["search-open", "search-submit"]);
    expect(steps[0].keys).toBe("/");
    // 問卦 的 Big5，不是 UTF-16 原字
    expect(steps[1].keys).toBe("\xb0\xdd\xa8\xf6\r");
  });
  test.each([
    ["author", "a"],
    ["push", "Z"],
    ["board", "s"],
  ])("%s 用 %s 開 prompt", (kind, key) => {
    expect(buildSearchSteps(kind, "10")[0].keys).toBe(key);
  });
  test("沒有可送的內容 ⇒ null", () => {
    expect(buildSearchSteps("push", "0")).toBeNull();
  });
});

describe("submitSearch（原生：共用 CommandQueue）", () => {
  function nativeCore() {
    const sent = [];
    const timers = [];
    const queue = new CommandQueue({
      send: (d) => sent.push(d),
      setTimeout: (fn) => (timers.push(fn), timers.length),
      clearTimeout: () => {},
    });
    return { core: { commandQueue: queue, activeListSession: () => null }, queue, sent };
  }

  test("prompt 出現後才送關鍵字", () => {
    const { core, queue, sent } = nativeCore();
    expect(submitSearch(core, "author", "someone")).toBe(true);
    expect(sent).toEqual(["a\f"]);
    // 中間有一幀不是 prompt（例如列表重繪）：關鍵字不可以出去
    queue.onSettle(null, articleList());
    expect(sent).toEqual(["a\f"]);
    queue.onSettle(null, promptFrame(23, "搜尋作者: ", 23));
    expect(sent).toEqual(["a\f", "someone\r"]);
  });

  test("prompt 一直沒出現（探針幀也不是）⇒ 關鍵字絕不送、回報失敗", () => {
    const { core, queue, sent } = nativeCore();
    const onFail = vi.fn();
    submitSearch(core, "push", "10", { onFail });
    queue._timedOut(queue._inFlight); // soft timeout → \f 探針
    queue.onSettle(null, articleList()); // 探針幀仍是列表
    expect(sent).toEqual(["Z\f", "\f"]);
    expect(onFail).toHaveBeenCalled();
  });
});

// REGRESSION（live 錄製檔：`/\f` → End → `\r` 插隊，關鍵字沒送）：兩步在途時
// serialized_op_gate 必須擋住使用者的鍵；任一終局都要解除（漏一條＝永久吞鍵）。
describe("searchInFlight（序列化操作閘門）", () => {
  function nativeCore() {
    const sent = [];
    const queue = new CommandQueue({
      send: (d) => sent.push(d),
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    return { core: { commandQueue: queue, activeListSession: () => null }, queue, sent };
  }

  test("送出後到第二步收尾之間，閘門回提示；收尾後解除", () => {
    const { core, queue } = nativeCore();
    submitSearch(core, "title", "abc");
    expect(serializedOpHint(core)).toBe("搜尋中，請稍候…");
    queue.onSettle(null, promptFrame(23, "搜尋標題: ", 23));
    expect(serializedOpHint(core)).toBe("搜尋中，請稍候…"); // 關鍵字剛上線
    queue.onSettle(null, articleList());
    expect(core.searchInFlight).toBe(false);
    expect(serializedOpHint(core)).toBeNull();
  });

  test("prompt 沒出現（失敗）⇒ 解除", () => {
    const { core, queue } = nativeCore();
    submitSearch(core, "title", "abc", { onFail: vi.fn() });
    queue._timedOut(queue._inFlight);
    queue.onSettle(null, articleList());
    expect(core.searchInFlight).toBe(false);
  });

  test("被 flush（例如離開畫面）⇒ 解除", () => {
    const { core, queue } = nativeCore();
    submitSearch(core, "title", "abc");
    queue.flush();
    expect(core.searchInFlight).toBe(false);
  });

  test("保底計時器：任何終局都沒來也會在 SEARCH_INFLIGHT_MAX_MS 後解除", () => {
    vi.useFakeTimers();
    try {
      const core = { commandQueue: { enqueue: vi.fn() }, activeListSession: () => null };
      submitSearch(core, "title", "abc");
      expect(core.searchInFlight).toBe(true);
      vi.advanceTimersByTime(SEARCH_INFLIGHT_MAX_MS + 1);
      expect(core.searchInFlight).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("沒送出（session 忙）⇒ 不立旗標", () => {
    const core = {
      commandQueue: {},
      activeListSession: () => ({ state: "opening", _beginPassthroughBytes: vi.fn() }),
    };
    submitSearch(core, "title", "abc");
    expect(core.searchInFlight).toBeFalsy();
  });
});

describe("submitSearch（列表 session 接管中）", () => {
  test("交給 session 的多步 passthrough，不直接碰佇列", () => {
    const session = { state: "active", _beginPassthroughBytes: vi.fn() };
    const queue = { enqueue: vi.fn() };
    const ok = submitSearch(
      { commandQueue: queue, activeListSession: () => session },
      "title",
      "abc",
    );
    expect(ok).toBe(true);
    expect(queue.enqueue).not.toHaveBeenCalled();
    const [steps, opts] = session._beginPassthroughBytes.mock.calls[0];
    expect(steps.map((s) => s.keys)).toEqual(["/", "abc\r"]);
    expect(opts.kind).toBe("search");
  });
  test("session 正在開文 ⇒ 回 false（呼叫端提示），不送", () => {
    const session = { state: "opening", _beginPassthroughBytes: vi.fn() };
    expect(
      submitSearch({ commandQueue: {}, activeListSession: () => session }, "title", "abc"),
    ).toBe(false);
    expect(session._beginPassthroughBytes).not.toHaveBeenCalled();
  });
});

describe("看板列表 session 的多步 passthrough（s → 等 prompt → 板名）", () => {
  test("第二步只在第一步 expect 成立後才排；kind 帶 brd- 前綴（佇列所有權）", () => {
    const sent = [];
    const queue = new CommandQueue({
      send: (d) => sent.push(d),
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    const ctx = {
      state: "active",
      _selectedNum: null,
      _queue: queue,
      _view: {},
      _enterNative: vi.fn(),
      _enqueuePassthroughStep: BoardListSession.prototype._enqueuePassthroughStep,
    };
    BoardListSession.prototype._beginPassthroughBytes.call(
      ctx,
      buildSearchSteps("board", "C_Chat"),
      { kind: "search", hint: null },
    );
    expect(sent).toEqual(["s\f"]);
    expect(queue.inFlightKind).toBe("brd-search-open");
    queue.onSettle(null, boardList()); // 還不是 prompt
    expect(sent).toEqual(["s\f"]);
    queue.onSettle(null, promptFrame(1, "請輸入看板名稱(按空白鍵自動搜尋): ", 1));
    expect(sent).toEqual(["s\f", "C_Chat\r\f"]);
    expect(queue.inFlightKind).toBe("brd-search-submit");
  });
});

describe("tryOpenSearchModal", () => {
  function coreOnArticleList(opens) {
    const f = articleList();
    return {
      buf: {
        rows: ROWS,
        cols: 80,
        cur_x: 0,
        cur_y: 5,
        getRowText: (r) => f.rowTexts[r],
        isCursorOnInputField: () => false,
        listRenderMode: "native",
      },
      openSearchModal: vi.fn(() => opens),
    };
  }
  test("預設 pref 開著：文章列表按 a → 開彈窗（種類 author）", () => {
    const core = coreOnArticleList(true);
    expect(tryOpenSearchModal(core, "a", { ctrlKey: false })).toBe(true);
    expect(core.openSearchModal).toHaveBeenCalledWith("author");
  });
  test("openSearchModal 沒開成 ⇒ 回 false（不准吞鍵）", () => {
    const core = coreOnArticleList(undefined);
    expect(tryOpenSearchModal(core, "/", null)).toBe(false);
  });
  test("pref 關掉 ⇒ 連問都不問", () => {
    writeValues({ ...readValuesWithDefault(), searchKeyOpensModal: false });
    const core = coreOnArticleList(true);
    expect(tryOpenSearchModal(core, "/", null)).toBe(false);
    expect(core.openSearchModal).not.toHaveBeenCalled();
  });
});
