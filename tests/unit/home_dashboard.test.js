// 首頁儀表板（src/js/home_dashboard.js、docs/home-dashboard.md）：主功能表怎麼認、我的最愛
// 每一列怎麼讀、Ctrl+Z f → 讀頁 → 跳號 → 回游標 → q 的送鍵序列、收起與自動抓的時機。
// 畫面照 pttbbs 版面手寫：主功能表＝menu.c#menu_renderer，我的最愛＝board.c#brdlist_renderer。
import {
  isHomeScreen,
  hasNewMail,
  parseFavRow,
  favPage,
  mergeFavEntries,
  shouldFetchFavorites,
  pushRecentBoard,
  articleListBoard,
  keyDismissesHome,
  HomeDashboard,
  FAV_TTL_MS,
  FAV_MAX_PAGES,
  RECENT_LIMIT,
  AUTO_FETCH_DELAY_MS,
  HOME_FAV_FETCH_FLAG,
} from "../../src/js/home_dashboard";
import { serializedOpHint } from "../../src/js/serialized_op_gate";
import { HINT_ERROR } from "../../src/js/status_hint";

const ROWS = 24;
const ZA_FAV = "\x1af";
const ZA_MAIL = "\x1am";

// ── 主功能表（menu.c：標題列、上半 ANSI 圖、row 13 起選單項、底列狀態列）──────────
const MENU_ITEMS = [
  "(A)nnounce     【 精華公佈欄 】",
  "(F)avorite     【 我 的 最愛 】",
  "(C)lass        【 分組討論區 】",
  "(M)ail         【 私人信件區 】",
  "(G)oodbye         離開，再見…",
];
function mainMenu({ title = "主功能表", items = MENU_ITEMS, mail = false, inputField = false } = {}) {
  const rowTexts = Array.from({ length: ROWS }, () => "");
  rowTexts[0] = "【" + title + "】" + (mail ? "     你有新信件     " : "     ") + "批踢踢實業坊";
  rowTexts[1] = "┌────────┬───█──────┐";
  items.forEach((t, i) => (rowTexts[13 + i] = " ".repeat(20) + (i === 1 ? ">" : " ") + " " + t));
  rowTexts[ROWS - 1] = " 主選單   世界郵政日   10/9 週五 13:31 | someone | 線上24764人     (h)說明 ";
  return { rowTexts, rows: ROWS, curX: 20, curY: 14, inputField };
}

// ── 我的最愛（board.c#brdlist_renderer：%7d%c%s ＋板名(13)＋類別＋◎＋敘述）────────
const pad7 = (n) => String(n).padStart(7, " ");
// 中文敘述欄 34 格（brdlist_coldefs），全形算兩格，後面接人氣、板主。
const padCells = (s, n) => s + " ".repeat(Math.max(0, n - [...s].reduce((w, c) => w + (c.charCodeAt(0) < 0x80 ? 1 : 2), 0)));
const favRow = (num, name, { unread = false, desc = "測試看板", cursor = false } = {}) => {
  const head = pad7(num) + " " + (unread ? "ˇ" : "  ");
  return (cursor ? ">" + head.slice(1) : head) + name.padEnd(13, " ") + "綜合 ◎" + padCells(desc, 34) + "HOT someone";
};
const FAV_FOOT = "  選擇看板    (a)增加看板 (s)進入已知板名 (y)列出全部 (v/V)已讀/未讀";
const ALL_FOOT = "  選擇看板    (m)加入/移出最愛 (y)只列最愛 (v/V)已讀/未讀 ";
const HEADER_NUM = "   編號   看  板       類別   中   文   敘   述               人氣 板   主";
// entries：[{num, name, unread}]；body 從 row 3 起。cursorNum 那一列帶 `>`。
function favScreen(entries, { cursorNum, foot = FAV_FOOT, header = HEADER_NUM } = {}) {
  const rowTexts = Array.from({ length: ROWS }, () => "");
  rowTexts[0] = "【看板列表】                     批踢踢實業坊              看板《Test》";
  rowTexts[1] = "[←][q]回上層 [→][r]閱讀 [↑↓]選擇 [PgUp][PgDn]翻頁 [c]新文章 [/]搜尋 [h]求助";
  rowTexts[2] = header;
  const cur = cursorNum == null ? entries[0].num : cursorNum;
  let curY = 3;
  entries.forEach((e, i) => {
    rowTexts[3 + i] = favRow(e.num, e.name, { unread: e.unread, cursor: e.num === cur });
    if (e.num === cur) curY = 3 + i;
  });
  rowTexts[ROWS - 1] = foot;
  return { rowTexts, rows: ROWS, curX: 0, curY };
}
const boards = (from, to, unreadOf = () => false) => {
  const out = [];
  for (let n = from; n <= to; ++n) out.push({ num: n, name: "Board" + n, unread: unreadOf(n) });
  return out;
};

