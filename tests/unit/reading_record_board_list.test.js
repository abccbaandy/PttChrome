// @unit-env browser
// 閱讀紀錄 × 看板列表平滑捲動：原生交易（重新整理 `/⏎`、`s` 看板搜尋取消）會把
// 緩衝整份丟掉（_enterNative），靜置探針 seed 回來時以前一律採用 PTT 分頁頂端。
// 現在：落點驗證過（同變體＋游標仍在發起那一列）就把視野還原到原本的頂端。
import { BoardListSession } from "../../src/js/board_list_session";
import { ScreenRefresh } from "../../src/js/screen_refresh";
import { recordFor } from "../../src/js/reading_record";
import { HelpMenuController, parseHelpMenuScreen } from "../../src/js/help_menu";
import { HELP_FAV_PAGE1 } from "./fixtures/help_menu_rows";

const pad7 = (n) => String(n).padStart(7, " ");
const brdRow = (num, name) =>
  pad7(num) + "  " + String(name).padEnd(13, " ") + "綜合  ｜閒聊｜ 測試看板";
const FOOT_FAV =
  "  選擇看板    (a)增加看板 (s)進入已知板名 (y)列出全部 (v/V)已讀/未讀";
const HEADER_NUM =
  "   編號   看  板       類別   中   文   敘   述               人氣 板   主";
const ROW_H = 20;

function brdScreenRows(startNum) {
  const rowTexts = ["【看板列表】 批踢踢實業坊", "[←][q]回上層 [↑↓]選擇", HEADER_NUM];
  for (let i = 0; i < 20; ++i) rowTexts.push(brdRow(startNum + i, "B" + (startNum + i)));
  rowTexts.push(FOOT_FAV);
  return rowTexts;
}

const charOf = (ch) => ({ ch, isLeadByte: false, resetAttr() {} });
const rowChars = (text) => Array.from({ length: 80 }, (_, i) => charOf(text[i] || " "));

function fillBuffer(termBuf, from, to) {
  termBuf.brdListLines = [];
  termBuf.brdListLineNums = [];
  for (let n = from; n <= to; ++n) {
    termBuf.brdListLines.push(rowChars(brdRow(n, "B" + n)));
    termBuf.brdListLineNums.push(n);
  }
}

function makeSession() {
  window.localStorage.setItem(
    "pttchrome.pref.v1",
    JSON.stringify({ values: { enableBoardListSmoothScroll: true, enableListNativeAutoResume: true } })
  );
  const enqueued = [];
  let scrollTop = 0;
  const scrollWrites = [];
  let s = null;
  // 落地頁：21..40（PTT 的 20 列分頁），游標停在 25（curY = 3 + 4）。
  let landing = [21, 40];
  const view = {
    chh: ROW_H,
    hideCursor() {},
    showCursor() {},
    resetBoardListAccumulation() {},
    flashListHint() {},
    promptListInput: null,
    componentScreen: {
      setListScrollTop: (px) => {
        scrollTop = px;
        scrollWrites.push(px);
      },
      getListScrollTop: () => scrollTop,
      getListViewportPx: () => 20 * ROW_H,
      hasListViewport: () => true,
      scrollListTo() {},
    },
  };
  let settleListener = null;
  const termBuf = {
    rows: 24,
    cols: 80,
    pageState: 1,
    brdListLines: [],
    brdListLineNums: [],
    listRenderMode: "native",
    listRenderOwner: null,
    lineChangeds: new Array(24).fill(false),
    changed: false,
    settleSnapshot: null,
    startedEasyReading: false,
    cur_x: 0,
    cur_y: 7,
    _rowTexts: brdScreenRows(21),
    getRowText(r) {
      return this._rowTexts[r] || "";
    },
    isUnicolor: () => true,
    addEventListener(name, fn) {
      if (name === "screenSettled") settleListener = fn;
    },
    // 模擬 term_view 的看板列表分支：buffer 模式下同步累積＋錨的擷取／還原。
    notify() {
      if (!s || s._renderMode !== "buffer") return;
      if (!termBuf.brdListLineNums.length) fillBuffer(termBuf, landing[0], landing[1]);
      s._seqCache = null;
      s.captureScrollAnchor();
      s.applyScrollAfterRender();
    },
  };
  const queue = {
    idle: true,
    inFlightKind: null,
    enqueue: (cmd) => enqueued.push(cmd),
    onSettle: () => null,
    flush() {},
    flushPending() {},
    flushPendingKind() {},
    hasKind: () => false,
    flushKind() {},
  };
  const core = {
    conn: { isConnected: true, send() {} },
    buf: termBuf,
    view: view,
    commandQueue: queue,
    activeListSession: () => s,
  };
  s = new BoardListSession(core, view, termBuf, queue);
  core.boardListSession = s;
  // 使用者捲到 10..29 在看，游標（也是 server 游標）在 25。
  s.state = "active";
  s._renderMode = "buffer";
  s._variant = "fav";
  fillBuffer(termBuf, 1, 60);
  s._topNum = 10;
  s._scrollFrac = 0;
  s._selectedNum = 25;
  s._serverNum = 25;
  scrollTop = (10 - 1) * ROW_H;
  return {
    s,
    core,
    termBuf,
    enqueued,
    scrollWrites,
    setLanding: (a, b) => (landing = [a, b]),
  };
}

