// 跳過進板畫面（src/js/board_note_skip.js）。鎖的是：
//   - 只有「看板列表上的進板鍵／選擇看板 prompt 的 ⏎」之後才 arm；畫面沒出現就一個鍵都不送
//     （bnote_lastbid：同連線第二次進板沒有進板畫面，預先送鍵會落進文章列表）；
//   - 動畫送 q（pmore 唯一不可遮罩的鍵），pressanykey 送空白，pager 送 ←；
//   - 送鍵後舊動畫幀不算回應（不重送 —— 重送的鍵會落進文章列表）；
//   - 使用者在 arm 期間自己按了鍵 ⇒ 解除，不搶；pref 關 ⇒ 完全不動。
// 錄製檔實錄：動畫公告播 18 秒才出現「請按任意鍵繼續」（使用者回報）。
import { CommandQueue } from "../../src/js/command_queue";
import {
  BoardNoteSkip,
  boardEntryArms,
  boardNoteDecision,
  isBoardEntryKey,
  ARM_MS,
  KEY_LEFT,
} from "../../src/js/board_note_skip";
import { classifyListScreen } from "../../src/js/list_session";
import { serializedOpHint } from "../../src/js/serialized_op_gate";

const ROWS = 24;
const COLS = 80;

function screen(rows, opts = {}) {
  const r = Array.from({ length: ROWS }, (_, i) => rows[i] || "");
  return {
    rows: r,
    curX: opts.curX ?? COLS - 1,
    curY: opts.curY ?? ROWS - 1,
    reversed: !!opts.reversed,
  };
}

const BOARD_LIST = screen(
  {
    0: "【看板列表】                       批踢踢實業坊",
    3: ">     1 ˇAndroid      手機 ◎[Android] 綜合討論區              爆!",
  },
  { curX: 0, curY: 3 }
);
const MAIN_MENU = screen({ 0: "【主功能表】                       批踢踢實業坊" }, { curX: 0, curY: 10 });
const SELECT_PROMPT = screen(
  { 0: "【 選擇看板 】", 1: "請輸入看板名稱(按空白鍵自動搜尋)：Android" },
  { curX: 40, curY: 1 }
);
// do_select 只清 row 0/1，下面還是主選單、底列是主選單 footer（日期＋線上人數，
// parseListRow 認得它 ⇒ classifyListScreen 判 'menu'）。板名回顯那一幀長這樣。
const SELECT_ECHO_OVER_MENU = screen(
  {
    0: "【 選擇看板 】",
    1: "請輸入看板名稱(按空白鍵自動搜尋):Stock",
    13: "                      (B)oards       【 看板列表 】",
    23: " 主選單   【 寒露 】   10/8 週四 21:35 | xxxxxxxxxxx | 線上26572人     (h)說明",
  },
  { curX: 39, curY: 1 }
);
const MOVIE = screen({
  5: "              ██ ● ██ ● ██",
  10: "           █ █ ██Ａｎｄｒｏｉｄ██ █ █",
  23: " >>> 動畫播放中... 可按 q, Ctrl-C 或其它任意鍵停止",
});
const INTERACTIVE_MOVIE = screen({
  5: "  互動選單",
  23: " >> 請輸入選項:  (互動式動畫播放中，可按 q 或 Ctrl-C 中斷)",
});
const MOVIE_PAUSED = screen({
  5: "  art",
  23: " >>> 暫停播放動畫，請按任意鍵繼續或 q 中斷。 <<<",
});
const PAUSE = screen({
  5: "  歡迎來到本板",
  23: " ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄ 請按任意鍵繼續 ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
});
// PMORE_AUTO_EXIT 多頁公告：沒有 footer、游標停末列。
const AUTOEXIT_PAGER = screen({ 2: "  本板規", 10: "  一、禁止…" });
const VMSG_ERROR = screen({ 23: " ◆ 您沒有進入此看板的權限！                        [按任意鍵繼續]" });
const ARTICLE_LIST = (() => {
  const rows = {
    0: "【板主:someone】                    看板《Android》",
    1: "[←]離開 [→]閱讀 [Ctrl-P]發表文章 [d]刪除 [z]精華區 [i]看板資訊/設定",
    2: "   編號    日 期 作  者       文  章  標  題                       人氣:99",
    23: " 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面",
  };
  for (let i = 0; i < 20; ++i) {
    const n = String(48366 + i).padStart(7);
    rows[3 + i] = (i === 0 ? ">" : " ") + n.slice(1) + " +  10/08 someone      □ [問題] 標題 " + i;
  }
  return screen(rows, { curX: 0, curY: 3, reversed: true });
})();

