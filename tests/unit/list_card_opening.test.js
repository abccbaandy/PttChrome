// real-input: tests/e2e/offline/mobile_list_cards.offline.spec.js
// 手機列表卡片「開啟中」（P45，docs/mobile.md「列表卡片」）。
//
// 鎖的症狀：
//   1. tap 卡片之後要等 PTT 回文章畫面才有變化；網路慢時看起來像沒點到 ⇒ 開文交易一開始，
//      游標那張卡片（onMouseClick 先把選取移過去）就掛 listCardOpening。
//   2. 交易的每個出口（文章到了、被拒退回、切原生、watchdog）都會關「讀取中」⇒ 開啟中跟著收，
//      不會留在回到列表後的卡片上。
//   3. 只在卡片模式；showStatusHints 關掉就不出現（跟「讀取中…」同一組）；一個 byte 都不多送。
//   4. 列表忙時點的那一下（P47）排隊時，標的是**被點的那張**（凍結交易中游標常不在那裡），
//      作廢（按鍵、對不上、離開）就收；交易出口關「讀取中」時還在排隊的話不收（交給補開判定）。
import { LIST_CARD_OPENING_CLASS, withListOpening } from "../../src/js/cursor_highlight";
import { TermView } from "../../src/js/term_view";
import { ListSession } from "../../src/js/list_session";
import { LIST_HEADER_ROWS } from "../../src/js/list_window";
import { LIST_TITLE_COL_START } from "../../src/js/comment_parse";

describe("withListOpening", () => {
  test("開啟中 ⇒ 標游標列，底色樣式照舊疊上", () => {
    expect(withListOpening(4, "b2", { opening: true, listCursorRow: 6 })).toEqual({
      row: 6,
      cls: "b2 " + LIST_CARD_OPENING_CLASS,
    });
    // 底色關掉（cls 空字串）也要標
    expect(withListOpening(-1, "", { opening: true, listCursorRow: 6 })).toEqual({
      row: 6,
      cls: LIST_CARD_OPENING_CLASS,
    });
  });
  test("沒在開啟、或沒有游標列 ⇒ 原樣", () => {
    expect(withListOpening(4, "b2", { opening: false, listCursorRow: 6 })).toEqual({ row: 4, cls: "b2" });
    expect(withListOpening(4, "b2", { opening: true, listCursorRow: -1 })).toEqual({ row: 4, cls: "b2" });
    expect(withListOpening(4, "b2", { opening: true, listCursorRow: null })).toEqual({ row: 4, cls: "b2" });
  });

  test("指定了被點的那一列（P47 排隊中）⇒ 標那一列，不標游標列", () => {
    expect(withListOpening(4, "b2", { opening: true, listCursorRow: 6, openingRow: 9 })).toEqual({
      row: 9,
      cls: "b2 " + LIST_CARD_OPENING_CLASS,
    });
    expect(withListOpening(4, "b2", { opening: true, listCursorRow: -1, openingRow: 9 }).row).toBe(9);
    expect(withListOpening(4, "b2", { opening: true, listCursorRow: 6, openingRow: -1 }).row).toBe(6);
  });
});

