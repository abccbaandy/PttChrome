// CommandQueue guards (v4 principle C): single in-flight serialization,
// content-decided completion, settle-re-armed soft timeout, absolute hard cap,
// silent flush. All timing via jest fake timers.
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
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

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
    const done = jest.fn();
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

    q.enqueue(cmd("B", { onFail: jest.fn() }));
    jest.advanceTimersByTime(3000); // 探針上線
    expect(settleWith(q, false)).toBe("miss"); // 探針幀仍不符 → miss 也算消費
  });

  test("fullRepaint appends \\f to the sent keys (v5 deterministic tail)", () => {
    const { q, sent } = makeQueue();
    q.enqueue(cmd("123\r", { fullRepaint: true }));
    expect(sent).toEqual(["123\r\f"]);
  });

  test("timeout → \\f probe first; a truthy expect on the probed frame completes normally", () => {
    const { q, sent } = makeQueue();
    const done = jest.fn();
    const fail = jest.fn();
    q.enqueue(cmd("A", { timeoutMs: 3000, onDone: done, onFail: fail }));
    jest.advanceTimersByTime(2999);
    expect(sent).toEqual(["A"]);
    jest.advanceTimersByTime(1); // soft timeout → probe, not failure
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
    const fail = jest.fn();
    q.enqueue(cmd("A", { timeoutMs: 3000, onFail: fail }));
    jest.advanceTimersByTime(3000); // probe sent
    q.onSettle({}, { __result: false, kind: "clean-list" });
    expect(fail).toHaveBeenCalledWith("miss", { __result: false, kind: "clean-list" });
    expect(q.idle).toBe(true);
  });

  test("probe unanswered (second silent window) → onFail('timeout'); the next command runs", () => {
    const { q, sent } = makeQueue();
    const fail = jest.fn();
    q.enqueue(cmd("A", { timeoutMs: 3000, onFail: fail }));
    q.enqueue(cmd("B"));
    jest.advanceTimersByTime(3000); // probe
    expect(fail).not.toHaveBeenCalled();
    jest.advanceTimersByTime(3000); // probe itself timed out → link dead
    expect(fail).toHaveBeenCalledWith("timeout");
    expect(sent).toEqual(["A", "\f", "B"]); // queue continues after a failure
  });

  test("probe: false → timeout fails directly (no \\f sent)", () => {
    const { q, sent } = makeQueue();
    const fail = jest.fn();
    q.enqueue(cmd("A", { timeoutMs: 3000, probe: false, onFail: fail }));
    jest.advanceTimersByTime(3000);
    expect(fail).toHaveBeenCalledWith("timeout");
    expect(sent).toEqual(["A"]);
  });

  test("every settle re-arms the soft timeout (a slow response keeps itself alive)", () => {
    const { q, sent } = makeQueue();
    q.enqueue(cmd("A", { timeoutMs: 3000 }));
    jest.advanceTimersByTime(2000);
    settleWith(q, false); // activity at t=2s
    jest.advanceTimersByTime(2000); // t=4s — old deadline (3s) must NOT have fired
    expect(sent).toEqual(["A"]); // no probe yet
    jest.advanceTimersByTime(1000); // t=5s = 2s + fresh 3s window → probe
    expect(sent).toEqual(["A", "\f"]);
  });

  test("hard timeout caps a command that keeps re-arming via settles (probe, then fail)", () => {
    const { q } = makeQueue();
    const fail = jest.fn();
    q.enqueue(cmd("A", { timeoutMs: 3000, hardTimeoutMs: 10000, onFail: fail }));
    for (let t = 0; t < 4; ++t) {
      jest.advanceTimersByTime(2000);
      settleWith(q, false); // settles every 2s forever
    }
    // t=10s: the absolute cap fires even though the soft window never expired
    // → probe goes out; the next unsatisfying settle (a full frame) means MISS.
    expect(fail).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2000);
    settleWith(q, false);
    expect(fail).toHaveBeenCalledWith("miss", { __result: false });
    expect(q.idle).toBe(true);
  });

  test("completion cancels both timers", () => {
    const { q } = makeQueue();
    const fail = jest.fn();
    q.enqueue(cmd("A", { timeoutMs: 3000, hardTimeoutMs: 10000, onFail: fail }));
    settleWith(q, true);
    jest.advanceTimersByTime(20000);
    expect(fail).not.toHaveBeenCalled();
  });

  test("flush drops in-flight and pending silently; the queue stays usable", () => {
    const { q, sent } = makeQueue();
    const fail = jest.fn();
    q.enqueue(cmd("A", { onFail: fail }));
    q.enqueue(cmd("B", { onFail: fail }));
    q.flush();
    expect(q.idle).toBe(true);
    expect(q.inFlightKind).toBeNull();
    jest.advanceTimersByTime(20000);
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
    const anchorDone = jest.fn();
    const leaveDone = jest.fn();
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

  test("onSettle with nothing in flight is a no-op", () => {
    const { q } = makeQueue();
    expect(() => settleWith(q, true)).not.toThrow();
  });
});
