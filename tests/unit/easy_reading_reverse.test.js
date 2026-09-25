// 反向讀取（End）的交易 harness：真的 EasyReading ＋真的 TermView.accumulatePageLines，
// 對著 pmore 分頁模擬器（tests/e2e/helpers/pmore_sim.js，規則出自 pmore.c）逐幀餵。
//
// 鎖的是**行為**：
//   - 讀取中按 End ⇒ 下一個回應就看得到文末；之後往上長，最後與「從頭讀完」逐列相同
//   - 同時只有一個鍵在線上（P4：第二個鍵會讓 pfterm 跳過中間那一幀，那一頁永久消失）
//   - 絕不在第 1 行送 PgUp（PTT 零回應 ⇒ 交易永遠等不到 ack）
//   - wrap 缺口、End 落地 <100%、短文、換文章、functionMode 中途暫停都收斂
// 見 docs/easy-reading.md「反向讀取」。
import { TermView } from "../../src/js/term_view";
import { EasyReading } from "../../src/js/easy_reading";
import { rowToText } from "../../src/js/comment_parse";
import { createPmoreSim } from "../e2e/helpers/pmore_sim.js";

const ROWS = 24;
const PGDN = "\x1b[6~";
const PGUP = "\x1b[5~";
const END = "\x1b[4~";

const cell = (ch) => ({ ch, isLeadByte: false, getFg: () => 7, getBg: () => 0 });
const cells = (text) => {
  const row = [];
  for (let i = 0; i < 80; ++i) row.push(cell(text[i] || " "));
  return row;
};