function makeHarness(initial, { prefOff = false } = {}) {
  vi.useFakeTimers();
  if (prefOff) {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => JSON.stringify({ values: { skipBoardEntryScreen: false } }),
      },
    });
  }
  const listeners = [];
  const buf = {
    rows: ROWS,
    cols: COLS,
    cur: initial,
    cur_x: initial.curX,
    cur_y: initial.curY,
    settleSnapshot: null,
    getRowText(r) {
      return this.cur.rows[r] || "";
    },
    isUnicolor() {
      return this.cur.reversed;
    },
    addEventListener(name, fn) {
      if (name === "screenSettled") listeners.push(fn);
    },
  };
  const sent = [];
  let skip = null;
  const queue = new CommandQueue({
    send: (d) => {
      sent.push(d);
      // 真的 App：queue.send → conn.send → telnet._sendEscaped → onDataSent。
      skip.noteSent(d);
    },
  });
  const core = { aidNavigation: { active: false }, commandQueue: queue };
  skip = new BoardNoteSkip(core, {}, buf, queue);
  core.boardNoteSkip = skip;
  // 使用者／別的 session 送出的 bytes（同一個送出出口）。
  const userSend = (bytes) => {
    sent.push(bytes);
    skip.noteSent(bytes);
  };
  // server 畫好一幀並靜止：list_session 先跑 queue.onSettle（真 App 的 listener 順序），
  // 然後才輪到我們的 listener。
  // server 資料到達（App.onData → noteRecv）。settle() 自帶一次；單獨呼叫用來模擬
  // 「回應已到、還沒 settle」。
  const recv = () => skip.noteRecv();
  // beforeOurs：同一個 settle 裡排在我們前面的 listener（例如 board_list_session 在
  // 這裡送出開板鍵）。
  const settle = (next, beforeOurs, { withRecv = true } = {}) => {
    if (withRecv) recv();
    buf.cur = next;
    buf.cur_x = next.curX;
    buf.cur_y = next.curY;
    const snap = {
      changedRows: new Set(Array.from({ length: ROWS }, (_, i) => i)),
      cursorMoved: true,
      curX: next.curX,
      curY: next.curY,
    };
    buf.settleSnapshot = snap;
    const facts = {
      rowTexts: next.rows.slice(),
      rows: ROWS,
      curX: next.curX,
      curY: next.curY,
      row0Reversed: next.reversed,
      row2Reversed: next.reversed,
      changedRows: snap.changedRows,
    };
    const cls = classifyListScreen(facts);
    facts.kind = cls.kind;
    facts.boardName = cls.boardName;
    queue.onSettle(snap, facts);
    if (beforeOurs) beforeOurs();
    for (const fn of listeners) fn();
  };
  const settleThen = (next, fn) => settle(next, fn);
  return { buf, queue, sent, skip, core, userSend, settle, settleThen, recv };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("純函式", () => {
  test("進板鍵：⏎／→／r／l，以及滑鼠點列（↑↓…⏎），尾端 \\f 不影響", () => {
    for (const k of ["\r", "\n", "\x1b[C", "\x1bOC", "r", "l", "\r\f", "\x1b[B\x1b[B\r", "\x1b[A\r"])
      expect(isBoardEntryKey(k)).toBe(true);
    for (const k of ["1\r", "\x1b[D", " ", "q", "abc\r", "\x1b[B", "\f"])
      expect(isBoardEntryKey(k)).toBe(false);
  });

  test("arm 只認看板列表／選擇看板 prompt", () => {
    expect(boardEntryArms(BOARD_LIST.rows, "\r")).toBe(true);
    expect(boardEntryArms(SELECT_PROMPT.rows, "\r")).toBe(true);
    expect(boardEntryArms(SELECT_PROMPT.rows, "r")).toBe(false); // 在輸入欄打字
    expect(boardEntryArms(MAIN_MENU.rows, "\r")).toBe(false);
    // 文章列表的 → 是開文章，不是進板
    expect(boardEntryArms(ARTICLE_LIST.rows, "\x1b[C")).toBe(false);
  });

  test("畫面決策：動畫 q、暫停中的動畫也是 q、pressanykey 空白、pager ←", () => {
    const f = (s) => ({ rowTexts: s.rows, rows: ROWS, curX: s.curX, curY: s.curY, row0Reversed: s.reversed, row2Reversed: s.reversed });
    expect(boardNoteDecision(f(MOVIE))).toMatchObject({ action: "skip", key: "q" });
    expect(boardNoteDecision(f(INTERACTIVE_MOVIE))).toMatchObject({ action: "skip", key: "q" });
    // 暫停畫面也寫著「請按任意鍵繼續」，但那裡任意鍵＝繼續播，必須 q。
    expect(boardNoteDecision(f(MOVIE_PAUSED))).toMatchObject({ action: "skip", key: "q" });
    expect(boardNoteDecision(f(PAUSE))).toMatchObject({ action: "skip", key: " " });
    expect(boardNoteDecision(f(AUTOEXIT_PAGER))).toMatchObject({ action: "skip", key: KEY_LEFT });
    expect(boardNoteDecision(f(ARTICLE_LIST))).toEqual({ action: "landed" });
    expect(boardNoteDecision(f(BOARD_LIST))).toEqual({ action: "landed" });
    // 進板失敗的 vmsg 要留給使用者看
    expect(boardNoteDecision(f(VMSG_ERROR))).toEqual({ action: "wait" });
  });
});