function step(h, suffix) {
  const c = h.enqueued.filter((x) => (x.kind || "").endsWith(suffix)).pop();
  expect(c).toBeDefined();
  return c;
}

function runRefresh(h) {
  const sr = new ScreenRefresh(h.core);
  expect(sr._dispatch({ kind: "board-list" })).toBe(true);
  step(h, "refresh-open").onDone(true);
  step(h, "refresh-submit").onDone(true);
  expect(h.s._renderMode).toBe("native");
}

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("看板列表重新整理：回平滑捲動時視野回到原處", () => {
  test("閱讀紀錄在切原生那一刻記下視野（_enterNative 會丟掉整份緩衝）", () => {
    const h = makeSession();
    expect(h.s.readingPosition()).toMatchObject({ kind: "boardList", variant: "fav", topNum: 10, cursorNum: 25 });
    runRefresh(h);
    // 鏡像期間問「在哪」⇒ 切進去那一刻的視野。
    expect(recordFor(h.core).current().boardList).toMatchObject({ topNum: 10, cursorNum: 25 });
  });

  test("錨在落點頁之上：往上補頁、捲得到那一幀才還原", () => {
    const h = makeSession();
    runRefresh(h);
    const before = h.enqueued.length;
    vi.advanceTimersByTime(400); // 靜置探針 → seed
    expect(h.s.state).toBe("active");
    expect(h.s._pendingViewport).not.toBe(null);
    const up = h.enqueued.slice(before).find((c) => /fetch-up/.test(c.kind));
    expect(up).toBeDefined();
    fillBuffer(h.termBuf, 1, 40);
    h.s._seqCache = null;
    h.s.applyScrollAfterRender();
    expect(h.s._topNum).toBe(10);
    expect(h.s._pendingViewport).toBe(null);
    expect(h.scrollWrites[h.scrollWrites.length - 1]).toBe((10 - 1) * ROW_H);
  });

  test("落點游標不在發起的那一列 ⇒ 認不出，採用 PTT 的落點（舊行為）", () => {
    const h = makeSession();
    runRefresh(h);
    h.termBuf.cur_y = 9; // 游標落在 27
    vi.advanceTimersByTime(400);
    expect(h.s.state).toBe("active");
    expect(h.s._pendingViewport).toBe(null);
    expect(h.s._topNum).toBe(21);
  });

  test("回來之後使用者先按了鍵 ⇒ 待還原作廢", () => {
    const h = makeSession();
    runRefresh(h);
    vi.advanceTimersByTime(400);
    expect(h.s._pendingViewport).not.toBe(null);
    h.s.onKeyDown({
      key: "ArrowDown",
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {},
    });
    expect(h.s._pendingViewport).toBe(null);
  });

  // 使用者回報：看板列表按 h 叫出說明彈窗，取消之後位置跑掉（seed 採用 PTT 分頁頂端）。
  test("說明選單（h）：離開之後回平滑捲動，視野回到原處", () => {
    const h = makeSession();
    h.s.onKeyDown({
      key: "h",
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {},
    });
    step(h, "native-key").onDone(true);
    expect(h.s._renderMode).toBe("native");
    const sent = [];
    const hm = new HelpMenuController(h.core, null, {
      send: (b) => sent.push(b),
      enabled: () => true,
    });
    hm.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
    expect(hm.phase).toBe("open");
    hm.close();
    hm.noteScreen(null); // q ⇒ PTT 重畫看板列表（游標仍在 25）
    vi.advanceTimersByTime(400); // 靜置探針 → seed
    expect(h.s.state).toBe("active");
    expect(h.s._pendingViewport).not.toBe(null);
    fillBuffer(h.termBuf, 1, 40);
    h.s._seqCache = null;
    h.s.applyScrollAfterRender();
    expect(h.s._topNum).toBe(10);
    expect(h.s._pendingViewport).toBe(null);
    expect(h.scrollWrites[h.scrollWrites.length - 1]).toBe((10 - 1) * ROW_H);
  });

  test("說明選單：執行某一項 ⇒ 不還原（採用 PTT 的落點）", () => {
    const h = makeSession();
    h.s._beginPassthroughBytes("h");
    const hm = new HelpMenuController(h.core, null, { send() {}, enabled: () => true });
    hm.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
    hm.select(3);
    hm.noteScreen(null);
    vi.advanceTimersByTime(400);
    expect(h.s.state).toBe("active");
    expect(h.s._pendingViewport).toBe(null);
    expect(h.s._topNum).toBe(21);
  });

  test("外部序列停在看板列表：交回（releaseExternal）後自動回平滑捲動", () => {
    const h = makeSession();
    h.s.beginExternalNavigation();
    expect(h.s._holdReason).toBe("external");
    vi.advanceTimersByTime(5000);
    expect(h.s.state).toBe("functionMode");
    recordFor(h.core).releaseExternal();
    vi.advanceTimersByTime(400);
    expect(h.s.state).toBe("active");
  });
});
