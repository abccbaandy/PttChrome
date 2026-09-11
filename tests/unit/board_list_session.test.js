// 看板列表平滑捲動的 session 守護（src/js/board_list_session.js）。
//
// 三塊：純 reducer 的轉移表、鍵盤白名單（board.c 的同義鍵集合）、以及會送到
// PTT 的交易（抓頁跳號／Enter 進板的本地守門／離開）。
// 捲動數學本身在 list_scroll.test.js 已有守護（兩種列表共用同一組純函式）。
import {
  BoardListSession,
  transitionBoardListSession,
} from "../../src/js/board_list_session";
import { BRD_CMD_PREFIX } from "../../src/js/list_render_owner";

const pad7 = (n) => String(n).padStart(7, " ");
const brdRow = (num, name) =>
  pad7(num) + "  " + String(name).padEnd(13, " ") + "綜合  ｜閒聊｜ 測試看板";
const lineRow = (num) =>
  pad7(num) + "   " + "-".repeat(12) + "      " + "-".repeat(42);
const blockedRow = (num, name) =>
  pad7(num) + "X  " + String(name).padEnd(13, " ") + "[禁入] <目前無法進入此看板>";
const FOOT_FAV =
  "  選擇看板    (a)增加看板 (s)進入已知板名 (y)列出全部 (v/V)已讀/未讀";
const HEADER_NUM =
  "   編號   看  板       類別   中   文   敘   述               人氣 板   主";

// totalRows ＝終端機列數；body 佔 rows-4（＝pttbbs 的 p_lines）。預設 24 列。
function brdScreenRows({
  startNum = 1,
  count = 20,
  bodyRows = null,
  totalRows = 24,
} = {}) {
  const rowTexts = ["【看板列表】 批踢踢實業坊", "[←][q]回上層 [↑↓]選擇", HEADER_NUM];
  const body =
    bodyRows ||
    Array.from({ length: count }, (_, i) => brdRow(startNum + i, "B" + (startNum + i)));
  for (let i = 0; i < totalRows - 4; ++i) rowTexts.push(body[i] || "");
  rowTexts.push(FOOT_FAV);
  return rowTexts;
}

// TermChar 夠用的替身：render 層不參與這支測試，只要 ch/isLeadByte/resetAttr。
const charOf = (ch) => ({ ch, isLeadByte: false, resetAttr() {} });
const rowChars = (text) =>
  Array.from({ length: 80 }, (_, i) => charOf(text[i] || " "));

function makeSession({ prefOn = true, rows = 24 } = {}) {
  window.localStorage.setItem(
    "pttchrome.pref.v1",
    JSON.stringify({ values: { enableBoardListSmoothScroll: prefOn } })
  );
  const enqueued = [];
  const hints = [];
  const core = { conn: { isConnected: true, send() {} } };
  const view = {
    chh: 0, // 沒有 DOM ⇒ 捲動數學一律走「量不到」的分支
    hideCursor() {},
    showCursor() {},
    resetBoardListAccumulation() {},
    flashListHint: (m) => hints.push(m),
    promptListInput: null,
    componentScreen: null,
  };
  let settleListener = null;
  const termBuf = {
    rows,
    cols: 80,
    lines: [],
    brdListLines: [],
    brdListLineNums: [],
    listRenderMode: "native",
    listRenderOwner: null,
    lineChangeds: new Array(rows).fill(false),
    changed: false,
    settleSnapshot: null,
    startedEasyReading: false,
    _rowTexts: new Array(rows).fill(""),
    getRowText(r) {
      return this._rowTexts[r] || "";
    },
    addEventListener(name, fn) {
      if (name === "screenSettled") settleListener = fn;
    },
    notify() {},
    // 餵一幀畫面進 session（模擬 term_buf 的 screenSettled）。
    feed(rowTexts, { curX = 0, curY = 3, changedRows = null } = {}) {
      this._rowTexts = rowTexts;
      this.cur_x = curX;
      this.cur_y = curY;
      this.settleSnapshot = {
        curX,
        curY,
        changedRows: changedRows || new Set([3]),
        cursorMoved: true,
      };
      settleListener();
    },
  };
  const queue = {
    idle: true,
    inFlightKind: null,
    enqueue(cmd) {
      enqueued.push(cmd);
    },
    onSettle() {
      return null;
    },
    flush() {},
    flushPending() {},
    flushPendingKind(prefix) {
      this.pendingKindFlushed = prefix;
    },
    expedite(ms) {
      this.expedited = ms;
    },
    hasKind(prefix) {
      return enqueued.some((c) => (c.kind || "").indexOf(prefix) === 0);
    },
    flushKind() {},
  };
  const s = new BoardListSession(core, view, termBuf, queue);
  return { s, termBuf, queue, enqueued, hints, view };
}

// 把一頁畫面塞進緩衝（term_view.accumulateBoardListLines 在真實路徑上做的事）。
function seedBuffer(termBuf, startNum, count) {
  termBuf.brdListLines = [];
  termBuf.brdListLineNums = [];
  for (let i = 0; i < count; ++i) {
    termBuf.brdListLines.push(rowChars(brdRow(startNum + i, "B" + (startNum + i))));
    termBuf.brdListLineNums.push(startNum + i);
  }
}

const keyEvent = (key, mods = {}) => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
});

afterEach(() => localStorage.clear());

// ---------------------------------------------------------------------------

