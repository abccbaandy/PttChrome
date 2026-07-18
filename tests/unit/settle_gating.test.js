// 好讀列表「按住 PgUp/PgDn 無效」回歸：本地 _forceRedraw（lineChangeds.fill +
// changed=true，無 server 寫入）每 ~30ms notify 一次，舊行為每次 notify 都
// _armSettleTimer → settle 永不 fire → CommandQueue expect 餓死、prefetch 卡住。
// 修法：settle timer 只由 server 活動（_touchRows / 游標 escape 的 posChanged）
// re-arm；純本地重繪不得推遲已在倒數的 settle。
// 直接以 stub 呼叫真的 TermBuf.prototype（notify/_armSettleTimer/_touchRows），
// 不建構 TermBuf（constructor 摸 document）。
import { TermBuf } from "../../src/js/term_buf";

const SETTLE_MS = 50; // 與 term_buf.js 同步

function makeBuf() {
  const events = [];
  return {
    // notify 依賴的最小狀態
    changed: false,
    posChanged: false,
    useMouseBrowsing: false,
    pageState: 2,
    settledPageState: 2,
    prevSettledPageState: 2,
    cur_x: 1,
    cur_y: 5,
    timerUpdate: null,
    _settleTimer: null,
    _settleChangedRows: new Set(),
    settleSnapshot: null,
    _serverActivity: false,
    _settleCursorMoved: false,
    view: { update() {}, updateCursorPos() {}, blinkOn: false },
    updateCharAttr() {},
    setPageState() {},
    clearHighlight() {},
    dispatchEvent(ev) {
      events.push(ev.type);
    },
    events,
    // 受測的真實 prototype 方法
    notify: TermBuf.prototype.notify,
    _armSettleTimer: TermBuf.prototype._armSettleTimer,
    _touchRows: TermBuf.prototype._touchRows,
  };
}

// 模擬 server 寫入一列（同 puts 的效果：_touchRows + changed）
function serverWrite(buf, row) {
  buf._touchRows(row, row);
  buf.changed = true;
  buf.notify();
}

// 模擬本地 _forceRedraw（list_session._forceRedraw：只有 changed，無 server 活動）
function localRepaint(buf) {
  buf.changed = true;
  buf.notify();
}

describe("settle 只由 server 活動 re-arm（按住 nav 鍵不得餓死 settle）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("server 回應後按住鍵連續本地重繪：settle 仍在 SETTLE_MS 內 fire", () => {
    const buf = makeBuf();
    serverWrite(buf, 5); // prefetch 回應到達
    // 使用者按住鍵：每 30ms 一次本地重繪，共 10 次（>> SETTLE_MS）
    for (let i = 0; i < 10; ++i) {
      vi.advanceTimersByTime(30);
      localRepaint(buf);
    }
    expect(buf.events).toContain("screenSettled");
    expect(buf.settleSnapshot).not.toBeNull();
    expect(Array.from(buf.settleSnapshot.changedRows)).toEqual([5]);
  });

  test("server 持續送資料時 settle 照舊被推遲（原不變量不回歸）", () => {
    const buf = makeBuf();
    serverWrite(buf, 5);
    vi.advanceTimersByTime(30);
    serverWrite(buf, 6); // 30ms 後又一筆 → re-arm
    vi.advanceTimersByTime(30); // 距第二筆僅 30ms < SETTLE_MS
    expect(buf.events).not.toContain("screenSettled");
    vi.advanceTimersByTime(SETTLE_MS);
    expect(buf.events).toContain("screenSettled");
    expect(Array.from(buf.settleSnapshot.changedRows).sort()).toEqual([5, 6]);
  });

  test("游標-only frame（posChanged，server escape）仍 re-arm settle，且 snapshot 帶 cursorMoved", () => {
    // 回應的內容窗與游標 park 窗相隔 >SETTLE_MS 時會 settle 兩次；第二個
    // settle（零內容列）必須帶 cursorMoved=true，讓 ListSession 守門放行給
    // CommandQueue（否則 anchor expect 餓死 —— offline 重放實測）。
    const buf = makeBuf();
    buf.posChanged = true; // gotoPos 等 escape 只設 posChanged
    buf.notify();
    vi.advanceTimersByTime(SETTLE_MS + 1);
    expect(buf.events).toContain("screenSettled");
    expect(buf.settleSnapshot.cursorMoved).toBe(true);
    expect(buf.settleSnapshot.changedRows.size).toBe(0);
    // 下一個窗重新起算
    expect(buf._settleCursorMoved).toBe(false);
  });

  test("純本地重繪自己不觸發 settle timer（沒有 server 活動就沒有 settle）", () => {
    const buf = makeBuf();
    localRepaint(buf);
    vi.advanceTimersByTime(SETTLE_MS * 4);
    expect(buf.events).not.toContain("screenSettled");
  });
});
