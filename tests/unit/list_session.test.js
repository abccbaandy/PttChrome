// List easy reading v4 pure-layer guards: screen classification (fingerprint
// predicates over a REAL captured C_Chat board page + synthetic variants),
// burst classification, the full state-machine transition table (every row of
// the docs table gets at least one case), and the accumulation/selection
// primitives ported from the v3 wip branch.
import fs from "fs";
import path from "path";
import {
  ListSession,
  bufferEdgeNum,
  evictListBuffer,
  parseBoardName,
  classifyListScreen,
  classifyListBurst,
  transitionListSession,
  mergeListPage,
  flattenListBuffer,
  shouldStopListPrefetch,
  moveListSelection,
  visibleListIndices,
} from "../../src/js/list_session";

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "replay", "cchat-list.page.json"),
    "utf8"
  )
);
const listRows = fixture.pageScreens[0]; // 24 decoded rows of a real C_Chat page

const STATUS_ROW = "  瀏覽 第 1/8 頁 ( 12%)  目前顯示: 第 01~23 行 (←)離開 ";
const BOARD_MENU_FOOTER =
  "[6/14 星期六 12:34] 動態看板 線上1234人, 我是guest [呼叫器]打開 ";

// Facts builder around the captured page. Color reversal booleans default to
// true (the capture is a clean board page); curY=3/curX=1 is the protocol §5
// park position (cursor row head, one col in).
function facts(overrides = {}) {
  return {
    rowTexts: listRows.slice(),
    curX: 1,
    curY: 3,
    rows: listRows.length,
    row0Reversed: true,
    row2Reversed: true,
    ...overrides,
  };
}

describe("parseBoardName", () => {
  test("extracts the 《board》 from the reversed title row", () => {
    expect(parseBoardName(listRows[0])).toBe("C_Chat");
    expect(parseBoardName("【板主:abc】[哈拉] 標語  看板《Gossiping》")).toBe(
      "Gossiping"
    );
  });
  test("null when absent", () => {
    expect(parseBoardName("【主功能表】")).toBeNull();
    expect(parseBoardName("")).toBeNull();
    expect(parseBoardName(null)).toBeNull();
  });
});

describe("classifyListScreen", () => {
  test("real captured C_Chat page → clean-list with the board name", () => {
    expect(classifyListScreen(facts())).toEqual({
      kind: "clean-list",
      boardName: "C_Chat",
    });
  });

  test("cursor parked on the bottom row → prompt (never clean-list)", () => {
    // A '/' search or jump prompt parks the cursor on the input row (§5) even
    // though every list row still reads as a list — the park position is the
    // cheap discriminator (v3 trap: prompt misread as list steals Enter).
    const f = facts({ curY: listRows.length - 1, curX: 10 });
    expect(classifyListScreen(f).kind).toBe("prompt");
  });

  test("cursor parked mid-entry but col too far right → transient", () => {
    expect(classifyListScreen(facts({ curX: 12 })).kind).toBe("transient");
  });

  test("article status row → article", () => {
    const rows = listRows.slice();
    rows[rows.length - 1] = STATUS_ROW;
    expect(
      classifyListScreen(facts({ rowTexts: rows, curY: rows.length - 1 })).kind
    ).toBe("article");
  });

  test("board MENU footer (parseListRow) → menu, NOT clean-list (v3 trap #3)", () => {
    const rows = listRows.slice();
    rows[rows.length - 1] = BOARD_MENU_FOOTER;
    expect(
      classifyListScreen(facts({ rowTexts: rows, curY: 5 })).kind
    ).toBe("menu");
  });

  test("top-level menus by title marker → menu", () => {
    for (const title of ["【主功能表】", "【分類看板】", "【精華文章】"]) {
      const rows = listRows.slice();
      rows[0] = title + " 批踢踢實業坊";
      rows[rows.length - 1] = "  選擇看板";
      expect(
        classifyListScreen(facts({ rowTexts: rows, curY: 5 })).kind
      ).toBe("menu");
    }
  });

  test("mail list (郵件選讀 feeter) never engages as clean-list", () => {
    const rows = listRows.slice();
    rows[0] = "【 郵件選單 】"; // no 《board》
    rows[rows.length - 1] =
      " 郵件選讀  (y)回信(X)站內尋人(^X)站長信箱 (b)進板畫面";
    const r = classifyListScreen(facts({ rowTexts: rows }));
    expect(r.kind).not.toBe("clean-list");
  });

  test("feeter present but fewer than 3 parsable numbers → not clean-list", () => {
    const rows = listRows.slice();
    for (let i = 3; i <= rows.length - 2; ++i) rows[i] = "";
    rows[4] = " 350025 + 3 6/14 conquer1988  □ [閒聊] x";
    expect(classifyListScreen(facts({ rowTexts: rows })).kind).toBe(
      "transient"
    );
  });

  test("half-painted frame (blank bottom row, cursor mid-screen) → transient", () => {
    const rows = listRows.slice();
    rows[rows.length - 1] = "";
    expect(classifyListScreen(facts({ rowTexts: rows, curY: 10, curX: 5 })).kind).toBe(
      "transient"
    );
  });
});

