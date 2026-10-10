// @unit-env browser
// 「解析失敗 ⇒ 降級原生」的高可用守護。
//
// 列表好讀／看板列表平滑捲動／文章好讀／跳過進板畫面這類功能會**接管或改寫 PTT 的
// 原生畫面行為**，它們靠畫面指紋判斷「現在是哪一種畫面」。PTT 改版或我們解錯時，
// 唯一可接受的結果是：認不出 ⇒ 不接管、不送鍵、照原生畫面顯示（使用者照樣能用）；
// 已接管中認不出 ⇒ 切回原生。絕不能是「認錯 ⇒ 送錯鍵／畫錯清單」。
//
// 兩半：
//   1. 真實畫面（C_Chat、LoL）× 一組「改版／解錯」突變 ⇒ 每個分類器都必須回「不是我的」
//   2. session 層：idle 收到認不出的幀不 engage、不送命令；active 收到 ⇒ functionMode
//      （原生鏡像）
//
// 另含 LoL 回歸：看板描述太長時 server 會整段省略「看板《LoL》」
// （vtuikit.c#vs_draw_header `szmid + szright > w ⇒ szright = 0`），曾被誤判成
// 非文章列表 ⇒ 永遠停在原生（2026-10-09 錄製檔）。
import cchat from "./fixtures/replay/cchat-list.page.json";
import lol from "./fixtures/replay/lol-list-no-board-name.page.json";
import {
  ListSession,
  classifyListScreen,
  isJumpParkedListScreen,
} from "../../src/js/list_session";
import {
  boardNameFromKey,
  isArticleListTitleRow,
  parseBoardKey,
  parseBoardName,
} from "../../src/js/screen_titles";
import {
  boardListContextKind,
  classifyBoardListScreen,
} from "../../src/js/board_list_parse";
import { boardNoteDecision } from "../../src/js/board_note_skip";
import { landedOnBoard } from "../../src/js/aid_navigation";
import { functionModeExitDecision } from "../../src/js/easy_reading";
import { parseStatusRow } from "../../src/js/string_util";

const LISTS = {
  "C_Chat（24 列，有《板名》）": {
    rows: cchat.pageScreens[0],
    curX: 1,
    curY: 3,
  },
  "LoL（28 列，《板名》被省略）": {
    rows: lol.pageScreens[0],
    curX: lol.cursor.curX,
    curY: lol.cursor.curY,
  },
};

function listFacts(src, overrides = {}) {
  const rowTexts = src.rows.slice();
  return {
    rowTexts,
    rows: rowTexts.length,
    curX: src.curX,
    curY: src.curY,
    row0Reversed: true,
    row2Reversed: true,
    ...overrides,
  };
}

// 「PTT 改版／我們解錯」的模擬。每一條都只動一個指紋要素，其餘維持真實畫面。
const LIST_MUTATIONS = {
  "標題列改版（沒有【板主】也沒有《板名》）": (f) => {
    f.rowTexts[0] = " 批踢踢實業坊 新版標題列 ";
  },
  "標題列沒反白": (f) => {
    f.row0Reversed = false;
  },
  "表頭「編號」改名": (f) => {
    f.rowTexts[2] = f.rowTexts[2].replace("編號", "序號");
  },
  "表頭沒反白": (f) => {
    f.row2Reversed = false;
  },
  "底列 caption 改版": (f) => {
    f.rowTexts[f.rows - 1] = " 新版列表  (y)回應 (X)推文 ";
  },
  "底列還沒畫（半繪）": (f) => {
    f.rowTexts[f.rows - 1] = "";
  },
  "條目列格式改版（編號解不出來）": (f) => {
    for (let i = 3; i <= f.rows - 2; ++i)
      f.rowTexts[i] = "  ＃" + i + "  某作者  某標題";
  },
  "整頁往下錯一列（多了一列公告）": (f) => {
    f.rowTexts.splice(1, 0, "  [公告] 新版功能說明");
    f.rowTexts.length = f.rows;
  },
  "游標停在底列（PTT 在等輸入）": (f) => {
    f.curY = f.rows - 1;
  },
  "游標停在列中（prompt 疊在列表上）": (f) => {
    f.curX = 30;
  },
  "游標停在表頭": (f) => {
    f.curY = 1;
  },
};