const ARTICLE_LIST = () => {
  const rowTexts = Array.from({ length: ROWS }, () => "");
  rowTexts[0] = "【板主:someone】                  看板《C_Chat》";
  rowTexts[ROWS - 1] = " 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面 ";
  return { rowTexts, rows: ROWS, curX: 0, curY: 3 };
};

describe("isHomeScreen：主功能表＋(F)avorite＋不在輸入欄", () => {
  test("主功能表 ⇒ 是", () => {
    expect(isHomeScreen(mainMenu())).toBe(true);
  });
  test.each([
    ["子選單（標題不是主功能表）", mainMenu({ title: "個人設定" })],
    ["主功能表沒有 (F)avorite", mainMenu({ items: MENU_ITEMS.filter((t) => !t.startsWith("(F)")) })],
    ["游標在輸入欄（prompt 開著）", mainMenu({ inputField: true })],
    ["我的最愛列表", favScreen(boards(1, 3))],
    ["文章列表", ARTICLE_LIST()],
  ])("%s ⇒ 不是", (_label, facts) => {
    expect(isHomeScreen(facts)).toBe(false);
  });
  test("沒有 facts ⇒ 不是", () => {
    expect(isHomeScreen(null)).toBe(false);
  });
});

test("hasNewMail：標題列中段的「你有新信件」（menu.c#redraw_title）", () => {
  expect(hasNewMail(mainMenu({ mail: true }).rowTexts[0])).toBe(true);
  expect(hasNewMail(mainMenu().rowTexts[0])).toBe(false);
});

describe("parseFavRow：我的最愛的一列", () => {
  test("一般看板：編號、板名、敘述", () => {
    expect(parseFavRow(favRow(3, "Gossiping", { desc: "[八卦]今天吃什麼" }))).toEqual({
      num: 3,
      name: "Gossiping",
      desc: "[八卦]今天吃什麼",
      unread: false,
    });
  });
  test("未讀「ˇ」在編號與板名之間；游標 `>` 不影響", () => {
    expect(parseFavRow(favRow(12, "C_Chat", { unread: true, cursor: true }))).toMatchObject({
      num: 12,
      name: "C_Chat",
      unread: true,
    });
  });
  test("新版 %6d 欄寬也讀得到（brdlist_renderer 的 col_num）", () => {
    const row = " " + String(5).padStart(6, " ") + " ˇ" + "Stock".padEnd(13, " ") + "學術 ◎[股票]今天漲了";
    expect(parseFavRow(row)).toMatchObject({ num: 5, name: "Stock", unread: true, desc: "[股票]今天漲了" });
  });
  test("真實錄製的一列（scn-boardlist-class）：敘述前面有空白", () => {
    expect(parseFavRow("      6   NCCU06_MJOUR 新研 ◎       一起邁向美好未來")).toMatchObject({
      name: "NCCU06_MJOUR",
      desc: "一起邁向美好未來",
    });
  });
  test("敘述只取 34 格，後面的人氣／板主不混進來", () => {
    const long = "一二三四五六七八九十一二三四五六七";
    const r = parseFavRow(pad7(1) + "   " + "Test".padEnd(13, " ") + "綜合 ◎" + long + "爆!  someone");
    expect(r.desc).toBe(long);
  });
  test("找不到 ◎Σ☆ 符號 ⇒ 敘述留空，不猜", () => {
    expect(parseFavRow(pad7(1) + "   " + "Test".padEnd(13, " ") + "綜合 測試").desc).toBe("");
  });
  test.each([
    ["分隔線", pad7(4) + "   " + "-".repeat(12) + "      " + "-".repeat(42)],
    ["目錄", pad7(5) + "   MyFavFolder  目錄 □我的分類"],
    ["禁入", pad7(6) + "X  " + "Secret".padEnd(13, " ") + "[禁入] <目前無法進入此看板>"],
    ["空白列", ""],
  ])("%s ⇒ null", (_label, row) => {
    expect(parseFavRow(row)).toBeNull();
  });
});

