// 畫面重新整理（src/js/screen_refresh.js）：哪些畫面接手、送什麼鍵、冷卻與忙碌守門。
// 讀碼依據見 docs/screen-refresh.md。
import {
  refreshTargetFromFacts,
  refreshCooldownLeftMs,
  isRefreshKeyEvent,
  buildArticleListRefreshSteps,
  buildBoardListRefreshSteps,
  isBoardKeywordPromptFrame,
  ScreenRefresh,
  DEFAULT_REFRESH_MIN_INTERVAL_SEC,
} from "../../src/js/screen_refresh";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { serializedOpHint } from "../../src/js/serialized_op_gate";
import { OWNER_ARTICLE_LIST } from "../../src/js/list_render_owner";

const ROWS = 24;
const frame = (rows, extra) => {
  const rowTexts = Array.from({ length: ROWS }, () => "");
  Object.entries(rows).forEach(([i, t]) => (rowTexts[i] = t));
  return { rowTexts, rows: ROWS, curX: 0, curY: 5, inputField: false, listOwner: null, ...extra };
};

const READ_ROW =
  "  瀏覽 第 1/2 頁 ( 45%)  目前顯示: 第 1~23 行  (y)回應(X%)推文(h)說明(←)離開 ";
const SQUEEZED_ROW =
  "  瀏覽 第 1/90 頁 (  1%)  目前顯示: 第 1~23 行  (h)說明 (←/q)離開 ";
const MAIL_ROW =
  "  瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~18 行  (y)回信 (h)說明 (←/q)離開 ";
const LIST = { 0: " 【板主:none】看板《Test》", 23: " 文章選讀  (y)回應(X)推文(^X)轉錄 " };

const pad7 = (n) => String(n).padStart(7, " ");
const brdRow = (num, name) => pad7(num) + "  " + name.padEnd(13, " ") + "綜合  ｜閒聊｜ 測試看板";
const BRD = (() => {
  const rows = {
    0: "【看板列表】 批踢踢實業坊",
    1: "[←][q]回上層 [→][r]閱讀 [↑↓]選擇 [PgUp][PgDn]翻頁 [c]新文章 [/]搜尋 [h]求助",
    2: "   編號   看  板       類別   中   文   敘   述               人氣 板   主",
    23: "  選擇看板    (a)增加看板 (s)進入已知板名 (y)列出全部 (v/V)已讀/未讀",
  };
  for (let i = 0; i < 20; ++i) rows[3 + i] = brdRow(i + 1, "Board" + (i + 1));
  return rows;
})();

