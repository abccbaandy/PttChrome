// @unit-env browser
// 閱讀紀錄 × 文章列表好讀：會切到原生的交易做完回好讀時，視野（視口頂端那一列）
// 必須回到使用者原本看的地方，而不是 PTT 的 20 列分頁頂端。
//
// 這些全是盤點出來的缺口（docs/reading-record.md「盤點」）：以前只有右鍵「前已讀
// 後未讀」做對（list_mark_read_viewport.test.js），其他功能回來一律採用落點。
//   - 設為全部已讀、列表重新整理、`s` 看板搜尋取消
//   - 在文章裡的外部導覽（AID 跳文、長推文、文章重新整理）把身後的列表停進外部
//     hold、清掉看板身分 ⇒ 退回列表時 rebuild，視野丟失
//   - 外部 hold 永不解除：序列停在列表時列表好讀卡在原生鏡像
//   - 搜尋結果（MODE_SELECT）的編號空間旗標從沒被設起來
import fixture from "./fixtures/replay/cchat-list.page.json";
import { ListSession } from "../../src/js/list_session";
import { MarkAllRead } from "../../src/js/mark_all_read";
import { ScreenRefresh } from "../../src/js/screen_refresh";
import { BoardSearchBridge } from "../../src/js/board_search_bridge";
import { recordFor } from "../../src/js/reading_record";

const listRows = fixture.pageScreens[0]; // 真實 C_Chat 一頁：350024..350039＋置底

const PREF_KEY = "pttchrome.pref.v1";
const ROW_H = 20;

function rowOf(text) {
  return text.split("").map((c) => ({ ch: c, isLeadByte: false }));
}

function fillBuffer(termBuf, from, to) {
  termBuf.listLines = [];
  termBuf.listLineNums = [];
  for (let n = from; n <= to; ++n) {
    termBuf.listLines.push(rowOf(` ${n} +   6/14 author${n}  □ 標題${n}`));
    termBuf.listLineNums.push(n);
  }
}

