// Unit tests for AidNavigation (src/js/aid_navigation.js): the serialized
// native-key sequence behind an AID link click. Drives a REAL CommandQueue
// (fake send + vitest fake timers) and feeds settle facts by hand — the same
// harness style as command_queue.test.js / list_session.test.js.

import { CommandQueue } from "../../src/js/command_queue";
import { AidNavigation } from "../../src/js/aid_navigation";
import { subjectOfListText } from "../../src/js/list_session";

vi.useFakeTimers();

// Minimal facts object (shape of list_session._collectFacts).
function facts(kind, over = {}) {
  return {
    kind,
    boardName: null,
    cursorRowNum: null,
    rows: 24,
    rowTexts: new Array(24).fill(""),
    curX: 0,
    curY: 0,
    ...over
  };
}

// pmore footer part3 = the currstat projection AidNavigation branches on
// (mbbsd/more.c#common_pmore_footer_handler; see string_util.parsePagerFooterContext).
// Reading-article status row (string_util.parseStatusRow shape).
const STATUS_ROW =
  "  瀏覽 第 1/2 頁 ( 45%)  目前顯示: 第 1~23 行  (y)回應(X%)推文(h)說明(←)離開 ";
// currstat == RMAIL：站內信。實錄 ptt-debug-20260813 的末列。
const MAIL_STATUS_ROW =
  "  瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~18 行  (y)回信 (h)說明 (←/q)離開 ";
// part3 被 part1+part2 擠掉：分不出 currstat（單向推論 → 走安全路徑）。
const FOOTERLESS_STATUS_ROW =
  "  瀏覽 第 12345/12345 頁 (100%)  目前顯示: 第 271589~271611 行        ";
// 進板畫面收尾的 pressanykey（同 term_buf.setPageState 認的字面）。
const PRESS_ANY_KEY_ROW = "                              請按任意鍵繼續";

// 一個 24 列畫面：mark 用來讓相鄰兩張畫面的「整螢幕簽章」不同（退出流程判定
// 「← 真的退了一層」的依據）。
function screen({ row0 = "", last = "", mark = "" } = {}) {
  const rowTexts = new Array(24).fill("");
  rowTexts[0] = row0;
  rowTexts[5] = mark;
  rowTexts[23] = last;
  return rowTexts;
}

const MAIN_MENU_SCREEN = screen({
  row0: "【主功能表】",
  mark: "  (M)ail         【 私人信件區 】",
  last: "[8/13 星期四 0:30] 線上24963人, 我是someuser        [呼叫器]打開 "
});

function makeHarness({
  listState = "suspended",
  footer = STATUS_ROW,
  // 返回錨點的兩個來源（預設 null＝既有測試的行為完全不變：沒有錨點就沒有返回）
  listAnchor = null,
  articleBoard = null,
  // 捲動位置（像素）＋行高：錨點記的是「行索引」= scrollTop / chh
  scrollTop = null,
  chh = 20
} = {}) {
  const sent = [];
  const queue = new CommandQueue({ send: d => sent.push(d) });
  const hints = [];
  const backButton = { shown: false, label: null, cb: null };
  const view = {
    flashListHint: (msg, ms) => hints.push(msg),
    _articleBoard: articleBoard,
    mainDisplay: scrollTop == null ? null : { scrollTop },
    chh,
    showBackButton(label, cb) {
      backButton.shown = true;
      backButton.label = label;
      backButton.cb = cb;
    },
    hideBackButton() {
      backButton.shown = false;
    }
  };
  // termBuf 是「當前原生畫面」：AidNavigation 用 getRowText 讀末列判 currstat，
  // 並在起手時取整螢幕簽章（CLAUDE.md：讀畫面一律用 buf.getRowText）。
  const termBuf = {
    startedEasyReading: true,
    rows: 24,
    cols: 80,
    rowTexts: screen({ last: footer, mark: "文章內文" }),
    getRowText(row) {
      return this.rowTexts[row] || "";
    }
  };
  const core = {
    easyReading: {
      enterFunctionModeCalls: 0,
      restoreCalls: [],
      _enterFunctionMode() {
        this.enterFunctionModeCalls++;
      },
      requestScrollRestore(lineIndex) {
        this.restoreCalls.push(lineIndex);
      }
    },
    listSession: {
      state: listState,
      beginCalls: 0,
      anchor: listAnchor,
      currentAnchor() {
        return this.anchor;
      },
      beginExternalNavigation() {
        this.beginCalls++;
        // 真實行為：_enterFunctionMode() 清掉 _boardName/_serverNum，所以之後
        // 再問就沒有錨點了 —— 守護「錨點必須先擷取」這條順序不變量。
        this.anchor = null;
      }
    }
  };
  const nav = new AidNavigation(core, view, termBuf, queue);
  return { nav, queue, sent, hints, view, termBuf, core, backButton };
}

