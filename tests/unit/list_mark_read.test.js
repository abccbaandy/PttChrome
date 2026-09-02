// 列表好讀模式的右鍵選單「前已讀後未讀」（pttbbs b_mark_read_unread）。
//
// 承重點：`v` 沒有成功進入 getdata prompt 時，後面的 `w` 會落回**列表按鍵**
// b_call_in（對該列作者送呼叫器，有副作用）、`\r` 則會開文。所以兩步必須序列化，
// 而且第一步的 expect 要確認 prompt 真的出現才准送第二步 —— 這支測試就是守它。
// 另一顆地雷：prompt 畫在 row 22（b_lines = t_lines-1）而不是最後一列，只看底列
// 的 expect 會永遠判否。
import { ListSession } from "../../src/js/list_session";
import { LIST_HEADER_ROWS } from "../../src/js/list_window";

function rowOf(text) {
  return text.split("").map((c) => ({ ch: c, isLeadByte: false }));
}

function makeSession({ count = 8, pinned = 0 } = {}) {
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
  for (let i = 0; i < pinned; ++i) {
    listLines.push(rowOf(`  ★ + pinner${i}   置底${i}`));
    listLineNums.push(null);
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
  s._edgeDown = true; // 讓置底文進入可選序列（native parity）
  s._selectedNum = 101;
  s._serverNum = 101;
  s._topNum = 101;
  return { s, sent, enqueued, hints };
}

const bodyRow = (idx) => LIST_HEADER_ROWS + idx;

// 24 列畫面。extra = { rowIndex: text }
function facts(extra) {
  const rowTexts = [];
  for (let r = 0; r < 24; ++r) rowTexts.push("");
  rowTexts[0] = "  【板主：nobody】";
  for (let r = 3; r < 23; ++r) rowTexts[r] = `  ${100 + r} + author  標題`;
  Object.keys(extra || {}).forEach((k) => {
    rowTexts[Number(k)] = extra[k];
  });
  return { rowTexts, rows: 24 };
}

// pttbbs mbbsd/bbs.c#b_mark_read_unread 的 getdata prompt，畫在 b_lines-1 = 22。
const PROMPT_ROW = 22;
const PROMPT_TEXT =
  "設定所有文章 (U)未讀 (V)已讀 (W)前已讀後未讀 (Q)取消？[Q] ";
const REJECT_TEXT = "請改用其它文章設定當參考點";

const stepOf = (enqueued, kind) => enqueued.find((c) => c.kind === kind);

describe("markReadTargetAtRow（純查詢，決定選單項出不出現）", () => {
  test("body 第 3 列 → 該列的文章序號", () => {
    const { s } = makeSession();
    expect(s.markReadTargetAtRow(bodyRow(2))).toEqual({ num: 103 });
  });

  test("header 列 → null", () => {
    const { s } = makeSession();
    expect(s.markReadTargetAtRow(0)).toBe(null);
    expect(s.markReadTargetAtRow(LIST_HEADER_ROWS - 1)).toBe(null);
  });

  test("超出序列的空白列／footer → null", () => {
    const { s } = makeSession({ count: 5 });
    expect(s.markReadTargetAtRow(bodyRow(4))).toEqual({ num: 105 });
    expect(s.markReadTargetAtRow(bodyRow(5))).toBe(null);
    expect(s.markReadTargetAtRow(bodyRow(19))).toBe(null);
  });

  test("置底文（無序號）→ null：跳不了號，時間戳當界線語意也不對", () => {
    const { s } = makeSession({ count: 3, pinned: 2 });
    expect(s.markReadTargetAtRow(bodyRow(2))).toEqual({ num: 103 });
    expect(s.markReadTargetAtRow(bodyRow(3))).toBe(null);
    expect(s.markReadTargetAtRow(bodyRow(4))).toBe(null);
  });

  test("非 active／非 buffer（原生鏡像、交易中）→ null", () => {
    const { s } = makeSession();
    s._renderMode = "native";
    expect(s.markReadTargetAtRow(bodyRow(2))).toBe(null);
    s._renderMode = "frozen";
    expect(s.markReadTargetAtRow(bodyRow(2))).toBe(null);
    s._renderMode = "buffer";
    s.state = "opening";
    expect(s.markReadTargetAtRow(bodyRow(2))).toBe(null);
  });
});

describe("markReadUnreadBefore 的序列", () => {
  test("游標落後 → 先送序號跳轉（frozen），還沒有 v", () => {
    const { s, sent, enqueued } = makeSession();
    expect(s.markReadUnreadBefore(105)).toBe(true);
    expect(s._selectedNum).toBe(105);
    expect(s._renderMode).toBe("frozen");
    expect(sent).toEqual([]); // 一律走佇列，絕不直送 byte
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].kind).toBe("native-sync-jump");
    expect(enqueued[0].keys).toBe("105\r");
  });

  test("跳轉落地後才切原生並送 v", () => {
    const { s, enqueued } = makeSession();
    s.markReadUnreadBefore(105);
    enqueued[0].onDone();
    expect(s._renderMode).toBe("native");
    expect(enqueued).toHaveLength(2);
    expect(enqueued[1].kind).toBe("mark-read-prompt");
    expect(enqueued[1].keys).toBe("v");
  });

  test("真游標已在該列 → 省掉跳轉腿，直接送 v", () => {
    const { s, enqueued } = makeSession();
    s._serverNum = 103;
    expect(s.markReadUnreadBefore(103)).toBe(true);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].kind).toBe("mark-read-prompt");
    expect(enqueued[0].keys).toBe("v");
  });

  test("v 的 expect 認 row 22 的 prompt，普通列表畫面判否", () => {
    const { s, enqueued } = makeSession();
    s._serverNum = 103;
    s.markReadUnreadBefore(103);
    const v = stepOf(enqueued, "mark-read-prompt");
    // 回歸守護：prompt 不在最後一列，只看底列的實作會在這裡紅。
    expect(v.expect(null, facts({ [PROMPT_ROW]: PROMPT_TEXT }))).toBe(true);
    expect(v.expect(null, facts({ 23: "  文章選讀  (y)回信" }))).toBe(false);
  });

  test("v 沒進 prompt（onFail）→ 絕不送 w，顯性降級原生", () => {
    const { s, sent, enqueued, hints } = makeSession();
    s._serverNum = 103;
    s.markReadUnreadBefore(103);
    stepOf(enqueued, "mark-read-prompt").onFail("miss", facts());
    expect(stepOf(enqueued, "mark-read-apply")).toBeUndefined();
    expect(sent).toEqual([]);
    expect(s._renderMode).toBe("native");
    expect(hints.join()).toContain("逾時");
  });

  test("v 落地後才送 w + Enter（getdata 是整行輸入）", () => {
    const { s, enqueued } = makeSession();
    s._serverNum = 103;
    s.markReadUnreadBefore(103);
    stepOf(enqueued, "mark-read-prompt").onDone(true);
    const w = stepOf(enqueued, "mark-read-apply");
    expect(w).toBeDefined();
    expect(w.keys).toBe("w\r");
  });

  test("w 落地 → 提示說出做了什麼、以哪一篇為界（D1：沒有確認框，文案是唯一說明）", () => {
    const { s, enqueued, hints } = makeSession();
    s._serverNum = 103;
    s.markReadUnreadBefore(103);
    stepOf(enqueued, "mark-read-prompt").onDone(true);
    const w = stepOf(enqueued, "mark-read-apply");
    expect(w.expect(null, facts())).toBe(true); // 任何 settle 都是回應
    w.onDone(true);
    const last = hints[hints.length - 1];
    expect(last).toContain("103");
    expect(last).toContain("已讀");
    expect(last).toContain("未讀");
  });

  test("PTT 拒絕（時間戳不能當參考點）→ 提示不可謊稱已設定", () => {
    const { s, enqueued, hints } = makeSession();
    s._serverNum = 103;
    s.markReadUnreadBefore(103);
    stepOf(enqueued, "mark-read-prompt").onDone(true);
    const w = stepOf(enqueued, "mark-read-apply");
    w.expect(null, facts({ 23: REJECT_TEXT }));
    w.onDone(true);
    const last = hints[hints.length - 1];
    expect(last).toContain("沒有變動");
    expect(last).not.toContain("已將第");
  });

  test("完成後停在原生（_nativeHold），不自動回好讀", () => {
    const { s, enqueued } = makeSession();
    s._serverNum = 103;
    s.markReadUnreadBefore(103);
    stepOf(enqueued, "mark-read-prompt").onDone(true);
    stepOf(enqueued, "mark-read-apply").onDone(true);
    expect(s._renderMode).toBe("native");
    expect(s._nativeHold).toBe(true);
  });
});

