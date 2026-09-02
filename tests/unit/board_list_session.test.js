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

function brdScreenRows({ startNum = 1, count = 20, bodyRows = null } = {}) {
  const rowTexts = ["【看板列表】 批踢踢實業坊", "[←][q]回上層 [↑↓]選擇", HEADER_NUM];
  const body =
    bodyRows ||
    Array.from({ length: count }, (_, i) => brdRow(startNum + i, "B" + (startNum + i)));
  for (let i = 0; i < 20; ++i) rowTexts.push(body[i] || "");
  rowTexts.push(FOOT_FAV);
  return rowTexts;
}

// TermChar 夠用的替身：render 層不參與這支測試，只要 ch/isLeadByte/resetAttr。
const charOf = (ch) => ({ ch, isLeadByte: false, resetAttr() {} });
const rowChars = (text) =>
  Array.from({ length: 80 }, (_, i) => charOf(text[i] || " "));

function makeSession({ prefOn = true } = {}) {
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
    rows: 24,
    cols: 80,
    lines: [],
    brdListLines: [],
    brdListLineNums: [],
    listRenderMode: "native",
    listRenderOwner: null,
    lineChangeds: new Array(24).fill(false),
    changed: false,
    settleSnapshot: null,
    startedEasyReading: false,
    _rowTexts: new Array(24).fill(""),
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
    flushPendingKind() {},
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

  test("active：落到文章列表／主功能表 → 收攤回 idle（畫面交給另一邊）", () => {
    for (const ctx of ["article-list", "menu"]) {
      expect(transitionBoardListSession("active", settle({ ctx }))).toEqual({
        next: "idle",
        actions: ["cleanup"],
      });
    }
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

  test("functionMode：黏性原生 —— 還在看板列表就繼續鏡像，只有情境變換才放開", () => {
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
  const cls = (key, mods) =>
    BoardListSession.prototype._classifyKey.call({}, keyEvent(key, mods));

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

  test("1-9 收集跳號；改寫清單的鍵一律 passthrough（回來要整份重建）", () => {
    expect(cls("5")).toEqual({ class: "jump-digit", digit: "5" });
    for (const k of ["y", "c", "/", "a", "t", "D", "m", "S", "s", "v", "*"])
      expect(cls(k).class).toBe("passthrough");
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

  test("End／Home 在邊界未確認時改送交易，不本地跳", () => {
    const { s, enqueued } = activeSession();
    s._edgeDown = false;
    s.onKeyDown(keyEvent("End"));
    expect(enqueued.map((c) => c.kind)).toEqual([BRD_CMD_PREFIX + "jump-end"]);
    expect(enqueued[0].keys).toBe("99999999\r");
  });
});

// ---------------------------------------------------------------------------

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