const settle = (queue, f) => queue.onSettle({}, f);

describe("AidNavigation", () => {
  test("happy path: s board ⏎ (from inside the article) → # aid ⏎ → ⏎, active toggles, mirrors entered", () => {
    const { nav, queue, sent, core, hints } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    expect(nav.active).toBe(true);
    expect(core.easyReading.enterFunctionModeCalls).toBe(1);
    expect(core.listSession.beginCalls).toBe(1);
    // Board jump sent immediately — s works from inside the article, no
    // leave-article step (fullRepaint appends \f).
    expect(sent).toEqual(["sAndroid\r\f"]);
    // Board landing: name must match case-insensitively.
    settle(queue, facts("clean-list", { boardName: "android" }));
    expect(sent[1]).toBe("#1gIeu-3A\r\f");
    settle(
      queue,
      facts("clean-list", { boardName: "android", cursorRowNum: 123, curY: 10 })
    );
    expect(sent[2]).toBe("\r\f");
    settle(queue, facts("article"));
    expect(nav.active).toBe(false);
    expect(queue.idle).toBe(true);
    // The 15s "跳至…" progress banner must be replaced by a short confirmation
    // on success (regression: it lingered long into the opened article).
    expect(hints[hints.length - 1]).toContain("已跳至");
  });

  test("no board → refuses to start, nothing sent", () => {
    const { nav, sent, hints } = makeHarness();
    nav.start("1gIeu-3A", null);
    expect(nav.active).toBe(false);
    expect(sent).toEqual([]);
    expect(hints.some(h => h.includes("看板"))).toBe(true);
  });

  test("not in an open post (startedEasyReading false) → ignored", () => {
    const { nav, sent, termBuf } = makeHarness();
    termBuf.startedEasyReading = false;
    nav.start("1gIeu-3A", "Android");
    expect(nav.active).toBe(false);
    expect(sent).toEqual([]);
  });

  test("re-entrant start while active is ignored", () => {
    const { nav, sent } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    nav.start("2AbCdEf0", "C_Chat");
    expect(sent).toEqual(["sAndroid\r\f"]);
  });

  test("idle list session is not disturbed", () => {
    const { nav, core } = makeHarness({ listState: "idle" });
    // beginExternalNavigation guards on idle itself, but the call is still made;
    // assert the navigation works regardless of session state.
    nav.start("1gIeu-3A", "Android");
    expect(core.listSession.beginCalls).toBe(1);
    expect(nav.active).toBe(true);
  });

  test("REGRESSION: AID landing with a BLANK bottom footer (kind 'transient') is accepted", () => {
    // Live-verified 2026-07-10: the # prompt clears the footer row and the
    // jump repaint (even after \f) leaves it blank → classifyListScreen says
    // 'transient' although the cursor is parked on the target article. The
    // old kind==='clean-list' gate turned every successful jump into a
    // 「找不到文章」miss.
    const { nav, queue, sent } = makeHarness();
    nav.start("1gKF7GO4", "C_Chat");
    settle(queue, facts("clean-list", { boardName: "C_Chat" }));
    expect(sent[1]).toBe("#1gKF7GO4\r\f");
    settle(
      queue,
      facts("transient", {
        boardName: "C_Chat",
        cursorRowNum: 353218,
        curY: 18,
        curX: 1
      })
    );
    expect(sent[2]).toBe("\r\f");
    settle(queue, facts("article"));
    expect(nav.active).toBe(false);
  });

  test("AID not found: press-any-key screen never satisfies expect → probe → miss → visible fail", () => {
    const { nav, queue, sent, hints } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    settle(queue, facts("clean-list", { boardName: "Android" }));
    expect(sent[1]).toBe("#1gIeu-3A\r\f");
    // The vmsg press-any-key settle: not clean-list → expect false, timer re-armed.
    settle(queue, facts("prompt"));
    // Soft timeout → probe \f.
    vi.advanceTimersByTime(4000);
    expect(sent[2]).toBe("\f");
    // Probed full frame still shows the message → definitive miss.
    settle(queue, facts("prompt"));
    expect(nav.active).toBe(false);
    expect(hints.some(h => h.includes("找不到文章 #1gIeu-3A"))).toBe(true);
    expect(queue.idle).toBe(true);
  });

  test("error text on a clean-list bottom row also rejects (belt and braces)", () => {
    const { nav, queue, sent } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    settle(queue, facts("clean-list", { boardName: "Android" }));
    const rowTexts = new Array(24).fill("");
    rowTexts[23] = "找不到這個文章代碼(AID)";
    settle(
      queue,
      facts("clean-list", {
        boardName: "Android",
        cursorRowNum: 5,
        curY: 10,
        rowTexts
      })
    );
    // expect false → nothing new sent yet (still waiting / will probe).
    expect(sent.length).toBe(2);
    expect(nav.active).toBe(true);
  });

  test("board jump timeout → visible fail, unlock, queue drained", () => {
    const { nav, queue, sent, hints } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    expect(sent[0]).toBe("sAndroid\r\f");
    // Silent link: soft timeout → probe, then hard silence → timeout fail.
    vi.advanceTimersByTime(6000); // probe
    expect(sent[1]).toBe("\f");
    vi.advanceTimersByTime(6000); // probe timeout
    expect(nav.active).toBe(false);
    expect(hints.some(h => h.includes("切換看板"))).toBe(true);
    // The queued follow-up steps must not fire after the failure.
    expect(queue.idle).toBe(true);
    expect(sent.length).toBe(2);
  });

  test("共用 queue 被 flush 掉時要解鎖 active（否則全域吞鍵永久死鎖）", () => {
    // AidNavigation 與 ListSession 共用同一個 CommandQueue。list 的 cleanup／
    // 切原生／斷線都會 queue.flush()，而 flush 是靜默的（不呼叫 onFail）→
    // in-flight 的 AID 命令被丟掉、active 永遠是 true → term_view.onKeyDown
    // 吞掉全部鍵盤並一直閃「AID 跳文中，請稍候…」，無法自行復原。
    const { nav, queue, hints } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    expect(nav.active).toBe(true);
    queue.flush(); // 例：離板 settle → listSession._cleanup()
    expect(nav.active).toBe(false);
    expect(hints.some(h => h.includes("AID 跳文失敗"))).toBe(true);
  });

  test("看板文章（footer 有「回應」）維持文章內直接 s 的快路徑", () => {
    // 回歸守護：這條路徑 mbbsd/more.c:177 只呼叫 Select()（不經 Read()），
    // 所以沒有進板畫面、也不該多繞主功能表。
    const { nav, sent } = makeHarness({ footer: STATUS_ROW });
    nav.start("1gIeu-3A", "Android");
    expect(sent).toEqual(["sAndroid\r\f"]);
  });

  test("final open accepts a status-row bottom even if the classifier hesitates", () => {
    const { nav, queue } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    settle(queue, facts("clean-list", { boardName: "Android" }));
    settle(
      queue,
      facts("clean-list", { boardName: "Android", cursorRowNum: 123, curY: 10 })
    );
    const rowTexts = new Array(24).fill("");
    rowTexts[23] = STATUS_ROW;
    settle(queue, facts("prompt", { rowTexts }));
    expect(nav.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 站內信（currstat == RMAIL）的退出前導段
//
// mbbsd/more.c:102-112：pager 的 s(RET_SELECTBRD) 與 #(RET_SELECTAID) 都寫死
// `currstat != READING → break`。站內信是 RMAIL → 兩鍵都是 DONOTHING，而送出的
// "sSYSOP\r" 會被 pager **逐鍵當快捷鍵吃掉**（Y=回信給所有人 / X,%=推文 /
// T=改標題 / E=編輯）——回報實錄 ptt-debug-20260813 就是這樣跳到另一封信。
//
// 修法：footer 判不出 READING 時，先用 ← 退到主功能表（mbbsd/menu.c:498 的
// MMENU/TMENU/XMENU 才是 ReadSelect() → do_select() 真的進板；mbbsd/board.c:1902
// 的看板列表 s 只會移動游標，不可當終點）再跳。
// ---------------------------------------------------------------------------
describe("AidNavigation 非 READING context（站內信／精華區）", () => {
  const ESC_LEFT = "\x1b[D\f";

  test("REGRESSION 主症狀：站內信 footer → 絕不把板名送上線，第一步是 ←", () => {
    const { nav, sent } = makeHarness({ footer: MAIL_STATUS_ROW });
    nav.start("1gIeu-3A", "SYSOP");
    expect(nav.active).toBe(true);
    expect(sent).toEqual([ESC_LEFT]);
    // 症狀本身：板名的任何一個字元都不得進入站內信 pager。
    expect(sent.some(s => s.indexOf("SYSOP") !== -1)).toBe(false);
  });

  test("← ← ← 退到主功能表後才送 s<board>", () => {
    const { nav, queue, sent } = makeHarness({ footer: MAIL_STATUS_ROW });
    nav.start("1gIeu-3A", "SYSOP");
    // 信件內容 → 信件列表
    settle(queue, facts("transient", { rowTexts: screen({ row0: "郵件選單", mark: "  73 11/13 coedschool" }) }));
    expect(sent[1]).toBe(ESC_LEFT);
    // 信件列表 → 郵件選單
    settle(queue, facts("menu", { rowTexts: screen({ row0: "電子郵件", mark: "  (R)ead 我的信箱" }) }));
    expect(sent[2]).toBe(ESC_LEFT);
    // 郵件選單 → 主功能表
    settle(queue, facts("menu", { rowTexts: MAIN_MENU_SCREEN }));
    expect(sent[3]).toBe("sSYSOP\r\f");
    // 之後與既有路徑完全相同。
    settle(queue, facts("clean-list", { boardName: "SYSOP" }));
    expect(sent[4]).toBe("#1gIeu-3A\r\f");
    settle(queue, facts("clean-list", { boardName: "SYSOP", cursorRowNum: 92, curY: 10 }));
    expect(sent[5]).toBe("\r\f");
    settle(queue, facts("article"));
    expect(nav.active).toBe(false);
    expect(queue.idle).toBe(true);
  });

  test("主功能表的 s 會走 Read() → 進板畫面 ＋ pressanykey 要自動化解", () => {
    // mbbsd/bbs.c:4482-4492：ReadSelect() → Read() 在本 session 首次進該板時
    // 先跑 more(notes) 再 pressanykey()。文章內的 s 不會，所以只有這條路徑要處理。
    const { nav, queue, sent } = makeHarness({ footer: MAIL_STATUS_ROW });
    nav.start("1gIeu-3A", "SYSOP");
    settle(queue, facts("menu", { rowTexts: MAIN_MENU_SCREEN }));
    expect(sent[1]).toBe("sSYSOP\r\f");
    // 進板畫面本身是 pmore → classifyListScreen 判成 'article'。
    settle(queue, facts("article", { rowTexts: screen({ last: STATUS_ROW, mark: "進板畫面" }) }));
    expect(sent[2]).toBe(ESC_LEFT);
    // 離開 pager 後的 pressanykey。
    settle(queue, facts("transient", { rowTexts: screen({ last: PRESS_ANY_KEY_ROW }) }));
    expect(sent[3]).toBe(ESC_LEFT);
    // 終於落到看板列表。
    settle(queue, facts("clean-list", { boardName: "SYSOP" }));
    expect(sent[4]).toBe("#1gIeu-3A\r\f");
    expect(nav.active).toBe(true);
  });

  test("退出層數超過上限 → 可見失敗、解鎖、queue 清空", () => {
    // 例：信箱爆量時 mbbsd/menu.c:493 會把 ← 強制轉成 'R' 卡在讀信，畫面一直
    // 在變但永遠到不了主功能表。不可無限按下去。
    const { nav, queue, sent, hints } = makeHarness({ footer: MAIL_STATUS_ROW });
    nav.start("1gIeu-3A", "SYSOP");
    for (let i = 0; i < 10; ++i) {
      if (!nav.active) break;
      settle(queue, facts("transient", { rowTexts: screen({ mark: "第 " + i + " 層" }) }));
    }
    expect(nav.active).toBe(false);
    expect(sent.every(s => s === ESC_LEFT)).toBe(true);
    expect(sent.length).toBeLessThanOrEqual(6);
    expect(hints.some(h => h.includes("AID 跳文失敗"))).toBe(true);
    expect(queue.idle).toBe(true);
  });

  test("← 沒有效果（畫面簽章不變）→ probe → miss → 可見失敗", () => {
    const { nav, queue, sent, hints } = makeHarness({ footer: MAIL_STATUS_ROW });
    const frozen = screen({ last: MAIL_STATUS_ROW, mark: "文章內文" });
    nav.start("1gIeu-3A", "SYSOP");
    settle(queue, facts("article", { rowTexts: frozen }));
    expect(sent.length).toBe(1); // 還沒結論，繼續等
    vi.advanceTimersByTime(5000); // soft timeout → probe
    expect(sent[1]).toBe("\f");
    settle(queue, facts("article", { rowTexts: frozen })); // 探針幀仍沒變 → miss
    expect(nav.active).toBe(false);
    expect(hints.some(h => h.includes("AID 跳文失敗"))).toBe(true);
  });

  test("footer part3 整段消失（分不出 currstat）→ 走安全的退出路徑", () => {
    // 單向推論：只有「含回應」才敢直接送 s，其餘一律降級（看板文章走這條也對，只是慢）。
    const { nav, sent } = makeHarness({ footer: FOOTERLESS_STATUS_ROW });
    nav.start("1gIeu-3A", "Android");
    expect(sent).toEqual([ESC_LEFT]);
  });

  test("共用 queue 被 flush 掉時，退出步驟一樣要解鎖 active", () => {
    const { nav, queue, hints } = makeHarness({ footer: MAIL_STATUS_ROW });
    nav.start("1gIeu-3A", "SYSOP");
    queue.flush();
    expect(nav.active).toBe(false);
    expect(hints.some(h => h.includes("AID 跳文失敗"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 返回（back）
//
// PTT 沒有「跳轉來源」這種東西（select_by_aid 只在 currboard 內搜尋，跨板就是
// 真的換板），所以返回＝用離開前擷取的錨點再導航一次。仿 BePTT 的重放，但每一
// 步都用 expect 判內容而不是盲送。錨點分三級：aid（最穩）→ num（要驗 subject，
// 刪文會位移）→ board（只回列表不開文，靠 pttbbs getkeep 的游標記憶）。
// ---------------------------------------------------------------------------
describe("AidNavigation 返回", () => {
  const ESC_LEFT = "\x1b[D\f";

  // 列表列：標題區從 col 29 起（comment_parse.LIST_AUTHOR_COL_END）。
  const listRow = title => " ".repeat(29) + title;
  const SUBJECT = subjectOfListText(listRow("[閒聊] 原本那篇"));

  // 走完一次成功的正向跳轉，stack 裡就有一層可以返回。
  function jumpForward(h, aid = "1gIeu-3A", board = "Android") {
    h.nav.start(aid, board);
    settle(h.queue, facts("clean-list", { boardName: board }));
    settle(
      h.queue,
      facts("clean-list", { boardName: board, cursorRowNum: 5, curY: 10 })
    );
    settle(h.queue, facts("article"));
    h.sent.length = 0;
    h.hints.length = 0;
  }

  test("素材有效：構造的列表列解析得出 subject", () => {
    expect(SUBJECT).toBe("[閒聊] 原本那篇");
  });

  test("stack 空時 back() 一個 byte 都不送", () => {
    const { nav, sent, hints } = makeHarness();
    nav.back();
    expect(sent).toEqual([]);
    expect(nav.active).toBe(false);
    expect(hints.some(h => h.includes("沒有可返回"))).toBe(true);
  });

  test("跳文期間 back() 完全忽略（不可重入）", () => {
    const h = makeHarness({ articleBoard: "C_Chat" });
    h.nav.start("1gIeu-3A", "Android");
    expect(h.sent).toEqual(["sAndroid\r\f"]);
    h.nav.back();
    expect(h.sent).toEqual(["sAndroid\r\f"]);
  });

  test("num 錨點：s<原板> → <序號> → ⏎，且落地 subject 相符才開文", () => {
    const h = makeHarness({
      listAnchor: { board: "C_Chat", num: 353218, subject: SUBJECT }
    });
    jumpForward(h);
    expect(h.nav.canGoBack()).toBe(true);

    h.nav.back();
    expect(h.nav.active).toBe(true);
    expect(h.sent).toEqual(["sC_Chat\r\f"]);
    settle(h.queue, facts("clean-list", { boardName: "c_chat" }));
    expect(h.sent[1]).toBe("353218\r\f");

    // 跳號落地：底列被 prompt 清空 → classifier 判 transient，只能靠游標 park。
    const rowTexts = new Array(24).fill("");
    rowTexts[12] = listRow("[閒聊] 原本那篇");
    settle(
      h.queue,
      facts("transient", {
        boardName: "C_Chat",
        cursorRowNum: 353218,
        curY: 12,
        curX: 1,
        rowTexts
      })
    );
    expect(h.sent[2]).toBe("\r\f");
    settle(h.queue, facts("article"));
    expect(h.nav.active).toBe(false);
    expect(h.nav.canGoBack()).toBe(false); // 這層已經用掉
  });

  test("REGRESSION num 錨點落地的 subject 不符（刪文位移）→ 絕不送 ⏎", () => {
    const h = makeHarness({
      listAnchor: { board: "C_Chat", num: 353218, subject: SUBJECT }
    });
    jumpForward(h);
    h.nav.back();
    settle(h.queue, facts("clean-list", { boardName: "C_Chat" }));
    expect(h.sent[1]).toBe("353218\r\f");

    const rowTexts = new Array(24).fill("");
    rowTexts[12] = listRow("[公告] 別篇文章遞補上來了");
    settle(
      h.queue,
      facts("transient", {
        boardName: "C_Chat",
        cursorRowNum: 353218,
        curY: 12,
        curX: 1,
        rowTexts
      })
    );
    expect(h.sent.length).toBe(2); // 停手：沒有第三個指令
    expect(h.nav.active).toBe(false);
    expect(h.hints.some(hint => hint.includes("位置已變動"))).toBe(true);
    expect(h.nav.canGoBack()).toBe(false); // 位置不明 → 整個清空
  });

  test("aid 錨點（連跳兩層）：返回時用 #AID，逐層回到最初那篇", () => {
    const h = makeHarness({
      listAnchor: { board: "C_Chat", num: 353218, subject: SUBJECT }
    });
    jumpForward(h, "1gIeu-3A", "Android"); // C_Chat → Android
    jumpForward(h, "2AbCdEf0", "movie"); // Android → movie

    // 第一層返回：回 Android 那篇，用的是它的 AID（我們知道，因為是跳過去的）
    h.nav.back();
    expect(h.sent[0]).toBe("sAndroid\r\f");
    settle(h.queue, facts("clean-list", { boardName: "Android" }));
    expect(h.sent[1]).toBe("#1gIeu-3A\r\f");
    settle(
      h.queue,
      facts("transient", { boardName: "Android", cursorRowNum: 7, curY: 9 })
    );
    expect(h.sent[2]).toBe("\r\f");
    settle(h.queue, facts("article"));
    expect(h.nav.canGoBack()).toBe(true); // 還有 C_Chat 那層

    // 第二層返回：回到最初的 C_Chat 序號錨點
    h.sent.length = 0;
    h.nav.back();
    expect(h.sent[0]).toBe("sC_Chat\r\f");
    settle(h.queue, facts("clean-list", { boardName: "C_Chat" }));
    expect(h.sent[1]).toBe("353218\r\f");
  });

  test("board 錨點：只回到看板列表就停手，不盲開文章", () => {
    const h = makeHarness({ articleBoard: "Gossiping" });
    jumpForward(h, "1gIeu-3A", "Android");

    h.nav.back();
    expect(h.sent).toEqual(["sGossiping\r\f"]);
    settle(h.queue, facts("clean-list", { boardName: "Gossiping" }));
    expect(h.sent.length).toBe(1); // 沒有第二個指令：Enter 留給使用者
    expect(h.nav.active).toBe(false);
    expect(h.hints.some(hint => hint.includes("按 Enter 開啟"))).toBe(true);
  });

  test("同板跳轉沒有 board 錨點（#aid 會覆寫該板 getkeep 游標）", () => {
    const h = makeHarness({ articleBoard: "Android" });
    jumpForward(h, "1gIeu-3A", "Android");
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("站內信（無看板、無列表錨點）跳出去之後不可返回", () => {
    const h = makeHarness({ footer: MAIL_STATUS_ROW });
    h.nav.start("1gIeu-3A", "SYSOP");
    settle(h.queue, facts("menu", { rowTexts: MAIN_MENU_SCREEN }));
    settle(h.queue, facts("clean-list", { boardName: "SYSOP" }));
    settle(
      h.queue,
      facts("clean-list", { boardName: "SYSOP", cursorRowNum: 92, curY: 10 })
    );
    settle(h.queue, facts("article"));
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("返回也吃退出前導段：目標 footer 判不出 READING 時先 ←", () => {
    const h = makeHarness({
      listAnchor: { board: "C_Chat", num: 1, subject: SUBJECT }
    });
    jumpForward(h);
    // 落地後的畫面變成判不出 currstat 的 footer（例如寬狀態列擠掉 part3）
    h.termBuf.rowTexts = screen({ last: FOOTERLESS_STATUS_ROW });
    h.nav.back();
    expect(h.sent).toEqual([ESC_LEFT]);
    expect(h.sent.some(s => s.indexOf("C_Chat") !== -1)).toBe(false);
  });

  test("順序不變量：錨點必須在 beginExternalNavigation 之前擷取", () => {
    // harness 的 listSession 在 beginExternalNavigation() 內把 anchor 清成
    // null（真實的 _enterFunctionMode 就是這樣清 _boardName/_serverNum）。
    // 若擷取順序寫反，這裡就會變成「沒有錨點 → 不能返回」。
    const h = makeHarness({
      listAnchor: { board: "C_Chat", num: 353218, subject: SUBJECT }
    });
    jumpForward(h);
    expect(h.core.listSession.anchor).toBe(null);
    expect(h.nav.canGoBack()).toBe(true);
    h.nav.back();
    expect(h.sent[0]).toBe("sC_Chat\r\f");
  });

  test("正向跳文失敗 → 不入 stack（沒有可返回的東西）", () => {
    const h = makeHarness({
      listAnchor: { board: "C_Chat", num: 1, subject: SUBJECT }
    });
    h.nav.start("1gIeu-3A", "Android");
    vi.advanceTimersByTime(6000); // probe
    vi.advanceTimersByTime(6000); // probe timeout → fail
    expect(h.nav.active).toBe(false);
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("返回途中被 flush → 解鎖 active 且整個 stack 清空", () => {
    const h = makeHarness({
      listAnchor: { board: "C_Chat", num: 1, subject: SUBJECT }
    });
    jumpForward(h);
    h.nav.back();
    h.queue.flush();
    expect(h.nav.active).toBe(false);
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("使用者自己回到列表／選單（noteSettle）→ 錨點作廢", () => {
    const h = makeHarness({
      listAnchor: { board: "C_Chat", num: 1, subject: SUBJECT }
    });
    jumpForward(h);
    expect(h.nav.canGoBack()).toBe(true);
    h.nav.noteSettle(facts("clean-list", { boardName: "Android" }));
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("我方導航期間的中途 list/menu settle 不得清掉 stack", () => {
    const h = makeHarness({
      listAnchor: { board: "C_Chat", num: 1, subject: SUBJECT }
    });
    jumpForward(h);
    h.nav.back();
    h.nav.noteSettle(facts("clean-list", { boardName: "C_Chat" }));
    h.nav.noteLeftPost();
    settle(h.queue, facts("clean-list", { boardName: "C_Chat" }));
    expect(h.sent[1]).toBe("1\r\f"); // 流程沒被打斷
  });

  test("REGRESSION 我方落地自己會產生一次 leaveCurrentPost，不得清掉剛建立的 stack", () => {
    // live 實測（2026-08-13）：導航會進 easy reading 的 functionMode，目標文章
    // settle 時 functionMode 走 'leave' 分支 → leaveCurrentPost()，而那時 onDone
    // 已經把 active 清掉了。沒有這個 one-shot 的話，每次跳文結束都會立刻把
    // 自己剛 push 的那層抹掉 → 返回鈕永遠不出現。
    const h = makeHarness({
      listAnchor: { board: "C_Chat", num: 1, subject: SUBJECT }
    });
    jumpForward(h);
    h.nav.noteLeftPost(); // ← 落地造成的那一次
    expect(h.nav.canGoBack()).toBe(true);
  });

  test("使用者自己的文章→文章切換（落地那次之後）→ 錨點作廢", () => {
    const h = makeHarness({
      listAnchor: { board: "C_Chat", num: 1, subject: SUBJECT }
    });
    jumpForward(h);
    h.nav.noteLeftPost(); // 我方落地
    h.nav.noteLeftPost(); // 使用者按 ] 跳下一篇
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("斷線 reset() 清空", () => {
    const h = makeHarness({
      listAnchor: { board: "C_Chat", num: 1, subject: SUBJECT }
    });
    jumpForward(h);
    h.nav.reset();
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("返回鈕是 (active, stack) 的投影：跳完顯示、導航中隱藏、用掉後消失", () => {
    const h = makeHarness({
      listAnchor: { board: "C_Chat", num: 353218, subject: SUBJECT }
    });
    expect(h.backButton.shown).toBe(false);
    jumpForward(h);
    expect(h.backButton.shown).toBe(true);
    expect(h.backButton.label).toContain("353218");

    h.nav.back();
    expect(h.backButton.shown).toBe(false); // 導航中不給按第二次
    settle(h.queue, facts("clean-list", { boardName: "C_Chat" }));
    const rowTexts = new Array(24).fill("");
    rowTexts[12] = listRow("[閒聊] 原本那篇");
    settle(
      h.queue,
      facts("transient", {
        boardName: "C_Chat",
        cursorRowNum: 353218,
        curY: 12,
        curX: 1,
        rowTexts
      })
    );
    settle(h.queue, facts("article"));
    expect(h.backButton.shown).toBe(false); // stack 空了
  });

  test("捲動位置以「行索引」入錨點，返回開文後才交棒給好讀還原", () => {
    const h = makeHarness({
      listAnchor: { board: "C_Chat", num: 353218, subject: SUBJECT },
      scrollTop: 600,
      chh: 20
    });
    jumpForward(h); // 離開時停在第 30 行
    h.nav.back();
    settle(h.queue, facts("clean-list", { boardName: "C_Chat" }));
    const rowTexts = new Array(24).fill("");
    rowTexts[12] = listRow("[閒聊] 原本那篇");
    settle(
      h.queue,
      facts("transient", {
        boardName: "C_Chat",
        cursorRowNum: 353218,
        curY: 12,
        curX: 1,
        rowTexts
      })
    );
    // 還原請求只在文章真的開起來之後才發出
    expect(h.core.easyReading.restoreCalls).toEqual([]);
    settle(h.queue, facts("article"));
    expect(h.core.easyReading.restoreCalls).toEqual([30]);
  });

  test("原本就在文章開頭（行索引 0）→ 不要求還原", () => {
    const h = makeHarness({
      listAnchor: { board: "C_Chat", num: 1, subject: SUBJECT },
      scrollTop: 0
    });
    jumpForward(h);
    h.nav.back();
    settle(h.queue, facts("clean-list", { boardName: "C_Chat" }));
    const rowTexts = new Array(24).fill("");
    rowTexts[12] = listRow("[閒聊] 原本那篇");
    settle(
      h.queue,
      facts("transient", {
        boardName: "C_Chat",
        cursorRowNum: 1,
        curY: 12,
        curX: 1,
        rowTexts
      })
    );
    settle(h.queue, facts("article"));
    expect(h.core.easyReading.restoreCalls).toEqual([]);
  });

  test("返回鈕的 callback 就是 back()", () => {
    const h = makeHarness({
      listAnchor: { board: "C_Chat", num: 353218, subject: SUBJECT }
    });
    jumpForward(h);
    h.backButton.cb();
    expect(h.sent[0]).toBe("sC_Chat\r\f");
  });
});
