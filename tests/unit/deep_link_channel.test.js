// Unit tests for src/js/deep_link_channel.js — 分頁之間的 deep link 交接。
// 用一個假的 BroadcastChannel bus（照規範：訊息不會送回給發送端自己），這樣可以
// 在同一個 test 裡開好幾個「分頁」。

import {
  claimHandoff,
  serveHandoff,
  createChannel
} from "../../src/js/deep_link_channel";

const TARGET = { board: "Gossiping", aid: "1gIeu-3A" };

// 一條 bus = 一個 BroadcastChannel 名稱底下的所有分頁。
function makeBus() {
  const ports = [];
  return {
    open() {
      const listeners = [];
      const port = {
        posted: [],
        addEventListener: (type, fn) => type === "message" && listeners.push(fn),
        removeEventListener: (type, fn) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
        postMessage(data) {
          port.posted.push(data);
          // 規範：BroadcastChannel 不會把訊息 deliver 給發送的那個物件自己。
          ports.forEach(p => {
            if (p !== port) p._deliver(data);
          });
        },
        _deliver(data) {
          listeners.slice().forEach(fn => fn({ data }));
        }
      };
      ports.push(port);
      return port;
    }
  };
}

// 同步版計時器：把 callback 收進 queue，由 test 自己決定何時跑。
function makeClock() {
  const q = [];
  return {
    setTimeout: (fn, ms) => {
      q.push({ fn, ms });
      return q.length - 1;
    },
    clearTimeout: id => {
      if (q[id]) q[id].fn = null;
    },
    // 依照延遲時間先後跑完（模擬真實排程順序）
    runAll() {
      q.slice()
        .sort((a, b) => a.ms - b.ms)
        .forEach(t => t.fn && t.fn());
    }
  };
}

describe("claimHandoff", () => {
  test("有人 ack → 回 true", async () => {
    const bus = makeBus();
    const clock = makeClock();
    const claimer = bus.open();
    const existing = bus.open();
    existing.addEventListener("message", e => {
      if (e.data.t === "claim") existing.postMessage({ t: "ack", id: e.data.id });
    });
    await expect(
      claimHandoff(claimer, TARGET, { setTimeout: clock.setTimeout })
    ).resolves.toBe(true);
  });

  test("沒人回應 → 逾時回 false（新分頁自己開站）", async () => {
    const bus = makeBus();
    const clock = makeClock();
    const p = claimHandoff(bus.open(), TARGET, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout
    });
    clock.runAll();
    await expect(p).resolves.toBe(false);
  });

  test("別人的 claim 的 ack 不算數（id 必須對上）", async () => {
    const bus = makeBus();
    const clock = makeClock();
    const claimer = bus.open();
    const other = bus.open();
    const p = claimHandoff(claimer, TARGET, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      makeId: () => "mine"
    });
    other.postMessage({ t: "ack", id: "someone-else" });
    clock.runAll();
    await expect(p).resolves.toBe(false);
  });

  test("沒有 BroadcastChannel 的環境 → 直接 false，不 throw", async () => {
    await expect(claimHandoff(null, TARGET)).resolves.toBe(false);
    expect(createChannel({})).toBeNull();
  });
});

describe("serveHandoff", () => {
  test("REGRESSION：ack 必須是同步的，一個 timer 都不能用", () => {
    // 使用者從外部點連結時，既有分頁必定是**背景分頁**，而 Chrome 把背景分頁的
    // setTimeout 節流到最少 1 秒。原本的「0..60ms 隨機退讓」在真機上會變成
    // 1000ms+，新分頁早就逾時放棄（實測 2026-08-16：新分頁照樣自己登入）。
    // headless e2e 不節流，所以只有這條測得到。
    const bus = makeBus();
    const existing = bus.open();
    const got = [];
    const neverFires = () => {
      throw new Error("serveHandoff 不得使用 timer：背景分頁會被節流");
    };
    serveHandoff(existing, () => true, t => got.push(t), {
      setTimeout: neverFires
    });
    bus.open().postMessage({ t: "claim", id: "c1", target: TARGET });
    // 完全沒有推進任何時鐘。
    expect(existing.posted).toEqual([{ t: "ack", id: "c1" }]);
    expect(got).toEqual([TARGET]);
  });

  test("沒連線的分頁不接（讓新分頁自己開站）", () => {
    const bus = makeBus();
    const existing = bus.open();
    const got = [];
    serveHandoff(existing, () => false, t => got.push(t));
    bus.open().postMessage({ t: "claim", id: "c1", target: TARGET });
    expect(existing.posted).toEqual([]);
    expect(got).toEqual([]);
  });

  test("同一個 claim 重播不會跳兩次", () => {
    const bus = makeBus();
    const existing = bus.open();
    const got = [];
    serveHandoff(existing, () => true, t => got.push(t));
    const claimer = bus.open();
    claimer.postMessage({ t: "claim", id: "c1", target: TARGET });
    claimer.postMessage({ t: "claim", id: "c1", target: TARGET });
    expect(got).toEqual([TARGET]);
  });

  test("別人先 ack 過的 claim 不再接（多分頁的重播去重）", () => {
    const bus = makeBus();
    const existing = bus.open();
    const other = bus.open();
    const got = [];
    serveHandoff(existing, () => true, t => got.push(t));
    other.postMessage({ t: "ack", id: "c1" });
    bus.open().postMessage({ t: "claim", id: "c1", target: TARGET });
    expect(got).toEqual([]);
    expect(existing.posted).toEqual([]);
  });

  test("解除註冊後不再回應", () => {
    const bus = makeBus();
    const existing = bus.open();
    const got = [];
    const off = serveHandoff(existing, () => true, t => got.push(t));
    off();
    bus.open().postMessage({ t: "claim", id: "c1", target: TARGET });
    expect(got).toEqual([]);
  });

  test("端到端：claimer 拿到 true，既有分頁拿到 target", async () => {
    const bus = makeBus();
    const clock = makeClock();
    const existing = bus.open();
    const got = [];
    serveHandoff(existing, () => true, t => got.push(t));
    const p = claimHandoff(bus.open(), TARGET, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout
    });
    await expect(p).resolves.toBe(true);
    expect(got).toEqual([TARGET]);
  });
});