function mutated(src, mutate) {
  const f = listFacts(src);
  mutate(f);
  return f;
}

// ---------------------------------------------------------------------------
// LoL 回歸（純函式）
// ---------------------------------------------------------------------------

describe("看板身分鍵：「看板《X》」被 server 省略也認得出文章列表", () => {
  const lolRow0 = lol.pageScreens[0][0];

  test("錄製檔確實沒有《板名》（素材自我檢查）", () => {
    expect(parseBoardName(lolRow0)).toBeNull();
  });

  test("LoL 真實畫面 → clean-list，身分鍵＝整條標題列", () => {
    const cls = classifyListScreen(listFacts(LISTS["LoL（28 列，《板名》被省略）"]));
    expect(cls.kind).toBe("clean-list");
    expect(cls.boardName).toBe(lolRow0.trim());
  });

  test("身分鍵不是真板名：不可拿去 `s` 跳板", () => {
    expect(boardNameFromKey(parseBoardKey(lolRow0))).toBeNull();
    expect(boardNameFromKey(parseBoardKey(cchat.pageScreens[0][0]))).toBe("C_Chat");
  });

  test("不同板的身分鍵不同（不可把兩板的編號混進同一個緩衝）", () => {
    const other = "【板主:someone】[閒聊] 另一個描述很長很長很長很長很長很長的看板";
    expect(parseBoardKey(other)).not.toBe(parseBoardKey(lolRow0));
  });

  test("currBM 的兩種形狀（板主:xxx、徵求中）與截斷的 `..` 都認", () => {
    expect(isArticleListTitleRow("【徵求中】[測試] 很長的描述")).toBe(true);
    expect(isArticleListTitleRow("【板主:aaa/bbb/c..】很長的描述")).toBe(true);
  });

  test("其他【】標題不是文章列表", () => {
    for (const t of ["【主功能表】 批踢踢實業坊", "【分類看板】", "【精華文章】", "【 設定 】"])
      expect(isArticleListTitleRow(t)).toBe(false);
    expect(isArticleListTitleRow("")).toBe(false);
    expect(isArticleListTitleRow(null)).toBe(false);
  });

  test("跳號落點（底列空）也認得出 LoL", () => {
    const f = listFacts(LISTS["LoL（28 列，《板名》被省略）"]);
    f.rowTexts[f.rows - 1] = "";
    expect(isJumpParkedListScreen(f)).toBe(true);
  });

  test("看板列表 session 認得出「進到 LoL 了」（否則 Enter 進板的交易永遠等不到落地）", () => {
    expect(boardListContextKind(listFacts(LISTS["LoL（28 列，《板名》被省略）"]))).toBe(
      "article-list"
    );
  });

  test("deep link 跳板：LoL 沒有板名可比也算落地；有板名就照比", () => {
    const lolCls = classifyListScreen(listFacts(LISTS["LoL（28 列，《板名》被省略）"]));
    expect(landedOnBoard(lolCls, "lol")).toBe(true);
    const cchatCls = classifyListScreen(listFacts(LISTS["C_Chat（24 列，有《板名》）"]));
    expect(landedOnBoard(cchatCls, "c_chat")).toBe(true);
    expect(landedOnBoard(cchatCls, "lol")).toBe(false);
    // 不是乾淨列表（prompt／半繪）一律不算落地
    expect(landedOnBoard({ ...lolCls, kind: "transient" }, "lol")).toBe(false);
  });

  test("跳過進板畫面：LoL 列表半繪（底列空、游標在底列）不得被當成公告送 ←（會離板）", () => {
    const f = listFacts(LISTS["LoL（28 列，《板名》被省略）"]);
    f.rowTexts[f.rows - 1] = "";
    f.curY = f.rows - 1;
    f.curX = 0;
    expect(boardNoteDecision(f).action).toBe("wait");
  });
});

// ---------------------------------------------------------------------------
// 1. 分類器：改版／解錯 ⇒ 一律「不是我的」
// ---------------------------------------------------------------------------