describe("classifyListBurst", () => {
  const rows = 24;
  test("exactly the old+new cursor rows inside the entry area → cursor-move", () => {
    expect(
      classifyListBurst({ changedRows: new Set([5, 8]), curY: 8, rows })
    ).toBe("cursor-move");
    expect(
      classifyListBurst({ changedRows: new Set([5]), curY: 5, rows })
    ).toBe("cursor-move");
  });
  test("rows 3..23 all dirty, header untouched → page-turn", () => {
    const s = new Set();
    for (let r = 3; r < rows; ++r) s.add(r);
    expect(classifyListBurst({ changedRows: s, curY: 3, rows })).toBe(
      "page-turn"
    );
  });
  test("whole screen dirty (clear) → full-repaint", () => {
    const s = new Set();
    for (let r = 0; r < rows; ++r) s.add(r);
    expect(classifyListBurst({ changedRows: s, curY: 3, rows })).toBe(
      "full-repaint"
    );
  });
  test("anything else → other", () => {
    expect(
      classifyListBurst({ changedRows: new Set([0]), curY: 0, rows })
    ).toBe("other");
    expect(
      classifyListBurst({ changedRows: new Set([5, 23]), curY: 5, rows })
    ).toBe("other"); // touches the feeter row → not a pure cursor move
    expect(classifyListBurst({ changedRows: new Set(), curY: 3, rows })).toBe(
      "other"
    );
  });
});