describe("TermView.setListOpening", () => {
  const makeView = ({ listCards = true, showStatusHints, renderMode = "frozen" } = {}) => {
    const v = Object.create(TermView.prototype);
    const calls = [];
    v.componentScreen = { setCursorHighlight: (h) => calls.push(h) };
    v.buf = {
      listRenderMode: renderMode,
      pageState: 2,
      cur_y: 0,
      nowHighlight: -1,
      useMouseBrowsing: true,
      highlightCursor: true,
      isCursorOnInputField: () => false,
    };
    v.listCards = listCards;
    v.showStatusHints = showStatusHints;
    v.keyboardCursorHighlight = true;
    v.cursorRowBackground = true;
    v.highlightBG = 2;
    v._listCursorRow = 7;
    v._listHoverRow = -1;
    return { v, last: () => calls[calls.length - 1], calls };
  };

  test("卡片模式：開 ⇒ 游標卡片多一個 class；關 ⇒ 回到一般底色", () => {
    const { v, last } = makeView();
    v.setListOpening(true);
    expect(last()).toMatchObject({ row: 7, cls: "b2 " + LIST_CARD_OPENING_CLASS });
    v.setListOpening(false);
    expect(last()).toMatchObject({ row: 7, cls: "b2" });
  });

  test("帶列號（P47 排隊中）⇒ 標那張卡片；換成游標列（真的開文）也會重標", () => {
    const { v, last } = makeView();
    v.setListOpening(true, 4);
    expect(last()).toMatchObject({ row: 4, cls: "b2 " + LIST_CARD_OPENING_CLASS });
    v.setListOpening(true);
    expect(last()).toMatchObject({ row: 7, cls: "b2 " + LIST_CARD_OPENING_CLASS });
    v.setListOpening(false);
    expect(last()).toMatchObject({ row: 7, cls: "b2" });
  });

  test("不是卡片模式、或狀態提示關掉 ⇒ 不標", () => {
    for (const opts of [{ listCards: false }, { showStatusHints: false }]) {
      const { v, calls } = makeView(opts);
      v.setListOpening(true);
      expect(calls).toEqual([]);
      expect(!!v._listOpening).toBe(false);
    }
  });

  test("已經離開列表好讀（文章畫面）⇒ 就算旗標還沒收也不標", () => {
    const { v, last } = makeView({ renderMode: "native" });
    v.buf.pageState = 3;
    v.useEasyReadingMode = true;
    v.setListOpening(true);
    expect(String(last().cls || "")).not.toContain(LIST_CARD_OPENING_CLASS);
  });
});

