// List easy reading v4 pure-layer guards: screen classification (fingerprint
// predicates over a REAL captured C_Chat board page + synthetic variants),
// burst classification, the full state-machine transition table (every row of
// the docs table gets at least one case), and the accumulation/selection
// primitives ported from the v3 wip branch.
import fs from "fs";
import path from "path";
import { CommandQueue } from "../../src/js/command_queue";
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
  isWaterballSettle,
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
    // 【看板列表】/【我的最愛】：從看板列表/最愛進板再 ← 離板的落點畫面——
    // 不認得會讓 leave-board 交易 expect 永不滿足（timeout→探針→顯性降級，
    // 「退到看板列表卡很久然後切原生」bug）。
    for (const title of [
      "【主功能表】",
      "【分類看板】",
      "【精華文章】",
      "【看板列表】",
      "【我的最愛】",
    ]) {
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

  // 2026-07-11 錄製檔誤降級：板尾最後一頁只有 1 列編號文章（游標壓在上面，
  // ● 蓋掉最高位 → parseListArticleNum null、只有 loose 可讀）＋數列置底文＋
  // 空白列。舊規則「≥3 列編號」判 transient → prefetch 腿 expect 永不滿足 →
  // 探針幀 miss → 無主 settle → catch-all 誤降級 functionMode（使用者無按鍵）。
  function boardTailRows() {
    const rows = listRows.slice(0, 3);
    rows[3] = "●53500 + 7/11 SaberMyWifi  □ [閒聊] 板尾文章";
    for (let i = 4; i <= 7; ++i)
      rows[i] = "  ★ 27 6/09     arrenwu     □ [公告] 板規與置底";
    for (let i = 8; i <= 22; ++i) rows[i] = "";
    rows[23] = listRows[listRows.length - 1];
    return rows;
  }

  test("板尾短頁（游標在僅存編號列＋置底＋空白）→ clean-list", () => {
    expect(
      classifyListScreen(facts({ rowTexts: boardTailRows(), curY: 3, curX: 1 }))
    ).toEqual({ kind: "clean-list", boardName: "C_Chat" });
  });

  // pttbbs b9a5029f 後：游標＝半形 '>'，只蓋 %7d 的前導空格、序號完整可見，
  // 且 cursor_show 後 move(row, column) ⇒ 終端游標 park 在 col 0（舊版 col 1）。
  function boardTailRowsAsciiCursor() {
    const rows = boardTailRows();
    rows[3] = ">353500 + 7/11 SaberMyWifi  □ [閒聊] 板尾文章";
    return rows;
  }

  test("新版 > 游標：一般整頁 → clean-list（park col 0 仍滿足 curX ≤ 1）", () => {
    const rows = listRows.slice();
    rows[3] = ">" + listRows[3].slice(1);
    expect(classifyListScreen(facts({ rowTexts: rows, curY: 3, curX: 0 }))).toEqual({
      kind: "clean-list",
      boardName: "C_Chat",
    });
  });

  test("新版 > 游標的板尾短頁 → clean-list（否則板尾無主 settle 誤降級）", () => {
    expect(
      classifyListScreen(
        facts({ rowTexts: boardTailRowsAsciiCursor(), curY: 3, curX: 0 })
      )
    ).toEqual({ kind: "clean-list", boardName: "C_Chat" });
  });

  test("板尾短頁但游標列是空白列 → 仍 transient（半繪防護）", () => {
    expect(
      classifyListScreen(facts({ rowTexts: boardTailRows(), curY: 10, curX: 0 }))
        .kind
    ).toBe("transient");
  });

  test("板尾短頁夾非列表形文字列（內文殘影）→ 仍 transient", () => {
    const rows = boardTailRows();
    rows[9] = "這是半繪的文章內文殘影，不是列表列";
    expect(
      classifyListScreen(facts({ rowTexts: rows, curY: 3, curX: 1 })).kind
    ).toBe("transient");
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

// v5/M4 T4：水球/廣播指紋（protocol §9 outmsg：只寫底列（msg_occupied>0 時
// 上移一列），該列以反白 ◆ 起頭）。caller 先排除 in-flight 交易再問。
describe("isWaterballSettle (T4 非請自來指紋)", () => {
  const rows = 24;
  const texts = msgRow => {
    const t = new Array(rows).fill("");
    Object.keys(msgRow).forEach(r => (t[r] = msgRow[r]));
    return t;
  };
  test("底列 ◆userid 訊息 → true", () => {
    expect(
      isWaterballSettle({
        changedRows: new Set([23]),
        rowTexts: texts({ 23: " ◆someuser 安安你好" }),
        rows,
      })
    ).toBe(true);
  });
  test("msg_occupied 上移一列（rows-2）也認", () => {
    expect(
      isWaterballSettle({
        changedRows: new Set([22, 23]),
        rowTexts: texts({ 22: "◆other 第二顆", 23: " ◆someuser 第一顆" }),
        rows,
      })
    ).toBe(true);
  });
  test("髒列超出底部兩列 → false（頁面重繪不是水球）", () => {
    expect(
      isWaterballSettle({
        changedRows: new Set([5, 23]),
        rowTexts: texts({ 23: "◆someuser hi" }),
        rows,
      })
    ).toBe(false);
  });
  test("底列非 ◆ 起頭 → false（一般 vmsg 訊息列）", () => {
    expect(
      isWaterballSettle({
        changedRows: new Set([23]),
        rowTexts: texts({ 23: "【功能鍵】按任意鍵繼續" }),
        rows,
      })
    ).toBe(false);
    expect(
      isWaterballSettle({ changedRows: new Set(), rowTexts: texts({}), rows })
    ).toBe(false);
    expect(isWaterballSettle({ changedRows: null, rowTexts: texts({}), rows })).toBe(
      false
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
    hasNumberedRow: true, // 不變量 17：無編號列的幀另有專門的枚舉列
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
    // 不變量 17：只剩置底文的短頁沒有序號可當 prefetch 錨點 → 不得 seed
    T(
      "idle",
      settle("clean-list", { engageEligible: true, hasNumberedRow: false }),
      "idle",
      []
    );
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
    // 2026-07-14 錄製檔：被剛完成的指令「消費」的 settle 不是無主——板尾
    // prefetch 探針幀（jump-park 後底列空 → transient）滿足 expect 判 edge，
    // queue 完成後 inFlightKind 已 null，同一 settle 進 reducer 不得 catch-all
    // 降級（consumed 標記）。
    T("active", settle("transient", { consumed: true }), "active", []);
    T("active", settle("prompt", { consumed: true }), "active", []);
    // menu/article/clean-list 出口不受 consumed 影響（照常轉移）
    T("active", settle("menu", { consumed: true }), "idle", ["cleanup"]);
    // menu 出口不受 in-flight 抑制（離板優先於任何殘留 prefetch）:
    T("active", settle("menu", { inFlightKind: "prefetch-up" }), "idle", ["cleanup"]);
    // 不變量 17：無編號列的幀帶不進序號——板名同就續用現有 buffer（不 rebuild
    // 成無錨點死局），板名異則連舊 buffer 都不能當畫面 → 顯性降級原生。
    T("active", settle("clean-list", { hasNumberedRow: false }), "active", []);
    T(
      "active",
      settle("clean-list", { hasNumberedRow: false, boardNameMatch: false }),
      "functionMode",
      ["enter-function-mode"]
    );
  });

  test("active: keys", () => {
    T("active", key("nav"), "active", ["move-selection"]);
    T("active", key("open"), "opening", ["begin-open"]);
    T("active", key("open-pinned"), "opening", ["begin-open-pinned"]); // End+內容定位序列
    // 未知 keyClass（防禦）＝stay
    T("active", key("other"), "active", []);
    // ←/q/e 離板＝交易化（frozen＋leave-board 佇列）
    T("active", key("leave"), "functionMode", ["begin-leave"]);
    // 非白名單鍵＝一鍵切原生（2026-07-10）：reducer 只轉態（sync 腿在途吸收
    // settle/吞鍵），enter-function-mode＋代送由 _beginNativePassthrough 執行
    T("active", key("passthrough"), "functionMode", []);
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
    // AID 跳文的退出前導段（站內信）刻意經過選單：mbbsd/more.c:102 把 s 綁死在
    // currstat == READING，所以必須先 ← 退到主功能表。cleanup 會 queue.flush()
    // → in-flight 指令的 onFlushed → 整串 AID 序列在第一步就死掉。
    T(
      "functionMode",
      settle("menu", { inFlightKind: "aid-escape" }),
      "functionMode",
      []
    );
    // 不變量 17：無編號列的落點無法 resume/rebuild → 繼續鏡像原生
    T(
      "functionMode",
      settle("clean-list", { landedNumInBuffer: true, hasNumberedRow: false }),
      "functionMode",
      []
    );
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
    // v5/M4 re-seed：退文回列表不再逐行 parity 還原（_restore 家族退役），
    // 與 functionMode 同規則——server 落點權威，落點在緩衝內續用 buffer，
    // 否則 rebuild（pinned 落點 cursorRowNum=null → landedNumInBuffer=false）。
    T(
      "suspended",
      settle("clean-list", { landedNumInBuffer: true }),
      "active",
      ["resume-buffer"]
    );
    T("suspended", settle("clean-list"), "active", ["resume-buffer", "rebuild"]);
    T(
      "suspended",
      settle("clean-list", { landedNumInBuffer: true, boardNameMatch: false }),
      "active",
      ["resume-buffer", "rebuild"]
    );
    // 不變量 17：退文落點只剩置底文 → 不 re-seed，停在原生鏡像等下一幀
    T(
      "suspended",
      settle("clean-list", { landedNumInBuffer: true, hasNumberedRow: false }),
      "suspended",
      []
    );
    T("suspended", settle("menu"), "idle", ["cleanup"]);
    // 同 functionMode：AID 退出前導段行經選單時不得被 cleanup 的 flush 打斷。
    T(
      "suspended",
      settle("menu", { inFlightKind: "aid-escape" }),
      "suspended",
      []
    );
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
  const loading = [];
  const banners = [];
  const offsets = [];
  const view = {
    hideCursor() {},
    showCursor() {},
    resetListAccumulation() {},
    setListLoading: (on) => loading.push(on),
    flashListHint: (msg) => banners.push(msg),
    blacklist: new Set(),
    titleBlacklist: [],
    // 平滑捲動用：列高（未縮放）＋次列位移的快路徑接收端。
    chh: 20,
    componentScreen: { setListScrollOffset: (px) => offsets.push(px) },
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
    flushPending() {
      this.pendingFlushed = (this.pendingFlushed || 0) + 1;
    },
    flushPendingKind(prefix) {
      this.pendingKindFlushed = prefix;
    },
    enqueue(cmd) {
      enqueued.push(cmd);
    },
    onSettle() {},
  };
  const s = new ListSession({ conn: { send() {} } }, view, termBuf, queue);
  s.state = "active";
  s._boardName = "C_Chat";
  return { s, enqueued, queue, nums, loading, banners, termBuf, offsets };
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

describe("_seed 落點短頁向下補頁（問題1：進版中段空白不補；2b：置底文整條被門控）", () => {
  // 進版 engage 若落點頁不滿一版（視窗下方有空白列），背景 fill 只往上、向下補頁
  // 只由 _moveSelection 觸發 → 使用者不按鍵就沒任何機制抓落點下方的列（下方空白）；
  // 且永不觸發向下 prefetch 的 markEdge → _edgeDown 停 false → 置底文整條被門控隱藏。
  // _seed 需比照 _rebuild 補「落點短頁→向下 demand」(_demandDownIfWindowShort)。
  test("短頁落點（seq.length < top+bodyRows）→ enqueue 向下 prefetch", () => {
    const { s, enqueued } = demandSession({ count: 5 }); // buffer 只 5 列 < 一版(20)
    s._topNum = 100;
    s._selectedNum = 104;
    s._demandDownIfWindowShort();
    expect(enqueued.length).toBeGreaterThan(0);
    expect(enqueued.some((c) => c.kind === "prefetch-anchor-down")).toBe(true);
  });
  test("滿版落點（buffer ≥ 視窗底）→ 不 enqueue（守護『滿版不探測』避免板尾零回應 race）", () => {
    const { s, enqueued } = demandSession({ count: 60 });
    s._topNum = 100;
    s._selectedNum = 105;
    s._demandDownIfWindowShort();
    expect(enqueued).toEqual([]);
  });
  test("已確認板尾（_edgeDown）→ 不 enqueue", () => {
    const { s, enqueued } = demandSession({ count: 5 });
    s._topNum = 100;
    s._selectedNum = 104;
    s._edgeDown = true;
    s._demandDownIfWindowShort();
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

  test("anchor onFail 只砍 prefetch pending（不得 flush 掉排隊在後的交易）", () => {
    // 前導改 flushPending 後，anchor 失敗當下 pending 可能已是使用者的 T2
    // 交易（page 命令早被前導清掉）——全量 flush 會無聲殺掉它、session 卡在
    // frozen。onFail 只准砍自己配對的 prefetch 命令。
    const { s, enqueued, queue } = firstDemand();
    enqueued[0].onFail("timeout");
    expect(queue.flushed || 0).toBe(0);
    expect(queue.pendingKindFlushed).toBe("prefetch");
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

describe("v5 確定性交易（timeout=探針觸發，非訊號；jump 腿維持 park 指紋）", () => {
  // 協定事實（§6）：\f 的 redrawwin 重繪 server 虛擬螢幕「現狀」——跳號後底列
  // 在 server 端本來就空，\f 不會補畫 feeter → jump 落點永遠 transient，所以
  // expect 必須維持 park 指紋（不得改成等 clean-list）。
  // 但跳號腿本身一律掛 fullRepaint：「裸跳號必回應」是錯的——跳到真游標
  // 已經所在的那一列，畫面零差異 ⇒ server 送 0 bytes ⇒ term_buf 永不 settle
  // ⇒ expect 永不被評估，只能苦等軟逾時（錄製檔
  // ptt-debug-20260825-105701#t=12562：open-jump 空等 4002ms）。
  test("錨定 jump 腿：fullRepaint＋park 指紋（transient 落點即完成）", () => {
    const { s, enqueued } = demandSession({ count: 60 });
    s._topNum = 110;
    s._selectedNum = 115;
    s._maybeDemand(1);
    const anchor = enqueued[0];
    expect(anchor.kind).toBe("prefetch-anchor-down");
    expect(anchor.fullRepaint).toBe(true);
    const base = 159; // bufferEdgeNum(down) = 最大序號
    expect(
      anchor.expect(null, { kind: "transient", cursorRowNum: base, curY: 5, curX: 0, rows: 24 })
    ).toBe(true);
    expect(
      anchor.expect(null, { kind: "transient", cursorRowNum: base, curY: 23, curX: 10, rows: 24 })
    ).toBe(false);
  });

  test("翻頁腿：短固定 timeout（250ms）觸發 queue 探針；探針幀游標未動＝內容判到邊", () => {
    const { s, enqueued } = demandSession({ count: 60 });
    s._topNum = 110;
    s._selectedNum = 115;
    s._maybeDemand(1);
    const page = enqueued[1];
    expect(page.kind).toBe("prefetch-down");
    // 翻頁腿刻意不掛 \f：有動的翻頁本來就確定性回應，附 \f 只是流量×2；
    // 板尾零回應那條由短探針窗負責（與跳號腿的取捨不同，勿順手補齊）。
    expect(page.fullRepaint).toBeUndefined();
    expect(page.timeoutMs).toBe(250); // 舊 RTT 自適應（不變量 7）退役
    // 探針全幅畫面（feeter 在）上游標仍在錨點 → {edge}（確定性到邊）。
    expect(page.expect(null, factsWithCursor(159))).toEqual(
      expect.objectContaining({ edge: true })
    );
  });

  test("翻頁腿（向下）：真板尾 PgDn 游標落置底列（cursorRowNum null）＝edge，不 miss", () => {
    // live 2026-07-08：落點在板尾的 demand-down，PgDn 回應把游標推到置底文列
    // （無序號 → cursorRowNum null）。舊 expect 對 null 一律 false → hard
    // timeout miss → 稍後 \f 探針回應變無主 settle → catch-all 誤降級 native
    //（「畫面偏離列表格式」banner）。同 _requestEnd 前例（不變量 3）：向下翻頁
    // 落在置底列＝板尾確認。
    const { s, enqueued } = demandSession({ count: 60 });
    s._topNum = 110;
    s._selectedNum = 115;
    s._maybeDemand(1);
    const page = enqueued[1];
    expect(page.kind).toBe("prefetch-down");
    const pinnedFacts = { kind: "clean-list", cursorRowNum: null, curY: 22, curX: 0, rows: 24 };
    expect(page.expect(null, pinnedFacts)).toEqual(
      expect.objectContaining({ edge: true })
    );
    // onDone：landed null → _serverNum null、markEdge
    page.onDone({ edge: true, landed: null });
    expect(s._edgeDown).toBe(true);
    expect(s._serverNum).toBeNull();
  });

  test("翻頁腿（向下）：transient 幀但 park 指紋＋序號位移確定 → moved/edge（2026-07-11 錄製檔）", () => {
    // 板尾短頁可能因編號列過少被分類 transient（classify 短頁規則已放寬，但
    // 這裡是第二道防線）：游標停 entry 區 col≤1 且序號相對 base 位移已確定，
    // 不必等 clean-list 也能收腿——否則 timeout→探針 miss→無主 settle→誤降級。
    const { s, enqueued } = demandSession({ count: 60 });
    s._topNum = 110;
    s._selectedNum = 115;
    s._maybeDemand(1);
    const page = enqueued[1];
    expect(page.kind).toBe("prefetch-down");
    const base = 159;
    const t = (over) =>
      page.expect(null, { kind: "transient", curY: 5, curX: 0, rows: 24, ...over });
    expect(t({ cursorRowNum: base + 6 })).toEqual(
      expect.objectContaining({ moved: true, landed: base + 6 })
    );
    expect(t({ cursorRowNum: base })).toEqual(
      expect.objectContaining({ edge: true })
    );
    // transient 的 null 可能只是半繪解析不到 → 不得判 edge，等探針幀。
    expect(t({ cursorRowNum: null })).toBe(false);
    // 沒 park（游標在底列打字區）→ 不是落點回應。
    expect(t({ cursorRowNum: base + 6, curY: 23, curX: 10 })).toBe(false);
  });

  test("翻頁腿（向上）：cursorRowNum null 不得判 edge（置底列只存在板尾）", () => {
    const { s, enqueued } = demandSession({ count: 60 });
    s._topNum = 110;
    s._selectedNum = 115;
    s._maybeDemand(-1);
    const page = enqueued[1];
    expect(page.kind).toBe("prefetch-up");
    expect(
      page.expect(null, { kind: "clean-list", cursorRowNum: null, curY: 22, curX: 0, rows: 24 })
    ).toBe(false);
  });

  test("開文 jump 腿：park 指紋＋目標序號（不因 v5 改動而變）", () => {
    const { s, enqueued } = demandSession({ count: 60 });
    s._selectedNum = 115;
    s._beginOpen();
    const jump = enqueued.find((c) => c.kind === "open-jump");
    expect(jump.fullRepaint).toBe(true);
    expect(
      jump.expect(null, { kind: "transient", cursorRowNum: 115, curY: 5, curX: 0, rows: 24 })
    ).toBe(true);
    expect(
      jump.expect(null, { kind: "prompt", cursorRowNum: 115, curY: 23, curX: 10, rows: 24 })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2026-07-14 錄製檔：板尾（整板一頁）prefetch 探針幀被自己的腿消費後，同一個
// settle 進 reducer 時 inFlightKind 已 null → 被 active 的 catch-all 當無主
// transient 誤降級 functionMode（黏性 hold，不自動恢復）。真 CommandQueue 全鏈重現。
// ---------------------------------------------------------------------------
describe("被完成指令消費的 settle 不得誤降級（2026-07-14 錄製檔）", () => {
  afterEach(() => vi.useRealTimers());

  test("板尾 prefetch-down 零回應 → 探針 transient 幀判 edge → state 停 active", async () => {
    vi.useFakeTimers();
    const sent = [];
    const queue = new CommandQueue({ send: (k) => sent.push(k) });

    const rows = 24;
    const numStart = 100;
    const count = 60; // buffer 100..159，base = 159
    const base = numStart + count - 1;
    const mkRow = (n) =>
      ` ${String(n)} + 2 6/14 someoneA     □ [閒聊] 文章 ${n}`.padEnd(80);
    const lines = [];
    const nums = [];
    for (let i = 0; i < count; ++i) {
      nums.push(numStart + i);
      lines.push([...mkRow(numStart + i)].map((ch) => ({ ch, isLeadByte: false })));
    }
    // jump-park 後的畫面（協定 §4✚/§6）：底列空 → 永遠 transient；游標 park
    // 在 base 序號列。\f 探針重繪同一虛擬螢幕 → 探針幀也是這個形狀。
    const rowTexts = new Array(rows).fill("");
    rowTexts[5] = mkRow(base);
    const termBuf = {
      rows,
      cols: 80,
      listLines: lines,
      listLineNums: nums,
      lineChangeds: new Array(rows).fill(false),
      changed: false,
      addEventListener() {},
      notify() {},
      getRowText: (r) => rowTexts[r],
      isUnicolor: () => false,
      settleSnapshot: null,
    };
    const banners = [];
    const view = {
      hideCursor() {},
      showCursor() {},
      resetListAccumulation() {},
      flashListHint: (msg) => banners.push(msg),
      blacklist: new Set(),
      titleBlacklist: [],
    };
    const s = new ListSession({ conn: { send() {} } }, view, termBuf, queue);
    s.state = "active";
    s._boardName = "C_Chat";
    s._topNum = 110;
    s._selectedNum = 115;

    s._maybeDemand(1); // anchor jump "159\r" 上線
    expect(sent[0]).toBe(String(base) + "\r\f");

    // settle #1：anchor 落點（transient park）→ anchor 完成、page 腿接棒上線
    termBuf.settleSnapshot = {
      changedRows: new Set([5, 23]),
      cursorMoved: true,
      curX: 0,
      curY: 5,
    };
    s._onScreenSettled();
    expect(sent[1]).toBe("\x1b[6~");
    expect(s.state).toBe("active"); // page 腿 in flight → transient stay

    // 板尾零回應 → soft timeout（CMD_PROBE_AFTER_MS）→ \f 探針
    vi.advanceTimersByTime(801);
    expect(sent[2]).toBe("\f");

    // settle #2：探針幀（同一 transient park，游標未動）→ expect 判 edge 完成。
    // 同一個 settle 接著進 reducer——不得被當無主 transient 降級。
    termBuf.settleSnapshot = {
      changedRows: new Set([0, 5]),
      cursorMoved: false,
      curX: 0,
      curY: 5,
    };
    s._onScreenSettled();
    expect(s._edgeDown).toBe(true); // edge 有收（markEdge）
    expect(s.state).toBe("active"); // 不降級
    expect(banners).toEqual([]); // 無「畫面偏離列表格式」banner
  });

  test("背景 prefetch 在線時開文：凍結不得等滿 prefetch 的 soft timeout（偶發長凍結）", async () => {
    // 使用者回報：快速連按翻頁後馬上按 Enter 開文 → 畫面停住、顯示「開啟文章中／
    // 讀取中」，過一陣子才復原（常以「已切至原生模式」收場）。原因＝_beginOpen
    // 立刻 frozen＋吞鍵，但交易只是排進 pending：得等 in-flight 的 prefetch anchor
    // 走完自己的 soft(4000)/hard(10000) 才送出第一個 byte。修法＝queue.expedite：
    // 立刻催出 \f 探針（零副作用、必有回應）→ 幾百毫秒內讓路。
    vi.useFakeTimers();
    const sent = [];
    const queue = new CommandQueue({ send: (k) => sent.push(k) });

    const rows = 24;
    const numStart = 100;
    const count = 60; // buffer 100..159，向下 anchor = 159
    const base = numStart + count - 1;
    const mkRow = (n) =>
      ` ${String(n)} + 2 6/14 someoneA     □ [閒聊] 文章 ${n}`.padEnd(80);
    const lines = [];
    const nums = [];
    for (let i = 0; i < count; ++i) {
      nums.push(numStart + i);
      lines.push([...mkRow(numStart + i)].map((ch) => ({ ch, isLeadByte: false })));
    }
    const rowTexts = new Array(rows).fill("");
    rowTexts[5] = mkRow(base); // anchor 落點（jump park，底列空 → transient）
    const termBuf = {
      rows,
      cols: 80,
      listLines: lines,
      listLineNums: nums,
      lineChangeds: new Array(rows).fill(false),
      changed: false,
      addEventListener() {},
      notify() {},
      getRowText: (r) => rowTexts[r],
      isUnicolor: () => false,
      settleSnapshot: null,
    };
    const view = {
      hideCursor() {},
      showCursor() {},
      resetListAccumulation() {},
      setListLoading() {},
      flashListHint() {},
      blacklist: new Set(),
      titleBlacklist: [],
    };
    const s = new ListSession({ conn: { send() {} } }, view, termBuf, queue);
    s.state = "active";
    s._boardName = "C_Chat";
    s._topNum = 110;
    s._selectedNum = 115;

    s._maybeDemand(1); // 背景 prefetch：anchor "159\r" 上線、page 腿排隊
    expect(sent).toEqual([String(base) + "\r\f"]);

    s.onKeyDown({ key: "Enter", preventDefault() {} }); // 使用者馬上開文
    expect(s.state).toBe("opening");
    expect(s._renderMode).toBe("frozen"); // 畫面已凍結、鍵被吞

    vi.advanceTimersByTime(300); // 修前：要等到 4000ms 才有動靜
    expect(sent).toEqual([String(base) + "\r\f", "\f"]);

    // 探針幀＝anchor 的落點 → anchor 完成 → 開文交易立刻上線。
    termBuf.settleSnapshot = {
      changedRows: new Set([5, 23]),
      cursorMoved: true,
      curX: 0,
      curY: 5,
    };
    s._onScreenSettled();
    expect(sent[sent.length - 1]).toBe("115\r\f"); // open-jump
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 卡住／凍結類回歸守護（2026-08 使用者回報「畫面停住、顯示處理中」）
// ---------------------------------------------------------------------------

describe("讀取中指示與凍結的收尾（旗標洩漏）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // _moveSelection 在「游標貼著 buffer 邊、server 端還有更多列」時亮起「讀取中…」
  // 膠囊。jump-end/jump-home 是它的 serverOp 出口，卻從不關掉 → 膠囊永久卡在
  // 右下角，直到開文／切原生／離板。↑ 在 buffer 頂端的 wrap 語意就會送 jump-end，
  // 極易踩到。
  test("_requestEnd onDone/onFail 都要關掉「讀取中…」", () => {
    for (const path of ["onDone", "onFail"]) {
      const { s, enqueued, loading } = demandSession();
      s._setLoading(true);
      s._requestEnd();
      const cmd = enqueued[enqueued.length - 1];
      expect(cmd.kind).toBe("jump-end");
      cmd[path]({});
      expect(loading[loading.length - 1]).toBe(false);
    }
  });

  test("_requestHome onDone/onFail 都要關掉「讀取中…」", () => {
    for (const path of ["onDone", "onFail"]) {
      const { s, enqueued, loading } = demandSession();
      s._setLoading(true);
      s._requestHome();
      const cmd = enqueued[enqueued.length - 1];
      expect(cmd.kind).toBe("jump-home");
      cmd[path]({});
      expect(loading[loading.length - 1]).toBe(false);
    }
  });

  // 保底看門狗：任何讓 frozen 沒有出口的路徑（回呼從未觸發、reducer 對該事件
  // 無轉移）都不得永久凍結——否則畫面永遠停住、鍵全被吞。
  test("交易回呼從未觸發時，frozen 會自癒回原生鏡像", () => {
    const { s, banners } = demandSession(); // mock queue：不跑任何 timer
    s._beginJumpNumber(500);
    expect(s._renderMode).toBe("frozen");
    vi.advanceTimersByTime(13000);
    expect(s._renderMode).toBe("native");
    expect(banners.some((m) => m.includes("逾時"))).toBe(true);
  });

  test("_openFailed 在非 opening 狀態（reducer 無對應轉移）不得永久凍結", () => {
    const { s } = demandSession();
    s._selectedNum = 115;
    s._beginOpen(); // frozen＋開文交易排隊
    expect(s._renderMode).toBe("frozen");
    s.state = "active"; // 例：article handoff 先發生，狀態已不是 opening
    s._openFailed(); // reducer stay → actions 空 → 沒有任何解凍動作
    vi.advanceTimersByTime(13000);
    expect(s._renderMode).toBe("native");
  });

  test("cleanup 會拆掉看門狗（不得在離板後才誤觸降級）", () => {
    const { s, banners } = demandSession();
    s._beginJumpNumber(500);
    s._cleanup();
    banners.length = 0;
    vi.advanceTimersByTime(13000);
    expect(banners).toEqual([]);
  });
});

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

// ---------------------------------------------------------------------------
// 2026-07-07 使用者回報三 bug 的回歸守護
// ---------------------------------------------------------------------------

// 建 24 行 clean-list facts：body 列 3 起放 startNum..startNum+count-1
//（count<20 = 部分頁，其餘列空白——select 退出落點的真實形狀）。
function pageFacts(startNum, cursorNum, count = 20) {
  const rowTexts = new Array(24).fill("");
  const nums = new Array(24).fill(null);
  rowTexts[0] = "【板主:abc】[哈拉]           看板《C_Chat》";
  let curY = 3;
  for (let r = 3; r < 3 + count && r <= 22; ++r) {
    const n = startNum + (r - 3);
    nums[r] = n;
    rowTexts[r] = ` ${n} + 2 6/14 someoneA     □ [閒聊] 文章 ${n}`;
    if (n === cursorNum) curY = r;
  }
  rowTexts[23] = "  文章選讀  (y)回應(X)推文";
  return {
    kind: "clean-list",
    boardName: "C_Chat",
    rowTexts,
    nums,
    rows: 24,
    curX: 1,
    curY,
    cursorRowNum: cursorNum,
  };
}

describe("bug：rebuild 落點下方未緩衝 → 自動 demand-down（不等使用者按鍵）", () => {
  // 症狀：搜尋退出回主列表（rebuild），落點＝帳號已讀進度、fill 只向上，
  // 視窗下方整片空白，要動一下鍵盤才開始讀取。rebuild 後必須自動補下方。
  test("rebuild 落點頁不滿版（下方空白列）→ 先 enqueue prefetch-down", () => {
    const { s, enqueued } = demandSession({ count: 6, numStart: 100 });
    const buf = s._termBuf;
    // select 退出的真實形狀：server 幀只畫到已讀進度（6 列），其餘空白。
    const facts = pageFacts(100, 105, 6);
    // 模擬 accumulate：_rebuild 清空後 notify（_forceRedraw）把落點頁收進 buffer。
    buf.notify = () => {
      if (!buf.listLineNums.length) {
        for (let i = 0; i < 6; ++i) {
          buf.listLineNums.push(100 + i);
          buf.listLines.push([]);
        }
      }
    };
    s._rebuild(facts);
    expect(enqueued.length).toBeGreaterThan(0);
    // 第一優先＝補視窗下方（anchor-down 腿），不是向上 fill。
    expect(enqueued[0].kind).toBe("prefetch-anchor-down");
  });
  test("rebuild 落點頁已滿版 → 不 demand-down（板尾零回應探測的 live race 迴避）", () => {
    const { s, enqueued } = demandSession({ count: 20, numStart: 100 });
    const buf = s._termBuf;
    const facts = pageFacts(100, 119); // 完整 20 列，游標在最後一列
    buf.notify = () => {
      if (!buf.listLineNums.length) {
        for (let i = 0; i < 20; ++i) {
          buf.listLineNums.push(100 + i);
          buf.listLines.push([]);
        }
      }
    };
    s._rebuild(facts);
    // 只允許向上 fill（或什麼都不做），不得出現 down 腿。
    expect(enqueued.every((c) => !/down/.test(c.kind))).toBe(true);
  });
  test("demand 鏈收尾後接回背景 fill（moved onDone 呼叫 _maybeFill）", () => {
    const { s, enqueued, queue } = demandSession({ count: 60 });
    s._topNum = 110;
    s._selectedNum = 115;
    s._maybeDemand(1);
    const page = enqueued[enqueued.length - 1];
    expect(page.kind).toBe("prefetch-down");
    // headroom 已滿（landed 遠超）→ 鏈不再 demand；queue idle 時應轉回 fill-up。
    let filled = false;
    s._maybeFill = () => {
      filled = true;
    };
    queue.idle = true;
    page.onDone({ moved: true, landed: 260 });
    expect(filled).toBe(true);
  });
});

describe("_lastReadTitle 生命週期（last-read 高亮的 currtitle 鏡像）", () => {
  // pttbbs 的 currtitle 是 per-login 全域（bbs.c readdoent:830 跨板都比對），
  // 且 title key 與序號空間無關 → seed/rebuild/resume 一律保留（新幀會重教），
  // 只有 cleanup（功能關閉）歸零。noteLastRead(null) 不得清掉已知值（開文教學
  // 找不到列時 fail-safe 保持現狀）。
  test("noteLastRead 更新；seed/rebuild 保留；_cleanup 重置為 null", () => {
    const { s } = demandSession({ count: 20 });
    s.noteLastRead("[ON] MyGO全體SR卡面公布");
    expect(s._lastReadTitle).toBe("[ON] MyGO全體SR卡面公布");
    s.noteLastRead(null); // fail-safe：教不到就維持原值
    expect(s._lastReadTitle).toBe("[ON] MyGO全體SR卡面公布");
    s._seed(pageFacts(100, 115));
    expect(s._lastReadTitle).toBe("[ON] MyGO全體SR卡面公布");
    s._rebuild(pageFacts(100, 115));
    expect(s._lastReadTitle).toBe("[ON] MyGO全體SR卡面公布");
    s._view.hideListOverlay = null;
    s._cleanup();
    expect(s._lastReadTitle).toBe(null);
  });
  test("_resumeBuffer 保留 _lastReadTitle（re-seed 幀重教，殘值無害）", () => {
    const { s } = demandSession({ count: 20 });
    s.noteLastRead("[閒聊] 某篇");
    s._resumeBuffer(pageFacts(100, 115));
    expect(s._lastReadTitle).toBe("[閒聊] 某篇");
  });
});

describe("passthrough 快路徑——server 游標已同步時跳過 sync-jump 腿", () => {
  // 非白名單鍵的 passthrough（切原生＋代送）在游標已同步時不必再 jump——
  // 一個 round-trip 都不花，直接切原生代送（保留舊 relative 快路徑語意）。
  const pkey = (key) => ({
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault() {},
  });
  test("seed 落點（server 游標=選取）後按 ] → 免 sync 腿、切原生＋native-key 單腿", () => {
    const { s, enqueued } = demandSession({ count: 20, numStart: 100 });
    s._view.flashListHint = () => {};
    s._seed(pageFacts(100, 115)); // server 游標=115=選取
    enqueued.length = 0;
    s._beginNativePassthrough(pkey("]"));
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].kind).toBe("native-key");
    expect(enqueued[0].keys).toBe("]");
    expect(s._renderMode).toBe("native");
  });
  test("本地導覽移動選取後（server 游標≠選取）→ 先 native-sync-jump 腿", () => {
    const { s, enqueued } = demandSession({ count: 20, numStart: 100 });
    const sent = [];
    s._core.conn.send = (d) => sent.push(d);
    s._view.flashListHint = () => {};
    s._seed(pageFacts(100, 115));
    s._selectedNum = 110; // 本地移動，server 游標仍在 115
    enqueued.length = 0;
    s._beginNativePassthrough(pkey("]"));
    expect(enqueued[0].kind).toBe("native-sync-jump");
    expect(enqueued[0].keys).toBe("110\r");
    expect(enqueued.length).toBe(1); // sync 完成前不得送鍵
    enqueued[0].onDone();
    expect(enqueued[1].kind).toBe("native-key");
    expect(enqueued[1].keys).toBe("]");
    expect(sent).toEqual([]); // 全程走 queue，不裸送
  });
  test("prefetch 落地會移走 server 游標 → 之後的 ] 回到 sync 腿", () => {
    const { s, enqueued } = demandSession({ count: 60 });
    s._view.flashListHint = () => {};
    s._seed(pageFacts(100, 115)); // _serverNum=115
    // _seed 清了 fake buffer（harness notify 不做 accumulate）——還原
    const buf = s._termBuf;
    for (let i = 0; i < 60; ++i) {
      buf.listLineNums.push(100 + i);
      buf.listLines.push([]);
    }
    s._topNum = 110;
    s._selectedNum = 115;
    s._maybeDemand(1); // anchor+page
    const page = enqueued[enqueued.length - 1];
    page.onDone({ moved: true, landed: 160 }); // server 游標=160
    enqueued.length = 0;
    s._beginNativePassthrough(pkey("]"));
    expect(enqueued[0].kind).toBe("native-sync-jump");
  });
});

describe("currentAnchor（AID 返回用的列表座標）", () => {
  // 兩次 live 實測誤跳（2026-08-13）都指向同一件事：能當返回座標的只有「我方
  // 序列化開文時用的序號」(_openedNum)，_selectedNum 不行。
  test("我方開文後：回傳 board + 該序號 + last-read subject", () => {
    const { s } = demandSession({ count: 20 });
    s._openedNum = 352295;
    s.noteLastRead("[閒聊] 某篇");
    expect(s.currentAnchor()).toEqual({
      board: "C_Chat",
      num: 352295,
      subject: "[閒聊] 某篇"
    });
  });

  test("REGRESSION 置底文（pinned，無序號）→ 沒有座標", () => {
    // 開的是 C_Chat 板規（置底）走 _beginOpenPinned，不設 _openedNum；
    // _selectedNum 還留著上一個數字選取的殘值 → 用它會開到不相干的文章。
    const { s } = demandSession({ count: 20 });
    s._selectedNum = 352295; // 殘值
    s._selectedPinnedKey = "[公告] C_Chat板板規";
    expect(s.currentAnchor()).toBe(null);
  });

  test("REGRESSION 原生模式下游標自己動過（functionMode）→ 沒有座標", () => {
    // 按 Q 開文章資訊框就會進 functionMode：之後的方向鍵是 passthrough，
    // server 游標移動而 _selectedNum 停在舊值。
    const { s } = demandSession({ count: 20 });
    s._openedNum = 5;
    s._selectedNum = 5;
    s._enterFunctionMode();
    s._selectedNum = 5; // 殘值猶在
    expect(s.currentAnchor()).toBe(null);
  });

  test("板名被原生插曲清掉 → 仍回傳序號，board 為 null 由呼叫端遞補", () => {
    const { s } = demandSession({ count: 20 });
    s._boardName = null;
    s._openedNum = 352295;
    expect(s.currentAnchor().num).toBe(352295);
    expect(s.currentAnchor().board).toBe(null);
  });

  test("使用者按 ] 跳到下一篇（noteLeftPost）→ 座標作廢", () => {
    const { s } = demandSession({ count: 20 });
    s._openedNum = 5;
    s.noteLeftPost();
    expect(s.currentAnchor()).toBe(null);
  });

  test("什麼都沒開 → null", () => {
    const { s } = demandSession({ count: 20 });
    expect(s.currentAnchor()).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 無編號列的 clean-list 幀不得 engage（不變量 17）
// ---------------------------------------------------------------------------
// 使用者回報「列表好讀卡在一頁、PgUp 沒反應；切原生會暫時恢復，進出一篇文章
// 就正常」。debug 錄製檔 20260820-015809：→ 進板後 server 只畫得出兩列 ★置底文
//（getkeep 還原的閱讀位置剛好在板尾 ⇒ top_ln 落在置底列，readdoent 畫兩列就
// clrtobot），這一幀通過板尾短頁放寬規則判 clean-list → seed，但 buffer 收進來
// 的兩列都沒有序號 ⇒ bufferEdgeNum 回 null ⇒ 錨定式 prefetch 的每條腿
//（_startFill/_maybeFill/_maybeDemand/_requestEnd）全在 base==null 靜默 return。
// 導覽鍵在那兩列裡原地打轉、零網路、連「讀取中…」都不亮 = 永久卡死
//（唯一逃生口是 Home 的 serverOp）。
describe("無編號列的 clean-list 幀（只剩置底文的短頁）不得 seed 出無錨點 buffer", () => {
  const PINNED = "  ★ 27 6/09     arrenwu     □ [公告] 板規與置底";
  const NUMBERED = " 353500 + 7/11 SaberMyWifi  □ [閒聊] 板尾文章";

  // 錄製檔那一幀的形狀：row0/row2/row23 是先前整頁重繪留下的（本次 partial
  // redraw 只改 row2 col10 之後，所以「編號」表頭還在），entry 區只剩兩列置底。
  function frame(entryRows) {
    const rowTexts = new Array(24).fill("");
    rowTexts[0] = listRows[0];
    rowTexts[1] = listRows[1];
    rowTexts[2] = listRows[2];
    for (const [r, text] of Object.entries(entryRows)) rowTexts[Number(r)] = text;
    rowTexts[23] = listRows[23];
    return rowTexts;
  }

  // 進板落點 session：state=idle、pref 開，termBuf 的 notify 模擬 accumulate
  // 把當前幀收進 buffer（真實 _forceRedraw 的同步累積）。
  function landingSession(rowTexts, curY) {
    window.localStorage.setItem(
      "pttchrome.pref.v1",
      JSON.stringify({ values: { enableEasyReadingList: true } })
    );
    const enqueued = [];
    const banners = [];
    const view = {
      hideCursor() {},
      showCursor() {},
      resetListAccumulation() {},
      setListLoading() {},
      flashListHint: (msg) => banners.push(msg),
      blacklist: new Set(),
      titleBlacklist: [],
    };
    const mkRow = (text) =>
      [...text.padEnd(80)].map((ch) => ({ ch, isLeadByte: false }));
    const termBuf = {
      rows: 24,
      cols: 80,
      listLines: [],
      listLineNums: [],
      lineChangeds: new Array(24).fill(false),
      changed: false,
      startedEasyReading: false,
      addEventListener() {},
      getRowText: (r) => rowTexts[r],
      isUnicolor: () => true,
      settleSnapshot: { changedRows: new Set([3, 4]), cursorMoved: true, curX: 0, curY },
      notify() {
        if (this.listLineNums.length) return;
        for (let r = 3; r <= 22; ++r) {
          const text = rowTexts[r];
          if (!text || !text.trim()) continue;
          const n = /^[>\s]*(\d+)\s/.exec(text);
          this.listLineNums.push(n ? parseInt(n[1], 10) : null);
          this.listLines.push(mkRow(text));
        }
      },
    };
    const queue = {
      idle: true,
      inFlightKind: null,
      flush() {},
      flushPending() {},
      flushPendingKind() {},
      enqueue: (cmd) => enqueued.push(cmd),
      onSettle: () => undefined,
    };
    const s = new ListSession({ conn: { send() {} } }, view, termBuf, queue);
    return { s, enqueued, banners, termBuf };
  }

  test("分類器不變：兩列 ★置底＋空白仍是 clean-list（不變量 3a 的板尾保護不動）", () => {
    const rowTexts = frame({ 3: ">" + PINNED.slice(1), 4: PINNED });
    expect(
      classifyListScreen(facts({ rowTexts, curY: 3, curX: 0 })).kind
    ).toBe("clean-list");
  });

  test("REGRESSION 進板落點只有置底文 → 不 engage，停在原生（舊行為：seed 出無錨點 buffer 後永久卡死）", () => {
    const rowTexts = frame({ 3: ">" + PINNED.slice(1), 4: PINNED });
    const { s, enqueued, banners, termBuf } = landingSession(rowTexts, 3);
    s._onScreenSettled();
    expect(s.state).toBe("idle");
    expect(s._renderMode).toBe("native");
    expect(enqueued).toEqual([]); // 沒有 buffer 就沒有半條抓頁腿
    expect(banners).toEqual([]); // 也不該跳降級 banner（原本就沒進好讀）
    expect(termBuf.listLineNums.every((n) => n == null)).toBe(true);
  });

  test("板尾短頁只剩 1 列編號＋置底 → 照常 engage（不變量 3a 不被誤殺）", () => {
    const rowTexts = frame({ 3: ">" + NUMBERED.slice(1), 4: PINNED, 5: PINNED });
    const { s, enqueued } = landingSession(rowTexts, 3);
    s._onScreenSettled();
    expect(s.state).toBe("active");
    expect(s._renderMode).toBe("buffer");
    // 有錨點 ⇒ 背景 fill 真的送得出去（無錨點時這裡會是空陣列＝卡死）
    expect(enqueued.some((c) => c.kind === "prefetch-anchor-up")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 滾輪平滑捲動（pref mouseWheelSmoothScroll）
// ---------------------------------------------------------------------------

describe("滾輪平滑捲動（_stepScroll，純本地零 byte）", () => {
  // buffer：序號 100..159（60 列），B=20，列高 20px ⇒ maxTop=40、maxPx=800。
  // 兩邊 edge 都已確認 ⇒ 不會有 demand 干擾，任何 enqueue 都代表偷送了東西。
  const setup = () => {
    const h = demandSession({ numStart: 100, count: 60 });
    h.s._renderMode = "buffer";
    h.s._edgeUp = true;
    h.s._edgeDown = true;
    h.s._topNum = 110; // 視窗位置 10
    h.s._selectedNum = 115; // 游標位置 15
    h.s.getWindowView(); // 讓 _setWindow 算出邊旗標（render 每幀都會做）
    h.termBuf.notify = vi.fn();
    return h;
  };

  test("沒跨列：只改視口偏移，不動視窗、不重繪（滾輪每幀都來，重繪是白工）", () => {
    const { s, termBuf, offsets } = setup();
    expect(s._stepScroll(8)).toBe(true);
    expect(s.scrollFrac()).toBe(8);
    expect(s._topNum).toBe(110);
    expect(offsets).toEqual([8]); // 一次 scrollTop 寫入
    expect(termBuf.notify).not.toHaveBeenCalled();
  });

  test("跨列：視窗走一列，餘下的像素留在次列偏移", () => {
    const { s, termBuf } = setup();
    s._stepScroll(26); // 一列 20px + 6px
    expect(s._topNum).toBe(111);
    expect(s.scrollFrac()).toBe(6);
    expect(termBuf.notify).toHaveBeenCalled();
  });

  test("往上捲對稱（次列偏移可以退回上一列）", () => {
    const { s } = setup();
    s._stepScroll(8);
    s._stepScroll(-14); // 8-14 = -6 ⇒ 退回上一列的第 14px
    expect(s._topNum).toBe(109);
    expect(s.scrollFrac()).toBe(14);
  });

  test("游標留在原本那一篇，被視窗推到邊緣才動", () => {
    const { s } = setup();
    s._stepScroll(20 * 3); // 視窗走三列
    expect(s._topNum).toBe(113);
    expect(s._selectedNum).toBe(115); // 還在視窗內 ⇒ 不動
    s._stepScroll(20 * 5); // 再五列，游標被推
    expect(s._topNum).toBe(118);
    expect(s._selectedNum).toBe(118);
  });

  test("捲到底：最後一列貼齊視口底部（次列偏移歸零），並回報停止", () => {
    const { s, nums } = setup();
    expect(s._stepScroll(20 * 999)).toBe(false); // 撞到邊 ⇒ 緩動器停
    expect(s._topNum).toBe(140); // len(60) - B(20)
    expect(s.scrollFrac()).toBe(0); // 不留半列，否則會露出空白
    const win = s.getWindowView();
    expect(nums[win.body[win.body.length - 1]]).toBe(159);
    expect(win.overscanAbs).toBeNull(); // 貼底不需要補列
  });

  test("捲到頂同理", () => {
    const { s } = setup();
    expect(s._stepScroll(-20 * 999)).toBe(false);
    expect(s._topNum).toBe(100);
    expect(s.scrollFrac()).toBe(0);
  });

  test("已在底端時再往下：偏移不得長出來（露白的來源）", () => {
    const { s, offsets } = setup();
    s._stepScroll(20 * 999);
    offsets.length = 0;
    expect(s._stepScroll(5)).toBe(false);
    expect(s.scrollFrac()).toBe(0);
  });

  test("次列位移時多給 render 一列補滿視口（overscan）", () => {
    const { s } = setup();
    expect(s.getWindowView().overscanAbs).toBeNull(); // 對齊時不多畫
    s._stepScroll(8);
    const win = s.getWindowView();
    expect(win.body.length).toBe(20); // body 長度不變＝渲染列號的換算基準
    expect(win.overscanAbs).toBe(win.body[19] + 1);
  });

  test("交易進行中（frozen）與非 active 一律吞掉", () => {
    const frozen = setup();
    frozen.s._renderMode = "frozen";
    expect(frozen.s._stepScroll(8)).toBe(false);
    expect(frozen.s.scrollFrac()).toBe(0);

    const opening = setup();
    opening.s.state = "opening";
    expect(opening.s._stepScroll(8)).toBe(false);
  });

  test("鍵盤導覽會把次列偏移歸零（不停在半列上）", () => {
    const { s } = setup();
    s._stepScroll(8);
    expect(s.scrollFrac()).toBe(8);
    s._moveSelection("down");
    expect(s.scrollFrac()).toBe(0);
  });

  test("開文前也歸零：frozen 快照不該凍在半列上", () => {
    const { s } = setup();
    s._stepScroll(8);
    s._beginOpen();
    expect(s.scrollFrac()).toBe(0);
  });

  // 2026-08-29 live e2e 現場：游標停在置底文（★，序號 null）時往上捲，游標一直
  // 在視窗內 ⇒ 捲動不會把它拉走，`_selectedNum` 保持 null。這是正確行為（選取以
  // 內容為身分，捲動不該偷換選取），但**與翻頁不同** —— pgup 每次都把游標放到新頁
  // 頂，一格就會變成有序號的列。live spec 原本用「selectedNum 變小」當作「捲上去
  // 了」的證據，換成捲動之後那個前提就不成立了。
  test("游標停在置底文時往上捲：視窗照樣走，選取不被偷換", () => {
    const h = demandSession({ numStart: 100, count: 60 });
    const { s, termBuf } = h;
    s._renderMode = "buffer";
    s._edgeDown = true; // 已確認板尾 ⇒ 置底列進入導覽序列
    s._edgeUp = true;
    for (let i = 0; i < 3; ++i) {
      const text = `      ★ 6/14 someoneP     □ [公告] 置底 ${i}`.padEnd(80);
      termBuf.listLines.push([...text].map((ch) => ({ ch, isLeadByte: false })));
      termBuf.listLineNums.push(null);
    }
    const pinnedAbs = termBuf.listLineNums.length - 3; // 三列置底的第一列
    s._topNum = 150; // 視窗位置 50（序列長 63，body 20）⇒ 置底列在視窗中段
    s._selectedNum = null;
    s._selectedPinnedKey = s._pinnedKeyAt(pinnedAbs);

    s._stepScroll(-20 * 4);
    expect(s._topNum).toBe(146); // 視窗確實往舊文走
    expect(s._selectedNum).toBeNull(); // 選取仍是那篇置底文
    expect(s._selectedPinnedKey).toBe(s._pinnedKeyAt(pinnedAbs));
  });

  test("捲到 buffer 邊、該方向還有更多且已有 in-flight ⇒ 亮「讀取中…」", () => {
    const { s, loading, queue } = setup();
    s._edgeDown = false; // 板尾未確認＝下面還有
    queue.idle = false; // 背景 prefetch 在線
    s._stepScroll(20 * 999);
    expect(loading).toContain(true);
  });
});

describe("onWheelScrollPx（事件層 → 緩動器）", () => {
  const setup = () => {
    const h = demandSession({ numStart: 100, count: 60 });
    h.s._renderMode = "buffer";
    h.s._topNum = 110;
    h.s._selectedNum = 115;
    h.s.getWindowView();
    return h;
  };

  test("距離交給緩動器分幀吃（不是當場瞬移）", () => {
    const { s } = setup();
    s.onWheelScrollPx(100);
    expect(s._scroller.pending()).toBeGreaterThan(0);
    expect(s.scrollFrac()).toBe(0); // 還沒有任何一幀跑過
  });

  test("非 active／frozen 不受理（連緩動器都不建）", () => {
    const frozen = setup();
    frozen.s._renderMode = "frozen";
    frozen.s.onWheelScrollPx(100);
    expect(frozen.s._scroller).toBeNull();
  });
});