describe("refreshTargetFromFacts — 哪些畫面接手", () => {
  test("文章（READING pager）＋已知看板 ⇒ article", () => {
    expect(refreshTargetFromFacts(frame({ 23: READ_ROW }), 3, { articleBoard: "Test" })).toEqual({
      kind: "article",
      board: "Test",
    });
  });
  test("文章但不知道看板 ⇒ 不接（s<板> 組不出來）", () => {
    expect(refreshTargetFromFacts(frame({ 23: READ_ROW }), 3, {})).toBeNull();
  });
  test("站內信 pager ⇒ 不接（more.c 在 RMAIL 擋掉 s/#）", () => {
    expect(refreshTargetFromFacts(frame({ 23: MAIL_ROW }), 3, { articleBoard: "Test" })).toBeNull();
  });
  test("超長文 footer 被擠掉：只有列表好讀自己開的這篇才算 READING", () => {
    const f = frame({ 23: SQUEEZED_ROW });
    expect(refreshTargetFromFacts(f, 3, { articleBoard: "Test" })).toBeNull();
    expect(refreshTargetFromFacts(f, 3, { articleBoard: "Test", listOpened: true })).toMatchObject({
      kind: "article",
    });
  });
  test("prompt 幀沿用 pageState 3 ⇒ 不接（推文輸入中按 F5 不可以把 prompt 弄掉）", () => {
    expect(refreshTargetFromFacts(frame({ 23: "搜尋標題: " }), 3, { articleBoard: "Test" })).toBeNull();
  });
  test("文章列表 ⇒ article-list，板名取自標題列", () => {
    expect(refreshTargetFromFacts(frame(LIST), 2)).toEqual({ kind: "article-list", board: "Test" });
  });
  test("列表好讀持有的文章列表也算", () => {
    expect(refreshTargetFromFacts(frame(LIST, { listOwner: OWNER_ARTICLE_LIST }), 2)).toMatchObject({
      kind: "article-list",
    });
  });
  test("文章列表上開著 prompt（游標在輸入欄）⇒ 不接", () => {
    expect(refreshTargetFromFacts(frame(LIST, { inputField: true }), 2)).toBeNull();
  });
  test("搜尋結果（系列文章）／文摘 ⇒ 不接（s 會離開那個模式）", () => {
    for (const cap of [" 系列文章 ", " 文摘列表 "]) {
      const f = frame({ ...LIST, 23: cap + " (y)回應(X)推文(^X)轉錄 " });
      expect(refreshTargetFromFacts(f, 2)).toBeNull();
    }
  });
  test("板名被省略（看板描述太長）⇒ 不接", () => {
    expect(
      refreshTargetFromFacts(frame({ ...LIST, 0: " 【板主:none】" }), 2)
    ).toBeNull();
  });
  test("看板列表 ⇒ board-list", () => {
    expect(refreshTargetFromFacts(frame(BRD, { curY: 3 }), 2)).toEqual({ kind: "board-list" });
  });
  test("主功能表／其他 ⇒ 不接（F5 交還瀏覽器）", () => {
    expect(refreshTargetFromFacts(frame({ 0: "【主功能表】    批踢踢實業坊" }), 1)).toBeNull();
    expect(refreshTargetFromFacts(frame({}), 0)).toBeNull();
    expect(refreshTargetFromFacts(null, 3)).toBeNull();
  });
  test("首頁儀表板畫著 ⇒ home（重抓我的最愛）；收起後的原生主功能表仍不接", () => {
    const menu = frame({ 0: "【主功能表】    批踢踢實業坊" });
    expect(refreshTargetFromFacts(menu, 1, { home: true })).toEqual({ kind: "home" });
    expect(refreshTargetFromFacts(menu, 1, { home: false })).toBeNull();
  });
});

describe("isRefreshKeyEvent", () => {
  const ev = (key, m = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...m });
  test("F5 與 ⌘R 接手", () => {
    expect(isRefreshKeyEvent(ev("F5"))).toBe(true);
    expect(isRefreshKeyEvent(ev("r", { metaKey: true }))).toBe(true);
    expect(isRefreshKeyEvent(ev("R", { metaKey: true }))).toBe(true);
  });
  test("強制重新載入（Shift／Ctrl＋F5、⌘⇧R）留給瀏覽器", () => {
    expect(isRefreshKeyEvent(ev("F5", { shiftKey: true }))).toBe(false);
    expect(isRefreshKeyEvent(ev("F5", { ctrlKey: true }))).toBe(false);
    expect(isRefreshKeyEvent(ev("R", { metaKey: true, shiftKey: true }))).toBe(false);
  });
  test("Ctrl+R 是 PTT 的 ^R，不接", () => {
    expect(isRefreshKeyEvent(ev("r", { ctrlKey: true }))).toBe(false);
    expect(isRefreshKeyEvent(ev("r"))).toBe(false);
  });
});

describe("refreshCooldownLeftMs", () => {
  test("從沒重整過 ⇒ 0；間隔內 ⇒ 剩餘；過了 ⇒ 0", () => {
    expect(refreshCooldownLeftMs(0, 1000, 5)).toBe(0);
    expect(refreshCooldownLeftMs(10000, 12000, 5)).toBe(3000);
    expect(refreshCooldownLeftMs(10000, 15000, 5)).toBe(0);
  });
  test("0／非數字 ＝不限制", () => {
    expect(refreshCooldownLeftMs(10000, 10001, 0)).toBe(0);
    expect(refreshCooldownLeftMs(10000, 10001, NaN)).toBe(0);
  });
  test("預設 5 秒（使用者指定），pref 預設值一致", () => {
    expect(DEFAULT_REFRESH_MIN_INTERVAL_SEC).toBe(5);
    expect(DEFAULT_PREFS.refreshMinIntervalSec).toBe(5);
    expect(DEFAULT_PREFS.refreshKeyIntercept).toBe(true);
  });
});