describe("忙碌／不適用時吞掉但不靜默", () => {
  test("原生鏡像 → 回 false，不送任何命令", () => {
    const { s, enqueued } = makeSession();
    s._renderMode = "native";
    expect(s.markReadUnreadBefore(103)).toBe(false);
    expect(enqueued).toEqual([]);
  });

  test("opening：提示、不排新指令", () => {
    const { s, enqueued, hints } = makeSession();
    s.state = "opening";
    expect(s.markReadUnreadBefore(103)).toBe(true);
    expect(enqueued).toEqual([]);
    expect(hints.join()).toContain("開啟文章中");
  });

  test("functionMode + frozen（交易在飛）：提示、不排新指令", () => {
    const { s, enqueued, hints } = makeSession();
    s.state = "functionMode";
    s._renderMode = "frozen";
    expect(s.markReadUnreadBefore(103)).toBe(true);
    expect(enqueued).toEqual([]);
    expect(hints.join()).toContain("指令處理中");
  });

  test("沒有序號（置底文誤傳）→ 回 false，不送任何命令", () => {
    const { s, enqueued } = makeSession();
    expect(s.markReadUnreadBefore(null)).toBe(false);
    expect(enqueued).toEqual([]);
  });
});

describe("passthrough 單步序列的既有行為不受影響", () => {
  test("一般非白名單鍵仍是一道命令、expect 恆真、沒有 onFail", () => {
    const { s, enqueued } = makeSession();
    s._serverNum = 101;
    expect(s.onFunctionKey("d")).toBe(true);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].kind).toBe("native-key");
    expect(enqueued[0].keys).toBe("d");
    expect(enqueued[0].expect(null, facts())).toBe(true);
    expect(enqueued[0].onFail).toBeUndefined();
  });
});