describe("transitionListSession (full table)", () => {
  const settle = (kind, extra = {}) => ({
    type: "settle",
    kind,
    boardNameMatch: true,
    inFlightKind: null,
    landedNumInBuffer: false,
    engageEligible: false,
    ...extra,
  });
  const key = keyClass => ({ type: "key", keyClass });
  const T = (state, event, next, actions) =>
    expect(transitionListSession(state, event)).toEqual({ next, actions });

  test("idle", () => {
    T("idle", settle("clean-list", { engageEligible: true }), "active", [
      "seed",
      "start-fill",
    ]);
    T("idle", settle("clean-list"), "idle", []); // pref off / rows≠24 / article ER busy
    T("idle", settle("article"), "idle", []);
    T("idle", settle("menu"), "idle", []);
    T("idle", settle("prompt"), "idle", []);
    T("idle", settle("transient"), "idle", []);
    T("idle", key("nav"), "idle", []);
    T("idle", { type: "pref-off" }, "idle", []);
  });

  test("active: settles", () => {
    T("active", settle("clean-list"), "active", ["continue-fill"]);
    T("active", settle("clean-list", { boardNameMatch: false }), "active", [
      "rebuild",
    ]); // s-jump / MODE_SELECT aliasing
    T("active", settle("article"), "suspended", ["handoff-article"]);
    // catch-all self-heal (waterball / 動態看板 / misclassification):
    T("active", settle("prompt"), "functionMode", ["enter-function-mode"]);
    // menu = 已離板，直接 idle（走 functionMode 需要再一個 settle 才能到 idle，
    // 靜止的選單畫面永遠不會再 settle → 卡死 —— live soak 回歸）:
    T("active", settle("menu"), "idle", ["cleanup"]);
    T("active", settle("transient"), "functionMode", ["enter-function-mode"]);
    // ... but a half-settled frame is EXPECTED while a command is in flight:
    T("active", settle("transient", { inFlightKind: "prefetch-up" }), "active", []);
    T("active", settle("prompt", { inFlightKind: "prefetch-up" }), "active", []);
    // menu 出口不受 in-flight 抑制（離板優先於任何殘留 prefetch）:
    T("active", settle("menu", { inFlightKind: "prefetch-up" }), "idle", ["cleanup"]);
  });

  test("active: keys", () => {
    T("active", key("nav"), "active", ["move-selection"]);
    T("active", key("open"), "opening", ["begin-open"]);
    T("active", key("open-pinned"), "opening", ["begin-open-pinned"]); // End+內容定位序列
    T("active", key("other"), "functionMode", ["enter-function-mode"]);
    // [ ] = 相對命令（有序號選取）＝一級公民：frozen 配對，不走 native 鏡像
    T("active", key("relative"), "functionMode", ["begin-relative"]);
    T("active", { type: "pref-off" }, "idle", ["cleanup"]);
  });

  test("functionMode", () => {
    T(
      "functionMode",
      settle("clean-list", { landedNumInBuffer: true }),
      "active",
      ["resume-buffer"]
    );
    T("functionMode", settle("clean-list"), "active", [
      "resume-buffer",
      "rebuild",
    ]); // landed outside the buffer (or board changed) → rebuild
    T(
      "functionMode",
      settle("clean-list", { landedNumInBuffer: true, boardNameMatch: false }),
      "active",
      ["resume-buffer", "rebuild"]
    );
    T("functionMode", settle("article"), "suspended", ["handoff-article"]);
    T("functionMode", settle("menu"), "idle", ["cleanup"]);
    T("functionMode", settle("prompt"), "functionMode", []);
    T("functionMode", settle("transient"), "functionMode", []);
    T("functionMode", { type: "pref-off" }, "idle", ["cleanup"]);
  });

  test("opening", () => {
    T("opening", settle("article"), "suspended", ["handoff-article"]);
    T("opening", settle("clean-list"), "opening", []); // stage-1 landing: queue's expect consumes it
    T("opening", settle("prompt"), "opening", []); // jump-prompt frames are EXPECTED here
    T("opening", settle("transient"), "opening", []);
    T("opening", settle("menu"), "opening", []); // unexpected → the timeout will self-heal
    T("opening", { type: "open-timeout" }, "functionMode", [
      "enter-function-mode",
    ]);
    T("opening", key("nav"), "opening", []); // serialized: keys swallowed mid-open
    T("opening", key("other"), "opening", []);
    T("opening", { type: "pref-off" }, "idle", ["cleanup"]);
  });

  test("suspended", () => {
    T("suspended", settle("clean-list"), "active", ["restore"]);
    T("suspended", settle("menu"), "idle", ["cleanup"]);
    T("suspended", settle("article"), "suspended", []); // page turns inside the article
    T("suspended", settle("prompt"), "suspended", []);
    T("suspended", settle("transient"), "suspended", []);
    T("suspended", { type: "pref-off" }, "idle", ["cleanup"]);
  });
});

