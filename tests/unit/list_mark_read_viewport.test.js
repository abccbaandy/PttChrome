// 右鍵「前已讀後未讀」做完回到好讀列表：閱讀進度（視口頂端那一列）必須還原。
//
// 為什麼會丟：markReadUnreadBefore 走原生 passthrough → _enterFunctionMode 清掉
// _boardName → 靜置探針 resume 一律 ['resume-buffer','rebuild'] → _resumeBuffer／
// _seedAnchors 都改採 **PTT 分頁的視窗頂端** 當 _topNum。而 rebuild 後的緩衝只有
// 落點那一頁，原本的頂端常常在上一頁 ⇒ 就算想還原也找不到，要等往上補頁。
//
// 「前已讀後未讀」只改已讀旗標、不動編號空間與看板 ⇒ 舊錨仍然有效（同 N6「退文
// 不得動捲動錨」）。條件：同板＋真游標仍停在發起的那一篇。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ListSession } from "../../src/js/list_session";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "replay", "cchat-list.page.json"),
    "utf8"
  )
);
const listRows = fixture.pageScreens[0]; // 真實 C_Chat 一頁：350024..350039＋置底

const PREF_KEY = "pttchrome.pref.v1";
const ROW_H = 20;

function rowOf(text) {
  return text.split("").map((c) => ({ ch: c, isLeadByte: false }));
}

// 緩衝 = from..to 的編號列（模擬 term_view 的 accumulate 結果）。
function fillBuffer(termBuf, from, to) {
  termBuf.listLines = [];
  termBuf.listLineNums = [];
  for (let n = from; n <= to; ++n) {
    termBuf.listLines.push(rowOf(` ${n} +   6/14 author${n}  □ 標題${n}`));
    termBuf.listLineNums.push(n);
  }
}

// topNum ＝使用者捲到的視口頂端（DOM scrollTop 同步設好：markRead 的重繪會從 DOM
// 重新擷取錨）。
// landing ＝ rebuild 那次同步重繪累積進緩衝的落點頁範圍。
function makeSession({
  curY = 5,
  curX = 1,
  topNum = 350010,
  landing = [350024, 350039],
  rows = listRows,
} = {}) {
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
  const screen = { rows: rows.slice(), curY, curX };
  const termBuf = {
    rows: 24,
    cols: 80,
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
    // 模擬 term_view.redraw 的列表分支：_forceRedraw 是同步的，rebuild 後的第一次
    // 重繪會把落點那一頁累積進緩衝，前後各跑一次錨的擷取／還原。
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
    hasKind: () => false,
    enqueue: (cmd) => enqueued.push(cmd),
    onSettle: () => null,
  };
  s = new ListSession({ conn: { send() {} } }, view, termBuf, queue);
  const boardName = s._collectFacts(null).boardName;
  // 使用者捲到較舊的地方讀：視口頂端 350010，游標（右鍵那一列）350026。
  s.state = "active";
  s._renderMode = "buffer";
  s._boardName = boardName;
  // 緩衝比落點頁多出上下各一段，視口才不會被 maxScrollTop 夾住。
  fillBuffer(termBuf, 350000, 350059);
  s._topNum = topNum;
  s._scrollFrac = 0;
  s._selectedNum = 350026;
  s._serverNum = 350026;
  scrollTop = (topNum - 350000) * ROW_H;
  return { s, enqueued, scrollWrites, screen, termBuf, boardName };
}

