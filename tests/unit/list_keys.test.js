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
    flush() {
      this.flushed = (this.flushed || 0) + 1;
    },
    flushPending() {
      this.pendingFlushed = (this.pendingFlushed || 0) + 1;
    },
    flushPendingKind() {},
    enqueue(cmd) {
      enqueued.push(cmd);
    },
    onSettle() {},
  };
  const s = new ListSession(core, view, termBuf, queue);
  return { s, sent, enqueued, queue };
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
    // v 先同步 server 游標（W 分界＝游標文章，protocol §7）再開 prompt
    ["v", "functionMode", "mark-sync-jump"],
    ["/", "functionMode", "search-prompt"],
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

  test.each([["z"], ["i"], ["b"], ["y"], ["X"], ["s"], ["Z"], ["#"]])(
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

  test("T2 `v` 交易：v→prompt 指紋→overlay 收參；u 提交 u\\r、其他鍵取消 \\r（getdata 必收尾）", () => {
    const { s, sent, enqueued } = makeSession();
    const overlays = [];
    s._view.showListOverlay = (m) => overlays.push(m);
    s._view.hideListOverlay = () => {};
    s.state = "active";
    s._renderMode = "buffer";
    s._selectedNum = 42;
    s.onKeyDown(keyEvent("v"));
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("frozen");
    // 第一腿：jump 同步 server 游標到選取（W 分界＝游標文章，protocol §7）
    expect(enqueued[0].kind).toBe("mark-sync-jump");
    expect(enqueued[0].keys).toBe("42\r");
    enqueued[0].onDone();
    expect(enqueued[1].kind).toBe("mark-prompt");
    expect(enqueued[1].keys).toBe("v");
    enqueued.shift(); // 後續斷言以 mark-prompt 為 [0]
    // prompt 指紋（protocol §7）
    const promptFacts = {
      rows: 24,
      rowTexts: Object.assign(new Array(24).fill(""), {
        22: "設定所有文章 (U)未讀 (V)已讀 (W)前已讀後未讀 (Q)取消？[Q]",
      }),
    };
    expect(enqueued[0].expect(null, promptFacts)).toBe(true);
    enqueued[0].onDone();
    expect(overlays.length).toBe(1); // 選單顯示
    // 收參：u → 提交
    s.onKeyDown(keyEvent("u"));
    expect(enqueued[1].kind).toBe("mark-commit");
    expect(enqueued[1].keys).toBe("u\r");
    expect(enqueued[1].expect(null, { kind: "clean-list" })).toBe(true); // FULLUPDATE 收尾
    expect(sent).toEqual([]); // 全程走 queue，不裸送
    // 取消路徑：非 u/v/w 一律送 \r（server getdata 必須收掉）
    const { s: s2, enqueued: q2 } = makeSession();
    s2._view.showListOverlay = () => {};
    s2._view.hideListOverlay = () => {};
    s2.state = "active";
    s2.onKeyDown(keyEvent("v"));
    q2[0].onDone();
    s2.onKeyDown(keyEvent("Escape"));
    expect(q2[1].keys).toBe("\r");
  });

  test("T2 `/` 交易：/→prompt→輸入框收參→kw\\r 提交＋強制 rebuild（序號空間獨立）；取消送 \\r", () => {
    const { s, enqueued } = makeSession();
    let inputCb = null;
    s._view.promptListInput = (label, init, cb) => {
      inputCb = cb;
    };
    s.state = "active";
    s._boardName = "C_Chat";
    s.onKeyDown(keyEvent("/"));
    expect(enqueued[0].kind).toBe("search-prompt");
    expect(enqueued[0].keys).toBe("/");
    expect(
      enqueued[0].expect(null, {
        rows: 24,
        curY: 23,
        rowTexts: Object.assign(new Array(24).fill(""), { 23: "搜尋標題:" }),
      })
    ).toBe(true);
    enqueued[0].onDone();
    expect(typeof inputCb).toBe("function");
    inputCb("Re");
    expect(enqueued[1].kind).toBe("search-commit");
    expect(enqueued[1].keys).toBe("Re\r");
    enqueued[1].onDone();
    expect(s._selectMode).toBe(true);
    expect(s._boardName).toBeNull(); // 完成 settle 的 reducer 將 rebuild
    // 取消：空輸入 → \r 收 getdata
    const { s: s2, enqueued: q2 } = makeSession();
    let cb2 = null;
    s2._view.promptListInput = (l, i, cb) => (cb2 = cb);
    s2.state = "active";
    s2.onKeyDown(keyEvent("/"));
    q2[0].onDone();
    cb2(null);
    expect(q2[1].kind).toBe("search-cancel");
    expect(q2[1].keys).toBe("\r");
  });

  test("select 清單離開（←）：leave onDone 清 _selectMode＋_boardName（回主列表必 rebuild）", () => {
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._selectMode = true;
    s._boardName = "C_Chat";
    s.onKeyDown(keyEvent("ArrowLeft"));
    expect(enqueued[0].kind).toBe("leave-board");
    enqueued[0].onDone();
    expect(s._selectMode).toBe(false);
    expect(s._boardName).toBeNull();
  });

  test("T2 數字跳號：digit→輸入框（預填）→確認＝jump-number 交易→落地 rebuild；取消零 server", () => {
    const { s, enqueued } = makeSession();
    let inputArgs = null;
    let inputCb = null;
    s._view.promptListInput = (label, init, cb) => {
      inputArgs = { label, init };
      inputCb = cb;
    };
    s.state = "active";
    s._renderMode = "buffer";
    s.onKeyDown(keyEvent("5"));
    expect(s.state).toBe("active"); // 收參純本地
    expect(enqueued).toEqual([]);
    expect(inputArgs.init).toBe("5");
    inputCb("523");
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("frozen");
    expect(enqueued[0].kind).toBe("jump-number");
    expect(enqueued[0].keys).toBe("523\r");
    // 落地（park 指紋）→ onDone rebuild 回 active/buffer
    expect(
      enqueued[0].expect(null, {
        rows: 24,
        curY: 5,
        curX: 0,
        cursorRowNum: 523,
        nums: new Array(24).fill(null),
        rowTexts: new Array(24).fill(""),
      })
    ).toBe(true);
    enqueued[0].onDone();
    expect(s.state).toBe("active");
    expect(s._renderMode).toBe("buffer");
    // 取消路徑
    const { s: s2, enqueued: q2 } = makeSession();
    let cb2 = null;
    s2._view.promptListInput = (l, i, cb) => (cb2 = cb);
    s2.state = "active";
    s2.onKeyDown(keyEvent("7"));
    cb2(null);
    expect(q2).toEqual([]);
    expect(s2.state).toBe("active");
  });

  test("交易前導只清 pending、保留 in-flight（[/←/v///Enter 開文——防 ownerless settle 誤配對）", () => {
    // live race：前導 flush() 砍掉 in-flight prefetch anchor → 其在線回應變
    // 無主 settle，提早滿足新交易的 expect（leave-board 吃掉 anchor 落地）。
    // 前導必須 flushPending（序列化修復），全量 flush 只准出現在退回原生鏡像
    // 的路徑（_enterFunctionMode/_handoffArticle/_cleanup——那裡沒有後續 expect）。
    const begins = [
      ["[", (s) => s.onKeyDown(keyEvent("["))],
      ["ArrowLeft", (s) => s.onKeyDown(keyEvent("ArrowLeft"))],
      ["v", (s) => s.onKeyDown(keyEvent("v"))],
      ["/", (s) => s.onKeyDown(keyEvent("/"))],
      ["Enter開文", (s) => s.onKeyDown(keyEvent("Enter"))],
    ];
    for (const [label, fire] of begins) {
      const { s, queue } = makeSession();
      s._view.showListOverlay = () => {};
      s._view.hideListOverlay = () => {};
      s._view.promptListInput = () => {};
      s.state = "active";
      s._renderMode = "buffer";
      s._selectedNum = 42;
      fire(s);
      expect({ label, flushed: queue.flushed || 0 }).toEqual({ label, flushed: 0 });
      expect({ label, pendingFlushed: queue.pendingFlushed || 0 }).toEqual({
        label,
        pendingFlushed: 1,
      });
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

describe("v5/M3：相對命令第二腿 \\f 確定性收尾（RTT 自適應 timeout 退役）", () => {
  // 舊：沒命中＝零回應，只能靠 RTT 自適應 timeout 收尾（不變量 12）。
  // v5：第二腿掛 fullRepaint（keys 尾附 \f）→ 沒命中也必得一幀全幅重繪 →
  // 任一 settle 即回應，timeout 僅剩 queue 探針的觸發器（固定值即可）。
  test("第二腿掛 fullRepaint、timeout 固定（不再 RTT 計算）", () => {
    const { s, enqueued } = makeSession();
    s.state = "active";
    s._selectedNum = 42;
    s.onKeyDown(keyEvent("["));
    enqueued[0].onDone();
    const leg2 = enqueued[1];
    expect(leg2.kind).toBe("relative-command");
    expect(leg2.fullRepaint).toBe(true);
    expect(leg2.timeoutMs).toBe(3000);
    expect(leg2.expect()).toBe(true); // 任一 settle 即完成
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
