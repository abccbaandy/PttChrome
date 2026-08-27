// 回歸守護：好讀模式下按 F8 切原生，畫面「卡在最後一頁」（非特定文章，長文較常見）。
//
// 症狀根因不是渲染，而是好讀被**自動重新啟用**：F8 (switchToNativeAtBottom) 送 End 跳到
// 文末後 exitEasyReading，畫面靜止下來的第一個 settle 產生了一個**假的「列表(2)→文章(3)」
// 邊緣**，nextEasyReadingState 判定「使用者剛從列表進到一篇文章」→ enterEasyReading()。
// 重新開啟的好讀從文末那一頁開始累積，footer 已是 100% ⇒ 不再送 PageDown ⇒ 畫面就停在
// 最後一頁不動。
//
// 假邊緣從何而來：settle timer 只在畫面**靜止** SETTLE_MS(50ms) 後 fire，而好讀自動翻頁
// 每 ~30-40ms 就有一次 server 活動 ⇒ 整段翻頁期間 timer 一直被 re-arm、從未 fire ⇒
// settledPageState 仍停在進文章前的「列表(2)」，從沒升級成 3。docs/easy-reading.md 當年
// 寫的「退出抑制天生正確：switchToNativeAtBottom 後 settledPageState 仍 3、不再升級」這個
// 假設，只在「翻頁途中至少 settle 過一次」時成立；長文章翻頁久，整段沒有 50ms 空檔的機率
// 更高，所以更容易中。
//
// 實錄：ptt-debug-20260815-204141.json — t=1231..2021 每 32~43ms 一次 recv（自動翻頁，
// 全程無 50ms 空檔）→ t=2035 easyReading.exit → t=2135 easyReading.enter。
//
// 用真的 TermBuf.prototype.notify/_armSettleTimer/_touchRows 驅動 30ms notify + 50ms
// settle 鏈（不建構 TermBuf，constructor 會摸 document），配真的 EasyReading。
import { TermBuf } from "../../src/js/term_buf";
import { EasyReading } from "../../src/js/easy_reading";

vi.mock("../../src/js/pref_storage", () => ({
  readValuesWithDefault: vi.fn(() => ({
    enableEasyReading: true,
    easyReadingEndSwitchNative: true,
    easyReadingEndSwitchKey: "F8"
  }))
}));

// 這些 parser 的正確性有自己的測試；這裡只驗 settle 邊緣的接線。狀態列由 `screen.status`
// 直接給（翻頁中 = 40%，F8 跳到文末後 = 100%），不必真的畫 Big5 畫面。
const screen = vi.hoisted(() => ({
  status: { rowIndexStart: 100, rowIndexEnd: 122, pagePercent: 40 }
}));
vi.mock(import("../../src/js/string_util"), async importOriginal => ({
  ...(await importOriginal()),
  parseStatusRow: vi.fn(() => screen.status)
}));

const ROWS = 24;
const COLS = 80;

function makeBuf() {
  const listeners = {};
  const buf = {
    rows: ROWS,
    cols: COLS,
    changed: false,
    posChanged: false,
    useMouseBrowsing: false,
    // 進文章前：列表畫面已經靜止過，settledPageState 是 2。
    pageState: 2,
    settledPageState: 2,
    prevSettledPageState: 0,
    prevPageState: 0,
    pageLines: [],
    lineChangeds: new Array(ROWS).fill(false),
    // 假的 TermChar 網格：_computeRowState 只讀末列第一格的前/背景色
    lines: Array.from({ length: ROWS }, () =>
      Array.from({ length: COLS }, () => ({ getFg: () => 7, getBg: () => 0 }))
    ),
    cur_x: COLS - 1,
    cur_y: ROWS - 1,
    timerUpdate: null,
    _settleTimer: null,
    _settleChangedRows: new Set(),
    _settleCursorMoved: false,
    _serverActivity: false,
    settleSnapshot: null,
    view: {
      update() {},
      updateCursorPos() {},
      refreshCursorVisibility() {},
      blinkOn: false
    },
    getRowText: () => "",
    updateCharAttr() {},
    setPageState() {},        // pageState 由測試直接設定（模擬伺服器畫面）
    clearHighlight() {},
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    dispatchEvent(ev) {
      (listeners[ev.type] || []).forEach(fn => fn(ev));
    },
    // 受測的真實 prototype 方法
    notify: TermBuf.prototype.notify,
    _armSettleTimer: TermBuf.prototype._armSettleTimer,
    _touchRows: TermBuf.prototype._touchRows,
    syncSettledPageState: TermBuf.prototype.syncSettledPageState
  };
  return buf;
}

