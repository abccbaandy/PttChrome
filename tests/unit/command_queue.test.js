// CommandQueue guards (v4 principle C): single in-flight serialization,
// content-decided completion, settle-re-armed soft timeout, absolute hard cap,
// silent flush. All timing via vitest fake timers.
import { CommandQueue } from "../../src/js/command_queue";

function makeQueue() {
  const sent = [];
  const q = new CommandQueue({ send: k => sent.push(k) });
  return { q, sent };
}
const settleWith = (q, result) => q.onSettle({}, { __result: result });
const cmd = (keys, over = {}) => ({
  keys,
  kind: "test",
  expect: (snap, facts) => facts.__result,
  ...over,
});

describe("CommandQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("sends immediately; a second command waits until the first completes", () => {
    const { q, sent } = makeQueue();
    q.enqueue(cmd("A"));
    q.enqueue(cmd("B"));
    expect(sent).toEqual(["A"]); // serialization: B not sent yet
    expect(q.inFlightKind).toBe("test");

    settleWith(q, false); // half-painted settle → still in flight
    expect(sent).toEqual(["A"]);

    settleWith(q, true); // content predicate satisfied → B goes out
    expect(sent).toEqual(["A", "B"]);
  });

  test("onDone receives the expect result (e.g. edge detection payload)", () => {
    const { q } = makeQueue();
    const done = vi.fn();
    q.enqueue(cmd("A", { onDone: done }));
    settleWith(q, { edge: true });
    expect(done).toHaveBeenCalledWith({ edge: true });
    expect(q.idle).toBe(true);
  });

  test("onSettle 回傳消費結果：done/miss/未消費（reducer 靠它辨識被指令擁有的 settle）", () => {
    const { q } = makeQueue();
    expect(settleWith(q, true)).toBeFalsy(); // 無 in-flight → 未消費

    q.enqueue(cmd("A"));
    expect(settleWith(q, false)).toBeFalsy(); // 半繪，指令仍在線 → 未消費
    expect(settleWith(q, true)).toBe("done"); // 完成幀 → 消費

    q.enqueue(cmd("B", { onFail: vi.fn() }));
    vi.advanceTimersByTime(3000); // 探針上線
    expect(settleWith(q, false)).toBe("miss"); // 探針幀仍不符 → miss 也算消費
  });

  test("fullRepaint appends \\f to the sent keys (v5 deterministic tail)", () => {
    const { q, sent } = makeQueue();
    q.enqueue(cmd("123\r", { fullRepaint: true }));
    expect(sent).toEqual(["123\r\f"]);
  });

  test("timeout → \\f probe first; a truthy expect on the probed frame completes normally", () => {
    const { q, sent } = makeQueue();
    const done = vi.fn();
    const fail = vi.fn();
    q.enqueue(cmd("A", { timeoutMs: 3000, onDone: done, onFail: fail }));
    vi.advanceTimersByTime(2999);
    expect(sent).toEqual(["A"]);
    vi.advanceTimersByTime(1); // soft timeout → probe, not failure
    expect(sent).toEqual(["A", "\f"]);
    expect(fail).not.toHaveBeenCalled();
    expect(q.inFlightKind).toBe("test"); // still in flight, awaiting the frame
    settleWith(q, { edge: true }); // e.g. zero-response board edge, judged by content
    expect(done).toHaveBeenCalledWith({ edge: true });
    expect(fail).not.toHaveBeenCalled();
    expect(q.idle).toBe(true);
  });

  test("probe frame arrives but expect stays falsy → onFail('miss', facts) — a real answer", () => {
    const { q } = makeQueue();
    const fail = vi.fn();
    q.enqueue(cmd("A", { timeoutMs: 3000, onFail: fail }));
    vi.advanceTimersByTime(3000); // probe sent
    q.onSettle({}, { __result: false, kind: "clean-list" });
    expect(fail).toHaveBeenCalledWith("miss", { __result: false, kind: "clean-list" });
    expect(q.idle).toBe(true);
  });

  test("probe unanswered (second silent window) → onFail('timeout'); the next command runs", () => {
    const { q, sent } = makeQueue();
    const fail = vi.fn();
    q.enqueue(cmd("A", { timeoutMs: 3000, onFail: fail }));
    q.enqueue(cmd("B"));
    vi.advanceTimersByTime(3000); // probe
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000); // probe itself timed out → link dead
    expect(fail).toHaveBeenCalledWith("timeout");
    expect(sent).toEqual(["A", "\f", "B"]); // queue continues after a failure
  });

  test("probe: false → timeout fails directly (no \\f sent)", () => {
    const { q, sent } = makeQueue();
    const fail = vi.fn();
    q.enqueue(cmd("A", { timeoutMs: 3000, probe: false, onFail: fail }));
    vi.advanceTimersByTime(3000);
    expect(fail).toHaveBeenCalledWith("timeout");
    expect(sent).toEqual(["A"]);
  });

  test("every settle re-arms the soft timeout (a slow response keeps itself alive)", () => {
    const { q, sent } = makeQueue();
    q.enqueue(cmd("A", { timeoutMs: 3000 }));
    vi.advanceTimersByTime(2000);
    settleWith(q, false); // activity at t=2s
    vi.advanceTimersByTime(2000); // t=4s — old deadline (3s) must NOT have fired
    expect(sent).toEqual(["A"]); // no probe yet
    vi.advanceTimersByTime(1000); // t=5s = 2s + fresh 3s window → probe
    expect(sent).toEqual(["A", "\f"]);
  });

  test("hard timeout caps a command that keeps re-arming via settles (probe, then fail)", () => {
    const { q } = makeQueue();
    const fail = vi.fn();
    q.enqueue(cmd("A", { timeoutMs: 3000, hardTimeoutMs: 10000, onFail: fail }));
    for (let t = 0; t < 4; ++t) {
      vi.advanceTimersByTime(2000);
      settleWith(q, false); // settles every 2s forever
    }
    // t=10s: the absolute cap fires even though the soft window never expired
    // → probe goes out; the next unsatisfying settle (a full frame) means MISS.
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    settleWith(q, false);
    expect(fail).toHaveBeenCalledWith("miss", { __result: false });
    expect(q.idle).toBe(true);
  });

  test("completion cancels both timers", () => {
    const { q } = makeQueue();
    const fail = vi.fn();
    q.enqueue(cmd("A", { timeoutMs: 3000, hardTimeoutMs: 10000, onFail: fail }));
    settleWith(q, true);
    vi.advanceTimersByTime(20000);
    expect(fail).not.toHaveBeenCalled();
  });

  test("flush drops in-flight and pending silently; the queue stays usable", () => {
    const { q, sent } = makeQueue();
    const fail = vi.fn();
    q.enqueue(cmd("A", { onFail: fail }));
    q.enqueue(cmd("B", { onFail: fail }));
    q.flush();
    expect(q.idle).toBe(true);
    expect(q.inFlightKind).toBeNull();
    vi.advanceTimersByTime(20000);
    expect(fail).not.toHaveBeenCalled(); // silent: residue absorbed by native mirror
    q.enqueue(cmd("C"));
    expect(sent).toEqual(["A", "C"]);
  });

  test("flushPending 只清未送出命令，in-flight 保持配對（live race：leave expect 吃掉 anchor 落地）", () => {
    // 症狀：T2 前導 flush() 砍掉 in-flight 的 prefetch anchor，其回應仍在線上
    // → 變成無主 settle，直接滿足下一個交易（leave-board）的 expect → 交易
    // 提早完成、真正的回應之後才到。修法＝flushPending：保留 in-flight，新交易
    // 排在它後面（序列化即修復）。
    const { q, sent } = makeQueue();
    const anchorDone = vi.fn();
    const leaveDone = vi.fn();
    q.enqueue(cmd("42\r", { kind: "prefetch-anchor-down", onDone: anchorDone }));
    q.enqueue(cmd("\x1b[6~", { kind: "prefetch-down" }));
    q.flushPending(); // T2 交易前導：只砍未送出的 page 命令
    q.enqueue(cmd("\x1b[D", { kind: "leave-board", onDone: leaveDone }));
    expect(sent).toEqual(["42\r"]); // leave 排隊等 anchor，不得直送
    settleWith(q, true); // anchor 的落地回應：配對給 anchor，不是 leave
    expect(anchorDone).toHaveBeenCalled();
    expect(leaveDone).not.toHaveBeenCalled();
    expect(sent).toEqual(["42\r", "\x1b[D"]); // anchor 完成後 leave 才上線
    settleWith(q, true);
    expect(leaveDone).toHaveBeenCalled();
    expect(q.idle).toBe(true);
  });

  test("flushPendingKind 只砍指定 kind 前綴的 pending（anchor onFail 不得誤殺排隊中的交易）", () => {
    const { q, sent } = makeQueue();
    q.enqueue(cmd("42\r", { kind: "prefetch-anchor-down" }));
    q.enqueue(cmd("\x1b[6~", { kind: "prefetch-down" }));
    q.enqueue(cmd("\x1b[D", { kind: "leave-board" }));
    q.flushPendingKind("prefetch");
    settleWith(q, true); // anchor 完成 → 下一個是 leave（page 已被砍）
    expect(sent).toEqual(["42\r", "\x1b[D"]);
  });

  test("探針不得重新武裝 hard：絕對上限＝hard＋探針窗，不是 2×hard", () => {
    // 症狀（列表好讀偶發長凍結）：_timedOut 的探針分支呼叫 _armBoth → hard 又
    // 拿到完整一份，單一命令最壞可達 2×hard（實測「畫面停住十幾秒」的來源）。
    // 探針只該重新武裝 SOFT（probeTimeoutMs），hard 是送出當下就定死的絕對截止。
    const { q, sent } = makeQueue();
    const fail = vi.fn();
    q.enqueue(cmd("A", { timeoutMs: 3000, hardTimeoutMs: 5000, onFail: fail }));
    // 每 2s 一個不滿足的 settle：soft 被無限延長，只剩 hard 擋著。
    vi.advanceTimersByTime(2000);
    settleWith(q, false);
    vi.advanceTimersByTime(2000);
    settleWith(q, false); // t=4000，soft 被推到 7000
    vi.advanceTimersByTime(1000); // t=5000：hard 到期 → 探針
    expect(sent).toEqual(["A", "\f"]);
    expect(fail).not.toHaveBeenCalled();
    // 探針窗＝probeTimeoutMs（預設 2000）→ t=7000 必須已經放棄。
    vi.advanceTimersByTime(2000);
    expect(fail).toHaveBeenCalledWith("timeout");
    expect(q.idle).toBe(true);
  });

  test("probeTimeoutMs 可覆寫探針窗", () => {
    const { q } = makeQueue();
    const fail = vi.fn();
    q.enqueue(cmd("A", { timeoutMs: 1000, probeTimeoutMs: 500, onFail: fail }));
    vi.advanceTimersByTime(1000); // 探針
    vi.advanceTimersByTime(499);
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fail).toHaveBeenCalledWith("timeout");
  });

  test("expedite：前景交易排隊時立刻催 in-flight 的探針，且不提前 finish（配對不破）", () => {
    // 症狀：使用者連按翻頁（背景 prefetch 在線）後馬上按 Enter 開文 → 交易只是
    // 排進 _pending，畫面卻已 frozen＋吞鍵，得等 prefetch 走完自己的 soft/hard
    // 才送出。expedite 把 in-flight 的 soft 縮到極短 → 立刻送零副作用的 \f 探針
    // （必有回應）→ 幾百毫秒內讓路。刻意不 _finish：配對不破，不產生無主 settle
    // （不變量 7 的 live race）。
    const { q, sent } = makeQueue();
    q.enqueue(cmd("42\r", { kind: "prefetch-anchor-down", timeoutMs: 4000 }));
    q.enqueue(cmd("100\r", { kind: "open-jump" }));
    q.expedite(250);
    expect(q.inFlightKind).toBe("prefetch-anchor-down"); // 未被提前 finish
    expect(sent).toEqual(["42\r"]);
    vi.advanceTimersByTime(250); // 原本要等 4000
    expect(sent).toEqual(["42\r", "\f"]);
    expect(q.inFlightKind).toBe("prefetch-anchor-down"); // 仍在配對中
    settleWith(q, false); // 探針幀仍不符 → miss → 讓路
    expect(sent).toEqual(["42\r", "\f", "100\r"]);
  });

  test("expedite：已送過探針 / probe:false / 無 in-flight 時皆為 no-op", () => {
    const { q, sent } = makeQueue();
    q.enqueue(cmd("A", { timeoutMs: 3000 }));
    vi.advanceTimersByTime(3000); // 已進探針階段
    expect(sent).toEqual(["A", "\f"]);
    q.expedite(100);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual(["A", "\f"]); // 不重送探針
    q.flush();

    q.enqueue(cmd("B", { timeoutMs: 3000, probe: false }));
    q.expedite(100);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual(["A", "\f", "B"]); // probe:false 不催

    q.flush();
    expect(() => q.expedite(100)).not.toThrow(); // 無 in-flight
  });

  test("flush 對帶 onFlushed 的 in-flight 命令通知（AID active 旗標死鎖）", () => {
    // 症狀：AidNavigation 與 ListSession 共用 queue；list 的 cleanup/切原生會
    // flush()（靜默、不呼叫 onFail）→ in-flight 的 AID 命令被丟掉 → active 永遠
    // 是 true → term_view 吞掉全部鍵盤並一直閃「AID 跳文中」。flush 仍對其他
    // 命令保持靜默，只有 opt-in 的 onFlushed 會被通知。
    const { q } = makeQueue();
    const flushed = vi.fn();
    const fail = vi.fn();
    q.enqueue(cmd("s Gossiping\r", { kind: "aid-board-jump", onFlushed: flushed, onFail: fail }));
    q.enqueue(cmd("#AID\r", { kind: "aid-search", onFlushed: flushed }));
    q.flush();
    expect(flushed).toHaveBeenCalledTimes(1); // 只有 in-flight 那個
    expect(fail).not.toHaveBeenCalled(); // flush 仍不是 onFail
  });

  test("onEvent 診斷時間軸：enqueue → send → probe → fail（debugRecorder 用）", () => {
    const events = [];
    const q = new CommandQueue({
      send: () => {},
      onEvent: (name, info) => events.push([name, info && info.kind]),
    });
    q.enqueue(cmd("A", { kind: "prefetch-anchor-down", timeoutMs: 1000, onFail: () => {} }));
    vi.advanceTimersByTime(1000); // 探針
    vi.advanceTimersByTime(2000); // 探針窗到期 → 放棄
    expect(events).toEqual([
      ["enqueue", "prefetch-anchor-down"],
      ["send", "prefetch-anchor-down"],
      ["probe", "prefetch-anchor-down"],
      ["fail", "prefetch-anchor-down"],
    ]);
  });

  test("onSettle with nothing in flight is a no-op", () => {
    const { q } = makeQueue();
    expect(() => settleWith(q, true)).not.toThrow();
  });
});