describe("mergeListPage + flattenListBuffer", () => {
  // Rows are opaque to the accumulation core — use strings as stand-in rows.
  const entry = (num, row, key) => ({ num, key: key != null ? key : null, row });

  it("flattens numbered rows ASCENDING (oldest→newest) with pinned rows last", () => {
    const numMap = new Map(),
      pinnedMap = new Map();
    // A page painted newest-first in buffer order still flattens ascending by number.
    mergeListPage(numMap, pinnedMap, [
      entry(102, "c"),
      entry(100, "a"),
      entry(101, "b"),
      entry(null, "PIN1", "pinkey1"),
    ]);
    expect(flattenListBuffer(numMap, pinnedMap)).toEqual({
      lines: ["a", "b", "c", "PIN1"],
      nums: [100, 101, 102, null],
    });
  });

  it("OVERWRITES an existing number with the latest clone (live 推文數 / 已讀)", () => {
    const numMap = new Map(),
      pinnedMap = new Map();
    mergeListPage(numMap, pinnedMap, [entry(100, "old"), entry(101, "b")]);
    mergeListPage(numMap, pinnedMap, [entry(100, "new")]); // re-painted page
    expect(flattenListBuffer(numMap, pinnedMap)).toEqual({
      lines: ["new", "b"],
      nums: [100, 101],
    });
  });

  it("de-dups pinned rows by key and keeps them at the very bottom", () => {
    const numMap = new Map(),
      pinnedMap = new Map();
    mergeListPage(numMap, pinnedMap, [
      entry(null, "P1", "k1"),
      entry(null, "P2", "k2"),
      entry(200, "x"),
    ]);
    mergeListPage(numMap, pinnedMap, [entry(null, "P1", "k1")]); // same pinned again
    const flat = flattenListBuffer(numMap, pinnedMap);
    expect(flat.lines).toEqual(["x", "P1", "P2"]);
    expect(flat.nums).toEqual([200, null, null]);
  });

  it("pinned keyed by TITLE slice: a live push-count change must not duplicate the row (v3 bug 5a)", () => {
    const numMap = new Map(),
      pinnedMap = new Map();
    // Same pinned announcement, push count 1 → 2 between two paints. Keying by
    // the whole row text would keep both; the title key overwrites in place.
    const titleKey = "轉 [公告] 不當連結相關申訴";
    mergeListPage(numMap, pinnedMap, [
      entry(null, "    ★  m 1 6/01 arrenwu      轉 [公告] 不當連結相關申訴", titleKey),
    ]);
    mergeListPage(numMap, pinnedMap, [
      entry(null, "    ★  m 2 6/01 arrenwu      轉 [公告] 不當連結相關申訴", titleKey),
    ]);
    const flat = flattenListBuffer(numMap, pinnedMap);
    expect(flat.lines).toEqual([
      "    ★  m 2 6/01 arrenwu      轉 [公告] 不當連結相關申訴",
    ]);
  });

  it("prepends older pages on top; selection resolved by NUMBER survives the shift", () => {
    const numMap = new Map(),
      pinnedMap = new Map();
    mergeListPage(numMap, pinnedMap, [entry(300, "c"), entry(301, "d")]);
    let flat = flattenListBuffer(numMap, pinnedMap);
    const selNum = 300;
    expect(flat.nums.indexOf(selNum)).toBe(0);
    // An UPWARD prefetch prepends older numbers → absolute index of 300 shifts up.
    mergeListPage(numMap, pinnedMap, [entry(298, "a"), entry(299, "b")]);
    flat = flattenListBuffer(numMap, pinnedMap);
    expect(flat.nums).toEqual([298, 299, 300, 301]);
    expect(flat.nums.indexOf(selNum)).toBe(2); // index moved, number stable
  });
});