describe("送出序列", () => {
  test("文章列表：先 s、等 CompleteBoard prompt 才送板名⏎、落地必須是同一板", () => {
    const steps = buildArticleListRefreshSteps("Test");
    expect(steps.map((s) => s.keys)).toEqual(["s", "Test\r"]);
    // prompt 沒出現（s 沒被接受）⇒ 第一步不成立 ⇒ 板名絕不送。
    expect(steps[0].expect(null, frame(LIST))).toBe(false);
    const prompt = frame({ ...LIST, 1: "請輸入看板名稱(按空白鍵自動搜尋)：" }, { curY: 1 });
    expect(steps[0].expect(null, prompt)).toBe(true);
    expect(steps[1].expect(null, { kind: "clean-list", boardName: "Test" })).toBe(true);
    expect(steps[1].expect(null, { kind: "clean-list", boardName: "Other" })).toBe(false);
    expect(steps[1].expect(null, { kind: "prompt", boardName: "Test" })).toBe(false);
  });

  test("看板列表：/ → 關鍵字 prompt → ⏎；熱門看板的拒絕訊息也接得住並回報 hot", () => {
    const onDone = vi.fn();
    const steps = buildBoardListRefreshSteps({ onDone });
    expect(steps.map((s) => s.keys)).toEqual(["/", "\r"]);
    const prompt = frame({ ...BRD, 22: "請輸入看板中文關鍵字:" }, { curY: 22 });
    expect(isBoardKeywordPromptFrame(prompt)).toBe(true);
    expect(steps[0].expect(null, prompt)).toBe(true);
    expect(steps[0].expect(null, frame(BRD, { curY: 3 }))).toBe(false);
    expect(steps[1].expect(null, frame(BRD, { curY: 3 }))).toBe(true);
    steps[1].onDone();
    expect(onDone).toHaveBeenLastCalledWith(false);

    const hotSteps = buildBoardListRefreshSteps({ onDone });
    const reject = frame({ ...BRD, 23: "熱門看板模式下不支援中文關鍵字搜尋  請按任意鍵繼續" });
    expect(hotSteps[0].expect(null, reject)).toBe(true);
    hotSteps[1].onDone();
    expect(onDone).toHaveBeenLastCalledWith(true);
  });
});

// 假 App：buf 從 frame 讀，CommandQueue 只收集命令。
function makeCore(rows, { pageState = 2, extra = {} } = {}) {
  const f = frame(rows, extra);
  const enqueued = [];
  const hints = [];
  const core = {
    conn: { isConnected: true },
    buf: {
      rows: ROWS,
      cols: 80,
      cur_x: f.curX,
      cur_y: f.curY,
      pageState,
      getRowText: (r) => f.rowTexts[r],
      isCursorOnInputField: () => !!extra.inputField,
    },
    view: { flashListHint: (m) => hints.push(m), _articleBoard: extra.articleBoard },
    commandQueue: { enqueue: (cmd) => enqueued.push(cmd) },
    aidNavigation: { active: false, refresh: vi.fn(() => true) },
  };
  return { core, enqueued, hints };
}

