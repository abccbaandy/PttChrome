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

  test("soft timeout fires when no settle arrives, then the next command runs", () => {
    const { q, sent } = makeQueue();
    const fail = jest.fn();
    q.enqueue(cmd("A", { timeoutMs: 3000, onFail: fail }));
    q.enqueue(cmd("B"));
    jest.advanceTimersByTime(2999);
    expect(fail).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fail).toHaveBeenCalledWith("timeout");
    expect(sent).toEqual(["A", "B"]); // queue continues after a failure
  });

  test("every settle re-arms the soft timeout (a slow response keeps itself alive)", () => {
    const { q } = makeQueue();
    const fail = jest.fn();
    q.enqueue(cmd("A", { timeoutMs: 3000, onFail: fail }));
    jest.advanceTimersByTime(2000);
    settleWith(q, false); // activity at t=2s
    jest.advanceTimersByTime(2000); // t=4s — old deadline (3s) must NOT have fired
    expect(fail).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000); // t=5s = 2s + fresh 3s window
    expect(fail).toHaveBeenCalledWith("timeout");
  });

  test("hard timeout caps a command that keeps re-arming via settles", () => {
    const { q } = makeQueue();
    const fail = jest.fn();
    q.enqueue(cmd("A", { timeoutMs: 3000, hardTimeoutMs: 10000, onFail: fail }));
    for (let t = 0; t < 5; ++t) {
      jest.advanceTimersByTime(2000);
      settleWith(q, false); // settles every 2s forever
    }
    // t=10s: the absolute cap fires even though the soft window never expired.
    expect(fail).toHaveBeenCalledWith("timeout");
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

  test("onSettle with nothing in flight is a no-op", () => {
    const { q } = makeQueue();
    expect(() => settleWith(q, true)).not.toThrow();
  });
});