describe("evictListBuffer (total-row cap)", () => {
  const mapOf = nums => new Map(nums.map(n => [n, "r" + n]));
  it("no-op under the cap", () => {
    const m = mapOf([1, 2, 3]);
    expect(evictListBuffer(m, 2, 3)).toEqual({
      evictedUp: false,
      evictedDown: false,
    });
    expect(m.size).toBe(3);
  });
  it("evicts the end FARTHEST from the selection (selection kept)", () => {
    // selection near the bottom → the old top gets dropped.
    const m = mapOf([10, 11, 12, 13, 14]);
    const r = evictListBuffer(m, 14, 3);
    expect(r).toEqual({ evictedUp: true, evictedDown: false });
    expect(Array.from(m.keys()).sort((a, b) => a - b)).toEqual([12, 13, 14]);
  });
  it("evicts the bottom when the selection sits at the top", () => {
    const m = mapOf([10, 11, 12, 13, 14]);
    const r = evictListBuffer(m, 10, 3);
    expect(r).toEqual({ evictedUp: false, evictedDown: true });
    expect(Array.from(m.keys()).sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });
  it("mid selection evicts both ends, keeping the window around it", () => {
    const m = mapOf([1, 2, 3, 4, 5, 6, 7]);
    const r = evictListBuffer(m, 4, 3);
    expect(r).toEqual({ evictedUp: true, evictedDown: true });
    expect(Array.from(m.keys()).sort((a, b) => a - b)).toEqual([3, 4, 5]);
  });
  it("null selection (pinned tail selected) is treated as bottom → evicts the top", () => {
    const m = mapOf([10, 11, 12, 13]);
    const r = evictListBuffer(m, null, 2);
    expect(r).toEqual({ evictedUp: true, evictedDown: false });
    expect(Array.from(m.keys()).sort((a, b) => a - b)).toEqual([12, 13]);
  });
});

describe("shouldStopListPrefetch", () => {
  const s = o =>
    shouldStopListPrefetch({
      visibleCount: 0,
      target: 200,
      pageCount: 0,
      maxPages: 15,
      ...o,
    });
  it("stops once enough visible (non-blacklisted) rows are accumulated", () => {
    expect(s({ visibleCount: 200 })).toBe(true);
    expect(s({ visibleCount: 199 })).toBe(false);
  });
  it("stops at the page cap so a heavily-filtered board can't page forever", () => {
    expect(s({ visibleCount: 10, pageCount: 15 })).toBe(true);
    expect(s({ visibleCount: 10, pageCount: 14 })).toBe(false);
  });
});

describe("moveListSelection", () => {
  const visible = [0, 2, 3, 5]; // rows 1 and 4 dropped (blacklisted)
  it("steps to the next/previous visible row, skipping dropped rows", () => {
    expect(moveListSelection(visible, 0, 1)).toBe(2);
    expect(moveListSelection(visible, 3, 1)).toBe(5);
    expect(moveListSelection(visible, 5, -1)).toBe(3);
  });
  it("clamps at the ends", () => {
    expect(moveListSelection(visible, 5, 1)).toBe(5);
    expect(moveListSelection(visible, 0, -1)).toBe(0);
  });
  it("snaps to the nearest visible row when the current selection is no longer visible", () => {
    // current=4 was dropped; moving down lands on the next visible (5), up on 3.
    expect(moveListSelection(visible, 4, 1)).toBe(5);
    expect(moveListSelection(visible, 4, -1)).toBe(3);
  });
  it("returns -1 when nothing is visible", () => {
    expect(moveListSelection([], 0, 1)).toBe(-1);
  });
});

describe("bufferEdgeNum (anchored prefetch targets)", () => {
  const nums = [100, 101, 102, null, null]; // ascending + pinned tail
  it("direction<0 → smallest numbered (top edge)", () => {
    expect(bufferEdgeNum(nums, -1)).toBe(100);
  });
  it("direction>0 → largest numbered (bottom edge), skipping the pinned tail", () => {
    expect(bufferEdgeNum(nums, 1)).toBe(102);
  });
  it("no numbered rows / empty → null", () => {
    expect(bufferEdgeNum([null, null], -1)).toBeNull();
    expect(bufferEdgeNum([], 1)).toBeNull();
    expect(bufferEdgeNum(null, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// demand prefetch（session 層：邊距與鏈式）
// ---------------------------------------------------------------------------

// 最小 ListSession stub：buffer 內 count 篇（numStart 起連號），無黑名單。
// 列文字給 rowToText 用（_visibleIndices），格式取自真實列。
function demandSession({ numStart = 100, count = 60 } = {}) {
  const enqueued = [];
  const view = {
    hideCursor() {},
    showCursor() {},
    resetListAccumulation() {},
    blacklist: new Set(),
    titleBlacklist: [],
  };
  const mkRow = (n) => {
    const text = ` ${String(n)} + 2 6/14 someoneA     □ [閒聊] 文章 ${n}`.padEnd(80);
    return [...text].map((ch) => ({ ch, isLeadByte: false }));
  };
  const nums = [];
  const lines = [];
  for (let i = 0; i < count; ++i) {
    nums.push(numStart + i);
    lines.push(mkRow(numStart + i));
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
  };
  const queue = {
    idle: true,
    inFlightKind: null,
    flush() {
      this.flushed = (this.flushed || 0) + 1;
    },
    enqueue(cmd) {
      enqueued.push(cmd);
    },
    onSettle() {},
  };
  const s = new ListSession({ conn: { send() {} } }, view, termBuf, queue);
  s.state = "active";
  s._boardName = "C_Chat";
  return { s, enqueued, queue, nums };
}

describe("demand 邊距（提早預補隱藏 round-trip 延遲）", () => {
  // bodyRows B = 20。視窗距 buffer 邊 < 2B 就該補（舊規則 < B 太晚：使用者
  // 已貼近邊緣才開始抓，每次都吃滿兩個 round-trip 的等待）。
  test("向下：視窗底距 buffer 底 1.5 頁（< 2B）→ 觸發 demand（舊 <B 不觸發 → 紅）", () => {
    const { s, enqueued } = demandSession({ count: 60 }); // 60 列
    // 視窗 top=第10列 → 底下剩 60-(10+20)=30 列 = 1.5B
    s._topNum = 110;
    s._selectedNum = 115;
    s._maybeDemand(1);
    expect(enqueued.length).toBeGreaterThan(0);
    expect(enqueued[enqueued.length - 1].kind).toBe("prefetch-down");
  });
  test("向下：距邊 ≥ 2B → 不觸發", () => {
    const { s, enqueued } = demandSession({ count: 80 }); // 80-(10+20)=50 ≥ 40
    s._topNum = 110;
    s._selectedNum = 115;
    s._maybeDemand(1);
    expect(enqueued).toEqual([]);
  });
  test("向上：top 距 buffer 頂 1.5 頁 → 觸發 prefetch-up", () => {
    const { s, enqueued } = demandSession({ count: 80 });
    s._topNum = 130; // top pos = 30 < 2B
    s._selectedNum = 135;
    s._maybeDemand(-1);
    expect(enqueued.length).toBeGreaterThan(0);
    expect(enqueued[enqueued.length - 1].kind).toBe("prefetch-up");
  });
  test("已確認到邊 → 不觸發", () => {
    const { s, enqueued } = demandSession({ count: 60 });
    s._topNum = 110;
    s._selectedNum = 115;
    s._edgeDown = true;
    s._maybeDemand(1);
    expect(enqueued).toEqual([]);
  });
});

describe("鏈式 prefetch（同方向連補免重複錨定 jump，round-trip 減半）", () => {
  // 錨定命令對＝jump＋PgDn 兩個序列化 round-trip。同方向連續補頁時 server
  // 游標位置已知（上一 PgDn 的落點），直送 PgDn 即可；任何外部活動（flush／
  // 其他命令／非 in-flight settle）都必須打斷鏈、回到兩腿錨定。
  function firstDemand() {
    const ctx = demandSession({ count: 60 });
    ctx.s._topNum = 110;
    ctx.s._selectedNum = 115;
    ctx.s._maybeDemand(1);
    expect(ctx.enqueued.length).toBe(2); // anchor + page（首次照舊）
    expect(ctx.enqueued[0].kind).toBe("prefetch-anchor-down");
    expect(ctx.enqueued[1].kind).toBe("prefetch-down");
    return ctx;
  }

  test("同方向第二次 demand → 只 enqueue 一個 page 命令（無 anchor 腿；現行兩腿 → 紅）", () => {
    const { s, enqueued } = firstDemand();
    // page 完成（游標落新頁頂 160）→ onDone 遞迴 _maybeDemand，鏈上直送
    enqueued[1].onDone({ moved: true, landed: 160 });
    expect(enqueued.length).toBe(3);
    expect(enqueued[2].kind).toBe("prefetch-down");
  });

  test("鏈上 page 的 expect：越過上次落點=moved、等於=edge", () => {
    const { s, enqueued } = firstDemand();
    enqueued[1].onDone({ moved: true, landed: 160 });
    const chained = enqueued[2];
    expect(chained.expect(null, factsWithCursor(165))).toEqual(
      expect.objectContaining({ moved: true })
    );
    expect(chained.expect(null, factsWithCursor(160))).toEqual(
      expect.objectContaining({ edge: true })
    );
  });

  test("鏈上到邊（edge）→ markEdge 且鏈清空（下次 demand 回兩腿）", () => {
    const { s, enqueued } = firstDemand();
    enqueued[1].onDone({ moved: true, landed: 160 });
    enqueued[2].onDone({ edge: true, landed: 160 });
    expect(s._edgeDown).toBe(true);
    expect(s._chainState).toBeNull();
  });

  test("插入其他佇列命令（開文 flush）→ 鏈失效，下次 demand 回兩腿", () => {
    const { s, enqueued } = firstDemand();
    enqueued[1].onDone({ moved: true, landed: 160 });
    expect(enqueued.length).toBe(3);
    s.state = "active";
    s._beginOpen(); // flush + open 命令 → server 游標將被動走
    const n = enqueued.length;
    s._maybeDemand(1);
    // 重新錨定：anchor 腿必須回來
    expect(enqueued[n].kind).toBe("prefetch-anchor-down");
  });

  test("方向反轉 → 鏈失效（向下鏈不能拿來直送 PgUp）", () => {
    const { s, enqueued } = firstDemand();
    enqueued[1].onDone({ moved: true, landed: 160 });
    const n = enqueued.length;
    s._topNum = 130; // top pos = 30 < 2B → 向上觸發
    s._selectedNum = 135;
    s._maybeDemand(-1);
    expect(enqueued[n].kind).toBe("prefetch-anchor-up");
  });
});

// 最小 facts：只有鏈式 expect 讀的欄位。
function factsWithCursor(num) {
  return { kind: "clean-list", cursorRowNum: num, curY: 5, curX: 0, rows: 24 };
}

describe("visibleListIndices (mirrors Screen#computeAnnotations PAGE_LIST)", () => {
  const rows = [
    " 350024 + 2 6/14 a0930307148  R: [閒聊] 烙印勇士384",
    " 350025 + 3 6/14 conquer1988  □   [閒聊] 已在轉頭找的中間",
    " 350026 + 1 6/14 HarunoYukino □ [廢文] 政治先不論",
  ];
  it("author blacklist hit drops the row", () => {
    expect(visibleListIndices(rows, new Set(["conquer1988"]), [])).toEqual([
      0, 2,
    ]);
  });
  it("title keyword hit drops the row", () => {
    expect(visibleListIndices(rows, new Set(), ["廢文"])).toEqual([0, 1]);
  });
  it("no blacklists → everything visible", () => {
    expect(visibleListIndices(rows, new Set(), [])).toEqual([0, 1, 2]);
  });
  it("刪除文（作者欄 -）即使無黑名單也隱藏（開文會 wedge，比照黑名單）", () => {
    const withDeleted = [
      rows[0],
      " 350025     7/04 -            □ (本文已被刪除) <wh40917>",
      rows[2],
    ];
    expect(visibleListIndices(withDeleted, new Set(), [])).toEqual([0, 2]);
    // 黑名單同時生效時規則疊加
    expect(
      visibleListIndices(withDeleted, new Set(["harunoyukino"]), [])
    ).toEqual([0]);
  });
});
