// 看板分頁（src/js/board_tabs.js、docs/board-tabs.md）：
//   - 畫面認法：只有「標題列有《板名》＋底列是文章列表 caption」才記、才顯示；
//   - 分頁清單：照第一次去的先後、已有只更新時間、滿了丟最久沒去的（不丟剛到的）、存本機；
//   - 至少兩個分頁才顯示；點現在這個板不送鍵；現在這個板關不掉。
const prefOverride = vi.hoisted(() => ({}));
vi.mock("../../src/js/pref_storage", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, readEffectivePrefs: () => ({ ...real.readEffectivePrefs(), ...prefOverride }) };
});
const submitted = vi.hoisted(() => []);
vi.mock("../../src/js/article_search", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, submitSearch: (core, kind, name) => (submitted.push([kind, name]), true) };
});
import { DEFAULT_PREFS, NATIVE_SAFE_MODE_KEYS, effectivePrefs } from "../../src/js/pref_storage";
import {
  BoardTabs,
  articleListBoardOf,
  visitBoard,
  closeBoardTab,
  BOARD_TABS_KEY,
  BOARD_TABS_MAX,
} from "../../src/js/board_tabs";

const ROWS = 24;
function listScreen(board, footer = " 文章選讀  (y)回應(X)推文") {
  const t = new Array(ROWS).fill("");
  t[0] = "【板主:someone】 中文描述                看板《" + board + "》";
  t[1] = "[←]離開 [→]閱讀";
  t[2] = "  編號    日 期 作  者       文  章  標  題";
  t[ROWS - 1] = footer;
  return t;
}

describe("articleListBoardOf", () => {
  test("文章列表（新舊 caption、搜尋結果）⇒ 板名", () => {
    expect(articleListBoardOf(listScreen("C_Chat"))).toBe("C_Chat");
    expect(articleListBoardOf(listScreen("Stock", " 文章列表  (y)回應"))).toBe("Stock");
    expect(articleListBoardOf(listScreen("Stock", " 系列文章  (y)回應"))).toBe("Stock");
  });
  test("看板列表、信箱、文章、底列是 prompt ⇒ null", () => {
    expect(articleListBoardOf(listScreen("C_Chat", " 看板列表  (c)新文章"))).toBeNull();
    expect(articleListBoardOf(listScreen("C_Chat", " 信件列表  (y)回信"))).toBeNull();
    expect(articleListBoardOf(listScreen("C_Chat", "請輸入看板名稱(按空白鍵自動搜尋): "))).toBeNull();
    const t = listScreen("C_Chat");
    t[0] = "【板主:someone】";
    expect(articleListBoardOf(t)).toBeNull();
  });
});

describe("分頁清單", () => {
  test("照第一次去的先後；已有只更新時間（位置不動、大小寫不分）", () => {
    let t = visitBoard([], "C_Chat", 1);
    t = visitBoard(t, "Stock", 2);
    t = visitBoard(t, "c_chat", 3);
    expect(t).toEqual([
      { name: "C_Chat", at: 3 },
      { name: "Stock", at: 2 },
    ]);
  });
  test(`超過 ${BOARD_TABS_MAX} 個 ⇒ 丟掉最久沒去的，不丟剛到的`, () => {
    let t = [];
    for (let i = 0; i < BOARD_TABS_MAX; ++i) t = visitBoard(t, "B" + i, 10 + i);
    t = visitBoard(t, "B0", 100); // B0 剛去過 ⇒ 最久沒去的是 B1
    t = visitBoard(t, "New", 101);
    expect(t.map((x) => x.name)).toEqual(["B0", "B2", "B3", "B4", "B5", "New"]);
  });
  test("關掉", () => {
    expect(closeBoardTab([{ name: "A", at: 1 }, { name: "B", at: 2 }], "a")).toEqual([{ name: "B", at: 2 }]);
  });
});