describe("文章列表指紋：真實畫面通過，任一要素壞掉就不接管", () => {
  for (const [name, src] of Object.entries(LISTS)) {
    test(`${name}：原樣 → clean-list（突變測試的對照組）`, () => {
      expect(classifyListScreen(listFacts(src)).kind).toBe("clean-list");
    });

    test.each(Object.entries(LIST_MUTATIONS))(`${name}：%s → 不是 clean-list`, (_m, mutate) => {
      expect(classifyListScreen(mutated(src, mutate)).kind).not.toBe("clean-list");
    });
  }
});

describe("看板列表指紋：認不出就不 engage", () => {
  const pad7 = (n) => String(n).padStart(7, " ");
  const brdRow = (n) => pad7(n) + "  " + ("B" + n).padEnd(13, " ") + "綜合  ｜閒聊｜ 測試看板";
  const base = () => {
    const rowTexts = [
      "【看板列表】 批踢踢實業坊",
      "[←][q]回上層 [↑↓]選擇",
      "   編號   看  板       類別   中   文   敘   述               人氣 板   主",
    ];
    for (let i = 0; i < 20; ++i) rowTexts.push(brdRow(i + 1));
    rowTexts.push("  選擇看板    (a)增加看板 (s)進入已知板名 (y)列出全部 (v/V)已讀/未讀");
    return { rowTexts, rows: 24, curX: 0, curY: 3 };
  };

  test("對照組：我的最愛 → 可 engage", () => {
    expect(classifyBoardListScreen(base()).engageable).toBe(true);
  });

  test.each([
    ["標題改版", (f) => (f.rowTexts[0] = " 看板總覽 ")],
    ["底列 caption 改版", (f) => (f.rowTexts[23] = " 新版選單 (a)加入 ")],
    ["底列還沒畫", (f) => (f.rowTexts[23] = "")],
    ["表頭改名", (f) => (f.rowTexts[2] = f.rowTexts[2].replace("編號", "序號"))],
    [
      "條目格式改版（編號解不出來）",
      (f) => {
        for (let i = 3; i <= 22; ++i) f.rowTexts[i] = "  ＃" + i + " 某看板";
      },
    ],
  ])("%s → 不可 engage", (_n, mutate) => {
    const f = base();
    mutate(f);
    const brd = classifyBoardListScreen(f);
    expect(!!(brd && brd.engageable)).toBe(false);
  });
});

describe("文章好讀：狀態列認不出 ⇒ 不進好讀；functionMode 認不出 ⇒ 繼續原生", () => {
  const STATUS = "  瀏覽 第 1/8 頁 ( 12%)  目前顯示: 第 01~23 行  (y)回應(X%)推文(h)說明(←)離開 ";

  test("對照組：真狀態列解析得出來", () => {
    expect(parseStatusRow(STATUS)).not.toBeNull();
  });

  test.each([
    ["措辭改版", "  閱讀 第 1/8 頁 ( 12%)  顯示 第 01~23 行  (←)離開 "],
    ["數字欄位改版", "  瀏覽 第 一/八 頁  目前顯示: 第 一~二三 行  (←)離開 "],
    ["半繪（只畫到一半）", "  瀏覽 第 1/8 "],
    ["空白", ""],
  ])("%s → null（pageState 不會變 3，好讀不接管）", (_n, row) => {
    expect(parseStatusRow(row)).toBeNull();
  });

  test.each([0, 5, 6])("functionMode 中落在認不出的畫面（pageState %i）→ stay 原生", (pageState) => {
    expect(
      functionModeExitDecision({ pageState, isStatusRow: false, curY: 23, lastRowNum: 23 })
    ).toBe("stay");
  });

  test("pageState 3 但游標不在狀態列（prompt 疊在文章上）→ stay，不得回好讀", () => {
    expect(
      functionModeExitDecision({ pageState: 3, isStatusRow: true, curY: 10, lastRowNum: 23 })
    ).toBe("stay");
  });
});

describe("跳過進板畫面：認不出的畫面一律等待，不送鍵", () => {
  test.each([
    ["空白畫面", new Array(24).fill("")],
    ["改版後的進板畫面（無任何已知指紋）", ["", "  歡迎來到本板", ...new Array(21).fill("  公告內文"), " 按任意鍵… "]],
    ["列表標題但其他列全是雜訊", [cchat.pageScreens[0][0], ...new Array(23).fill("雜訊")]],
  ])("%s → wait", (_n, rowTexts) => {
    expect(
      boardNoteDecision({ rowTexts, rows: 24, curX: 5, curY: 10 }).action
    ).toBe("wait");
  });
});