describe("transitionBoardListSession（純 reducer）", () => {
  const settle = (o) => ({ type: "settle", ctx: "brdlist", ...o });

  test("idle：可 engage 的看板列表 ＋ pref 開著 → active（seed + start-fill）", () => {
    expect(
      transitionBoardListSession("idle", settle({ engageEligible: true }))
    ).toEqual({ next: "active", actions: ["seed", "start-fill"] });
  });

  test("idle：pref 關著就不 engage", () => {
    expect(
      transitionBoardListSession("idle", settle({ engageEligible: false })).next
    ).toBe("idle");
  });

  test("idle：不在本期範圍的看板列表（全部看板／newflag）不 engage", () => {
    expect(
      transitionBoardListSession(
        "idle",
        settle({ ctx: "brdlist-other", engageEligible: true })
      ).next
    ).toBe("idle");
  });

  test("active：同變體的看板列表 → 續抓；換了變體 → 整份重建（編號空間換了）", () => {
    expect(
      transitionBoardListSession("active", settle({ sameVariant: true })).actions
    ).toEqual(["continue-fill"]);
    expect(
      transitionBoardListSession("active", settle({ sameVariant: false })).actions
    ).toEqual(["rebuild"]);
  });

  test("active：進板 → suspended（緩衝留著）；回主功能表 → 收攤回 idle", () => {
    // 進板＝還會從同一個 choose_board 退回來 ⇒ 緩衝與捲動錨留著，
    // 退板時原樣接上（不變量 N6）。主功能表＝真的離開，上一層是另一個編號空間。
    expect(
      transitionBoardListSession("active", settle({ ctx: "article-list" }))
    ).toEqual({ next: "suspended", actions: ["suspend"] });
    expect(transitionBoardListSession("active", settle({ ctx: "menu" }))).toEqual({
      next: "idle",
      actions: ["cleanup"],
    });
  });

  test("suspended：退回同一份清單 → resume-in-place（捲動錨不動）", () => {
    expect(
      transitionBoardListSession(
        "suspended",
        settle({ sameVariant: true, landedSameList: true, engageEligible: true })
      )
    ).toEqual({ next: "active", actions: ["resume-in-place"] });
  });

  test("suspended：落到別份清單（目錄看板遞迴／換變體）→ 整份重建", () => {
    // 分類看板的目錄列 Enter 會遞迴進另一份 choose_board：footer 變體一模一樣、
    // 編號同樣是絕對位置 ⇒ 只比 variant 會把兩份清單混進同一個緩衝。
    for (const o of [
      { sameVariant: true, landedSameList: false },
      { sameVariant: false, landedSameList: true },
    ])
      expect(
        transitionBoardListSession(
          "suspended",
          settle({ ...o, engageEligible: true })
        )
      ).toEqual({ next: "active", actions: ["seed", "start-fill"] });
  });

  test("suspended：板內的一切 settle 都只是 stay", () => {
    for (const ctx of ["article-list", "brdlist-other", "other"])
      expect(
        transitionBoardListSession("suspended", settle({ ctx })).next
      ).toBe("suspended");
  });

  test("suspended：回主功能表 → cleanup；交易在飛時不得插隊", () => {
    expect(
      transitionBoardListSession("suspended", settle({ ctx: "menu" }))
    ).toEqual({ next: "idle", actions: ["cleanup"] });
    // AID 退出前導段行經選單／看板列表時不得被 cleanup 的 flush 打斷（同 functionMode）。
    for (const ctx of ["menu", "brdlist"])
      expect(
        transitionBoardListSession(
          "suspended",
          settle({ ctx, inFlightKind: "aid-escape", engageEligible: true })
        )
      ).toEqual({ next: "suspended", actions: [] });
  });

  test("suspended：pref 關掉／不可 engage → 收攤", () => {
    expect(
      transitionBoardListSession("suspended", { type: "pref-off" })
    ).toEqual({ next: "idle", actions: ["cleanup"] });
    expect(
      transitionBoardListSession(
        "suspended",
        settle({ sameVariant: true, landedSameList: true, engageEligible: false })
      )
    ).toEqual({ next: "idle", actions: ["cleanup"] });
  });

  test("REGRESSION（I10）：active 收到不在本期範圍的看板列表 → 顯性切原生", () => {
    // 在我的最愛按 y 會就地變成「全部看板」（footer 變體換掉、編號空間也換掉）。
    // 沿用舊緩衝繼續畫就是畫錯的清單。
    expect(
      transitionBoardListSession("active", settle({ ctx: "brdlist-other" }))
    ).toEqual({ next: "functionMode", actions: ["enter-native"] });
  });

  test("active：交易在飛／這一幀剛被命令消費 → 中間幀，不得誤降級", () => {
    expect(
      transitionBoardListSession(
        "active",
        settle({ ctx: "other", inFlightKind: "brd-fetch-down" })
      ).next
    ).toBe("active");
    expect(
      transitionBoardListSession("active", settle({ ctx: "other", consumed: true }))
        .next
    ).toBe("active");
  });

  test("functionMode：黏性原生 —— settle 本身不解除 hold，只有情境變換才放開", () => {
    expect(
      transitionBoardListSession("functionMode", settle({ ctx: "brdlist" })).next
    ).toBe("functionMode");
    expect(
      transitionBoardListSession("functionMode", settle({ ctx: "brdlist-other" })).next
    ).toBe("functionMode");
    expect(
      transitionBoardListSession("functionMode", settle({ ctx: "menu" }))
    ).toEqual({ next: "idle", actions: ["cleanup"] });
  });

  test("functionMode：交易在飛時不得收攤（會 flush 掉自己的命令）", () => {
    expect(
      transitionBoardListSession(
        "functionMode",
        settle({ ctx: "menu", inFlightKind: "brd-leave" })
      ).next
    ).toBe("functionMode");
  });

  test("opening：任何 settle 都不轉態（落地由 queue 的 expect 判），鍵一律吞掉", () => {
    expect(transitionBoardListSession("opening", settle({ ctx: "menu" })).next).toBe(
      "opening"
    );
    expect(
      transitionBoardListSession("opening", { type: "key", keyClass: "nav" }).next
    ).toBe("opening");
    expect(
      transitionBoardListSession("opening", { type: "transaction-failed" })
    ).toEqual({ next: "functionMode", actions: ["enter-native"] });
  });

  test("pref 關掉 → 不論在哪個狀態都收攤（idle 時是 no-op）", () => {
    expect(transitionBoardListSession("active", { type: "pref-off" })).toEqual({
      next: "idle",
      actions: ["cleanup"],
    });
    expect(
      transitionBoardListSession("idle", { type: "pref-off" }).actions
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("engage / 收攤", () => {
  test("進到我的最愛 → active，並宣告 buf.listRenderMode 的所有權", () => {
    const { s, termBuf } = makeSession();
    termBuf.feed(brdScreenRows());
    expect(s.state).toBe("active");
    expect(termBuf.listRenderMode).toBe("buffer");
    expect(termBuf.listRenderOwner).toBe("board-list");
  });

  test("pref 關著就不接管（畫面維持原生）", () => {
    const { s, termBuf } = makeSession({ prefOn: false });
    termBuf.feed(brdScreenRows());
    expect(s.state).toBe("idle");
    expect(termBuf.listRenderMode).toBe("native");
  });

  // REGRESSION：設定頁「BBS 終端機大小 → 固定字體大小」的列數是由視窗高度反推
  // （term_size.calcTermSize），可視高 > 480px 就 > 24 列 ⇒ 舊碼的 `rows === 24`
  // 讓整個功能靜默失效（勾了設定完全沒反應）。下界 24 照 mbbsd/term.c:55。
  test("REGRESSION：非 24 列的終端機（固定字體大小模式）照樣接管", () => {
    const { s, termBuf } = makeSession({ rows: 40 });
    expect(s._engageEligible()).toBe(true);
    termBuf.feed(brdScreenRows({ count: 36, totalRows: 40 }), { curY: 3 });
    expect(s.state).toBe("active");
    expect(termBuf.listRenderMode).toBe("buffer");
    expect(termBuf.listRenderOwner).toBe("board-list");
  });

  test("落到主功能表 → 收攤，所有權釋放回原生", () => {
    const { s, termBuf } = makeSession();
    termBuf.feed(brdScreenRows());
    const menu = new Array(24).fill("");
    menu[0] = "【主功能表】 批踢踢實業坊";
    termBuf.feed(menu, { curY: 5 });
    expect(s.state).toBe("idle");
    expect(termBuf.listRenderMode).toBe("native");
    expect(termBuf.listRenderOwner).toBeNull();
  });

  // 看板列表的 header 是**自己的**常數（BRD_HEADER_ROWS，與文章列表的
  // LIST_HEADER_ROWS 同值但語意不同）。滑鼠座標鏈兩種列表共用，所以「render row
  // ↔ body idx」的換算一律走 session 的 headerRows()，不得寫死任一常數。
  test("列號換算走 session 的 headerRows()（不是寫死的常數）", () => {
    const mk = () => {
      const ctx = makeSession();
      ctx.termBuf.feed(brdScreenRows());
      seedBuffer(ctx.termBuf, 1, 20);
      ctx.s._serverNum = ctx.s._selectedNum; // 真游標已同步 ⇒ 開板不必先跳號
      return ctx;
    };
    // baseline：header = 3 ⇒ render row 3 是 body 第 0 項，點下去會開板。
    // （少了這段，下面那條會在「其實根本沒走到換算」的情況下沉默通過。）
    const base = mk();
    expect(base.s.headerRows()).toBe(3);
    base.s.onMouseClick(3, 10);
    expect(base.s.state).toBe("opening");
    expect(base.s._selectedNum).toBe(1);

    // headerRows 換成 4 ⇒ 同一個 render row 落在 header 區，不得開板。
    const moved = mk();
    moved.s.headerRows = () => 4;
    moved.s.onMouseClick(3, 10);
    expect(moved.s.state).toBe("active");
    // row 4 才是 body 第 0 項。
    moved.s.onMouseClick(4, 10);
    expect(moved.s.state).toBe("opening");
    expect(moved.s._selectedNum).toBe(1);
  });

  test("disable()：pref 關掉一律回到原生", () => {
    const { s, termBuf } = makeSession();
    termBuf.feed(brdScreenRows());
    s.disable();
    expect(s.state).toBe("idle");
    expect(termBuf.listRenderMode).toBe("native");
  });
});

// ---------------------------------------------------------------------------

describe("鍵盤白名單（board.c:1751-1840 的同義鍵）", () => {
  // _classifyKey 讀 this._autoResumeEnabled()（A 類鍵的 pref 閘門），所以要給一個
  // 有那支方法的 receiver。預設開＝產品預設值。
  const cls = (key, mods, autoResume = true) =>
    BoardListSession.prototype._classifyKey.call(
      { _autoResumeEnabled: () => autoResume },
      keyEvent(key, mods)
    );

  test("導覽鍵：board.c 的同義鍵集合（PgUp 多一個 'b'、Home 是 '0'）", () => {
    expect(cls("ArrowUp")).toEqual({ class: "nav", op: "up" });
    expect(cls("k")).toEqual({ class: "nav", op: "up" });
    expect(cls("p")).toEqual({ class: "nav", op: "up" });
    expect(cls("j")).toEqual({ class: "nav", op: "down" });
    expect(cls("n")).toEqual({ class: "nav", op: "down" });
    expect(cls("b")).toEqual({ class: "nav", op: "pgup" });
    expect(cls("P")).toEqual({ class: "nav", op: "pgup" });
    expect(cls(" ")).toEqual({ class: "nav", op: "pgdn" });
    expect(cls("N")).toEqual({ class: "nav", op: "pgdn" });
    expect(cls("0")).toEqual({ class: "nav", op: "home" });
    expect(cls("$")).toEqual({ class: "nav", op: "end" });
  });

  test("開／離開：'r'/'l' 也是開，但 'e' **不是**離開（那是 read.c 才有的）", () => {
    expect(cls("Enter").class).toBe("open");
    expect(cls("r").class).toBe("open");
    expect(cls("l").class).toBe("open");
    expect(cls("ArrowLeft").class).toBe("leave");
    expect(cls("q").class).toBe("leave");
    expect(cls("e").class).toBe("passthrough");
  });

  test("1-9 收集跳號；改寫清單／換編號空間的鍵一律 passthrough（回來要整份重建）", () => {
    expect(cls("5")).toEqual({ class: "jump-digit", digit: "5" });
    // `*`（tag all）刻意留在 B 類：它一次翻掉整份清單的 tag 標記，緩衝裡其他頁
    // 會殘留舊標記 ⇒ 必須切原生、回來整份重建。
    for (const k of ["y", "c", "/", "a", "D", "m", "S", "s", "*"])
      expect(cls(k).class).toBe("passthrough");
  });

  test("A 類鍵（t / v / V：board.c 原地重繪）→ native-inplace，全程不切原生", () => {
    // 枚舉即合約（board.c#choose_board）：t 是 fav_tag + fall through KEY_DOWN、
    // v/V 是 brc_toggle_all_read → show_brdlist 原地重畫。三者都不開 prompt、
    // 不換編號空間 ⇒ 走凍結交易。
    for (const k of ["t", "v", "V"]) expect(cls(k).class).toBe("native-inplace");
  });

  test("pref enableListNativeAutoResume 關掉 → A 類鍵整組落回 passthrough（逐位元回到舊行為）", () => {
    for (const k of ["t", "v", "V"]) expect(cls(k, {}, false).class).toBe("passthrough");
  });

  test("送不出 byte 的鍵（F1 / CapsLock）→ ignore，不轉態也不 preventDefault", () => {
    expect(cls("F1").class).toBe("ignore");
    expect(cls("CapsLock").class).toBe("ignore");
  });
});

// ---------------------------------------------------------------------------

describe("本地導覽（游標夾住，不照抄 PTT 的 wrap）", () => {
  function activeSession(count = 40) {
    const { s, termBuf, queue, enqueued, hints } = makeSession();
    termBuf.feed(brdScreenRows());
    seedBuffer(termBuf, 1, count);
    s._edgeUp = true;
    s._edgeDown = true;
    s._selectedNum = 1;
    s._topNum = 1;
    return { s, termBuf, queue, enqueued, hints };
  }

  test("REGRESSION：第一項按 ↑ **停在原地**（board.c 會 wrap 到最後一項）", () => {
    const { s } = activeSession();
    s.onKeyDown(keyEvent("ArrowUp"));
    expect(s._selectedNum).toBe(1);
  });

  test("REGRESSION：第一項按 PgUp 停在第一項（board.c 會 fall-through 到 KEY_END）", () => {
    const { s } = activeSession();
    s.onKeyDown(keyEvent("PageUp"));
    expect(s._selectedNum).toBe(1);
  });

  test("REGRESSION：最後一項按 ↓／PgDn 停在最後（board.c 會回捲到第 1 項）", () => {
    const { s } = activeSession();
    s._selectedNum = 40;
    s._topNum = 21;
    s.onKeyDown(keyEvent("ArrowDown"));
    expect(s._selectedNum).toBe(40);
    s.onKeyDown(keyEvent("PageDown"));
    expect(s._selectedNum).toBe(40);
  });

  test("PgDn 以視口頂為基準往下一整頁（p_lines=20）", () => {
    const { s } = activeSession();
    s.onKeyDown(keyEvent("PageDown"));
    expect(s._selectedNum).toBe(21);
  });

  // 合約變更 2026-09-05（與 list_session 同步）：Home/End 一律走 server 並送
  // 原生鍵。board.c:1768/1830 CONFIRMED —— KEY_END → num = brdnum-1、
  // KEY_HOME/'0' → num = 0。邊界已確認也照送（舊碼在這裡是本地瞬移＋零 byte）。
  test("End／Home 一律送原生鍵交易，不本地跳", () => {
    for (const [key, kind, keys] of [
      ["End", "jump-end", "\x1b[4~"],
      ["Home", "jump-home", "\x1b[1~"]
    ]) {
      const { s, enqueued } = activeSession();
      s._edgeUp = true;
      s._edgeDown = true;
      s.onKeyDown(keyEvent(key));
      expect(enqueued.map((c) => c.kind)).toEqual([BRD_CMD_PREFIX + kind]);
      expect([enqueued[0].keys, enqueued[0].fullRepaint]).toEqual([keys, true]);
    }
  });

  // REGRESSION 2026-09-05（與 list_session 同一個洞）：舊碼
  // `if (!this._queue.idle) return;` 讓背景抓頁在飛時整個按鍵靜默消失。
  test("背景抓頁在飛時 End 仍送得出去（舊碼靜默丟棄 → 紅）", () => {
    const { s, queue, enqueued } = activeSession();
    queue.idle = false;
    queue.inFlightKind = BRD_CMD_PREFIX + "fetch-down";
    s.onKeyDown(keyEvent("End"));
    expect(enqueued.map((c) => c.kind)).toEqual([BRD_CMD_PREFIX + "jump-end"]);
    // 前景優先：排隊中的抓頁丟掉、在飛的那筆縮短等待（不 flush，保持配對）。
    expect(queue.pendingKindFlushed).toBe(BRD_CMD_PREFIX + "fetch");
    expect(queue.expedited).toBe(250);
  });

  test("連按 End 只排一筆", () => {
    const { s, queue, enqueued } = activeSession();
    queue.idle = false;
    s.onKeyDown(keyEvent("End"));
    s.onKeyDown(keyEvent("End"));
    expect(enqueued.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------

// 遠跳（Home/End）期間 evict 的樞紐必須是落點那一側 —— 與 ListSession 同構的同一個
// bug（2026-09-10 回報「好讀列表 Home/End 有時失效」，錄製檔 ptt-debug-20260910-021827）。
// 樞紐若還是「跳之前的視口頂」，evictListBuffer 的「砍離樞紐最遠的那一端」正好把剛
// 落地的那一頁砍掉（緩衝吃滿 MAX_LIST_ROWS 時）。
describe("evictPivot（遠跳期間改用落點樞紐）", () => {
  test("沒有遠跳在飛 → 視口優先，退路才是選取", () => {
    const { s } = makeSession();
    s._topNum = 115;
    s._selectedNum = 100;
    expect(s.evictPivot()).toBe(115);
    s._topNum = null;
    expect(s.evictPivot()).toBe(100);
  });

  test("遠跳在飛 → 與 prunePivot 同一個覆寫（null 留板尾、1 留第 1 項）", () => {
    const { s } = makeSession();
    s._topNum = 115;
    s._selectedNum = 100;
    s._prunePivotOverride = null; // brd-jump-end 在飛
    expect(s.evictPivot()).toBe(null);
    expect(s.prunePivot()).toBe(null);
    s._prunePivotOverride = 1; // brd-jump-home 在飛
    expect(s.evictPivot()).toBe(1);
    s._prunePivotOverride = undefined;
    expect(s.evictPivot()).toBe(115);
  });
});

describe("抓頁（跳號一腿，不用會 wrap 的 PgUp/PgDn）", () => {
  test("往下抓：跳到緩衝底端的下一號，帶 \\f 保證有回應", () => {
    const { s, termBuf, enqueued } = makeSession();
    termBuf.feed(brdScreenRows());
    seedBuffer(termBuf, 1, 20);
    s._fillPages = 0;
    s._enqueueFetch(1, "key");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].keys).toBe("21\r");
    expect(enqueued[0].fullRepaint).toBe(true);
    expect(enqueued[0].kind.startsWith(BRD_CMD_PREFIX)).toBe(true);
  });

  test("往下抓卻停在原地 ⇒ 板尾（search_num 夾住），設 edgeDown 且不再送", () => {
    const { s, termBuf, enqueued } = makeSession();
    termBuf.feed(brdScreenRows());
    seedBuffer(termBuf, 1, 20);
    s._enqueueFetch(1, "key");
    const cmd = enqueued[0];
    // 落點編號 20 ＝ base，代表 21 被夾回 20 ⇒ 到底了
    const facts = { brd: { parked: true, cursorNum: 20 } };
    expect(cmd.expect(null, facts)).toBe(true);
    cmd.onDone();
    expect(s._edgeDown).toBe(true);
  });

  test("已經在第 1 項時往上不送任何 byte，直接確認上緣", () => {
    const { s, termBuf, enqueued } = makeSession();
    termBuf.feed(brdScreenRows());
    seedBuffer(termBuf, 1, 20);
    s._enqueueFetch(-1, "key");
    expect(enqueued).toHaveLength(0);
    expect(s._edgeUp).toBe(true);
  });

  test("REGRESSION：落在最後一頁時，往下到邊之後要**換方向往上**補", () => {
    // `choose_board` 的 `num` 是 static（board.c:1646）⇒ PTT 記得上次離開的位置，
    // 進來常常直接落在最後一頁。只往下填的話那一腿一次就撞到板尾，背景填充就此
    // 結束，畫面只剩落點那幾列 ＋ 一整片空白列（2026-09-03 live 實測 buffered=4）。
    const { s, termBuf, enqueued } = makeSession();
    termBuf.feed(brdScreenRows({ startNum: 21, count: 4 }), { curY: 3 });
    seedBuffer(termBuf, 21, 4); // 落點頁＝板尾那 4 項
    expect(s.state).toBe("active");
    s._fillTarget = 200;
    s._fillPages = 0;
    s._edgeUp = false;
    s._edgeDown = false;
    s._topNum = 21;
    s._maybeFill();
    // 第一腿往下 → 被 search_num 夾住 ⇒ 板尾
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].keys).toBe("25\r");
    // 落點停在 24（＝base）⇒ search_num 夾住了，也就是板尾
    enqueued[0].expect(null, { brd: { parked: true, cursorNum: 24 } });
    enqueued[0].onDone();
    expect(s._edgeDown).toBe(true);
    // **關鍵**：緊接著要有第二腿往上，否則上面整份清單永遠補不回來
    expect(enqueued).toHaveLength(2);
    expect(enqueued[1].keys).toBe("20\r");
    expect(enqueued[1].kind).toBe(BRD_CMD_PREFIX + "fetch-up");
  });

  test("兩端都確認之後就停手（不得無限往返）", () => {
    const { s, termBuf, enqueued } = makeSession();
    termBuf.feed(brdScreenRows({ startNum: 1, count: 20 }));
    seedBuffer(termBuf, 1, 20);
    s._edgeUp = true;
    s._edgeDown = true;
    s._fillTarget = 200;
    s._maybeFill();
    expect(enqueued).toHaveLength(0);
  });

  test("抓頁逾時是良性的：當作到邊、不切模式", () => {
    const { s, termBuf, enqueued } = makeSession();
    termBuf.feed(brdScreenRows());
    seedBuffer(termBuf, 1, 20);
    s._enqueueFetch(1, "fill");
    enqueued[0].onFail("timeout");
    expect(s._edgeDown).toBe(true);
    expect(s.state).toBe("active");
    expect(termBuf.listRenderMode).toBe("buffer");
  });
});

// ---------------------------------------------------------------------------

describe("Enter 進看板", () => {
  function ready() {
    const ctx = makeSession();
    ctx.termBuf.feed(brdScreenRows());
    seedBuffer(ctx.termBuf, 1, 20);
    ctx.s._selectedNum = 3;
    ctx.s._serverNum = 3; // 真游標已同步 ⇒ 不必先跳號
    return ctx;
  }

  test("一般看板：送 Enter，落地後收攤讓另一邊接手", () => {
    const { s, termBuf, enqueued } = ready();
    s.onKeyDown(keyEvent("Enter"));
    expect(s.state).toBe("opening");
    expect(termBuf.listRenderMode).toBe("frozen");
    const cmd = enqueued[enqueued.length - 1];
    expect(cmd.keys).toBe("\r");
    // 任何一幀 settle 都是回應：落點可能是文章列表、也可能是進了資料夾／群組看板
    // 的另一份看板列表，一律收攤後由內容重新決定。
    expect(cmd.expect()).toBe(true);
    cmd.onDone();
    expect(s.state).toBe("idle");
    expect(termBuf.listRenderMode).toBe("native");
  });

  test("REGRESSION：分隔線列不得送 Enter（board.c 直接 break ⇒ 零回應會凍畫面）", () => {
    const { s, termBuf, enqueued, hints } = ready();
    termBuf.brdListLines[2] = rowChars(lineRow(3));
    s.onKeyDown(keyEvent("Enter"));
    expect(enqueued).toHaveLength(0);
    expect(s.state).toBe("active");
    expect(termBuf.listRenderMode).toBe("buffer");
    expect(hints.length).toBe(1); // 吞掉不得無聲
  });

  test("REGRESSION：禁入／隱板列同樣不得送 Enter（HasBoardPerm 為假，零回應）", () => {
    const { s, enqueued, termBuf, hints } = ready();
    termBuf.brdListLines[2] = rowChars(blockedRow(3, "SYSOP"));
    s.onKeyDown(keyEvent("Enter"));
    expect(enqueued).toHaveLength(0);
    expect(s.state).toBe("active");
    expect(hints.length).toBe(1);
  });

  test("真游標落後選取時先跳號同步（choose_board 的 num 是 static，會決定落點）", () => {
    const { s, enqueued } = ready();
    s._serverNum = 1;
    s._selectedNum = 7;
    s.onKeyDown(keyEvent("Enter"));
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].keys).toBe("7\r");
    expect(enqueued[0].kind).toBe(BRD_CMD_PREFIX + "open-sync-jump");
    // 同步腿落地後才送 Enter（同 tick 直送會踩 pttbbs typeahead）
    enqueued[0].onDone();
    expect(enqueued[1].keys).toBe("\r");
  });
});

// ---------------------------------------------------------------------------

describe("離開（←/q）", () => {
  test("先同步真游標再送 ←，落地後收攤（上層可能是主功能表或另一份看板列表）", () => {
    const { s, termBuf, enqueued } = makeSession();
    termBuf.feed(brdScreenRows());
    seedBuffer(termBuf, 1, 20);
    s._selectedNum = 5;
    s._serverNum = 1;
    s.onKeyDown(keyEvent("ArrowLeft"));
    expect(enqueued[0].keys).toBe("5\r");
    enqueued[0].onDone();
    expect(enqueued[1].keys).toBe("\x1b[D");
    enqueued[1].onDone();
    expect(s.state).toBe("idle");
    expect(termBuf.listRenderMode).toBe("native");
  });
});

// ---------------------------------------------------------------------------

describe("佇列所有權（與 ListSession 共用同一條 CommandQueue）", () => {
  test("in-flight 不是 brd- 開頭時**不得**呼叫 queue.onSettle", () => {
    const { s, termBuf, queue } = makeSession();
    let calls = 0;
    queue.onSettle = () => {
      calls++;
      return null;
    };
    queue.inFlightKind = "prefetch-down"; // ListSession 的命令
    termBuf.feed(brdScreenRows());
    expect(calls).toBe(0);
    queue.inFlightKind = BRD_CMD_PREFIX + "fetch-down";
    termBuf.feed(brdScreenRows());
    expect(calls).toBe(1);
    expect(s).toBeTruthy();
  });

  test("收攤只清自己的命令（flushKind），不得整條 flush 掉別人的", () => {
    const { s, termBuf, queue } = makeSession();
    const flushed = [];
    queue.flushKind = (p) => flushed.push(p);
    queue.flush = () => flushed.push("ALL");
    termBuf.feed(brdScreenRows());
    const menu = new Array(24).fill("");
    menu[0] = "【主功能表】 批踢踢實業坊";
    termBuf.feed(menu, { curY: 5 });
    expect(flushed).toEqual([BRD_CMD_PREFIX]);
    expect(s.state).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// 非導覽操作完成後自動回平滑捲動（pref enableListNativeAutoResume，2026-09-03）
// ---------------------------------------------------------------------------
// 與 list_session 同一套設計；差別是回復＝**重新 seed**（_enterNative 已把緩衝
// 整份丟掉），而且**不可以走「回 idle 等下一個 settle」**——畫面靜止時不會再有
// settle，那會卡死。

describe("reducer：functionMode × resume-probe（看板列表）", () => {
  const probe = (extra = {}) => ({
    type: "resume-probe",
    ctx: "brdlist",
    holdReason: "passthrough",
    inFlightKind: null,
    consumed: false,
    sameVariant: false,
    engageEligible: true,
    withinResumeGrace: false,
    ...extra,
  });

  test("條件全中 → 直接回 active 並重新 seed（不得先回 idle）", () => {
    expect(transitionBoardListSession("functionMode", probe())).toEqual({
      next: "active",
      actions: ["seed", "start-fill"],
    });
  });

  test.each([
    ["external hold（AID／長推文停泊）", { holdReason: "external" }],
    ["沒有停泊", { holdReason: null }],
    ["命令還在線上", { inFlightKind: BRD_CMD_PREFIX + "native-key" }],
    ["畫面不是可接管的看板列表", { ctx: "brdlist-other" }],
    ["回到選單", { ctx: "menu" }],
    ["pref 關／非 24 列", { engageEligible: false }],
  ])("%s → stay 鏡像", (_label, extra) => {
    expect(transitionBoardListSession("functionMode", probe(extra))).toEqual({
      next: "functionMode",
      actions: [],
    });
  });
});

describe("reducer：回復後的寬限窗（不變量 N4，看板列表）", () => {
  const settle = (extra = {}) => ({
    type: "settle",
    ctx: "other",
    inFlightKind: null,
    consumed: false,
    sameVariant: true,
    engageEligible: true,
    holdReason: null,
    withinResumeGrace: false,
    ...extra,
  });
  test("grace 內的殘餘幀 → stay（不得 banner／不得切原生）", () => {
    expect(
      transitionBoardListSession("active", settle({ withinResumeGrace: true }))
    ).toEqual({ next: "active", actions: [] });
  });
  test("grace 外 → 照舊自癒降級", () => {
    expect(transitionBoardListSession("active", settle())).toEqual({
      next: "functionMode",
      actions: ["enter-native"],
    });
  });
});

describe("靜置探針（看板列表 session）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function parked() {
    const h = makeSession();
    h.termBuf.feed(brdScreenRows());
    expect(h.s.state).toBe("active");
    // 按一個 B 類鍵（`/` 中文關鍵字搜尋）→ 切原生鏡像
    h.s.onKeyDown(keyEvent("/"));
    h.enqueued[h.enqueued.length - 1].onDone &&
      h.enqueued[h.enqueued.length - 1].onDone();
    expect(h.s.state).toBe("functionMode");
    expect(h.s._holdReason).toBe("passthrough");
    return h;
  }

  test("原生操作完成、畫面靜下來 → 自動重新 engage（seed）", () => {
    const h = parked();
    h.termBuf._rowTexts = brdScreenRows();
    h.termBuf.cur_x = 0;
    h.termBuf.cur_y = 3;
    vi.advanceTimersByTime(400);
    expect(h.s.state).toBe("active");
    expect(h.s._renderMode).toBe("buffer");
    expect(h.hints.some((m) => m.includes("平滑捲動"))).toBe(true);
  });

  test("使用者還在打字（又送了 byte）→ 重新計時，不搶畫面", () => {
    const h = parked();
    h.termBuf._rowTexts = brdScreenRows();
    h.termBuf.cur_x = 0;
    h.termBuf.cur_y = 3;
    vi.advanceTimersByTime(200);
    h.s.noteNativeInput();
    vi.advanceTimersByTime(200);
    expect(h.s.state).toBe("functionMode");
    vi.advanceTimersByTime(100);
    expect(h.s.state).toBe("active");
  });

  test("external hold（beginExternalNavigation）→ 永不自動解除（不變量 N1）", () => {
    const h = makeSession();
    h.termBuf.feed(brdScreenRows());
    h.s.beginExternalNavigation();
    expect(h.s._holdReason).toBe("external");
    expect(h.s._resumeProbe).toBe(null);
    vi.advanceTimersByTime(5000);
    expect(h.s.state).toBe("functionMode");
  });

  test("pref 關掉 → 一次探針都沒排，停在原生（逐位元回到舊行為）", () => {
    const h = makeSession(); // makeSession 自己會寫 pref ⇒ 關掉要在它之後
    h.termBuf.feed(brdScreenRows());
    window.localStorage.setItem(
      "pttchrome.pref.v1",
      JSON.stringify({
        values: {
          enableBoardListSmoothScroll: true,
          enableListNativeAutoResume: false,
        },
      })
    );
    h.s.onKeyDown(keyEvent("/"));
    expect(h.s._resumeProbe).toBe(null);
    vi.advanceTimersByTime(5000);
    expect(h.s.state).toBe("functionMode");
  });
});

describe("B 類 passthrough 的命令形狀", () => {
  test("代送的鍵尾附 \\f（PTT 忽略該鍵時是零 byte 零 settle，否則要空等 3s）", () => {
    const h = makeSession();
    h.termBuf.feed(brdScreenRows());
    seedBuffer(h.termBuf, 1, 20);
    h.s._selectedNum = 5;
    h.s._serverNum = 5; // 已同步 ⇒ 免 sync 腿
    h.enqueued.length = 0;
    h.s.onKeyDown(keyEvent("/"));
    const cmd = h.enqueued[0];
    expect(cmd.kind).toBe(BRD_CMD_PREFIX + "native-key");
    expect(cmd.keys).toBe("/");
    expect(cmd.fullRepaint).toBe(true);
    expect(cmd.timeoutMs).toBe(3000); // 不凍畫面 ⇒ 維持長窗（撐住 settle 吸收）
  });
});

describe("A 類鍵的凍結交易（看板列表：t / v / V）", () => {
  test("按 v → frozen（不是 native）、緩衝保住、命令是 brd-native-inplace", () => {
    const h = makeSession();
    h.termBuf.feed(brdScreenRows());
    seedBuffer(h.termBuf, 1, 20);
    h.s._selectedNum = 5;
    h.s._serverNum = 5; // 已同步 ⇒ 直送鍵
    h.enqueued.length = 0;
    const e = keyEvent("v");
    h.s.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(h.s._renderMode).toBe("frozen");
    expect(h.s._holdReason).toBe(null); // 不是原生小旅行
    expect(h.termBuf.brdListLineNums.length).toBe(20); // 緩衝沒被丟掉
    const cmd = h.enqueued[0];
    expect(cmd.kind).toBe(BRD_CMD_PREFIX + "native-inplace");
    expect(cmd.keys).toBe("v");
    expect(cmd.fullRepaint).toBe(true);
  });

  test("落地採用真落點、回 buffer，錨不動（不變量 N6）", () => {
    const h = makeSession();
    h.termBuf.feed(brdScreenRows());
    seedBuffer(h.termBuf, 1, 20);
    h.s._selectedNum = 5;
    h.s._serverNum = 5;
    h.s._topNum = 3;
    h.enqueued.length = 0;
    h.s.onKeyDown(keyEvent("t"));
    const cmd = h.enqueued[0];
    const landed = {
      brd: { parked: true, cursorNum: 6, variant: h.s._variant, topNum: 1 },
      rows: 24,
      curX: 0,
      curY: 4,
      rowTexts: brdScreenRows()
    };
    expect(cmd.expect(null, landed)).toBe(true);
    cmd.onDone();
    expect(h.s.state).toBe("active");
    expect(h.s._renderMode).toBe("buffer");
    expect(h.s._selectedNum).toBe(6);
    expect(h.s._topNum).toBe(3); // 錨不動
  });

  test("逾時 → 顯性降級原生＋banner（不變量 N8）", () => {
    const h = makeSession();
    h.termBuf.feed(brdScreenRows());
    seedBuffer(h.termBuf, 1, 20);
    h.s._selectedNum = 5;
    h.s._serverNum = 5;
    h.enqueued.length = 0;
    h.s.onKeyDown(keyEvent("V"));
    h.hints.length = 0;
    h.enqueued[0].onFail("timeout");
    expect(h.s._renderMode).toBe("native");
    expect(h.s._holdReason).toBe("passthrough");
    expect(h.hints.some((m) => m.includes("逾時"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 進板 → 退板：視野不得被 server 那一頁重新釘住
//
// 使用者回報（與文章列表好讀同一個症狀，錄製檔 ptt-debug-20260911-113150）：
// 用滑鼠把某個看板捲到視口最下面，進去再退出，它會跳回畫面中間。
// 根因：舊行為在進板時 `_reset()` 把緩衝整份丟掉，退板再 `seed` —— 錨變成
// server 落地頁的頂列，而 `head = (num / p_lines) * p_lines` 是 20 列分頁
// （board.c:1710-1716）⇒ 位置一律被吸附回分頁邊界。
// ---------------------------------------------------------------------------
describe("進板 → 退板：緩衝與捲動錨跨畫面保留", () => {
  // 文章列表那一幀（boardListContextKind 的指紋：row0 有《》、footer 有「文章選讀」）。
  const articleListRows = () => {
    const rows = new Array(24).fill("");
    rows[0] = " 【板主:none】看板《C_Chat》";
    rows[23] = "  文章選讀  (y)回應(X)推文";
    return rows;
  };

  // 進板前：緩衝 1..60、使用者把視口捲到頂＝21（序列位置 20）、游標 40。
  const engaged = () => {
    const h = makeSession();
    seedBuffer(h.termBuf, 1, 60);
    h.s.state = "active";
    h.s._variant = "fav";
    h.s._renderMode = "buffer";
    h.s._topNum = 21;
    h.s._scrollFrac = 9;
    h.s._selectedNum = 40;
    h.s._serverNum = 40;
    h.s._edgeUp = true;
    h.s._edgeDown = true;
    return h;
  };

  test("進板（非交易路徑）→ suspended，緩衝／錨／變體原封不動", () => {
    const { s, termBuf } = engaged();
    termBuf.feed(articleListRows(), { curY: 3 });

    expect(s.state).toBe("suspended");
    expect(s._renderMode).toBe("native"); // 畫面所有權已交還
    expect(termBuf.brdListLineNums.length).toBe(60); // 緩衝沒被丟掉
    expect(s._topNum).toBe(21);
    expect(s._scrollFrac).toBe(9);
    expect(s._variant).toBe("fav");
    expect(s._serverNum).toBeNull(); // 板內游標會亂跑 ⇒ 不確定
  });

  test("退板回到同一份清單 → 錨不動，只採用 server 游標", () => {
    const { s, termBuf } = engaged();
    termBuf.feed(articleListRows(), { curY: 3 });
    // server 退板重繪：`num` 是 static（board.c:1646）⇒ 停在剛讀的 40，
    // head 對齊到 [21, 40] 那一頁 —— 舊行為就是被這一頁的頂列釘住。
    termBuf.feed(brdScreenRows({ startNum: 21, count: 20 }), { curY: 3 + 19 });

    expect(s.state).toBe("active");
    expect(s._renderMode).toBe("buffer");
    expect(termBuf.brdListLineNums.length).toBe(60); // 緩衝沒被丟掉重建
    expect(s._topNum).toBe(21); // 沒被 server 落地頁改掉
    expect(s._scrollFrac).toBe(9);
    expect(s._selectedNum).toBe(40); // 游標採用落點
    expect(s._serverNum).toBe(40);
  });

  test("落到別份清單（同變體、同編號、板名不同）→ 整份重建，不得混進舊緩衝", () => {
    // 分類看板的目錄列 Enter 會遞迴進另一份 choose_board：footer 變體一樣、
    // 編號一樣是 1-based 絕對位置 ⇒ 只比編號就會別名。
    const { s, termBuf } = engaged();
    termBuf.feed(articleListRows(), { curY: 3 });
    const other = brdScreenRows({
      bodyRows: Array.from({ length: 20 }, (_, i) => brdRow(21 + i, "OTHER" + i)),
    });
    termBuf.feed(other, { curY: 3 + 19 });

    expect(s.state).toBe("active");
    // 舊緩衝整份丟掉（_resetBuffer）——不得把別份清單 merge 進來。
    expect(termBuf.brdListLineNums.length).toBe(0);
    expect(s._topNum).toBe(21); // seed 採用落地頁頂列（本來就該重新錨定）
    expect(s._selectedNum).toBe(40);
  });

  test("從板內一路回到主功能表 → 收攤，緩衝丟掉", () => {
    const { s, termBuf } = engaged();
    termBuf.feed(articleListRows(), { curY: 3 });
    const menu = new Array(24).fill("");
    menu[0] = "【主功能表】 批踢踢實業坊";
    termBuf.feed(menu, { curY: 3 });

    expect(s.state).toBe("idle");
    expect(termBuf.brdListLineNums.length).toBe(0);
    expect(s._topNum).toBeNull();
  });

  test("開板交易落在文章列表 → suspend；落在別的畫面（目錄遞迴等）→ 照舊 reset", () => {
    for (const [ctx, expected] of [
      ["article-list", "suspended"],
      ["brdlist", "idle"],
      ["menu", "idle"],
    ]) {
      const { s, enqueued } = engaged();
      s._beginOpen();
      const cmd = enqueued.find((c) => c.kind === BRD_CMD_PREFIX + "open-board");
      expect(cmd).toBeTruthy();
      cmd.expect(null, { ctx });
      cmd.onDone();
      expect(s.state).toBe(expected);
    }
  });
});

describe("suspended：外部序列化導覽不得動我們的緩衝", () => {
  test("板內的 AID 導覽呼叫 beginExternalNavigation → 早退（同 idle）", () => {
    const h = makeSession();
    seedBuffer(h.termBuf, 1, 60);
    h.s.state = "suspended";
    h.s._variant = "fav";
    h.s._topNum = 21;

    h.s.beginExternalNavigation();

    expect(h.s.state).toBe("suspended");
    expect(h.termBuf.brdListLineNums.length).toBe(60);
    expect(h.s._topNum).toBe(21);
  });
});