describe("favPage：一幀我的最愛", () => {
  test("讀出條目、頂號、最後一號、游標號；20 列都有編號才算滿", () => {
    const p = favPage(favScreen(boards(21, 40), { cursorNum: 25 }));
    expect(p).toMatchObject({ topNum: 21, lastNum: 40, cursorNum: 25, full: true, newflag: false });
    expect(p.entries).toHaveLength(20);
    expect(favPage(favScreen(boards(1, 7))).full).toBe(false);
  });
  test("按 y 列出全部看板（variant all）⇒ 不收", () => {
    expect(favPage(favScreen(boards(1, 3), { foot: ALL_FOOT }))).toBeNull();
  });
  test("按 c 的新文章模式（row2「總數」）⇒ 收，但標成 newflag", () => {
    const p = favPage(favScreen(boards(1, 3), { header: HEADER_NUM.replace("編號", "總數") }));
    expect(p.newflag).toBe(true);
  });
  test("主功能表 ⇒ null", () => {
    expect(favPage(mainMenu())).toBeNull();
  });
});

test("mergeFavEntries：依編號排、同號去重", () => {
  const a = [{ num: 2, name: "B", desc: "", unread: false }, { num: 1, name: "A", desc: "", unread: true }];
  const b = [{ num: 2, name: "B", desc: "x", unread: true }];
  expect(mergeFavEntries([a, b])).toEqual([
    { name: "A", desc: "", unread: true },
    { name: "B", desc: "x", unread: true },
  ]);
});

test("shouldFetchFavorites：沒抓過或過期才抓；剛失敗的 TTL 內不重試；抓的途中不再抓", () => {
  const now = 10 * FAV_TTL_MS;
  expect(shouldFetchFavorites({ fetchedAt: null }, now)).toBe(true);
  expect(shouldFetchFavorites({ fetchedAt: now - FAV_TTL_MS + 1 }, now)).toBe(false);
  expect(shouldFetchFavorites({ fetchedAt: now - FAV_TTL_MS }, now)).toBe(true);
  expect(shouldFetchFavorites({ fetchedAt: null, failedAt: now - 1 }, now)).toBe(false);
  expect(shouldFetchFavorites({ fetchedAt: null, failedAt: now - FAV_TTL_MS }, now)).toBe(true);
  expect(shouldFetchFavorites({ fetchedAt: null, fetching: true }, now)).toBe(false);
});

test("pushRecentBoard：新的在前、不分大小寫去重、最多 RECENT_LIMIT 個", () => {
  expect(pushRecentBoard(["A", "c_chat", "B"], "C_Chat")).toEqual(["C_Chat", "A", "B"]);
  const many = Array.from({ length: RECENT_LIMIT }, (_, i) => "B" + i);
  expect(pushRecentBoard(many, "New")).toHaveLength(RECENT_LIMIT);
  expect(pushRecentBoard(many, "New")[0]).toBe("New");
});