describe("ScreenRefresh.refresh", () => {
  test("不支援的畫面 ⇒ 回 false（F5 交還瀏覽器），按鍵入口不出提示", () => {
    const { core, hints } = makeCore({ 0: "【主功能表】    批踢踢實業坊" }, { pageState: 1 });
    const r = new ScreenRefresh(core);
    expect(r.refresh("key")).toBe(false);
    expect(hints).toEqual([]);
    expect(r.refresh("toolbar")).toBe(false);
    expect(hints).toEqual(["這個畫面不支援重新整理"]);
  });

  test("沒連線 ⇒ 不接", () => {
    const { core } = makeCore(LIST);
    core.conn.isConnected = false;
    expect(new ScreenRefresh(core).refresh("key")).toBe(false);
  });

  test("文章列表：排出 s，完成才排板名；在途旗標擋使用者輸入；收尾解除", () => {
    const { core, enqueued, hints } = makeCore(LIST);
    const r = new ScreenRefresh(core);
    expect(r.refresh("key")).toBe(true);
    expect(enqueued.map((c) => c.keys)).toEqual(["s"]);
    expect(core.refreshInFlight).toBe(true);
    expect(serializedOpHint(core)).toBe("重新整理中，請稍候…");
    enqueued[0].onDone(true);
    expect(enqueued.map((c) => c.keys)).toEqual(["s", "Test\r"]);
    enqueued[1].onDone(true);
    expect(core.refreshInFlight).toBe(false);
    expect(hints).toContain("已重新整理");
  });

  test("冷卻：5 秒內再按只得到提示、不送鍵；過了才再送", () => {
    const { core, enqueued, hints } = makeCore(LIST);
    const r = new ScreenRefresh(core);
    let now = 100000;
    r._now = () => now;
    r.refresh("key");
    enqueued[0].onDone(true);
    enqueued[1].onDone(true);
    now += 2000;
    expect(r.refresh("key")).toBe(true); // 仍然吞掉 F5，不可以變成整頁重載
    expect(enqueued.length).toBe(2);
    expect(hints.at(-1)).toBe("請稍候 3 秒再重新整理");
    now += 3000;
    r.refresh("key");
    expect(enqueued.length).toBe(3);
  });

  test("cooldownLeftMs／onCooldown：真的送出才起算並通知一次；被冷卻擋下不通知", () => {
    const { core, enqueued } = makeCore(LIST);
    const r = new ScreenRefresh(core);
    let now = 50000;
    r._now = () => now;
    const seen = [];
    const off = r.onCooldown((ms) => seen.push(ms));
    expect(r.cooldownLeftMs()).toBe(0);
    r.refresh("pull");
    expect(seen).toEqual([5000]);
    now += 1500;
    expect(r.cooldownLeftMs()).toBe(3500);
    r.refresh("key"); // 冷卻中：只提示
    expect(seen).toEqual([5000]);
    expect(enqueued.length).toBe(1);
    off();
    enqueued[0].onFlushed && enqueued[0].onFlushed();
    now += 5000;
    r.refresh("toolbar");
    expect(seen).toEqual([5000]); // 已解除訂閱
  });

  test("線路忙碌（AID 跳文等）⇒ 只提示", () => {
    const { core, enqueued, hints } = makeCore(LIST);
    core.aidNavigation.active = true;
    expect(new ScreenRefresh(core).refresh("key")).toBe(true);
    expect(enqueued).toEqual([]);
    expect(hints.at(-1)).toMatch(/請稍候/);
  });

  test("首頁儀表板 ⇒ 交給 homeDashboard.fetchFavorites()；與其他畫面同一道冷卻", () => {
    const { core, hints, enqueued } = makeCore({ 0: "【主功能表】    批踢踢實業坊" }, { pageState: 1 });
    core.homeDashboard = { state: { visible: true }, fetchFavorites: vi.fn(() => true) };
    const r = new ScreenRefresh(core);
    r._now = () => 5000;
    expect(r.target()).toEqual({ kind: "home" });
    expect(r.refresh("pull")).toBe(true);
    expect(core.homeDashboard.fetchFavorites).toHaveBeenCalledTimes(1);
    expect(enqueued).toEqual([]);
    r._now = () => 6000;
    expect(r.refresh("button")).toBe(true);
    expect(core.homeDashboard.fetchFavorites).toHaveBeenCalledTimes(1);
    expect(hints).toEqual(["請稍候 4 秒再重新整理"]);
    // 面板收起 ⇒ 原生主功能表，F5 交還瀏覽器。
    core.homeDashboard.state.visible = false;
    expect(r.target()).toBeNull();
  });

  test("首頁儀表板：抓不了（線路被佔）⇒ 提示、不記冷卻", () => {
    const { core, hints } = makeCore({ 0: "【主功能表】    批踢踢實業坊" }, { pageState: 1 });
    core.homeDashboard = { state: { visible: true }, fetchFavorites: vi.fn(() => false) };
    const r = new ScreenRefresh(core);
    expect(r.refresh("toolbar")).toBe(true);
    expect(r._lastAt).toBe(0);
    expect(hints).toEqual(["指令處理中，請稍候再重新整理"]);
  });

  test("文章 ⇒ 交給 aidNavigation.refresh()；拒絕時不記冷卻", () => {
    const { core } = makeCore({ 23: READ_ROW }, { pageState: 3, extra: { articleBoard: "Test" } });
    const r = new ScreenRefresh(core);
    r._now = () => 5000;
    core.aidNavigation.refresh.mockReturnValueOnce(false);
    expect(r.refresh("key")).toBe(true);
    expect(r._lastAt).toBe(0);
    expect(r.refresh("key")).toBe(true);
    expect(core.aidNavigation.refresh).toHaveBeenCalledTimes(2);
    expect(r._lastAt).toBe(5000);
  });
});
