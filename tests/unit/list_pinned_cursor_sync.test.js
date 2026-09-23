// 置底列被選取時，cursor-relative 鍵要先把 server 真游標走到那一列
// （2026-09-23；合約見 docs/easy-reading-list.md 不變量 12「置底列選取」子項）。
//
// 症狀：好讀列表把選取移到★置底列（無編號 ⇒ `_selectedNum == null`）後，三個入口的
// sync 腿只認編號 ⇒ 整段跳過 ⇒ Ctrl-Q 查到的是真游標那一列（通常是 prefetch 落點）
// 的作者、`t` 標記到別篇、`←` 讓 getkeep 記錯下次進板位置。
//
// 修法：三個入口共用 `_enqueuePinnedCursorSync`（= _beginOpenPinned 的 jump → End →
// 逐格方向鍵，最後一格用內容驗身分），走到了才送鍵；走不到**不送鍵**、降級原生。
import { ListSession } from "../../src/js/list_session";

const rowOf = (text) => text.split("").map((c) => ({ ch: c, isLeadByte: false }));

// 欄位對齊 bbs.c#readdoent（見 list_command_budget.test.js 同名常數的說明）。
const pinnedRow = (author, title) =>
  "  ★".padEnd(16) + author.padEnd(13) + title;
const PINNED_A = pinnedRow("pinner0", "[公告] 板規");
const PINNED_B = pinnedRow("pinner1", "[公告] 置底二");

function makeSession() {
  const enqueued = [];
  const sent = [];
  const lines = [];
  const nums = [];
  for (let i = 0; i < 40; ++i) {
    nums.push(100 + i);
    lines.push(
      rowOf(` ${100 + i} + 2 6/14 someoneA     □ [閒聊] 文章 ${100 + i}`.padEnd(80))
    );
  }
  for (const t of [PINNED_A, PINNED_B]) {
    nums.push(null);
    lines.push(rowOf(t));
  }
  const termBuf = {
    rows: 24,
    cols: 80,
    listLines: lines,
    listLineNums: nums,
    lineChangeds: new Array(24).fill(false),
    changed: false,
    addEventListener() {},
    notify() {},
    getRowText: () => "",
    isUnicolor: () => false,
    settleSnapshot: null,
  };
  const hints = [];
  const view = {
    hideCursor() {},
    showCursor() {},
    resetListAccumulation() {},
    setListLoading() {},
    flashListHint: (m) => hints.push(m),
    blacklist: new Set(),
    titleBlacklist: [],
  };
  const queue = {
    idle: true,
    inFlightKind: null,
    flush() {},
    flushPending() {},
    flushPendingKind() {},
    expedite() {},
    hasKind: () => false,
    enqueue(cmd) {
      enqueued.push(cmd);
    },
    onSettle() {},
  };
  const s = new ListSession({ conn: { send: (b) => sent.push(b) } }, view, termBuf, queue);
  s.state = "active";
  s._renderMode = "buffer";
  s._boardName = "C_Chat";
  s._topNum = 120;
  s._edgeUp = true;
  s._edgeDown = true;
  // 選取在第二個置底列；真游標停在 prefetch 落點（編號 105）。
  s._selectedNum = null;
  s._selectedPinnedKey = s._pinnedKeyAt(41);
  s._serverNum = 105;
  return { s, enqueued, sent, hints };
}

const keyEvent = (key, mods = {}) => ({
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
  preventDefault() {},
});

// End 落地幀：真游標停在 curY=5（某編號列），兩個置底列在第 20、21 列。
const endFacts = () => {
  const rowTexts = new Array(24).fill("");
  rowTexts[20] = PINNED_A;
  rowTexts[21] = PINNED_B;
  return { curY: 5, curX: 0, rows: 24, rowTexts };
};

// 走完 jump → End → 逐格：回傳逐格腿（最後一格尚未 onDone）。
function walkToLastStep(enqueued, start) {
  const jump = enqueued[start];
  expect(jump.keys).toBe("139\r"); // 緩衝最大編號當錨
  expect(jump.fullRepaint).toBe(true);
  jump.onDone({});
  const end = enqueued[start + 1];
  expect(end.keys).toBe("\x1b[4~");
  expect(end.fullRepaint).toBe(true);
  const facts = endFacts();
  expect(end.expect({}, facts)).toBe(true);
  end.onDone({});
  const steps = enqueued.slice(start + 2);
  expect(steps.map((c) => c.keys)).toEqual(new Array(16).fill("\x1b[B")); // 5 → 21
  // 逐格腿一次全排上（中間格沒有 onDone），每格 expect 認的是確切的 curY。
  steps.forEach((c, i) => {
    expect(c.expect({}, { ...facts, curY: 6 + i })).toBe(true);
    expect(c.expect({}, { ...facts, curY: 5 + i })).toBe(false);
  });
  return { steps, facts };
}

