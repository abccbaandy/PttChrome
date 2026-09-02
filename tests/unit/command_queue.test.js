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

  // onIdle：線路真的空出來的那一刻通知（好讀模式的 deferred 送鍵靠它補送）。
  // 「真的空」= 沒有 in-flight 也沒有 pending，所以必須在 _maybeSendNext 之後判定：
  // open-jump 的 onDone 會接著 enqueue open-enter，那種情況線路根本沒空過。
  describe("onIdle（線路空出來的通知）", () => {
    const makeIdleQueue = () => {
      const sent = [];
      const idle = vi.fn();
      const q = new CommandQueue({ send: k => sent.push(k), onIdle: idle });
      return { q, sent, idle };
    };

    test("done 之後線路空 → 通知一次", () => {
      const { q, idle } = makeIdleQueue();
      q.enqueue(cmd("A"));
      expect(idle).not.toHaveBeenCalled();
      settleWith(q, true);
      expect(idle).toHaveBeenCalledTimes(1);
    });

    test("REGRESSION：onDone 內接續 enqueue（open-jump→open-enter）不算空", () => {
      // 這條是本機制的核心陷阱：通知早一步發出去，好讀就會在下一個指令已經上線
      // 的瞬間補送 → 又被閘門吞掉，等於沒修。
      const { q, idle } = makeIdleQueue();
      q.enqueue(
        cmd("12\r", {
          kind: "open-jump",
          onDone: () => q.enqueue(cmd("\r", { kind: "open-enter" })),
        })
      );
      settleWith(q, true);
      expect(q.inFlightKind).toBe("open-enter");
      expect(idle).not.toHaveBeenCalled();

      settleWith(q, true); // open-enter 也完成 → 這時才真的空
      expect(idle).toHaveBeenCalledTimes(1);
    });

    test("pending 還有指令時不通知（序列化中間不算空）", () => {
      const { q, idle } = makeIdleQueue();
      q.enqueue(cmd("A"));
      q.enqueue(cmd("B"));
      settleWith(q, true); // A 完成 → B 上線
      expect(idle).not.toHaveBeenCalled();
      settleWith(q, true); // B 完成
      expect(idle).toHaveBeenCalledTimes(1);
    });

    test("miss / timeout 失敗收場也通知（線路一樣空了）", () => {
      const miss = makeIdleQueue();
      miss.q.enqueue(cmd("A", { timeoutMs: 1000, onFail: () => {} }));
      vi.advanceTimersByTime(1000); // 探針
      settleWith(miss.q, false); // 探針幀仍不符 → miss
      expect(miss.idle).toHaveBeenCalledTimes(1);

      const to = makeIdleQueue();
      to.q.enqueue(cmd("A", { timeoutMs: 1000, onFail: () => {} }));
      vi.advanceTimersByTime(1000 + 2000); // 探針窗也到期 → timeout
      expect(to.idle).toHaveBeenCalledTimes(1);
    });

    test("flush 也通知（切原生／離板把線路清空）", () => {
      const { q, idle } = makeIdleQueue();
      q.enqueue(cmd("A"));
      q.enqueue(cmd("B"));
      q.flush();
      expect(q.idle).toBe(true);
      expect(idle).toHaveBeenCalledTimes(1);
    });

    test("本來就空的 flush 不通知（避免空轉喚醒）", () => {
      const { q, idle } = makeIdleQueue();
      q.flush();
      expect(idle).not.toHaveBeenCalled();
    });

    test("沒給 onIdle 也不能炸", () => {
      const { q } = makeQueue();
      q.enqueue(cmd("A"));
      expect(() => settleWith(q, true)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // isCompleteFrame 守門（2026-08-25）：探針窗從秒級砍到 250ms 之後，「探針送出
  // 後的下一個 settle 就是探針的答案」這個假設不再成立——慢速連線上指令自己的
  // 真回應常常在探針之後才到，而部分幀不是「我在哪」的答案。沒有這道守門，
  // 那種幀會被判定讞 miss → 呼叫端誤降級原生。
  // -------------------------------------------------------------------------
  describe("isCompleteFrame：只有完整幀能把探針後的 settle 判成 miss", () => {
    const gated = () => {
      const sent = [];
      const q = new CommandQueue({
        send: (k) => sent.push(k),
        isCompleteFrame: (facts) => !!facts.__complete,
      });
      return { q, sent };
    };
    const settle = (q, result, complete) =>
      q.onSettle({}, { __result: result, __complete: complete });

    test("探針後的非完整幀不判 miss：指令留在線上等真正的全幅幀", () => {
      const { q } = gated();
      const fail = vi.fn();
      q.enqueue(cmd("A", { timeoutMs: 250, probeTimeoutMs: 600, onFail: fail }));
      vi.advanceTimersByTime(250); // 探針上線

      // 指令自己的真回應賽過探針先到，但只是部分幀 → 不是答案。
      expect(settle(q, false, false)).toBeFalsy();
      expect(fail).not.toHaveBeenCalled();
      expect(q.inFlightKind).toBe("test");
    });

    test("非完整幀之後的完整幀才定讞 miss", () => {
      const { q } = gated();
      const fail = vi.fn();
      q.enqueue(cmd("A", { timeoutMs: 250, probeTimeoutMs: 600, onFail: fail }));
      vi.advanceTimersByTime(250);
      settle(q, false, false); // 部分幀：延長
      expect(settle(q, false, true)).toBe("miss"); // 探針的全幅幀：定讞
      expect(fail).toHaveBeenCalledWith("miss", expect.objectContaining({ __result: false }));
    });

    test("非完整幀之後若 expect 成立，照樣正常收腿（真回應只是慢）", () => {
      const { q } = gated();
      const done = vi.fn();
      const fail = vi.fn();
      q.enqueue(cmd("A", { timeoutMs: 250, probeTimeoutMs: 600, onDone: done, onFail: fail }));
      vi.advanceTimersByTime(250);
      settle(q, false, false);
      expect(settle(q, true, false)).toBe("done");
      expect(done).toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
    });

    test("延長有上限：第二個非完整幀直接定讞（不得被吵雜連線無限延長）", () => {
      const { q } = gated();
      const fail = vi.fn();
      q.enqueue(cmd("A", { timeoutMs: 250, probeTimeoutMs: 600, onFail: fail }));
      vi.advanceTimersByTime(250);
      settle(q, false, false); // 第 1 次：延長
      expect(settle(q, false, false)).toBe("miss"); // 第 2 次：不再等
      expect(fail).toHaveBeenCalledWith("miss", expect.anything());
    });

    test("延長用的是探針窗，不是重新給一整個 soft 窗", () => {
      const { q, sent } = gated();
      const fail = vi.fn();
      q.enqueue(cmd("A", { timeoutMs: 3000, probeTimeoutMs: 600, onFail: fail }));
      vi.advanceTimersByTime(3000); // 探針
      expect(sent).toEqual(["A", "\f"]);
      settle(q, false, false); // 延長
      vi.advanceTimersByTime(599);
      expect(fail).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2); // 探針窗（600）到期，而非 3000
      expect(fail).toHaveBeenCalledWith("timeout");
    });

    test("每個指令各自重算延長次數（前一筆用掉的不算在後一筆頭上）", () => {
      const { q } = gated();
      const fail = vi.fn();
      q.enqueue(cmd("A", { timeoutMs: 250, probeTimeoutMs: 600, onFail: fail }));
      q.enqueue(cmd("B", { timeoutMs: 250, probeTimeoutMs: 600, onFail: fail }));
      vi.advanceTimersByTime(250);
      settle(q, false, false);
      settle(q, false, false); // A 定讞 miss → B 上線
      expect(q.inFlightKind).toBe("test");

      vi.advanceTimersByTime(250); // B 的探針
      expect(settle(q, false, false)).toBeFalsy(); // B 拿得到自己的第一次延長
    });

    test("未注入 isCompleteFrame 時行為與守門前一致（預設全部視為完整）", () => {
      const { q } = makeQueue();
      const fail = vi.fn();
      q.enqueue(cmd("A", { timeoutMs: 250, onFail: fail }));
      vi.advanceTimersByTime(250);
      expect(settleWith(q, false)).toBe("miss");
    });
  });
  // flushKind：兩種列表好讀（ListSession / BoardListSession）共用同一條佇列，而
  // 「我收攤了」以前一律 flush() 整條。兩個 session 都掛在同一個 screenSettled 上，
  // **同一幀**可能一邊收攤、另一邊剛排好 prefetch ⇒ 整條 flush 會把對方的命令
  // 靜默殺掉（症狀：進板之後文章列表永遠只有一頁）。
  describe("flushKind（限縮版 flush，只清自己的命令）", () => {
    test("在飛的是別人的命令 → 一個都不動", () => {
      const { q, sent } = makeQueue();
      q.enqueue(cmd("A", { kind: "prefetch-down" }));
      q.enqueue(cmd("B", { kind: "prefetch-up" }));
      q.flushKind("brd-");
      expect(q.inFlightKind).toBe("prefetch-down");
      settleWith(q, true);
      expect(sent).toEqual(["A", "B"]); // 排隊中的那條照樣送得出去
    });

    test("在飛的是自己的命令 → 收掉並把別人排隊中的命令接上線", () => {
      const { q, sent } = makeQueue();
      q.enqueue(cmd("A", { kind: "brd-fetch-down" }));
      q.enqueue(cmd("B", { kind: "prefetch-up" }));
      q.flushKind("brd-");
      expect(sent).toEqual(["A", "B"]);
      expect(q.inFlightKind).toBe("prefetch-up");
    });

    test("排隊中只清掉前綴相符的，別人的留著", () => {
      const { q, sent } = makeQueue();
      q.enqueue(cmd("A", { kind: "prefetch-down" }));
      q.enqueue(cmd("B", { kind: "brd-fetch-down" }));
      q.enqueue(cmd("C", { kind: "prefetch-up" }));
      q.flushKind("brd-");
      settleWith(q, true); // A 完成
      expect(sent).toEqual(["A", "C"]); // B 被清掉，C 保留
    });

    test("flush 掉在飛的命令時通知 onFlushed（AidNavigation 那類持有輸入鎖的呼叫端）", () => {
      const { q } = makeQueue();
      const onFlushed = vi.fn();
      q.enqueue(cmd("A", { kind: "brd-leave", onFlushed }));
      q.flushKind("brd-");
      expect(onFlushed).toHaveBeenCalled();
    });
  });
});
