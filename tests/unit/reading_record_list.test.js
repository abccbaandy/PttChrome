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
import { HelpMenuController, parseHelpMenuScreen } from "../../src/js/help_menu";
import { submitSearch } from "../../src/js/article_search";
import { HELP_FAV_PAGE1 } from "./fixtures/help_menu_rows";

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
  // 原生鏡像才會把終端機游標叫出來（_enterFunctionMode）⇒ 計數＝翻到原生的次數。
  const native = { shown: 0 };
  const view = {
    hideCursor() {},
    showCursor() {
      native.shown++;
    },
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
  return { s, core, enqueued, scrollWrites, screen, termBuf, boardName, native };
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

// 說明選單：按 h 是一般的原生 passthrough（切原生、清看板身分），說明選單由
// HelpMenuController 接手；畫面離開說明選單時交回書籤。termBuf 給 null：這裡直接餵
// 解析結果（noteScreen），不經 screenSettled。
function openHelp(h) {
  h.s._beginPassthroughBytes("h");
  step(h, "native-key").onDone(true);
  expect(h.s._renderMode).toBe("native");
  const sent = [];
  const hm = new HelpMenuController(h.core, null, {
    send: (b) => sent.push(b),
    enabled: () => true,
  });
  hm.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1));
  expect(hm.phase).toBe("open");
  return { hm, sent };
}

describe("說明選單（h）：離開後回好讀時視野回到原處", () => {
  test("在彈窗按離開（q）⇒ 回原處", () => {
    const h = makeSession();
    const { hm, sent } = openHelp(h);
    hm.close();
    expect(sent[sent.length - 1]).toBe("q");
    hm.noteScreen(null); // PTT 重畫文章列表
    expectRestoredAfterFill(h, 350010);
  });

  test("改看原生畫面、在原生說明選單裡自己離開 ⇒ 一樣回原處", () => {
    const h = makeSession();
    const { hm } = openHelp(h);
    hm.showNative();
    hm.noteScreen(parseHelpMenuScreen(HELP_FAV_PAGE1)); // 原生期間的說明幀不理
    hm.noteScreen(null);
    expectRestoredAfterFill(h, 350010);
  });

  test("執行說明選單的某一項 ⇒ 指令的結果就是目的地，不還原", () => {
    const h = makeSession();
    const { hm } = openHelp(h);
    hm.select(0);
    hm.noteScreen(null);
    vi.advanceTimersByTime(300);
    expect(h.s.state).toBe("active");
    expect(h.s._pendingViewport).toBe(null);
    expect(h.s._topNum).toBe(350024);
  });

  test("斷線（reset）⇒ 書籤直接作廢，不還原", () => {
    const h = makeSession();
    const { hm } = openHelp(h);
    hm.reset();
    hm.noteScreen(null);
    vi.advanceTimersByTime(300);
    expect(h.s._pendingViewport).toBe(null);
  });
});

