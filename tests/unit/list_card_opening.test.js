// real-input: tests/e2e/offline/mobile_list_cards.offline.spec.js
// 手機列表卡片「開啟中」（P45，docs/mobile.md「列表卡片」）。
//
// 鎖的症狀：
//   1. tap 卡片之後要等 PTT 回文章畫面才有變化；網路慢時看起來像沒點到 ⇒ 開文交易一開始，
//      游標那張卡片（onMouseClick 先把選取移過去）就掛 listCardOpening。
//   2. 交易的每個出口（文章到了、被拒退回、切原生、watchdog）都會關「讀取中」⇒ 開啟中跟著收，
//      不會留在回到列表後的卡片上。
//   3. 只在卡片模式；showStatusHints 關掉就不出現（跟「讀取中…」同一組）；一個 byte 都不多送。
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
    const view = {
      hideCursor() {},
      showCursor() {},
      resetListAccumulation() {},
      flashListHint() {},
      setListLoading() {},
      setListOpening: (on) => opening.push(!!on),
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
    return { s, opening, sent, enqueued };
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
});