describe("完整流程", () => {
  test("錄製檔情境：看板列表 ⏎ → 動畫公告 ⇒ 送 q，落在文章列表即解除", () => {
    const h = makeHarness(BOARD_LIST);
    h.userSend("\r");
    expect(h.skip.armed).toBe(true);
    expect(h.skip.active).toBe(true);
    h.settle(MOVIE);
    expect(h.sent).toEqual(["\r", "q\f"]);
    expect(h.skip.busy).toBe(true);
    expect(serializedOpHint(h.core)).toBe("略過進板畫面中，請稍候…");
    // 送鍵之前就在路上的舊動畫幀：不是回應，絕不再送第二鍵。
    h.settle(MOVIE);
    h.settle(MOVIE);
    expect(h.sent).toEqual(["\r", "q\f"]);
    h.settle(ARTICLE_LIST);
    expect(h.skip.active).toBe(false);
    expect(serializedOpHint(h.core)).toBe(null);
    // 落地後的文章列表操作完全不受影響
    h.settle(ARTICLE_LIST);
    expect(h.sent).toEqual(["\r", "q\f"]);
  });

  test("一般公告：pressanykey ⇒ 空白", () => {
    const h = makeHarness(BOARD_LIST);
    h.userSend("\x1b[C");
    h.settle(PAUSE);
    h.settle(ARTICLE_LIST);
    expect(h.sent).toEqual(["\x1b[C", " \f"]);
    expect(h.skip.active).toBe(false);
  });

  test("多頁公告（無 footer）⇒ ← 離開 pmore，再對 pressanykey 送空白", () => {
    const h = makeHarness(BOARD_LIST);
    h.userSend("\r");
    h.settle(AUTOEXIT_PAGER);
    h.settle(PAUSE);
    h.settle(ARTICLE_LIST);
    expect(h.sent).toEqual(["\r", KEY_LEFT + "\f", " \f"]);
    expect(h.skip.active).toBe(false);
  });

  test("主功能表 s 的選擇看板 prompt ⏎ 也會 arm", () => {
    const h = makeHarness(SELECT_PROMPT);
    h.userSend("\r");
    h.settle(PAUSE);
    expect(h.sent).toEqual(["\r", " \f"]);
  });

  // ptt-debug-20261008-215452：看板列表平滑捲動的開板 `\r` 是在 sync-jump 回應的
  // settle 裡（queue.done → 排下一個命令）送出的，我們的 listener 排在同一個 settle 的
  // 最後 ⇒ 看到的還是舊的看板列表，曾被判成已落地而立刻解除（arm 與 disarm 同一毫秒）。
  test("在 settle 裡送出的進板鍵：同一個 settle 的舊畫面不算落地", () => {
    const h = makeHarness(BOARD_LIST);
    h.settleThen(BOARD_LIST, () => h.userSend("\r"));
    expect(h.skip.active).toBe(true);
    h.recv();
    h.settle(MOVIE);
    expect(h.sent).toEqual(["\r", "q\f"]);
  });

  // live 2026-10-08：PTT 先回板名回顯（prompt 疊在主選單上）、下一個封包才是進板畫面。
  // 回顯幀的底列是主選單 footer ⇒ kind 'menu'，曾被當成「已落地」而提早解除。
  test("選擇看板的回顯幀（底列仍是主選單 footer）不算落地", () => {
    const h = makeHarness(SELECT_PROMPT);
    h.userSend("Stock\r");
    h.settle(SELECT_ECHO_OVER_MENU);
    expect(h.skip.active).toBe(true);
    h.settle(PAUSE);
    expect(h.sent).toEqual(["Stock\r", " \f"]);
  });

  test("沒有進板畫面（同連線第二次進板）⇒ 一個鍵都不送", () => {
    const h = makeHarness(BOARD_LIST);
    h.userSend("\r");
    h.settle(ARTICLE_LIST);
    expect(h.sent).toEqual(["\r"]);
    expect(h.skip.active).toBe(false);
  });

  test("進板失敗的 vmsg 不收；逾時後解除", () => {
    const h = makeHarness(BOARD_LIST);
    h.userSend("\r");
    h.settle(VMSG_ERROR);
    expect(h.sent).toEqual(["\r"]);
    vi.advanceTimersByTime(ARM_MS + 1);
    expect(h.skip.active).toBe(false);
  });
});