test("articleListBoard：文章列表才算（看板列表的標題列也有《目前看板》）", () => {
  const al = ARTICLE_LIST();
  expect(articleListBoard(al.rowTexts, al.rows)).toBe("C_Chat");
  const fav = favScreen(boards(1, 3));
  expect(articleListBoard(fav.rowTexts, fav.rows)).toBeNull();
});

test("keyDismissesHome：純修飾鍵與 F 鍵不收起面板", () => {
  expect(keyDismissesHome({ key: "a" })).toBe(true);
  expect(keyDismissesHome({ key: "ArrowDown" })).toBe(true);
  expect(keyDismissesHome({ key: "Shift" })).toBe(false);
  expect(keyDismissesHome({ key: "F4" })).toBe(false);
  expect(keyDismissesHome(null)).toBe(false);
});

// ── 控制器：假 App（buf 讀目前的 frame，CommandQueue 只收集命令）──────────────────
function makeCore(start = mainMenu()) {
  const enqueued = [];
  const hints = [];
  let frame = start;
  const listeners = {};
  const inputListeners = {};
  const core = {
    conn: { isConnected: true },
    buf: {
      rows: ROWS,
      cols: 80,
      get cur_x() {
        return frame.curX;
      },
      get cur_y() {
        return frame.curY;
      },
      pageState: 1,
      getRowText: (r) => frame.rowTexts[r],
      isCursorOnInputField: () => !!frame.inputField,
      addEventListener: (name, fn) => (listeners[name] = fn),
    },
    inputArea: { addEventListener: (name, fn) => (inputListeners[name] = fn) },
    view: { flashListHint: (m, ms, level) => hints.push({ m, level }) },
    commandQueue: {
      enqueue: (cmd) => enqueued.push(cmd),
      get idle() {
        return true;
      },
    },
  };
  const home = new HomeDashboard(core);
  const show = (f) => {
    frame = f;
    listeners.screenSettled();
  };
  // 第 i 個命令落地在 f 上：expect 必須認得它，然後 onDone（佇列的 settle 先於 screenSettled）。
  const land = (cmd, f) => {
    frame = f;
    expect(cmd.expect(null, f)).toBeTruthy();
    cmd.onDone(true);
    listeners.screenSettled();
  };
  const key = (k) => inputListeners.keydown({ key: k });
  return { core, home, enqueued, hints, show, land, key };
}

describe("HomeDashboard：何時出現", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("主功能表 settle ⇒ 出現；離開主功能表 ⇒ 收起", () => {
    const { home, show } = makeCore();
    show(mainMenu());
    expect(home.state.visible).toBe(true);
    show(ARTICLE_LIST());
    expect(home.state.visible).toBe(false);
  });

  test("面板開著時打字 ⇒ 收起（鍵不吞）；這一趟留在主功能表都不再出現，離開再回來才出現", () => {
    const { home, show, key } = makeCore();
    show(mainMenu());
    key("ArrowDown");
    expect(home.state.visible).toBe(false);
    show(mainMenu());
    expect(home.state.visible).toBe(false);
    show(ARTICLE_LIST());
    show(mainMenu());
    expect(home.state.visible).toBe(true);
  });

  test("F 鍵（指令面板之類的快捷鍵）不收起", () => {
    const { home, show, key } = makeCore();
    show(mainMenu());
    key("F4");
    expect(home.state.visible).toBe(true);
  });

  test("「原生主選單」＝ dismiss", () => {
    const { home, show } = makeCore();
    show(mainMenu());
    home.dismiss();
    expect(home.state.visible).toBe(false);
  });

  test("新信提示跟著標題列", () => {
    const { home, show } = makeCore();
    show(mainMenu({ mail: true }));
    expect(home.state.newMail).toBe(true);
    show(mainMenu());
    expect(home.state.newMail).toBe(false);
  });

  test("文章列表 settle ⇒ 記進最近看板", () => {
    const { home, show } = makeCore();
    show(ARTICLE_LIST());
    expect(home.state.recents).toEqual(["C_Chat"]);
  });

  test("不在主功能表的 settle 只讀頭尾兩列（每次 settle 都跑，不讀滿整頁）", () => {
    const { core, home, show } = makeCore();
    const spy = vi.spyOn(core.buf, "getRowText");
    show(ARTICLE_LIST());
    expect(spy).toHaveBeenCalledTimes(2);
    expect(home.state.recents).toEqual(["C_Chat"]);
    spy.mockClear();
    show(mainMenu());
    expect(spy.mock.calls.length).toBeGreaterThan(2);
    expect(home.state.visible).toBe(true);
  });
});