function makeER(buf, { enabled = true } = {}) {
  const view = {
    // _enabled 是 view.useEasyReadingMode 的別名（EasyReading constructor 的 bindProperty）
    useEasyReadingMode: enabled,
    mainDisplay: { scrollTop: 4000, scrollHeight: 9000 },
    _send: vi.fn()
  };
  const core = {
    connectedUrl: { easyReadingSupported: true },
    switchToEasyReadingMode: vi.fn(() => { view.useEasyReadingMode = false; })
  };
  const er = new EasyReading(core, view, buf);
  return { er, view, core };
}

// 伺服器寫入一列（_touchRows + changed），等同 puts 之後的 notify 視窗
function serverFrame(buf) {
  buf._touchRows(0, ROWS - 1);
  buf.changed = true;
  buf.notify();
}

describe("F8 切原生後不得被過期的 settledPageState 重新開啟好讀", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    screen.status = { rowIndexStart: 100, rowIndexEnd: 122, pagePercent: 40 };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // 重現用的完整劇本：列表 → 進文章 → 連續自動翻頁（全程無 50ms 空檔）→ F8。
  function runUntilF8(buf, er) {
    // 好讀開著、文章已開始翻頁
    er.startedEasyReading = true;
    buf.pageState = 3;
    for (let i = 0; i < 12; ++i) {
      // 每頁的狀態列行號都不同（翻頁 transaction 靠簽章 ack）
      screen.status = {
        rowIndexStart: 100 + i * 22, rowIndexEnd: 122 + i * 22, pagePercent: 40 + i
      };
      serverFrame(buf);
      vi.advanceTimersByTime(40); // < SETTLE_MS(50)：settle timer 一直被 re-arm
    }
    // 前提條件：整段翻頁期間 settle 從未 fire，settledPageState 還停在列表(2)
    expect(buf.settledPageState).toBe(2);
    expect(buf.pageState).toBe(3);

    er.switchToNativeAtBottom();       // F8
    // End 跳到文末 + ^L 整頁重繪回來，footer 變 100%
    screen.status = { rowIndexStart: 368, rowIndexEnd: 390, pagePercent: 100 };
    serverFrame(buf);
    vi.advanceTimersByTime(300);       // 畫面靜止 → 第一次 settle
  }

  it("翻頁途中按 F8：settle 不得產生假的 2->3 邊緣而重新開啟好讀", () => {
    const buf = makeBuf();
    const { er, view } = makeER(buf);
    const enterSpy = vi.spyOn(er, "enterEasyReading");

    runUntilF8(buf, er);

    expect(enterSpy).not.toHaveBeenCalled();
    expect(er._enabled).toBe(false);
    expect(view.useEasyReadingMode).toBe(false);
  });

  it("exitEasyReading 會把 settle 快照對齊當下畫面，消除過期邊緣", () => {
    const buf = makeBuf();
    const { er } = makeER(buf);

    er.startedEasyReading = true;
    buf.pageState = 3;
    er.exitEasyReading();

    expect(buf.settledPageState).toBe(3);
    expect(buf.prevSettledPageState).toBe(3);
  });

  it("退出時畫面若正好落在半畫幀 (pageState 0)，對齊的是當下值而非硬寫 3", () => {
    const buf = makeBuf();
    const { er } = makeER(buf);

    buf.pageState = 0;
    er.exitEasyReading();

    expect(buf.settledPageState).toBe(0);
    // 後續畫面補完成 3 時只會是 0->3，不是 nextEasyReadingState 認的 1|2->3
    expect(buf.prevSettledPageState).toBe(0);
  });

  // 對照組：正常「列表 → 文章」的自動開啟不能被這個修法擋掉。
  it("列表靜止過後進文章，settle 2->3 仍照常自動開啟好讀", () => {
    const buf = makeBuf();
    const { er } = makeER(buf, { enabled: false });
    const enterSpy = vi.spyOn(er, "enterEasyReading").mockImplementation(() => {});

    screen.status = null;              // 列表畫面沒有文章狀態列
    buf.pageState = 2;
    serverFrame(buf);
    vi.advanceTimersByTime(300);       // 列表 settle → settledPageState 2
    expect(buf.settledPageState).toBe(2);

    buf.pageState = 3;                 // 進文章
    serverFrame(buf);
    vi.advanceTimersByTime(300);

    expect(enterSpy).toHaveBeenCalledTimes(1);
  });
});
