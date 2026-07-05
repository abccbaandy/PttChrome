// 「[ ] 同標題跳文偶爾失效/亂跳/卡住」回歸：buffer 模式本地導航是零網路，server
// 端真游標停在舊位置；[ ] = 等相對命令需要先跳回選取列。且 jump＋key 不能同 tick
// 直送 —— pttbbs typeahead 會跳過重繪（協定 §2），畫面卡死但 server 已跳。
// 修法：preventDefault 後走 CommandQueue 序列化（relative-sync-jump → 完成才送
// relative-command），functionMode 鏡像期間 clean-list settle 被 in-flight 吸收，
// 配對完成的 settle 才 resume（採用落點游標）。
import { ListSession, transitionListSession } from "../../src/js/list_session";

function makeSession() {
  const sent = [];
  const enqueued = [];
  const core = { conn: { isConnected: true, send: (d) => sent.push(d) } };
  const view = {
    hideCursor() {},
    showCursor() {},
    resetListAccumulation() {},
    blacklist: new Set(),
    titleBlacklist: [],
  };
  const termBuf = {
    rows: 24,
    cols: 80,
    listLines: [],
    listLineNums: [],
    lineChangeds: new Array(24).fill(false),
    changed: false,
    addEventListener() {},
    notify() {},
  };
  const queue = {
    idle: true,
    inFlightKind: null,
    flush() {},
    enqueue(cmd) {
      enqueued.push(cmd);
    },
    onSettle() {},
  };
  const s = new ListSession(core, view, termBuf, queue);
  return { s, sent, enqueued };
}