function setup(simOpts) {
  vi.useFakeTimers();
  const sim = createPmoreSim(simOpts);
  const wire = []; // 已送出、尚未被回應的鍵
  const sent = [];
  let overlaps = 0; // 送鍵當下線上已有未回應的鍵（P4）
  const logs = [];
  const core = {
    connectedUrl: { easyReadingSupported: true },
    debugRecorder: { log: (type, payload) => logs.push({ type, ...payload }) },
    sendMachineBytes(d) {
      if (wire.length) ++overlaps;
      sent.push(d);
      wire.push(d);
      return true;
    },
  };
  const view = Object.create(TermView.prototype);
  let er;
  const buf = {
    rows: ROWS,
    cols: 80,
    cur_y: ROWS - 1,
    cur_x: 79,
    lines: [],
    pageLines: [],
    prevPageState: 0,
    pageState: 3,
    easyReadingPendingReset: false,
    lineChangeds: new Array(ROWS).fill(false),
    changed: false,
    getRowText(r) {
      return rowToText(this.lines[r]);
    },
    addEventListener() {},
    // 與 term_buf.notify 同序：'change' → view.update（redraw → accumulate）→ 'viewUpdate'
    notify() {
      er._onChanged();
      if (er._functionMode) {
        // functionMode：redraw 鏡像原生畫面，不累積
      } else {
        view.accumulatePageLines();
        this.prevPageState = 3;
      }
      er._onViewUpdated();
    },
  };
  view.buf = buf;
  view.mainContainer = null;
  view.mainDisplay = { scrollTop: 0, scrollHeight: 100000 };
  view.chh = 20;
  view._accEndRow = null;
  view._lastAccumulatedSig = null;
  view._articleInstanceId = 0;
  view._reverse = null;
  view._reverseResult = null;
  view._mirrorStatusRowToFooter = () => {};
  view.flashListHint = () => {};
  er = new EasyReading(core, view, buf);
  er._enabled = true;

  const deliverFrame = (f) => {
    buf.lines = f.texts.map(cells);
    buf.cur_y = f.cursor.y;
    buf.cur_x = f.cursor.x;
    buf.lineChangeds.fill(true);
    buf.changed = true;
    buf.notify();
  };
  // 回應線上最早的那個鍵；回傳是否有回應。
  const step = () => {
    const k = wire.shift();
    if (k === undefined) return false;
    const resp = sim.press(k);
    if (!resp) return true;
    resp.frames.forEach(deliverFrame);
    return true;
  };
  const pump = (max = 2000) => {
    let i = 0;
    while (wire.length && i++ < max) step();
  };
  const open = () => deliverFrame(sim.screen());
  const key = (k) =>
    er._onKeyDownProcessUI({ key: k, ctrlKey: false, altKey: false, preventDefault() {} });
  const texts = () => buf.pageLines.map((r) => rowToText(r).replace(/\s+$/, ""));
  const expected = () => sim.allRows();
  return { sim, er, view, buf, wire, sent, logs, step, pump, open, key, texts, expected,
    get overlaps() { return overlaps; } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("前提：forward 讀完＝整篇逐列一次", () => {
  test("無 wrap", () => {
    const h = setup({ total: 200 });
    h.open();
    h.pump();
    expect(h.texts()).toEqual(h.expected());
    expect(h.overlaps).toBe(0);
    expect(h.er.easyReadingReachedPageEnd).toBe(true);
  });
  test("有 wrap", () => {
    const h = setup({ total: 200, wraps: { 30: 2, 44: 3, 45: 2, 150: 2 } });
    h.open();
    h.pump();
    expect(h.texts()).toEqual(h.expected());
  });
});

describe("反向讀取（End）", () => {
  test("讀取中按 End：下一個回應就看得到文末，最後與從頭讀完逐列相同", () => {
    const h = setup({ total: 300 });
    h.open();
    h.step(); // 讀了兩頁；此刻又有一個 PageDown 在途
    expect(h.wire).toEqual([PGDN]);
    h.key("End");
    // P4：在途的 PageDown 還沒回來，End 不可以疊送
    expect(h.wire).toEqual([PGDN]);
    expect(h.overlaps).toBe(0);
    h.step(); // PageDown 的回應到了 ⇒ 這才送 End
    expect(h.wire).toEqual([END]);
    h.step(); // End 的落地頁
    expect(h.texts().at(-1)).toBe("article line 300");
    h.pump();
    expect(h.texts()).toEqual(h.expected());
    expect(h.overlaps).toBe(0);
    expect(h.sim.stats.pgUpAtTop).toBe(0);
    expect(h.er._reverse).toBeNull();
    expect(h.view._reverse).toBeNull();
    expect(h.er.easyReadingReachedPageEnd).toBe(true);
    // 真的是往上讀（不是 End 之後又從 head 一路 PageDown 下去）
    expect(h.sent.filter((k) => k === PGUP).length).toBeGreaterThan(5);
  });

  test("接合後把 PTT 的指標停回文末（seekBack／functionMode resume 依賴它）", () => {
    const h = setup({ total: 300 });
    h.open();
    h.step();
    h.key("End");
    h.pump();
    expect(h.sim.top).toBe(h.sim.endStart);
    expect(h.view._accEndRow).toBe(300);
  });

  test("反向期間累積頁＝head ++ tail，接合點之前的 head 原封不動", () => {
    const h = setup({ total: 300 });
    h.open();
    h.step();
    h.key("End");
    // 在途的 PageDown 先回來（接進 head），這一刻才送 End ⇒ head 從這裡凍結
    h.step();
    expect(h.wire).toEqual([END]);
    const head = h.buf.pageLines.slice();
    h.step(); // End 落地
    h.step(); // 第一次 PgUp（或 goto）
    h.step();
    const J = h.view._reverse.junction;
    expect(J).toBe(head.length);
    for (let i = 0; i < J; ++i) expect(h.buf.pageLines[i]).toBe(head[i]);
    // tail 的末列一路都是文末
    expect(h.texts().at(-1)).toBe("article line 300");
  });

  test("tail 原有列的物件參考在插入新頁時不變（renderer 位移重用的前提）", () => {
    const h = setup({ total: 300 });
    h.open();
    h.step();
    h.key("End");
    h.step();
    h.step(); // End 落地
    const tailBefore = h.buf.pageLines.slice(h.view._reverse.junction);
    h.step(); // 往上讀一頁
    h.step();
    const after = h.buf.pageLines;
    const tailAfter = after.slice(after.length - tailBefore.length);
    tailAfter.forEach((r, i) => expect(r).toBe(tailBefore[i]));
  });

  test("wrap 缺口：重新對準後仍與從頭讀完逐列相同", () => {
    const wraps = {};
    for (let n = 120; n < 260; n += 7) wraps[n] = 2;
    wraps[200] = 4;
    const h = setup({ total: 300, wraps });
    h.open();
    h.step();
    h.key("End");
    h.pump();
    expect(h.texts()).toEqual(h.expected());
    expect(h.overlaps).toBe(0);
    expect(h.sim.stats.pgUpAtTop).toBe(0);
    expect(h.er._reverse).toBeNull();
    // 真的走過重新對準（否則這條測試沒有測到 wrap 缺口）
    expect(h.logs.some((l) => l.type === "easyReading.reverse" && l.action === "goto")).toBe(true);
  });

  test("End 落地 <100%（PMORE_ACCURATE_WRAPEND）：先往下補到文末再往上讀", () => {
    const h = setup({ total: 300, endShortfall: 30 });
    h.open();
    h.step();
    h.key("End");
    h.pump();
    expect(h.texts()).toEqual(h.expected());
    expect(h.overlaps).toBe(0);
  });

  test("短文：End 的落地頁已接上 head ⇒ 直接接起來，零 PgUp", () => {
    const h = setup({ total: 60 });
    h.open(); // 第一頁 1~23，PageDown 在途
    h.key("End");
    h.pump();
    expect(h.texts()).toEqual(h.expected());
    expect(h.sent).not.toContain(PGUP);
    expect(h.er._reverse).toBeNull();
  });

  test("已讀完再按 End：只捲到底，不送任何鍵", () => {
    const h = setup({ total: 100 });
    h.open();
    h.pump();
    const n = h.sent.length;
    h.view.mainDisplay.scrollTop = 0;
    h.key("End");
    expect(h.sent.length).toBe(n);
    expect(h.view.mainDisplay.scrollTop).toBe(100000);
    expect(h.er._reverse).toBeNull();
  });

  test("反向中再按 End：不重複啟動", () => {
    const h = setup({ total: 300 });
    h.open();
    h.step();
    h.key("End");
    h.step();
    h.step();
    const rv = h.er._reverse;
    h.key("End");
    expect(h.er._reverse).toBe(rv);
    expect(h.overlaps).toBe(0);
  });

  test("反向中離開文章（leaveCurrentPost）⇒ 反向狀態清光", () => {
    const h = setup({ total: 300 });
    h.open();
    h.step();
    h.key("End");
    h.step();
    h.step();
    expect(h.view._reverse).not.toBeNull();
    h.er.leaveCurrentPost();
    expect(h.er._reverse).toBeNull();
    expect(h.view._reverse).toBeNull();
  });

  test("functionMode 中途暫停（例如按 X 推文又取消），resume 後繼續往上讀到接合", () => {
    const h = setup({ total: 300 });
    h.open();
    h.step();
    h.key("End");
    h.step();
    h.step();
    h.step();
    // 進 functionMode 時線上可能還有一個 PgUp；它的回應照樣到（畫面鏡像原生）
    h.er._enterFunctionMode();
    h.step();
    expect(h.wire).toEqual([]); // functionMode 期間不送任何翻頁鍵
    // 退出：同一篇文章的乾淨頁 ⇒ resume
    h.er._evalFunctionModeExit();
    h.pump();
    expect(h.texts()).toEqual(h.expected());
    expect(h.overlaps).toBe(0);
  });

  test("PgUp 沒有回應（掉鍵）⇒ watchdog 重送同一個 PgUp，不是 PageDown", () => {
    const h = setup({ total: 300 });
    h.open();
    h.step();
    h.key("End");
    h.step();
    h.step(); // End 落地 ⇒ 送出往上的第一步
    const lost = h.wire.shift(); // 這個鍵被吞掉
    expect([PGUP]).toContain(lost);
    vi.advanceTimersByTime(700);
    expect(h.wire).toEqual([lost]);
    h.pump();
    expect(h.texts()).toEqual(h.expected());
  });

  test("線路忙（別的交易在飛）⇒ 延後，idle 時補送，不疊送", () => {
    const h = setup({ total: 300 });
    h.open();
    h.step();
    h.key("End");
    h.step(); // PageDown 回來 ⇒ 送 End
    h.step(); // End 落地 ⇒ 送往上的第一步
    const busyCore = h.er._core;
    busyCore.commandQueue = { inFlightKind: "open-enter" };
    const k = h.wire.shift();
    const resp = h.sim.press(k);
    h.buf.lines = resp.frames.at(-1).texts.map(cells);
    h.buf.notify(); // 回應到了，但線路被佔 ⇒ 一個鍵都不准送
    expect(h.wire).toEqual([]);
    busyCore.commandQueue = { inFlightKind: null };
    h.er.onWireIdle();
    expect(h.wire.length).toBe(1);
    h.pump();
    expect(h.texts()).toEqual(h.expected());
    expect(h.overlaps).toBe(0);
  });

  test("debug 事件：request → send End → … → done", () => {
    const h = setup({ total: 200 });
    h.open();
    h.step();
    h.key("End");
    h.pump();
    const actions = h.logs.filter((l) => l.type === "easyReading.reverse").map((l) => l.action);
    expect(actions[0]).toBe("request");
    expect(actions).toContain("sendEnd");
    expect(actions).toContain("sendPageUp");
    expect(actions.at(-1)).toBe("done");
  });
});