// ---------------------------------------------------------------------------
// 2. session 層：列表好讀
// ---------------------------------------------------------------------------

const PREF_KEY = "pttchrome.pref.v1";

function makeListSession(src) {
  const enqueued = [];
  const banners = [];
  const sent = [];
  const screen = {
    rows: src.rows.slice(),
    curX: src.curX,
    curY: src.curY,
    reversed: { 0: true, 2: true },
  };
  const view = {
    hideCursor() {},
    showCursor() {},
    resetListAccumulation() {},
    setListLoading() {},
    flashListHint: (m) => banners.push(m),
    blacklist: new Set(),
    titleBlacklist: [],
    chh: 20,
    componentScreen: { setListScrollTop() {}, getListScrollTop: () => 0 },
  };
  const termBuf = {
    rows: src.rows.length,
    cols: 80,
    listLines: [],
    listLineNums: [],
    lineChangeds: new Array(src.rows.length).fill(false),
    changed: false,
    startedEasyReading: false,
    settleSnapshot: null,
    getRowText: (r) => screen.rows[r] || "",
    // _collectFacts 只問 row 0／row 2 是不是整段反白。
    isUnicolor: (r) => screen.reversed[r] !== false,
    get cur_x() {
      return screen.curX;
    },
    get cur_y() {
      return screen.curY;
    },
    addEventListener() {},
    notify() {},
  };
  const queue = {
    idle: true,
    inFlightKind: null,
    flush() {},
    flushPending() {},
    flushPendingKind() {},
    hasKind: () => false,
    enqueue: (cmd) => enqueued.push(cmd),
    onSettle: () => null,
  };
  const s = new ListSession({ conn: { send: (d) => sent.push(d) } }, view, termBuf, queue);
  // 餵一幀「server 剛寫完、靜下來」的畫面。
  const feed = (facts) => {
    screen.rows = facts.rowTexts.slice();
    screen.curX = facts.curX;
    screen.curY = facts.curY;
    screen.reversed = { 0: facts.row0Reversed, 2: facts.row2Reversed };
    termBuf.settleSnapshot = {
      changedRows: new Set([0, facts.curY]),
      cursorMoved: true,
      curX: facts.curX,
      curY: facts.curY,
    };
    s._onScreenSettled();
  };
  return { s, feed, enqueued, banners, sent };
}

describe("列表好讀 session：認不出 ⇒ 原生", () => {
  beforeEach(() => {
    window.localStorage.setItem(
      PREF_KEY,
      JSON.stringify({ values: { enableEasyReadingList: true } })
    );
  });
  afterEach(() => window.localStorage.clear());

  for (const [name, src] of Object.entries(LISTS)) {
    test(`${name}：原樣 → idle 接管成 active（對照組）`, () => {
      const h = makeListSession(src);
      h.feed(listFacts(src));
      expect(h.s.state).toBe("active");
    });

    test.each(Object.entries(LIST_MUTATIONS))(
      `${name}：idle 收到「%s」→ 留在 idle，不送任何命令`,
      (_m, mutate) => {
        const h = makeListSession(src);
        h.feed(mutated(src, mutate));
        expect(h.s.state).toBe("idle");
        expect(h.s._renderMode).toBe("native");
        expect(h.enqueued).toEqual([]);
        expect(h.sent).toEqual([]);
      }
    );

    test.each(Object.entries(LIST_MUTATIONS))(
      `${name}：active 中途收到「%s」→ 切原生（functionMode）`,
      (_m, mutate) => {
        const h = makeListSession(src);
        h.feed(listFacts(src));
        expect(h.s.state).toBe("active");
        const f = mutated(src, mutate);
        h.feed(f);
        const cls = classifyListScreen(f);
        // menu／article 有自己的正規出口（離板 → idle、開文 → suspended）；
        // 其餘認不出的幀一律原生鏡像。
        if (cls.kind === "menu") expect(h.s.state).toBe("idle");
        else if (cls.kind === "article") expect(h.s.state).toBe("suspended");
        else expect(h.s.state).toBe("functionMode");
        expect(h.s._renderMode).toBe("native");
      }
    );
  }
});