// 與 list_mark_read_viewport.test.js 同一套假畫面，多掛一個 core 讓功能模組
// （MarkAllRead／ScreenRefresh／BoardSearchBridge）走真的 submitSerializedSteps。
function makeSession({ curY = 5, topNum = 350010, landing = [350024, 350039], rows = listRows } = {}) {
  const enqueued = [];
  const scrollWrites = [];
  let scrollTop = 0;
  let s = null;
  const view = {
    hideCursor() {},
    showCursor() {},
    resetListAccumulation() {},
    setListLoading() {},
    flashListHint() {},
    blacklist: new Set(),
    titleBlacklist: [],
    chh: ROW_H,
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
  const screen = { rows: rows.slice(), curY, curX: 1 };
  const termBuf = {
    rows: 24,
    cols: 80,
    pageState: 1,
    listLines: [],
    listLineNums: [],
    lineChangeds: new Array(24).fill(false),
    changed: false,
    getRowText: (r) => screen.rows[r] || "",
    isUnicolor: () => true,
    get cur_x() {
      return screen.curX;
    },
    get cur_y() {
      return screen.curY;
    },
    addEventListener() {},
    notify() {
      if (!s || s._renderMode !== "buffer") return;
      if (!termBuf.listLines.length) fillBuffer(termBuf, landing[0], landing[1]);
      s._seqCache = null;
      s.captureScrollAnchor();
      s.applyScrollAfterRender();
    },
  };
  const queue = {
    idle: true,
    inFlightKind: null,
    flush() {},
    flushPending() {},
    flushPendingKind() {},
    flushKind() {},
    hasKind: () => false,
    enqueue: (cmd) => enqueued.push(cmd),
    onSettle: () => null,
  };
  const core = {
    conn: { send() {}, isConnected: true },
    buf: termBuf,
    view: view,
    commandQueue: queue,
    activeListSession: () => s,
  };
  s = new ListSession(core, view, termBuf, queue);
  core.listSession = s;
  const boardName = s._collectFacts(null).boardName;
  s.state = "active";
  s._renderMode = "buffer";
  s._boardName = boardName;
  fillBuffer(termBuf, 350000, 350059);
  s._topNum = topNum;
  s._scrollFrac = 0;
  s._selectedNum = 350026;
  s._serverNum = 350026;
  scrollTop = (topNum - 350000) * ROW_H;
  return { s, core, enqueued, scrollWrites, screen, termBuf, boardName };
}

function step(h, kind) {
  const c = h.enqueued.filter((x) => x.kind === kind).pop();
  expect(c).toBeDefined();
  return c;
}

// 回好讀（靜置探針 → resume-buffer＋rebuild）之後，往上那一頁補到了：視野應回到 topNum。
function expectRestoredAfterFill(h, topNum) {
  vi.advanceTimersByTime(300);
  expect(h.s.state).toBe("active");
  expect(h.s._renderMode).toBe("buffer");
  expect(h.s._pendingViewport).not.toBe(null);
  fillBuffer(h.termBuf, 350004, 350039);
  h.s._seqCache = null;
  h.s.applyScrollAfterRender();
  expect(h.s._topNum).toBe(topNum);
  expect(h.s._pendingViewport).toBe(null);
  expect(h.scrollWrites[h.scrollWrites.length - 1]).toBe((topNum - 350004) * ROW_H);
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(
    PREF_KEY,
    JSON.stringify({ values: { enableEasyReadingList: true, enableListNativeAutoResume: true } })
  );
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("列表上的原生交易：做完回好讀時視野回到原處", () => {
  test("設為全部已讀", () => {
    const h = makeSession();
    expect(new MarkAllRead(h.core).start()).toBe(true);
    step(h, "mark-all-read-prompt").onDone(true);
    step(h, "mark-all-read-apply").onDone(true);
    expect(h.s._renderMode).toBe("native");
    expectRestoredAfterFill(h, 350010);
  });

  test("設為全部已讀：PTT 沒有回應（失敗）也回原處", () => {
    const h = makeSession();
    new MarkAllRead(h.core).start();
    step(h, "mark-all-read-prompt").onDone(true);
    step(h, "mark-all-read-apply").onFail("timeout");
    expectRestoredAfterFill(h, 350010);
  });

  test("列表重新整理（s<本板>⏎，游標原地）", () => {
    const h = makeSession();
    const sr = new ScreenRefresh(h.core);
    expect(sr._dispatch({ kind: "article-list", board: "C_Chat" })).toBe(true);
    step(h, "refresh-open").onDone(true);
    step(h, "refresh-submit").onDone(true);
    expectRestoredAfterFill(h, 350010);
  });

  test("`s` 看板搜尋：取消 ⇒ 回原處", () => {
    const h = makeSession();
    const bridge = new BoardSearchBridge(h.core, () => {});
    step(h, "search-board-open").onDone({ field: "", candidates: null, more: false });
    bridge.cancel();
    const fin = step(h, "search-board-cancel");
    if (fin.onSend) fin.onSend();
    fin.onDone(true);
    expectRestoredAfterFill(h, 350010);
  });

  test("`s` 看板搜尋：送出（換板）⇒ 不還原", () => {
    const h = makeSession();
    const bridge = new BoardSearchBridge(h.core, () => {});
    step(h, "search-board-open").onDone({ field: "", candidates: null, more: false });
    bridge.submit("Gossiping");
    const fin = step(h, "search-board-submit");
    if (fin.onSend) fin.onSend();
    fin.onDone(true);
    expect(h.s._pendingViewport).toBe(null);
  });

  test("回好讀之前使用者自己移過游標 ⇒ 認不出，不還原（採用落點）", () => {
    const h = makeSession();
    new MarkAllRead(h.core).start();
    step(h, "mark-all-read-prompt").onDone(true);
    step(h, "mark-all-read-apply").onDone(true);
    h.screen.curY = 8; // 真游標跑到 350029
    vi.advanceTimersByTime(300);
    expect(h.s.state).toBe("active");
    expect(h.s._pendingViewport).toBe(null);
    expect(h.s._topNum).toBe(350024);
  });
});

// 文章期間（suspended）文章裡的序列呼叫 beginExternalNavigation：看板身分被清掉，
// 退回列表一定 rebuild。身後的列表由閱讀紀錄記著，rebuild 時驗證後還原。
function openArticle(h, num) {
  h.s._selectedNum = num;
  h.s._openedNum = num;
  h.s.state = "suspended";
  h.s._renderMode = "native";
}

function settleOnList(h) {
  const facts = h.s._collectFacts(null);
  h.s._dispatch(h.s._settleEvent(facts), facts);
}

describe("身後的列表：文章裡的外部導覽不毀掉退回列表時的視野", () => {
  test("長推文／AID 跳文／重新整理之後按 ← 回列表 ⇒ 視野回原處", () => {
    const h = makeSession();
    openArticle(h, 350026);
    h.s.beginExternalNavigation(); // 序列的第一步
    expect(h.s._boardName).toBe(null);
    // 序列落在文章（回到原文）⇒ handoff。
    h.s._handoffArticle();
    h.s.state = "suspended";
    // 使用者按 ← 回列表：游標停在剛剛那篇。
    settleOnList(h);
    expect(h.s.state).toBe("active");
    expect(h.s._pendingViewport).not.toBe(null);
    fillBuffer(h.termBuf, 350004, 350039);
    h.s._seqCache = null;
    h.s.applyScrollAfterRender();
    expect(h.s._topNum).toBe(350010);
  });

  test("回到的是別篇（跳到同板另一篇再退出）⇒ 認不出，不還原", () => {
    const h = makeSession();
    openArticle(h, 350026);
    h.s.beginExternalNavigation();
    h.s._handoffArticle();
    h.s.state = "suspended";
    h.screen.curY = 8; // 落點游標 350029
    settleOnList(h);
    expect(h.s.state).toBe("active");
    expect(h.s._pendingViewport).toBe(null);
    // 一次性：下一次 rebuild 不會再拿到它。
    expect(recordFor(h.core).peekBehindList()).toBe(null);
  });

  test("看板身分已清掉時的第二次序幕（長推文探路之後）不覆寫身後紀錄", () => {
    const h = makeSession();
    openArticle(h, 350026);
    h.s.beginExternalNavigation(); // 探路
    h.s._handoffArticle();
    h.s.state = "suspended";
    h.s.beginExternalNavigation(); // 真正送出
    expect(recordFor(h.core).peekBehindList()).toMatchObject({ board: h.boardName, topNum: 350010 });
  });
});

describe("外部導覽的出口：序列停在列表時交回靜置探針", () => {
  test("沒放開 ⇒ 永遠停在原生鏡像（不變量 N1：探針不碰 external）", () => {
    const h = makeSession();
    h.s.beginExternalNavigation();
    expect(h.s._holdReason).toBe("external");
    vi.advanceTimersByTime(5000);
    expect(h.s.state).toBe("functionMode");
  });

  test("序列擁有者交回（releaseExternal）⇒ 靜置後自動回好讀，視野回原處", () => {
    const h = makeSession();
    h.s.beginExternalNavigation();
    recordFor(h.core).releaseExternal();
    expect(h.s._holdReason).toBe("passthrough");
    expect(h.s.state).toBe("functionMode");
    expectRestoredAfterFill(h, 350010);
  });

  test("落在文章（handoff 已解除 hold）時交回是 no-op", () => {
    const h = makeSession();
    openArticle(h, 350026);
    h.s.beginExternalNavigation();
    h.s._handoffArticle();
    h.s.state = "suspended";
    recordFor(h.core).releaseExternal();
    expect(h.s.state).toBe("suspended");
    expect(h.s._holdReason).toBe(null);
  });
});

describe("編號空間：搜尋結果（系列文章）", () => {
  test("rebuild 到搜尋結果 ⇒ 記成 select；離開時 leave-board 強制 rebuild", () => {
    const rows = listRows.slice();
    rows[23] = "  系列文章  " + (rows[23] || "").slice(8);
    const h = makeSession({ rows });
    const facts = h.s._collectFacts(null);
    h.s._rebuild(facts);
    expect(h.s._selectMode).toBe(true);
    expect(h.s.readingPosition().mode).toBe("select");
  });

  test("完整列表 ⇒ plain", () => {
    const h = makeSession();
    h.s._rebuild(h.s._collectFacts(null));
    expect(h.s._selectMode).toBe(false);
    expect(h.s.readingPosition().mode).toBe("plain");
  });
});