function memoryStorage(init) {
  const m = new Map(init ? [[BOARD_TABS_KEY, JSON.stringify(init)]] : []);
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

function makeCore(storage) {
  const listeners = {};
  let t = listScreen("C_Chat");
  const hints = [];
  const core = {
    mobile: false,
    buf: {
      rows: ROWS,
      cols: 80,
      getRowText: (r) => t[r] || "",
      addEventListener: (name, fn) => (listeners[name] = fn),
    },
    view: {
      chh: 30,
      mainDisplay: { getBoundingClientRect: () => ({ left: 35, top: 40, width: 1200, height: 720 }) },
      flashListHint: (msg) => hints.push(msg),
    },
  };
  const tabs = new BoardTabs(core, { storage });
  return {
    tabs,
    hints,
    show: (screen) => {
      t = screen;
      listeners.screenSettled();
    },
  };
}

beforeEach(() => {
  submitted.length = 0;
});

describe("BoardTabs 控制器", () => {
  test("預設開；點分頁會送鍵 ⇒ 在安全模式名單內", () => {
    expect(DEFAULT_PREFS.enableBoardTabs).toBe(true);
    expect(NATIVE_SAFE_MODE_KEYS).toContain("enableBoardTabs");
    expect(effectivePrefs({ ...DEFAULT_PREFS, nativeSafeMode: true }).enableBoardTabs).toBe(false);
  });

  test("只有一個板 ⇒ 不顯示；去過第二個板 ⇒ 兩個分頁、疊在終端機第 1 列，存進本機", () => {
    const storage = memoryStorage();
    const { tabs, show } = makeCore(storage);
    show(listScreen("C_Chat"));
    expect(tabs.state.visible).toBe(false);
    show(listScreen("Stock"));
    expect(tabs.state).toMatchObject({
      visible: true,
      tabs: ["C_Chat", "Stock"],
      current: "Stock",
      left: 35,
      top: 70,
      width: 1200,
      rowHeight: 30,
    });
    expect(JSON.parse(storage.map.get(BOARD_TABS_KEY)).map((x) => x.name)).toEqual(["C_Chat", "Stock"]);
  });

  test("開站讀回上次的分頁；不是文章列表（文章、看板列表）⇒ 不顯示也不記", () => {
    const { tabs, show } = makeCore(memoryStorage([{ name: "Stock", at: 1 }]));
    show(listScreen("C_Chat", " 看板列表  (c)新文章"));
    expect(tabs.state.visible).toBe(false);
    expect(tabs.state.tabs).toEqual(["Stock"]);
    show(listScreen("C_Chat"));
    expect(tabs.state).toMatchObject({ visible: true, tabs: ["Stock", "C_Chat"] });
  });

  test("搜尋結果／文摘（新舊 caption）⇒ 照記、但不顯示也不送：子列表裡 s<板> 落地仍是子列表", () => {
    // bbs.c#do_select 不清 MODE_SELECT／MODE_DIGEST ⇒ 從子列表點分頁會進到別板的搜尋結果／文摘，
    // 不是那個板的列表、也不回 getkeep 記的位置（docs/pttbbs-screen-protocol.md §8.1）。
    const { tabs, show } = makeCore(memoryStorage([{ name: "Stock", at: 1 }]));
    show(listScreen("C_Chat", " 系列文章  (y)回應"));
    expect(tabs.state.visible).toBe(false);
    expect(tabs.state.tabs).toEqual(["Stock", "C_Chat"]);
    show(listScreen("C_Chat", " 文摘列表  (y)回應"));
    expect(tabs.state.visible).toBe(false);
    const oldSelect = listScreen("C_Chat");
    oldSelect[0] = "【板主:someone】 中文描述                系列《C_Chat》";
    show(oldSelect);
    expect(tabs.state.visible).toBe(false);
    expect(tabs.open("Stock")).toBe(false);
    expect(submitted).toEqual([]);
    show(listScreen("C_Chat", " 文章列表  (y)回應"));
    expect(tabs.state.visible).toBe(true);
  });

  test("點別的板 ⇒ 原生 s<板>⏎（submitSearch board）；點現在這個板不送", () => {
    const { tabs, show } = makeCore(memoryStorage([{ name: "Stock", at: 1 }]));
    show(listScreen("C_Chat"));
    expect(tabs.open("C_Chat")).toBe(false);
    expect(tabs.open("Stock")).toBe(true);
    expect(submitted).toEqual([["board", "Stock"]]);
  });

  test("關掉別的板；剩一個就收起；現在這個板關不掉", () => {
    const storage = memoryStorage([{ name: "Stock", at: 1 }]);
    const { tabs, show } = makeCore(storage);
    show(listScreen("C_Chat"));
    expect(tabs.close("C_Chat")).toBe(false);
    expect(tabs.close("Stock")).toBe(true);
    expect(tabs.state).toMatchObject({ visible: false, tabs: ["C_Chat"] });
    expect(JSON.parse(storage.map.get(BOARD_TABS_KEY)).map((x) => x.name)).toEqual(["C_Chat"]);
  });

  test("pref 關 ⇒ 不顯示", () => {
    const { tabs, show } = makeCore(memoryStorage([{ name: "Stock", at: 1 }]));
    prefOverride.enableBoardTabs = false;
    try {
      show(listScreen("C_Chat"));
      expect(tabs.state.visible).toBe(false);
    } finally {
      delete prefOverride.enableBoardTabs;
    }
  });

  test("localStorage 壞掉／丟例外 ⇒ 照常用，從空的開始", () => {
    const broken = { getItem: () => "{oops", setItem: () => { throw new Error("quota"); } };
    const { tabs, show } = makeCore(broken);
    show(listScreen("C_Chat"));
    show(listScreen("Stock"));
    expect(tabs.state.tabs).toEqual(["C_Chat", "Stock"]);
  });
});