describe("ListSession：開文交易開始就標、每個出口都收", () => {
  const rowOf = (text) => text.split("").map((c) => ({ ch: c, isLeadByte: false }));
  function makeSession() {
    const opening = [];
    const marks = [];
    const hints = [];
    const view = {
      hideCursor() {},
      showCursor() {},
      resetListAccumulation() {},
      flashListHint: (msg) => hints.push(msg),
      setListLoading() {},
      setListOpening: (on, row) => {
        opening.push(!!on);
        marks.push([!!on, row == null ? null : row]);
      },
      blacklist: new Set(),
      titleBlacklist: [],
      mouseListClickStart: "title",
    };
    const listLines = [];
    const listLineNums = [];
    for (let i = 0; i < 8; ++i) {
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
      getRowText: () => "",
      isUnicolor: () => false,
      cur_x: 0,
      cur_y: 0,
      addEventListener() {},
      notify() {},
    };
    const sent = [];
    const enqueued = [];
    const queue = {
      idle: true,
      inFlightKind: null,
      flush() {},
      flushPending() {},
      flushPendingKind() {},
      hasKind: () => false,
      enqueue: (cmd) => enqueued.push(cmd),
      onSettle() {},
    };
    const core = { conn: { isConnected: true, send: (d) => sent.push(d) } };
    const s = new ListSession(core, view, termBuf, queue);
    s.state = "active";
    s._renderMode = "buffer";
    s._edgeUp = true;
    s._edgeDown = true;
    s._selectedNum = 101;
    s._topNum = 101;
    return { s, opening, marks, hints, sent, enqueued, view };
  }

  test("點卡片 ⇒ 開；交易結束（關「讀取中」）⇒ 收；不多送任何 byte", () => {
    const { s, opening, sent, enqueued } = makeSession();
    s.onMouseClick(LIST_HEADER_ROWS + 2, LIST_TITLE_COL_START + 5);
    expect(s.state).toBe("opening");
    expect(opening).toEqual([true]);
    expect(sent).toEqual([]);
    expect(enqueued.map((c) => c.keys)).toEqual(["103\r"]);
    s._setLoading(false);
    expect(opening[opening.length - 1]).toBe(false);
  });

  test("交易進行中再點 ⇒ 不重設（不閃）", () => {
    const { s, opening } = makeSession();
    s.onMouseClick(LIST_HEADER_ROWS + 2, LIST_TITLE_COL_START + 5);
    s.onMouseClick(LIST_HEADER_ROWS + 3, LIST_TITLE_COL_START + 5);
    expect(opening).toEqual([true]);
  });

  describe("忙時點的那一下（P47）：排隊的那張卡片先標開啟中", () => {
    const rowOf = (text) => text.split("").map((c) => ({ ch: c, isLeadByte: false }));
    const LINE = (num, author, title) =>
      String(num).padStart(7) + "    " + " 9/01 " + author.padEnd(13) + "□" + title;
    const ROW = LIST_HEADER_ROWS + 2;
    function busy() {
      const t = makeSession();
      t.s.state = "functionMode";
      t.s._renderMode = "frozen";
      t.s._boardName = "Test";
      const shown = [];
      shown[ROW] = rowOf(LINE(103, "alice", "[閒聊] 被點的那篇"));
      t.view._listWindowLines = shown;
      return t;
    }

    test("凍結交易中點卡片 ⇒ 記著，標被點的那張；不送任何 byte", () => {
      const { s, marks, sent, enqueued } = busy();
      s.onMouseClick(ROW, LIST_TITLE_COL_START + 5);
      expect(s._pendingClick).toMatchObject({ num: 103 });
      expect(marks[marks.length - 1]).toEqual([true, ROW]);
      expect(sent).toEqual([]);
      expect(enqueued).toEqual([]);
    });

    test("使用者按了別的鍵（作廢）⇒ 收", () => {
      const { s, marks } = busy();
      s.onMouseClick(ROW, LIST_TITLE_COL_START + 5);
      s.cancelPendingClick();
      expect(marks[marks.length - 1]).toEqual([false, null]);
    });

    test("交易出口關「讀取中」時還在排隊 ⇒ 不收；交易結束對不上（moved）⇒ 收", async () => {
      const { s, marks, hints } = busy();
      s.onMouseClick(ROW, LIST_TITLE_COL_START + 5);
      s._setLoading(false);
      await Promise.resolve();
      expect(s._pendingClick).not.toBeNull(); // 還在 functionMode ⇒ wait
      expect(marks[marks.length - 1]).toEqual([true, ROW]);
      s.state = "active";
      s._renderMode = "buffer";
      s._flushPendingClick(); // 103 那列的作者不是 alice ⇒ moved
      expect(s._pendingClick).toBeNull();
      expect(marks[marks.length - 1]).toEqual([false, null]);
      expect(hints[hints.length - 1]).toContain("不在原處");
    });

    test("點到認不出的列（不記）⇒ 先前排隊的標記也收掉", () => {
      const { s, marks, view } = busy();
      s.onMouseClick(ROW, LIST_TITLE_COL_START + 5);
      view._listWindowLines[ROW + 1] = rowOf("        ");
      s.onMouseClick(ROW + 1, LIST_TITLE_COL_START + 5);
      expect(s._pendingClick).toBeNull();
      expect(marks[marks.length - 1]).toEqual([false, null]);
    });

    test("交易剛結束、補開判定還沒跑就又點到開不了的地方 ⇒ 排隊那張的標記不會卡住", () => {
      const { s, marks, enqueued } = busy();
      s.onMouseClick(ROW, LIST_TITLE_COL_START + 5);
      s.state = "active";
      s._renderMode = "buffer";
      s.onMouseClick(0, LIST_TITLE_COL_START + 5); // header：不開
      expect(s._pendingClick).toBeNull();
      expect(marks[marks.length - 1]).toEqual([false, null]);
      expect(enqueued).toEqual([]);
    });
  });
});