function keyEvent(key) {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

describe("ListSession 相對命令序列化（[ ] 卡住/亂跳回歸）", () => {
  test("active＋數字選取：按 [ → preventDefault、佇列先跳選取序號、完成才送 [", () => {
    const { s, sent, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = 42;
    const e = keyEvent("[");
    s.onKeyDown(e);
    // 鍵本身不得 passthrough（同 tick 直送會觸發 typeahead 卡畫面）
    expect(e.defaultPrevented).toBe(true);
    expect(sent).toEqual([]); // 不走裸 conn.send
    expect(s.state).toBe("functionMode");
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].keys).toBe("42\r");
    expect(enqueued[0].kind).toBe("relative-sync-jump");
    // jump 完成 → 才鏈出 key 命令
    enqueued[0].onDone();
    expect(enqueued.length).toBe(2);
    expect(enqueued[1].keys).toBe("[");
    expect(enqueued[1].kind).toBe("relative-command");
    // key 命令：任一 settle 即完成（回應可能是 clean-list 或訊息列）
    expect(enqueued[1].expect()).toBe(true);
  });

  test("= 同標題首篇同路徑", () => {
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = 7;
    s.onKeyDown(keyEvent("="));
    expect(enqueued[0].keys).toBe("7\r");
    enqueued[0].onDone();
    expect(enqueued[1].keys).toBe("=");
  });

  test("pinned 選取（無序號）：[ 無跳號可用 → v5 noop（吞鍵＋不佇列，不再 passthrough）", () => {
    const { s, sent, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = null;
    s._selectedPinnedKey = "arrenwu|[公告] 板規";
    const e = keyEvent("]");
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(enqueued).toEqual([]);
    expect(sent).toEqual([]);
    expect(s.state).toBe("active"); // 封閉互動：不墜落
  });

  test("←/q/e 離板 → v5 交易化：frozen＋佇列 leave-board（不再 passthrough 閃原生）", () => {
    const { s, sent, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = 42;
    const e = keyEvent("ArrowLeft");
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(sent).toEqual([]); // 不裸送——經 CommandQueue
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("frozen");
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].kind).toBe("leave-board");
    expect(enqueued[0].keys).toBe("\x1b[D");
    // expect：menu（離板）或 clean-list（MODE_SELECT 退出/回列表）都算完成
    expect(enqueued[0].expect(null, { kind: "menu" })).toBe(true);
    expect(enqueued[0].expect(null, { kind: "clean-list" })).toBe(true);
    expect(enqueued[0].expect(null, { kind: "transient" })).toBe(false);
    // q 同路徑
    const { s: s2, enqueued: q2 } = makeSession();
    s2.state = "active";
    s2.onKeyDown(keyEvent("q"));
    expect(q2.length).toBe(1);
    expect(q2[0].kind).toBe("leave-board");
  });

  test("nav 鍵不佇列不送（本地導航維持零網路）", () => {
    const { s, sent, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = 42;
    const e = keyEvent("ArrowDown");
    s.onKeyDown(e);
    expect(sent).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(e.defaultPrevented).toBe(true);
    expect(s.state).toBe("active");
  });
});

describe("相對命令配對期間 frozen（不得閃現原生畫面）", () => {
  test("按 [ 後 render mode 應為 frozen（非 native）、游標保持隱藏", () => {
    const { s } = makeSession();
    const calls = { hide: 0, show: 0 };
    s._view.hideCursor = () => calls.hide++;
    s._view.showCursor = () => calls.show++;
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    s.onKeyDown(keyEvent("["));
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("frozen"); // 舊行為 native = 閃現一幀原生
    expect(calls.show).toBe(0); // showCursor = 原生游標露出
  });

  test("frozen 配對期間按任意鍵 → 吞掉（preventDefault、不佇列不送）", () => {
    const { s, sent, enqueued } = makeSession();
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    s.onKeyDown(keyEvent("["));
    const n = enqueued.length;
    const e = keyEvent("x");
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(enqueued.length).toBe(n);
    expect(sent).toEqual([]);
  });

  test("← 離板同樣 frozen（v5 交易化：離板回應在途也不得閃現原生）", () => {
    const { s } = makeSession();
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    s.onKeyDown(keyEvent("ArrowLeft"));
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("frozen");
  });
});

describe("v5 互動封閉：keyClass 白名單枚舉＋未列鍵 no-op＋T3 氣閘", () => {
  // 枚舉即合約（docs/easy-reading-list.md §操作分類）：白名單外一律 no-op。
  const WHITELIST_BEHAVIOR = [
    // [key, 預期 state, 預期佇列 kind（null=不佇列）]
    ["ArrowUp", "active", null],
    ["ArrowDown", "active", null],
    ["k", "active", null],
    ["j", "active", null],
    ["PageUp", "active", null],
    ["PageDown", "active", null],
    ["ArrowLeft", "functionMode", "leave-board"],
    ["q", "functionMode", "leave-board"],
    ["e", "functionMode", "leave-board"],
    ["[", "functionMode", "relative-sync-jump"],
    ["]", "functionMode", "relative-sync-jump"],
    ["=", "functionMode", "relative-sync-jump"],
  ];
  test.each(WHITELIST_BEHAVIOR)("白名單 %s → state=%s", (key, state, kind) => {
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = 42;
    const e = keyEvent(key);
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(s.state).toBe(state);
    if (kind) expect(enqueued[0].kind).toBe(kind);
    else expect(enqueued).toEqual([]); // 空 buffer：nav 本地 no-op、零佇列
  });

  test.each([["z"], ["i"], ["b"], ["y"], ["X"], ["/"], ["v"], ["1"], ["s"]])(
    "未列鍵 %s → no-op（吞鍵、不佇列、不轉態、提示）",
    (key) => {
      const { s, sent, enqueued } = makeSession();
      const hints = [];
      s._view.flashListHint = (m) => hints.push(m);
      s.state = "active";
      s._renderMode = "buffer";
      s._selectedNum = 42;
      const e = keyEvent(key);
      s.onKeyDown(e);
      expect(e.defaultPrevented).toBe(true);
      expect(enqueued).toEqual([]);
      expect(sent).toEqual([]);
      expect(s.state).toBe("active");
      expect(s._renderMode).not.toBe("native"); // 不裸露
      expect(hints.length).toBe(1);
    }
  );

  test("T3 氣閘：同鍵二連擊 → 顯式切原生（第二擊 passthrough、enter-function-mode）", () => {
    const { s, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    const e1 = keyEvent("z");
    s.onKeyDown(e1);
    expect(e1.defaultPrevented).toBe(true);
    expect(s.state).toBe("active");
    const e2 = keyEvent("z");
    s.onKeyDown(e2);
    expect(e2.defaultPrevented).toBe(false); // 第二擊放行 → 原生送出
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("native");
    expect(enqueued).toEqual([]);
  });

  test("氣閘不跨鍵：z 後按 i → 仍是第一擊提示（不誤觸切換）", () => {
    const { s } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._selectedNum = 42;
    s.onKeyDown(keyEvent("z"));
    const e = keyEvent("i");
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(s.state).toBe("active");
  });

  test("Ctrl-P（發文）→ noop 氣閘，不再漏送 server（v4 key-leak 回歸）", () => {
    const { s, sent, enqueued } = makeSession();
    s._view.flashListHint = () => {};
    s.state = "active";
    s._selectedNum = 42;
    const e = keyEvent("p");
    e.ctrlKey = true;
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(enqueued).toEqual([]);
    expect(sent).toEqual([]);
    expect(s.state).toBe("active");
  });

  test("剪貼簿組合鍵（Ctrl-C/A/V/X）放行給 app 層（不吞、不轉態）", () => {
    const { s } = makeSession();
    s.state = "active";
    for (const k of ["c", "a", "v", "x"]) {
      const e = keyEvent(k);
      e.ctrlKey = true;
      s.onKeyDown(e);
      expect(e.defaultPrevented).toBe(false);
      expect(s.state).toBe("active");
    }
  });

  test("點擊選取（T1 解禁）：點 body 列 → 本地選取移動、零佇列", () => {
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._renderMode = "buffer";
    const mkRow = (num) =>
      Array.from(String(num).padStart(7) + "  + 7/05 someone      □ title").map(
        (ch) => ({ ch, isLeadByte: false })
      );
    const nums = [];
    const lines = [];
    for (let i = 0; i < 30; i++) {
      nums.push(100 + i);
      lines.push(mkRow(100 + i));
    }
    s._termBuf.listLineNums = nums;
    s._termBuf.listLines = lines;
    s._selectedNum = 129;
    s._topNum = 110;
    // row 5 = body slot 2 → seq top+2
    expect(s.onClick(5)).toBe(true);
    expect(s._selectedNum).toBe(112);
    expect(enqueued).toEqual([]);
    // header/footer 列不吃
    expect(s.onClick(2)).toBe(false);
    expect(s.onClick(23)).toBe(false);
  });
});

describe("相對命令沒命中後自動回 buffer（黑名單/刪除文不得裸露到下次轉移）", () => {
  function begin(s, enqueued) {
    s.state = "active";
    s._selectedNum = 42;
    s.onKeyDown(keyEvent("["));
    expect(s.state).toBe("functionMode");
    return enqueued;
  }

  test("key 命令 timeout（零回應）→ 立即 resume 回 buffer", () => {
    const { s, enqueued } = makeSession();
    begin(s, enqueued);
    enqueued[0].onDone(); // jump 完成 → key 命令入列
    enqueued[1].onFail("timeout");
    expect(s.state).toBe("active");
    expect(s._renderMode).toBe("buffer");
  });

  test("key 命令完成但 reducer 停在 functionMode（訊息列回應）→ 下一 tick resume", () => {
    jest.useFakeTimers();
    try {
      const { s, enqueued } = makeSession();
      begin(s, enqueued);
      enqueued[0].onDone();
      enqueued[1].onDone(true); // settle=訊息列，reducer 未 resume
      expect(s.state).toBe("functionMode"); // 先讓 reducer（同 settle）有機會跑
      jest.runAllTimers();
      expect(s.state).toBe("active");
      expect(s._renderMode).toBe("buffer");
    } finally {
      jest.useRealTimers();
    }
  });

  test("reducer 已 resume（clean-list 命中）→ 延遲檢查不重複動作", () => {
    jest.useFakeTimers();
    try {
      const { s, enqueued } = makeSession();
      begin(s, enqueued);
      enqueued[0].onDone();
      enqueued[1].onDone(true);
      s.state = "active"; // 模擬同 settle 的 reducer resume
      s._renderMode = "buffer";
      jest.runAllTimers();
      expect(s.state).toBe("active");
    } finally {
      jest.useRealTimers();
    }
  });

  test("jump 段失敗（目標被刪/怪畫面）→ 不送 key、resume 回 buffer", () => {
    const { s, enqueued } = makeSession();
    begin(s, enqueued);
    enqueued[0].onFail("timeout");
    expect(enqueued.length).toBe(1); // key 未入列
    expect(s.state).toBe("active");
    expect(s._renderMode).toBe("buffer");
  });
});

describe("相對命令第二腿 timeout RTT 自適應（沒命中不再固定等 3 秒）", () => {
  // 沒命中且 server 零回應時只能靠 soft timeout 收尾；固定 3000ms 對快速鏈路
  // 體感就是「按 [ 沒反應要等三秒」。jump 腿剛完成一個 round-trip，拿它的
  // 耗時當 RTT 估計：timeoutMs = clamp(4×rtt, 800, 3000)。
  function beginWithRtt(rttMs) {
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = 42;
    s.onKeyDown(keyEvent("["));
    jest.advanceTimersByTime(rttMs); // jump 腿的 round-trip 耗時
    enqueued[0].onDone();
    return enqueued[1];
  }
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("快鏈路（rtt 150ms）→ 第二腿 timeout 取下限 800ms（現行固定 3000 → 紅）", () => {
    expect(beginWithRtt(150).timeoutMs).toBe(800);
  });
  test("中速（rtt 400ms）→ 4×rtt = 1600ms", () => {
    expect(beginWithRtt(400).timeoutMs).toBe(1600);
  });
  test("慢鏈路（rtt 2000ms）→ 上限 3000ms 不放大", () => {
    expect(beginWithRtt(2000).timeoutMs).toBe(3000);
  });
});

describe("functionMode clean-list settle 的 in-flight 吸收（相對命令配對期間不彈回）", () => {
  const settle = (kind, extra = {}) => ({
    type: "settle",
    kind,
    boardNameMatch: true,
    inFlightKind: null,
    landedNumInBuffer: true,
    engageEligible: false,
    ...extra,
  });
  test("in-flight（relative-sync-jump/relative-command）→ stay 鏡像", () => {
    expect(
      transitionListSession(
        "functionMode",
        settle("clean-list", { inFlightKind: "relative-sync-jump" })
      )
    ).toEqual({ next: "functionMode", actions: [] });
    expect(
      transitionListSession(
        "functionMode",
        settle("clean-list", { inFlightKind: "relative-command" })
      )
    ).toEqual({ next: "functionMode", actions: [] });
  });
  test("配對完成（無 in-flight）→ resume 採用落點游標", () => {
    expect(transitionListSession("functionMode", settle("clean-list"))).toEqual({
      next: "active",
      actions: ["resume-buffer"],
    });
  });
});