describe("文章搜尋：送出後回到同一份列表時視野回原處", () => {
  test("找不到符合條件（vmsg 後 READ_REDRAW 回原列表）⇒ 回原處", () => {
    const h = makeSession();
    // 關鍵字用 ASCII：u2b 需要 Big5 轉碼表（window.lib），這裡不載。
    expect(submitSearch(h.core, "title", "nomatch")).toBe(true);
    step(h, "search-open").onDone(true);
    step(h, "search-submit").onDone(true);
    expectRestoredAfterFill(h, 350010);
  });

  test("prompt 沒開出來（關鍵字沒送）⇒ 回原處", () => {
    const h = makeSession();
    const onFail = vi.fn();
    submitSearch(h.core, "author", "someone", { onFail });
    step(h, "search-open").onFail("timeout");
    expect(onFail).toHaveBeenCalled();
    expectRestoredAfterFill(h, 350010);
  });

  test("有結果（落在系列文章，另一個編號空間）⇒ 認不出，不還原", () => {
    const h = makeSession();
    submitSearch(h.core, "title", "found");
    step(h, "search-open").onDone(true);
    step(h, "search-submit").onDone(true);
    h.screen.rows[23] = "  系列文章  " + (h.screen.rows[23] || "").slice(8);
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

  // 斷線重連後回到原處（reconnect_resume）：onClose 把 session disable 成 idle，重連後
  // 從主功能表出發。fromIdle 讓它照樣停泊，序列收尾後 rebuild 驗證（只比板）再還原。
  test("斷線重連：從 idle 停泊 → 收尾交回 ⇒ 回好讀，視野回到斷線前", () => {
    const h = makeSession();
    const before = h.s.readingPosition();
    expect(before).toMatchObject({ board: h.boardName, topNum: 350010 });
    h.s.disable(); // App.onClose
    expect(h.s.state).toBe("idle");
    h.s.beginExternalNavigation({ fromIdle: true });
    expect(h.s.state).toBe("functionMode");
    expect(h.s._holdReason).toBe("external");
    const rr = recordFor(h.core);
    rr.end(
      { feature: "reconnect-resume", article: null, list: { ...before, matchBoardOnly: true } },
      "done",
      { only: "list" }
    );
    rr.releaseExternal();
    expectRestoredAfterFill(h, 350010);
  });

  test("沒有 fromIdle（一般跳文）／列表好讀沒開 ⇒ idle 照舊不動", () => {
    const h = makeSession();
    h.s.disable();
    h.s.beginExternalNavigation();
    expect(h.s.state).toBe("idle");
    window.localStorage.setItem(
      PREF_KEY,
      JSON.stringify({ values: { enableEasyReadingList: false } })
    );
    h.s.beginExternalNavigation({ fromIdle: true });
    expect(h.s.state).toBe("idle");
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

// 「前已讀後未讀」那條優化的同型延遲：兩步序列
// 早就做完，舊流程卻是「切原生（PTT 的 prompt 畫給使用者看）→ 空等靜置探針 250ms →
// rebuild 切回好讀」，畫面翻面兩次。最後一步從 prompt 送出的序列改走凍結交易，落地
// 那一幀就回好讀（list_session._beginLandingTransaction）。
// 下面每一條都**不推進計時器**就斷言回到好讀：等探針的舊行為在這裡必紅。
describe("落地即回好讀：重新整理／搜尋／跳到未讀不切原生、不等探針", () => {
  // 落地幀＝當下畫面（真實 C_Chat 列表，游標停在發起的 350026）。
  const landOn = (h, kind) => {
    const c = step(h, kind);
    expect(c.expect(null, h.s._collectFacts(null))).toBeTruthy();
    c.onDone(true);
  };

  test("列表重新整理：s → 板名⏎ 全程凍著，落地當下回好讀，視野回原處", () => {
    const h = makeSession();
    const sr = new ScreenRefresh(h.core);
    expect(sr._dispatch({ kind: "article-list", board: "C_Chat" })).toBe(true);
    expect(h.s._renderMode).toBe("frozen");
    step(h, "refresh-open").onDone(true);
    expect(h.s._renderMode).toBe("frozen"); // CompleteBoard prompt 沒畫給使用者看
    landOn(h, "refresh-submit");
    expect(h.s.state).toBe("active");
    expect(h.s._renderMode).toBe("buffer");
    expect(h.native.shown).toBe(0);
    expect(h.s._pendingViewport).not.toBe(null);
    fillBuffer(h.termBuf, 350004, 350039);
    h.s._seqCache = null;
    h.s.applyScrollAfterRender();
    expect(h.s._topNum).toBe(350010);
  });

  test("文章搜尋：打字回顯那一幀（prompt 還在）不算落地；結果列表一到就回好讀", () => {
    const h = makeSession();
    expect(submitSearch(h.core, "title", "found")).toBe(true);
    step(h, "search-open").onDone(true);
    expect(h.s._renderMode).toBe("frozen");
    const submit = step(h, "search-submit");
    const list = { rows: h.screen.rows.slice(), curY: h.screen.curY };
    h.screen.rows[23] = "搜尋標題: found";
    h.screen.curY = 23;
    expect(submit.expect(null, h.s._collectFacts(null))).toBe(false);
    h.screen.rows = list.rows;
    h.screen.curY = list.curY;
    h.screen.rows[23] = "  系列文章  " + (h.screen.rows[23] || "").slice(8);
    landOn(h, "search-submit");
    expect(h.s.state).toBe("active");
    expect(h.s._renderMode).toBe("buffer");
    expect(h.native.shown).toBe(0);
    expect(h.s._selectMode).toBe(true); // 搜尋結果＝另一個編號空間，rebuild 有認出來
  });

  test("文章搜尋：找不到（vmsg）⇒ 停在原生鏡像讓使用者看，交給靜置探針", () => {
    const h = makeSession();
    submitSearch(h.core, "title", "nomatch");
    step(h, "search-open").onDone(true);
    h.screen.rows[23] = "            找不到符合條件的文章。      請按任意鍵繼續";
    h.screen.curY = 23;
    h.screen.curX = 60;
    landOn(h, "search-submit");
    expect(h.s._renderMode).toBe("native");
    expect(h.s._holdReason).toBe("passthrough");
  });

  test("最後一步標 trustLanding:false（落點不能自證游標）⇒ 照舊交給探針", () => {
    const h = makeSession();
    h.s._beginPassthroughBytes(
      [{ keys: "\x1b[5~", kind: "unread-pgup", trustLanding: false, expect: () => true }],
      { kind: "unread-jump", hint: null, resumeOnLanding: true }
    );
    expect(h.s._renderMode).toBe("frozen");
    landOn(h, "unread-pgup");
    expect(h.s._renderMode).toBe("native");
    expect(h.s._holdReason).toBe("passthrough");
  });

  test("跳到第一篇未讀的跳號（numJumpLanded 自證游標）⇒ 落地即回好讀", () => {
    const h = makeSession();
    h.s._beginPassthroughBytes(
      [
        { keys: "\x1b[5~", kind: "unread-pgup", trustLanding: false, expect: () => true },
        { keys: "350026\r", kind: "unread-jump", expect: () => true },
      ],
      { kind: "unread-jump", hint: null, resumeOnLanding: true }
    );
    landOn(h, "unread-pgup");
    expect(h.s._renderMode).toBe("frozen"); // 中間步驟不翻原生
    landOn(h, "unread-jump");
    expect(h.s.state).toBe("active");
    expect(h.s._renderMode).toBe("buffer");
    expect(h.native.shown).toBe(0);
  });

  // 進板／搜尋服務比一般按鍵慢，步驟自帶 5s 預算：凍結後盾（2.5s）不可以搶先把畫面
  // 降級成原生（＋「指令逾時」紅字），命令自己的逾時才是結論。
  test("步驟自帶較長預算 ⇒ 照用，凍結後盾撐得過它", () => {
    const h = makeSession();
    h.s._beginPassthroughBytes(
      [{ keys: "x\r", kind: "slow", timeoutMs: 1500, probeTimeoutMs: 700, hardTimeoutMs: 5000 }],
      { kind: "slow", hint: null, resumeOnLanding: true }
    );
    const c = step(h, "slow");
    expect(c.hardTimeoutMs).toBe(5000);
    expect(c.probeTimeoutMs).toBe(700);
    if (c.onSend) c.onSend();
    vi.advanceTimersByTime(3000);
    expect(h.s._renderMode).toBe("frozen");
    // hard 5000 + probe 700 之後後盾才降級（再晚 250ms 靜置探針就會把它接回好讀）。
    vi.advanceTimersByTime(2800);
    expect(h.s._renderMode).toBe("native");
  });

  // CodeQL js/resource-exhaustion：步驟帶進來的預算決定後盾的 setTimeout 長度。
  // 預算再離譜（或被帶錯），凍結畫面也有絕對上限，不可以變成永久凍結＋吞鍵。
  test("步驟預算再大，凍結後盾也有絕對上限（10s）", () => {
    const h = makeSession();
    h.s._beginPassthroughBytes(
      [{ keys: "x\r", kind: "slow", hardTimeoutMs: 1e9, probeTimeoutMs: 1e9 }],
      { kind: "slow", hint: null, resumeOnLanding: true }
    );
    const c = step(h, "slow");
    if (c.onSend) c.onSend();
    vi.advanceTimersByTime(9900);
    expect(h.s._renderMode).toBe("frozen");
    vi.advanceTimersByTime(200);
    expect(h.s._renderMode).toBe("native");
  });

  test("pref 自動回復關掉 ⇒ 舊行為：一開始就切原生鏡像", () => {
    const h = makeSession();
    window.localStorage.setItem(
      PREF_KEY,
      JSON.stringify({ values: { enableEasyReadingList: true, enableListNativeAutoResume: false } })
    );
    new ScreenRefresh(h.core)._dispatch({ kind: "article-list", board: "C_Chat" });
    expect(h.s._renderMode).toBe("native");
  });
});
