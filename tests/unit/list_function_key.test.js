// 列表好讀模式下，滑鼠點畫面上的功能鍵按鈕（`[←]回上層` / `[→]閱讀` / `[c]新文章`）。
//
// 合約（v5 封閉互動，docs/easy-reading-list.md §操作分類）：白名單以外的鍵＝一鍵切
// 原生，**永不靜默**。滑鼠點功能鍵語意上完全等同按下那個鍵，所以必須走同一條路 ——
// 直送 byte 會讓它落在使用者看不見的畫面上，而且繞過 CommandQueue。
import { ListSession } from "../../src/js/list_session";
import { LEFT_ARROW } from "../../src/js/function_key_plan";

function rowOf(text) {
  return text.split("").map((c) => ({ ch: c, isLeadByte: false }));
}

function makeSession({ count = 8 } = {}) {
  const sent = [];
  const enqueued = [];
  const hints = [];
  const core = { conn: { isConnected: true, send: (d) => sent.push(d) } };
  const view = {
    hideCursor() {},
    showCursor() {},
    resetListAccumulation() {},
    flashListHint: (m) => hints.push(m),
    setListLoading() {},
    blacklist: new Set(),
    titleBlacklist: [],
    mouseMisclickGuard: true,
  };
  const listLines = [];
  const listLineNums = [];
  for (let i = 0; i < count; ++i) {
    listLines.push(rowOf(`${101 + i} + author${i}   標題${i}`));
    listLineNums.push(101 + i);
  }
  const termBuf = {
    rows: 24,
    cols: 80,
    useMouseBrowsing: true,
    listLines,
    listLineNums,
    lineChangeds: new Array(24).fill(false),
    changed: false,
    addEventListener() {},
    notify() {},
  };
  const queue = {
    idle: true,
    inFlightKind: null,
    flush() {},
    flushPending() {},
    flushPendingKind() {},
    enqueue(cmd) {
      enqueued.push(cmd);
    },
    onSettle() {},
  };
  const s = new ListSession(core, view, termBuf, queue);
  s.state = "active";
  s._renderMode = "buffer";
  s._edgeUp = true;
  s._edgeDown = true;
  s._selectedNum = 103;
  s._serverNum = 103;
  s._topNum = 101;
  return { s, sent, enqueued, hints };
}

describe("接手與否", () => {
  test("原生鏡像（_renderMode native）→ 回 false，交給一般路徑", () => {
    const { s, enqueued } = makeSession();
    s._renderMode = "native";
    expect(s.onFunctionKey("d")).toBe(false);
    expect(enqueued).toEqual([]);
  });

  test("buffer 模式一律接手", () => {
    const { s } = makeSession();
    expect(s.onFunctionKey("d")).toBe(true);
  });
});

describe("忙碌時吞掉但**不靜默**", () => {
  test("opening：給提示、不排新指令", () => {
    const { s, enqueued, hints } = makeSession();
    s.state = "opening";
    expect(s.onFunctionKey("d")).toBe(true);
    expect(enqueued).toEqual([]);
    expect(hints.join()).toContain("開啟文章中");
  });

  test("functionMode + frozen（交易在飛）：給提示、不排新指令", () => {
    const { s, enqueued, hints } = makeSession();
    s.state = "functionMode";
    s._renderMode = "frozen";
    expect(s.onFunctionKey("d")).toBe(true);
    expect(enqueued).toEqual([]);
    expect(hints.join()).toContain("指令處理中");
  });
});

describe("白名單鍵走 reducer 的既有交易", () => {
  test("← ＝ leave：走 _beginLeave（frozen ＋ 排隊），絕不直送 byte", () => {
    const { s, sent, enqueued } = makeSession();
    expect(s.onFunctionKey(LEFT_ARROW)).toBe(true);
    expect(sent).toEqual([]);
    expect(enqueued.length).toBeGreaterThan(0);
    expect(s._renderMode).toBe("frozen");
  });

  test("↑ / ↓ ＝ nav：只動本地選取，一個 byte 都不送", () => {
    const { s, sent, enqueued } = makeSession();
    expect(s.onFunctionKey("\x1b[B")).toBe(true);
    expect(s._selectedNum).toBe(104);
    s.onFunctionKey("\x1b[A");
    expect(s._selectedNum).toBe(103);
    expect(sent).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  test("→ ＝ open：走序號跳轉交易", () => {
    const { s, sent, enqueued } = makeSession();
    expect(s.onFunctionKey("\x1b[C")).toBe(true);
    expect(s.state).toBe("opening");
    expect(sent).toEqual([]);
    expect(enqueued[0].keys).toBe("103\r");
  });
});

describe("白名單以外 → passthrough（切原生 ＋ 送出，絕不靜默）", () => {
  test("[c]新文章：進 functionMode 並把鍵排進 CommandQueue", () => {
    const { s, sent, enqueued, hints } = makeSession();
    expect(s.onFunctionKey("c")).toBe(true);
    expect(sent).toEqual([]);
    const nativeKey = enqueued.find((c) => c.kind === "native-key");
    expect(nativeKey).toBeTruthy();
    expect(nativeKey.keys).toBe("c");
    expect(hints.join()).toContain("已切至原生操作");
  });

  test("真游標落後選取時先補一段同步跳轉，再送鍵", () => {
    const { s, enqueued } = makeSession();
    s._serverNum = 101; // 真游標還停在第一篇
    s.onFunctionKey("c");
    expect(enqueued[0].kind).toBe("native-sync-jump");
    expect(s._renderMode).toBe("frozen");
  });

  test("Ctrl-P（\\x10）也走 passthrough，不會被當成導覽鍵", () => {
    const { s, enqueued } = makeSession();
    s.onFunctionKey("\x10");
    const nativeKey = enqueued.find((c) => c.kind === "native-key");
    expect(nativeKey.keys).toBe("\x10");
  });
});

describe("_classifyBytes 刻意獨立於 _classifyKey", () => {
  // _classifyKey 認 q/e/j/k/n/p 這些**字元**為導覽鍵（那是使用者按下的按鍵）；
  // byte 層看到的 'q' 就只是 'q'。合併兩者會把「按鍵」與「送位元組」攪在一起。
  test("字面 'q' / 'j' / 'k' 在 byte 層是 passthrough，不是 leave/nav", () => {
    ["q", "e", "j", "k", "n", "p", " "].forEach((b) => {
      const { s, enqueued } = makeSession();
      s.onFunctionKey(b);
      const nativeKey = enqueued.find((c) => c.kind === "native-key");
      expect(nativeKey, `byte ${JSON.stringify(b)} 應走 passthrough`).toBeTruthy();
      expect(nativeKey.keys).toBe(b);
    });
  });
});

describe("onMouseExitClick（左側退出帶）", () => {
  test("與點 [←] 完全同一條路：_beginLeave，不出現裸 conn.send", () => {
    const { s, sent, enqueued } = makeSession();
    expect(s.onMouseExitClick()).toBe(true);
    expect(sent).toEqual([]);
    expect(enqueued.length).toBeGreaterThan(0);
    expect(s._renderMode).toBe("frozen");
  });

  test("原生鏡像下回 false（交給一般路徑）", () => {
    const { s } = makeSession();
    s._renderMode = "native";
    expect(s.onMouseExitClick()).toBe(false);
  });

  test("opening 時吞掉並給提示", () => {
    const { s, enqueued, hints } = makeSession();
    s.state = "opening";
    expect(s.onMouseExitClick()).toBe(true);
    expect(enqueued).toEqual([]);
    expect(hints.join()).toContain("請稍候");
  });
});
