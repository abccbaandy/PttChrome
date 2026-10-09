// 一鍵登出（src/js/logout_session.js）。鎖的是「送出去的 byte 序列」與「什麼時候停手」：
//   - 走 PTT 正常流程：（逃回主選單）→ G⏎ → y⏎ → 任意鍵，連線由 server 關；
//     **從不自己關線**（session 根本拿不到 conn，只有 queue）。
//   - 每一步以畫面內容確認才送下一鍵；認不出的畫面停手，不盲送 G / y。
//   - 已在主選單不送 ←（主選單的 ← 只把游標移到 Goodbye）。
// pttbbs 出處見 logout_session.js 檔頭（menu.c:1354、xyz.c:59-85、mbbsd.c:187-209）。
import {
  LogoutSession,
  logoutEscapeKey,
  isGoodbyeConfirm,
  isAnyKeyPause,
  KEY_GOODBYE,
  KEY_CONFIRM,
  MAX_ESCAPE_STEPS,
} from "../../src/js/logout_session";
import { serializedOpHint } from "../../src/js/serialized_op_gate";

const ROWS = 24;
const blank = () => Array.from({ length: ROWS }, () => "");

function screen({ row0 = "", last = "", secondLast = "", input = false, extra = "" } = {}) {
  const rows = blank();
  rows[0] = row0;
  rows[1] = extra;
  rows[ROWS - 2] = secondLast;
  rows[ROWS - 1] = last;
  return { rows, input };
}

const ARTICLE = screen({
  row0: " 作者  someone (某人)                                  看板  Test",
  last: "  瀏覽 第 1/2 頁 ( 50%)  目前顯示: 第 01~22 行  (y)回應(X%)推文(h)說明(←)離開",
});
const LIST = screen({
  row0: "【板主:someone】                  看板《Test》",
  last: " 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面",
});
const MAIN_MENU = screen({ row0: "【主功能表】                    批踢踢實業坊" });
const CONFIRM = screen({
  row0: "【主功能表】                    批踢踢實業坊",
  secondLast: "您確定要離開【 批踢踢實業坊 】嗎(Y/N)？[N] ",
  input: true,
});
const STAY = screen({
  row0: "",
  last: " ◆ 此次停留時間: 0 小時 12 分                                  [按任意鍵繼續]",
});
// pttbbs mbbsd/bbs.c#do_reply：getdata(b_lines - 1, …) ⇒ prompt 在倒數第 2 列，
// 最後一列仍是文章的 pmore 狀態列（看起來像「在文章裡」，但游標在輸入欄）。
const REPLY_PROMPT = screen({
  row0: ARTICLE.rows[0],
  secondLast: "▲ 回應至 (F)看板 (M)作者信箱 (B)二者皆是 (Q)取消？[F] ",
  last: ARTICLE.rows[ROWS - 1],
  input: true,
});

function makeHarness(initial) {
  const buf = {
    rows: ROWS,
    cols: 80,
    cur: initial,
    getRowText(r) {
      return this.cur.rows[r] || "";
    },
    isCursorOnInputField() {
      return !!this.cur.input;
    },
  };
  const sent = [];
  const queue = {
    cmds: [],
    enqueue(cmd) {
      this.cmds.push(cmd);
      sent.push(cmd.keys);
    },
    get current() {
      return this.cmds[this.cmds.length - 1];
    },
  };
  const hints = [];
  const core = {
    isConnected: () => true,
    autoLogin: { stop: vi.fn() },
    easyReading: { _enterFunctionMode: vi.fn() },
    listSession: { beginExternalNavigation: vi.fn() },
    boardListSession: { beginExternalNavigation: vi.fn() },
  };
  const view = { flashListHint: (m) => hints.push(m) };
  const session = new LogoutSession(core, view, buf, queue);
  core.logout = session;
  // server 回了一幀 next：設好畫面，交給 in-flight 命令的 expect 判。
  const respond = (next) => {
    const cmd = queue.current;
    buf.cur = next;
    const facts = { rowTexts: next.rows.slice(), rows: ROWS };
    const r = cmd.expect(null, facts);
    if (r) cmd.onDone(r);
    return r;
  };
  // 逾時／probe 之後仍不符 ⇒ queue 回報 miss。
  const miss = () => queue.current.onFail("miss");
  return { buf, queue, sent, hints, core, session, respond, miss };
}

describe("純函式", () => {
  test("主選單 ⇒ 不送逃生鍵", () => {
    expect(logoutEscapeKey({ row0: MAIN_MENU.rows[0] })).toEqual({ menu: true });
  });
  test("輸入欄 ⇒ ^C；按任意鍵 ⇒ 空白；其餘 ⇒ ←", () => {
    expect(logoutEscapeKey({ row0: "x", lastRowText: "", cursorOnInputField: true })).toEqual({ bytes: "\x03" });
    expect(logoutEscapeKey({ row0: "x", lastRowText: STAY.rows[ROWS - 1] })).toEqual({ bytes: " " });
    expect(logoutEscapeKey({ row0: "x", lastRowText: "隨便" })).toEqual({ bytes: "\x1b[D" });
  });
  test("離站確認列在最後兩列之一", () => {
    expect(isGoodbyeConfirm(CONFIRM.rows)).toBe(true);
    expect(isGoodbyeConfirm(MAIN_MENU.rows)).toBe(false);
  });
  test("停留時間橫幅是 pressanykey", () => {
    expect(isAnyKeyPause(STAY.rows[ROWS - 1])).toBe(true);
    expect(isAnyKeyPause(LIST.rows[ROWS - 1])).toBe(false);
  });
});