// 走完 v → w⏎ 兩步，停在原生鏡像（hold='passthrough'）。
function runMarkRead(h, num) {
  expect(h.s.markReadUnreadBefore(num)).toBe(true);
  h.enqueued.find((c) => c.kind === "mark-read-prompt").onDone(true);
  const w = h.enqueued.find((c) => c.kind === "mark-read-apply");
  w.expect(null, { rowTexts: [], rows: 24 });
  w.onDone(true);
  expect(h.s._renderMode).toBe("native");
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(
    PREF_KEY,
    JSON.stringify({
      values: { enableEasyReadingList: true, enableListNativeAutoResume: true },
    })
  );
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("前已讀後未讀 → 回好讀時還原閱讀進度", () => {
  test("fixture 前提：C_Chat 看板、游標列是 350026", () => {
    const h = makeSession();
    const f = h.s._collectFacts(null);
    expect(f.kind).toBe("clean-list");
    expect(h.boardName).toBeTruthy();
    expect(f.cursorRowNum).toBe(350026);
  });

  test("錨在落點頁之上：等補頁把它帶進來那一幀才還原，不被寫死成 PTT 分頁頂端", () => {
    const h = makeSession();
    runMarkRead(h, 350026);
    const before = h.enqueued.length;
    vi.advanceTimersByTime(300); // 靜置探針 → resume-buffer + rebuild
    expect(h.s.state).toBe("active");
    expect(h.s._renderMode).toBe("buffer");

    // rebuild 為了找回錨一定要往上補（預抓目標 0 也一樣）。
    const fills = h.enqueued.slice(before).filter((c) => /up|fill/i.test(c.kind));
    expect(fills.length).toBeGreaterThan(0);

    // 落點那一頁進緩衝（rebuild 的同步重繪）：錨還不在 ⇒ 先不動、保留待還原。
    expect(h.s._pendingViewport).not.toBe(null);

    // 往上補的那一頁到了 ⇒ 還原到 350010。
    fillBuffer(h.termBuf, 350004, 350039);
    h.s._seqCache = null;
    h.s.applyScrollAfterRender();
    expect(h.s._topNum).toBe(350010);
    expect(h.s._pendingViewport).toBe(null);
    expect(h.scrollWrites[h.scrollWrites.length - 1]).toBe(
      (350010 - 350004) * ROW_H
    );
  });

  // 板尾還沒確認（落點頁沒有置底列）時，錨列即使在落點頁裡也常常捲不到——緩衝
  // 只有一個視窗高，scrollTop 被 maxScrollTop 夾住，下一次重繪的 capture 會把錨
  // 改寫成夾住後那一列。必須等下方補頁、捲得到了才套用。
  test("錨在落點頁內但下方不足一個視窗 ⇒ 往下補，捲得到那一幀才還原", () => {
    // 置底列換成一般文章 ⇒ 這一頁看不出板尾（_edgeDown 維持 false）。
    const rows = listRows.slice();
    rows[18] = rows[18].replace("●50039", " 350039");
    for (let r = 19; r <= 22; ++r)
      rows[r] = ` ${350021 + r} +   6/14 author      □ 標題${r}`;
    const h = makeSession({
      curY: 10, // 真游標 350031
      topNum: 350030,
      landing: [350024, 350043],
      rows,
    });
    h.s._selectedNum = 350031;
    h.s._serverNum = 350031;
    runMarkRead(h, 350031);
    const before = h.enqueued.length;
    vi.advanceTimersByTime(300);
    expect(h.s.state).toBe("active");
    expect(h.s._edgeDown).toBe(false);
    // 錨列在緩衝裡，但 20 列的緩衝捲不動 ⇒ 還不能套用。
    expect(h.s._pendingViewport).not.toBe(null);
    const downs = h.enqueued.slice(before).filter((c) => /down/.test(c.kind));
    expect(downs.length).toBeGreaterThan(0);

    fillBuffer(h.termBuf, 350024, 350059);
    h.s._seqCache = null;
    h.s.applyScrollAfterRender();
    expect(h.s._topNum).toBe(350030);
    expect(h.s._pendingViewport).toBe(null);
    expect(h.scrollWrites[h.scrollWrites.length - 1]).toBe(
      (350030 - 350024) * ROW_H
    );
  });

  // 錄製檔 ptt-debug-20260924-004016.json#t=13891..18324：resume 後只往下補到底，
  // 之後 4.4 秒完全沒有往上補，錨在落點頁之上的那幾次就還原不了（逾時作廢）。
  // 根因：rebuild 當下往下的 demand 先佔住佇列，_maybeFill 因佇列忙而直接返回；
  // 往下補的鏈到底時 markEdge 不會把工作交回 _maybeFill。上面幾支的 stub 佇列永遠
  // idle，所以測不到——這支讓佇列真的「送出後忙、完成後閒」。
  test("往下補先佔住佇列、到底收尾之後，仍要接著往上補把錨帶進來", () => {
    const rows = listRows.slice();
    rows[18] = rows[18].replace("●50039", " 350039");
    for (let r = 19; r <= 22; ++r)
      rows[r] = ` ${350021 + r} +   6/14 author      □ 標題${r}`;
    const h = makeSession({ curY: 10, landing: [350024, 350043], rows });
    h.s._selectedNum = 350031;
    h.s._serverNum = 350031;
    // 佇列：enqueue 即忙，由測試手動完成。
    const q = h.s._queue;
    q.enqueue = (cmd) => {
      h.enqueued.push(cmd);
      q.idle = false;
    };
    runMarkRead(h, 350031);
    // resume 那一刻佇列正被一條往下的 demand 佔著（真實情況：resume-buffer 那一幀
    // 留下的舊 scrollTop 讓 rebuild 擷取到的頂端落在頁尾 ⇒ 視窗不足、先往下補）。
    q.idle = false;
    vi.advanceTimersByTime(300);
    expect(h.s.state).toBe("active");
    expect(h.s._pendingViewport).not.toBe(null);
    q.idle = true;
    const before = h.enqueued.length;
    h.s._enqueuePrefetch(false, "key");
    const down = h.enqueued.slice(before).find((c) => c.kind === "prefetch-down");
    expect(down).toBeDefined();

    // 往下那一腿完成且確認是板尾（markEdge）。錄製檔裡往下補了 4 頁 ⇒ _fillPages
    // 已經超過「為錨往上補」的頁數上限，那個上限不可以跟往下的頁數共用。
    h.s._fillPages = 4;
    q.idle = true;
    const n = h.enqueued.length;
    down.onDone({ edge: true, landed: 350043 });
    const ups = h.enqueued.slice(n).filter((c) => /up/.test(c.kind));
    expect(ups.length).toBeGreaterThan(0);
  });

  test("使用者在原生鏡像裡移動過游標 ⇒ 不還原（採用落點，舊行為）", () => {
    const h = makeSession();
    runMarkRead(h, 350026);
    h.screen.curY = 8; // 真游標跑到 350029
    vi.advanceTimersByTime(300);
    expect(h.s.state).toBe("active");
    expect(h.s._pendingViewport).toBe(null);
    expect(h.s._topNum).toBe(350024);
  });

  test("回好讀後使用者先動了（按鍵）⇒ 待還原作廢，補頁到了也不拉回去", () => {
    const h = makeSession();
    runMarkRead(h, 350026);
    vi.advanceTimersByTime(300);
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

  test("逾時仍找不到 ⇒ 丟棄", () => {
    const h = makeSession();
    runMarkRead(h, 350026);
    vi.advanceTimersByTime(300);
    vi.advanceTimersByTime(11000);
    h.s.applyScrollAfterRender();
    expect(h.s._pendingViewport).toBe(null);
  });
});
