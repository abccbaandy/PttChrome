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

  test("pinned 選取（無序號）：[ 走原 passthrough，不佇列", () => {
    const { s, sent, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = null;
    s._selectedPinnedKey = "arrenwu|[公告] 板規";
    const e = keyEvent("]");
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(false);
    expect(enqueued).toEqual([]);
    expect(sent).toEqual([]);
    expect(s.state).toBe("functionMode");
  });

  test("非相對命令的 other 鍵（← 離板 / q）不佇列、照舊 passthrough（live soak 回歸）", () => {
    const { s, sent, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = 42;
    const e = keyEvent("ArrowLeft");
    s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(false);
    expect(enqueued).toEqual([]);
    expect(sent).toEqual([]);
    expect(s.state).toBe("functionMode");
    s.state = "active";
    s.onKeyDown(keyEvent("q"));
    expect(enqueued).toEqual([]);
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