describe("完整流程", () => {
  test("文章 → 列表 → 主選單 → G⏎ → y⏎ → 空白，最後一鍵等 server 關線", () => {
    const h = makeHarness(ARTICLE);
    expect(h.session.start()).toBe(true);
    expect(h.core.autoLogin.stop).toHaveBeenCalled();
    expect(h.core.easyReading._enterFunctionMode).toHaveBeenCalled();
    expect(h.core.listSession.beginExternalNavigation).toHaveBeenCalled();
    expect(serializedOpHint(h.core)).toBe("登出中，請稍候…");

    h.respond(LIST);
    h.respond(MAIN_MENU);
    h.respond(CONFIRM);
    h.respond(STAY);
    expect(h.sent).toEqual(["\x1b[D", "\x1b[D", KEY_GOODBYE, KEY_CONFIRM, " "]);
    // 逃生步驟附 \f 取整幀；最後一鍵不 probe（線會被關，\f 沒有意義）。
    expect(h.queue.cmds[0].fullRepaint).toBe(true);
    expect(h.queue.current.probe).toBe(false);
    expect(h.session.awaitingClose).toBe(true);

    expect(h.session.onConnectionClosed()).toBe(true);
    expect(h.session.active).toBe(false);
    expect(serializedOpHint(h.core)).toBe(null);
  });

  test("已在主選單 ⇒ 第一鍵就是 G⏎（不送 ←）", () => {
    const h = makeHarness(MAIN_MENU);
    h.session.start();
    expect(h.sent).toEqual([KEY_GOODBYE]);
  });

  test("停在輸入欄 ⇒ 先送 ^C 取消，不是 ←", () => {
    const h = makeHarness(REPLY_PROMPT);
    h.session.start();
    expect(h.sent).toEqual(["\x03"]);
  });

  test("站方多一個 pressanykey ⇒ 再送一次空白", () => {
    const h = makeHarness(MAIN_MENU);
    h.session.start();
    h.respond(CONFIRM);
    h.respond(STAY);
    h.respond(STAY);
    expect(h.sent).toEqual([KEY_GOODBYE, KEY_CONFIRM, " ", " "]);
  });
});

describe("停手條件（不盲送）", () => {
  test("畫面沒變（編輯器裡 ← 只移游標）⇒ 失敗停手，不送 G", () => {
    const h = makeHarness(ARTICLE);
    h.session.start();
    expect(h.respond(ARTICLE)).toBe(false);
    h.miss();
    expect(h.sent).toEqual(["\x1b[D"]);
    expect(h.session.active).toBe(false);
    expect(h.hints.some((m) => m.indexOf("登出失敗") === 0)).toBe(true);
  });

  test("一直退不回主選單 ⇒ 到上限停手", () => {
    const h = makeHarness(ARTICLE);
    h.session.start();
    for (let i = 0; i < MAX_ESCAPE_STEPS + 2 && h.session.active; ++i) {
      h.respond(screen({ row0: "郵件選單 " + i, extra: String(i) }));
    }
    expect(h.session.active).toBe(false);
    expect(h.sent.length).toBe(MAX_ESCAPE_STEPS);
    expect(h.sent).not.toContain(KEY_GOODBYE);
  });

  test("G⏎ 之後沒出現確認列 ⇒ 不送 y", () => {
    const h = makeHarness(MAIN_MENU);
    h.session.start();
    expect(h.respond(MAIN_MENU)).toBe(false);
    h.miss();
    expect(h.sent).toEqual([KEY_GOODBYE]);
    expect(h.session.active).toBe(false);
  });

  test("確認列文字對、但游標不在輸入欄 ⇒ 不送 y", () => {
    const h = makeHarness(MAIN_MENU);
    h.session.start();
    expect(h.respond({ ...CONFIRM, input: false })).toBe(false);
  });

  test("沒連線 ⇒ 不開始", () => {
    const h = makeHarness(MAIN_MENU);
    h.core.isConnected = () => false;
    expect(h.session.start()).toBe(false);
    expect(h.sent).toEqual([]);
  });

  test("中途斷線（不是在等關線）⇒ 不算登出", () => {
    const h = makeHarness(ARTICLE);
    h.session.start();
    expect(h.session.onConnectionClosed()).toBe(false);
    // 之後佇列被清（onFlushed）不再冒出失敗提示。
    h.queue.current.onFlushed();
    expect(h.hints.some((m) => m.indexOf("登出失敗") === 0)).toBe(false);
  });
});