describe("置底列選取：cursor-relative 鍵先把真游標走到該置底列", () => {
  test("Ctrl-Q（passthrough）：jump → End → 逐格 → 才送 \\x11", () => {
    const { s, enqueued } = makeSession();
    s.onKeyDown(keyEvent("q", { ctrlKey: true }));
    expect(enqueued[0].kind).toBe("native-pinned-jump"); // 修前：直接 native-key
    const { steps, facts } = walkToLastStep(enqueued, 0);
    const last = steps[steps.length - 1];
    expect(last.kind).toBe("native-pinned-step");
    // 最後一格用內容驗身分：落在 PINNED_B 才算到位。
    expect(last.expect({}, { ...facts, curY: 21 })).toBe(true);
    const n = enqueued.length;
    last.onDone({});
    expect(enqueued.length).toBe(n + 1);
    expect(enqueued[n].kind).toBe("native-key");
    expect(enqueued[n].keys).toBe("\x11");
    expect(s._serverNum).toBe(null); // 停在置底列＝無編號，不可留舊值謊報
  });

  test("最後一格不是目標置底列 ⇒ expect 不過；逾時則不送鍵、降級原生", () => {
    const { s, enqueued, hints } = makeSession();
    s.onKeyDown(keyEvent("q", { ctrlKey: true }));
    const { steps, facts } = walkToLastStep(enqueued, 0);
    const last = steps[steps.length - 1];
    const wrong = { ...facts, curY: 21, rowTexts: facts.rowTexts.slice() };
    wrong.rowTexts[21] = PINNED_A; // 置底列順序變了：21 列是別篇
    expect(last.expect({}, wrong)).toBe(false);
    const n = enqueued.length;
    last.onFail("timeout");
    expect(enqueued.length).toBe(n); // 破壞性鍵（Ctrl-D…）絕不落在錯列
    expect(s.state).toBe("functionMode");
    expect(s._renderMode).toBe("native");
    expect(hints.some((h) => /置底/.test(h))).toBe(true);
  });

  test("t（inplace）：同一串序列後才送 t", () => {
    const { enqueued, s } = makeSession();
    s.onKeyDown(keyEvent("t"));
    expect(enqueued[0].kind).toBe("inplace-pinned-jump");
    const { steps } = walkToLastStep(enqueued, 0);
    const n = enqueued.length;
    steps[steps.length - 1].onDone({});
    expect(enqueued[n].kind).toBe("native-inplace");
    expect(enqueued[n].keys).toBe("t");
  });

  test("t 落地在置底列：選取留在該置底列、錨不動（不變量 N6，不重建緩衝）", () => {
    const { enqueued, s } = makeSession();
    s.onKeyDown(keyEvent("t"));
    const { steps, facts } = walkToLastStep(enqueued, 0);
    steps[steps.length - 1].onDone({});
    const inplace = enqueued[enqueued.length - 1];
    const landed = {
      ...facts,
      kind: "clean-list",
      curY: 21,
      cursorRowNum: null,
      nums: new Array(24).fill(null),
    };
    const before = s._termBuf.listLines.length;
    expect(inplace.expect({}, landed)).toBe(true);
    inplace.onDone({});
    expect(s.state).toBe("active");
    expect(s._selectedNum).toBe(null);
    expect(s._selectedPinnedKey).toBe(s._pinnedKeyAt(41));
    expect(s._topNum).toBe(120);
    expect(s._termBuf.listLines.length).toBe(before); // 沒被 _rebuild 清掉
  });

  test("←（leave）：先走到置底列再離開（getkeep 記的才是使用者看到的那列）", () => {
    const { enqueued, s } = makeSession();
    s.onKeyDown(keyEvent("ArrowLeft"));
    expect(enqueued[0].kind).toBe("leave-pinned-jump");
    const { steps } = walkToLastStep(enqueued, 0);
    const n = enqueued.length;
    steps[steps.length - 1].onDone({});
    expect(enqueued[n].kind).toBe("leave-board");
  });

  test("End 落點剛好就是目標置底列 ⇒ 不走方向鍵，直接送鍵", () => {
    const { enqueued, s } = makeSession();
    s.onKeyDown(keyEvent("q", { ctrlKey: true }));
    enqueued[0].onDone({});
    const end = enqueued[1];
    expect(end.expect({}, { ...endFacts(), curY: 21 })).toBe(true);
    end.onDone({});
    expect(enqueued.length).toBe(3);
    expect(enqueued[2].kind).toBe("native-key");
  });

  test("編號選取不受影響：仍走原本的 native-sync-jump", () => {
    const { enqueued, s } = makeSession();
    s._selectedPinnedKey = null;
    s._selectedNum = 120;
    s.onKeyDown(keyEvent("q", { ctrlKey: true }));
    expect(enqueued[0].kind).toBe("native-sync-jump");
    expect(enqueued[0].keys).toBe("120\r");
  });
});