describe("停手條件", () => {
  test("pref 關 ⇒ 不 arm、不送", () => {
    const h = makeHarness(BOARD_LIST, { prefOff: true });
    h.userSend("\r");
    expect(h.skip.active).toBe(false);
    h.settle(MOVIE);
    expect(h.sent).toEqual(["\r"]);
  });

  test("arm 期間使用者自己按了鍵 ⇒ 解除，不搶", () => {
    const h = makeHarness(BOARD_LIST);
    h.userSend("\r");
    h.userSend(" ");
    expect(h.skip.active).toBe(false);
    h.settle(PAUSE);
    expect(h.sent).toEqual(["\r", " "]);
  });

  test("文章列表按 b 看進板畫面 ⇒ 不收（使用者要看）", () => {
    const h = makeHarness(ARTICLE_LIST);
    h.userSend("b");
    h.settle(PAUSE);
    expect(h.sent).toEqual(["b"]);
  });

  test("AID 跳文進行中 ⇒ 進板畫面歸 aid_navigation，不 arm", () => {
    const h = makeHarness(BOARD_LIST);
    h.core.aidNavigation.active = true;
    h.userSend("\r");
    expect(h.skip.active).toBe(false);
  });

  test("代按的鍵沒有效果（畫面一直是 pager）⇒ 有上限，不無限送", () => {
    const h = makeHarness(BOARD_LIST);
    h.userSend("\r");
    for (let i = 0; i < 10; ++i) h.settle(AUTOEXIT_PAGER);
    const machine = h.sent.filter((s) => s !== "\r");
    expect(machine.length).toBeLessThanOrEqual(4);
    expect(h.skip.busy).toBe(false);
  });
});