describe("HomeDashboard：自動抓我的最愛", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("面板出現後等 AUTO_FETCH_DELAY_MS 才送 Ctrl+Z f；中間打字收起 ⇒ 不送", () => {
    const a = makeCore();
    a.show(mainMenu());
    expect(a.enqueued).toHaveLength(0);
    vi.advanceTimersByTime(AUTO_FETCH_DELAY_MS);
    expect(a.enqueued.map((c) => c.keys)).toEqual([ZA_FAV]);

    const b = makeCore();
    b.show(mainMenu());
    b.key("s");
    vi.advanceTimersByTime(AUTO_FETCH_DELAY_MS);
    expect(b.enqueued).toHaveLength(0);
  });

  test("線路上有別人的事（deep link 還在排程）⇒ 不抓", () => {
    const { core, enqueued, show } = makeCore();
    core.deepLinkController = { hasPending: () => true };
    show(mainMenu());
    vi.advanceTimersByTime(AUTO_FETCH_DELAY_MS);
    expect(enqueued).toHaveLength(0);
  });

  test("一頁：Ctrl+Z f → 讀頁 → q；回到主功能表才更新清單", () => {
    const { core, home, enqueued, show, land } = makeCore();
    show(mainMenu());
    expect(home.fetchFavorites()).toBe(true);
    expect(core[HOME_FAV_FETCH_FLAG]).toBe(true);
    expect(serializedOpHint(core)).toMatch(/我的最愛/);
    expect(enqueued[0].fullRepaint).toBe(true);
    land(enqueued[0], favScreen(boards(1, 3, (n) => n === 2)));
    expect(home.state.visible).toBe(true); // 途中畫面離開主功能表，面板照樣在
    expect(home.state.fetching).toBe(true);
    expect(enqueued.map((c) => c.keys)).toEqual([ZA_FAV, "q"]);
    expect(enqueued[1].expect(null, favScreen(boards(1, 3)))).toBe(false);
    land(enqueued[1], mainMenu());
    expect(home.state.fetching).toBe(false);
    expect(core[HOME_FAV_FETCH_FLAG]).toBe(false);
    expect(home.state.boards.map((b) => [b.name, b.unread])).toEqual([
      ["Board1", false],
      ["Board2", true],
      ["Board3", false],
    ]);
    expect(home.state.visible).toBe(true);
  });

  test("進來停在第 2 頁：先跳 1 → 第 1 頁滿了跳 21 → 第 2 頁不滿 → 跳回原游標 25 → q", () => {
    const { home, enqueued, show, land } = makeCore();
    show(mainMenu());
    home.fetchFavorites();
    land(enqueued[0], favScreen(boards(21, 30), { cursorNum: 25 }));
    expect(enqueued.at(-1).keys).toBe("1\r");
    expect(enqueued.at(-1).expect(null, favScreen(boards(21, 30), { cursorNum: 25 }))).toBe(false);
    land(enqueued.at(-1), favScreen(boards(1, 20)));
    expect(enqueued.at(-1).keys).toBe("21\r");
    land(enqueued.at(-1), favScreen(boards(21, 30), { cursorNum: 21 }));
    expect(enqueued.at(-1).keys).toBe("25\r");
    land(enqueued.at(-1), favScreen(boards(21, 30), { cursorNum: 25 }));
    expect(enqueued.at(-1).keys).toBe("q");
    land(enqueued.at(-1), mainMenu());
    expect(home.state.boards).toHaveLength(30);
    expect(enqueued.map((c) => c.keys)).toEqual([ZA_FAV, "1\r", "21\r", "25\r", "q"]);
  });

  test("剛好 20 個：跳 21 被夾回最後一項（同一頁）＝沒有下一頁，不重複收", () => {
    const { home, enqueued, show, land } = makeCore();
    show(mainMenu());
    home.fetchFavorites();
    land(enqueued[0], favScreen(boards(1, 20)));
    expect(enqueued.at(-1).keys).toBe("21\r");
    land(enqueued.at(-1), favScreen(boards(1, 20), { cursorNum: 20 }));
    expect(enqueued.at(-1).keys).toBe("1\r"); // 回到進來時的游標
    land(enqueued.at(-1), favScreen(boards(1, 20)));
    expect(enqueued.at(-1).keys).toBe("q");
    land(enqueued.at(-1), mainMenu());
    expect(home.state.boards).toHaveLength(20);
  });

  test(`最多讀 ${FAV_MAX_PAGES} 頁`, () => {
    const { home, enqueued, show, land } = makeCore();
    show(mainMenu());
    home.fetchFavorites();
    for (let p = 0; p < FAV_MAX_PAGES; ++p) {
      const top = p * 20 + 1;
      land(enqueued.at(-1), favScreen(boards(top, top + 19), { cursorNum: p === 0 ? 1 : top }));
    }
    expect(enqueued.at(-1).keys).toBe("1\r");
    land(enqueued.at(-1), favScreen(boards(1, 20)));
    land(enqueued.at(-1), mainMenu());
    expect(home.state.boards).toHaveLength(FAV_MAX_PAGES * 20);
  });

  test("落地認不出（不是我的最愛）⇒ 失敗：停在原生畫面、提示、TTL 內不再自動抓", () => {
    const { core, home, enqueued, hints, show } = makeCore();
    show(mainMenu());
    home.fetchFavorites();
    expect(enqueued[0].expect(null, favScreen(boards(1, 3), { foot: ALL_FOOT }))).toBe(false);
    enqueued[0].onFail("miss");
    expect(home.state.fetching).toBe(false);
    expect(core[HOME_FAV_FETCH_FLAG]).toBe(false);
    expect(hints.at(-1).level).toBe(HINT_ERROR);
    show(ARTICLE_LIST());
    show(mainMenu());
    vi.advanceTimersByTime(AUTO_FETCH_DELAY_MS);
    expect(enqueued).toHaveLength(1);
  });

  test("抓完 TTL 內回到主功能表不重抓", () => {
    const { home, enqueued, show, land } = makeCore();
    show(mainMenu());
    home.fetchFavorites();
    land(enqueued[0], favScreen(boards(1, 3)));
    land(enqueued[1], mainMenu());
    show(ARTICLE_LIST());
    show(mainMenu());
    vi.advanceTimersByTime(AUTO_FETCH_DELAY_MS);
    expect(enqueued).toHaveLength(2);
  });

  test("不在主功能表 ⇒ fetchFavorites 不送", () => {
    const { home, enqueued, show } = makeCore();
    show(ARTICLE_LIST());
    expect(home.fetchFavorites()).toBe(false);
    expect(enqueued).toHaveLength(0);
  });
});

describe("HomeDashboard：動作都接到原生鍵", () => {
  test("點看板 ＝ 搜尋彈窗同一條 s<板>⏎", () => {
    const { home, enqueued, show } = makeCore();
    show(mainMenu());
    expect(home.openBoard("C_Chat")).toBe(true);
    expect(enqueued[0].keys).toBe("s");
  });

  test("開信箱 ＝ Ctrl+Z m，落地離開主功能表才算完成", () => {
    const { home, enqueued, show } = makeCore();
    show(mainMenu({ mail: true }));
    expect(home.openMail()).toBe(true);
    expect(enqueued[0].keys).toBe(ZA_MAIL);
    expect(enqueued[0].expect(null, mainMenu())).toBe(false);
    expect(enqueued[0].expect(null, ARTICLE_LIST())).toBe(true);
  });
});
