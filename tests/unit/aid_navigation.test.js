// Unit tests for AidNavigation (src/js/aid_navigation.js): the serialized
// native-key sequence behind an AID link click. Drives a REAL CommandQueue
// (fake send + vitest fake timers) and feeds settle facts by hand — the same
// harness style as command_queue.test.js / list_session.test.js.

import { recordFor } from "../../src/js/reading_record";
import { CommandQueue } from "../../src/js/command_queue";
import {
  AidNavigation,
  aidSearchLanded,
  numJumpLanded,
  endLanded,
  isSubListTitle,
  STEP_PROBE_AFTER_MS,
  STEP_PROBE_WINDOW_MS,
  BOARD_PROBE_AFTER_MS
} from "../../src/js/aid_navigation";
import { subjectOfListText } from "../../src/js/list_session";
import { parseStatusRow } from "../../src/js/string_util";
import { serializedOpHint } from "../../src/js/serialized_op_gate";
import { fnToAid } from "../../src/js/aid_codec";

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
  chh = 20,
  // findLocalPostAid 用：pageState 3 = READING；pageLines = 好讀累積長頁
  // （這裡用「每列一個字串」的簡化型，假 getRowText 直接取用）。
  pageState = null,
  pageLines = null,
  screenRows = null
} = {}) {
  const sent = [];
  const queue = new CommandQueue({ send: d => sent.push(d) });
  const hints = [];
  const backButton = { shown: false, label: null, cb: null };
  const view = {
    flashListHint: (msg, ms) => hints.push(msg),
    _articleBoard: articleBoard,
    mainDisplay: scrollTop == null ? null : { scrollTop },
    // 同 term_view.currentLineIndex 量不到節點時的格線版面退路（真 DOM 量測見該函式）。
    currentLineIndex() {
      return this.mainDisplay && this.chh ? Math.round(this.mainDisplay.scrollTop / this.chh) : null;
    },
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
    pageState,
    pageLines,
    rowTexts: screenRows || screen({ last: footer, mark: "文章內文" }),
    // 真的 getRowText 第四個參數是「改讀這一組 lines」（好讀累積長頁）。
    getRowText(row, colStart, colEnd, lines) {
      return (lines || this.rowTexts)[row] || "";
    }
  };
  const core = {
    easyReading: {
      enterFunctionModeCalls: 0,
      restoreCalls: [],
      // 忠實模擬真實副作用：_enterFunctionMode 結尾的 termBuf.notify() 是同步的，
      // 而 term_view.redraw 的 functionMode 分支第一件事就是 scrollTop = 0。少了
      // 這一行，「錨點／閱讀位置必須在 _begin() 之前擷取」那條 ORDER INVARIANT
      // 就測不出來（deep_link_controller 正是踩在同一個坑上）。
      _enterFunctionMode() {
        this.enterFunctionModeCalls++;
        if (view.mainDisplay) view.mainDisplay.scrollTop = 0;
      },
      // 落地時導航要主動把好讀接回來（settle edge 給不了那一次，見
      // easy_reading.nextEasyReadingExternalLanding）。這裡記下呼叫時的
      // nav.active 與相對順序，兩者都是不變量。
      ensureCalls: 0,
      ensureArgs: [],
      navActiveAtEnsure: [],
      callOrder: [],
      ensureEnabledOnArticle(allowRetry) {
        this.ensureCalls++;
        this.ensureArgs.push(allowRetry);
        this.navActiveAtEnsure.push(nav.active);
        this.callOrder.push("ensure");
        return true;
      },
      requestScrollRestore(lineIndex) {
        this.restoreCalls.push(lineIndex);
        this.callOrder.push("restore");
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

// 正向跳轉的第 0 步：在文章裡按 Q 叫出文章資訊框，讀出「本篇自己的 AID」當返回
// 錨點（mbbsd/more.c:70 → bbs.c#view_postinfo:3691-3705）。收尾是 pressanykey()，
// 所以框在畫面上時末列一定是「請按任意鍵繼續」。
const POST_INFO_ROW = (aid, board) =>
  "│ 文章代碼(AID): #" + aid + " (" + board + ") [ptt.cc] [閒聊] 原本那篇";

// aid 省略 = 本篇沒有合法 AID（bbs.c:3707 只印一根框線）→ 框有出現但升級不了。
function answerOriginInfo(queue, aid, board = "C_Chat") {
  const rowTexts = new Array(24).fill("");
  if (aid) rowTexts[19] = POST_INFO_ROW(aid, board);
  rowTexts[23] = PRESS_ANY_KEY_ROW;
  return settle(queue, facts("transient", { rowTexts }));
}

describe("AidNavigation", () => {
  test("happy path: Q → s board ⏎ (from inside the article) → # aid ⏎ → ⏎, active toggles, mirrors entered", () => {
    const { nav, queue, sent, core, hints } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    expect(nav.active).toBe(true);
    expect(core.easyReading.enterFunctionModeCalls).toBe(1);
    expect(core.listSession.beginCalls).toBe(1);
    // 第 0 步：Q 問出本篇自己的 AID。**不可帶 fullRepaint**——那個 \f 會被
    // view_postinfo 收尾的 pressanykey() 吃掉，資訊框當場消失就讀不到 AID。
    expect(sent).toEqual(["Q"]);
    answerOriginInfo(queue, "1gKF7GO4");
    // 板跳：s 在文章裡也能用，不需要離開文章步驟（fullRepaint 補 \f）。前綴的
    // 空白鍵是拿來餵資訊框那個 pressanykey 的——**不可以用 \f**：Ctrl-L 在
    // io.c#system_key_hook 就被吃掉回 KEY_INCOMPLETE，vkey() 直接 continue，
    // 那個 byte 永遠不會被當成按鍵，於是框關不掉、下一個 's' 反而被拿去關框。
    expect(sent[1]).toBe(" sAndroid\r\f");
    // Board landing: name must match case-insensitively.
    settle(queue, facts("clean-list", { boardName: "android" }));
    expect(sent[2]).toBe("#1gIeu-3A\r\f");
    settle(
      queue,
      facts("clean-list", { boardName: "android", cursorRowNum: 123, curY: 10 })
    );
    expect(sent[3]).toBe("\r\f");
    settle(queue, facts("article"));
    expect(nav.active).toBe(false);
    expect(queue.idle).toBe(true);
    // The 15s "跳至…" progress banner must be replaced by a short confirmation
    // on success (regression: it lingered long into the opened article).
    expect(hints[hints.length - 1]).toContain("已跳至");
  });

  test("文章裡開跳＋quietLanding（最近讀過，P51）：落地不閃「已跳至」，進度提示收掉", () => {
    const { nav, queue, sent, hints, view } = makeHarness();
    view.hideListHint = vi.fn();
    nav.start("1gIeu-3A", "Android", { quietLanding: true });
    answerOriginInfo(queue, "1gKF7GO4");
    settle(queue, facts("clean-list", { boardName: "android" }));
    settle(queue, facts("clean-list", { boardName: "android", cursorRowNum: 123, curY: 10 }));
    settle(queue, facts("article"));
    expect(nav.active).toBe(false);
    expect(sent).toEqual(["Q", " sAndroid\r\f", "#1gIeu-3A\r\f", "\r\f"]);
    expect(hints.some((m) => m.includes("已跳至"))).toBe(false);
    expect(view.hideListHint).toHaveBeenCalledTimes(1);
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

  test("re-entrant start while active is ignored, but not silently", () => {
    const { nav, sent, hints } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    hints.length = 0;
    nav.start("2AbCdEf0", "C_Chat");
    expect(sent).toEqual(["Q"]);
    // 第二下點擊被吞掉：吞掉使用者的輸入不得無聲（serialized_op_gate），提示跟其他入口同一句。
    expect(hints).toEqual([serializedOpHint({ aidNavigation: nav })]);
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
    answerOriginInfo(queue, "1gIeu-3A");
    settle(queue, facts("clean-list", { boardName: "C_Chat" }));
    expect(sent[2]).toBe("#1gKF7GO4\r\f");
    settle(
      queue,
      facts("transient", {
        boardName: "C_Chat",
        cursorRowNum: 353218,
        curY: 18,
        curX: 1
      })
    );
    expect(sent[3]).toBe("\r\f");
    settle(queue, facts("article"));
    expect(nav.active).toBe(false);
  });

  test("AID not found: press-any-key screen never satisfies expect → probe → miss → visible fail", () => {
    const { nav, queue, sent, hints } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    answerOriginInfo(queue, "1gKF7GO4");
    settle(queue, facts("clean-list", { boardName: "Android" }));
    expect(sent[2]).toBe("#1gIeu-3A\r\f");
    // The vmsg press-any-key settle: not clean-list → expect false, timer re-armed.
    settle(queue, facts("prompt"));
    // Soft timeout → probe \f.
    vi.advanceTimersByTime(STEP_PROBE_AFTER_MS);
    expect(sent[3]).toBe("\f");
    // Probed full frame still shows the message → definitive miss.
    settle(queue, facts("prompt"));
    expect(nav.active).toBe(false);
    expect(hints.some(h => h.includes("找不到文章 #1gIeu-3A"))).toBe(true);
    expect(queue.idle).toBe(true);
  });

  test("error text on a clean-list bottom row also rejects (belt and braces)", () => {
    const { nav, queue, sent } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    answerOriginInfo(queue, "1gKF7GO4");
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
    expect(sent.length).toBe(3);
    expect(nav.active).toBe(true);
  });

  test("board jump timeout → visible fail, unlock, queue drained", () => {
    const { nav, queue, sent, hints } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    answerOriginInfo(queue, "1gKF7GO4");
    expect(sent[1]).toBe(" sAndroid\r\f");
    // Silent link: soft timeout → probe, then hard silence → timeout fail.
    vi.advanceTimersByTime(BOARD_PROBE_AFTER_MS); // probe
    expect(sent[2]).toBe("\f");
    vi.advanceTimersByTime(STEP_PROBE_WINDOW_MS); // probe timeout
    expect(nav.active).toBe(false);
    expect(hints.some(h => h.includes("切換看板"))).toBe(true);
    // The queued follow-up steps must not fire after the failure.
    expect(queue.idle).toBe(true);
    expect(sent.length).toBe(3);
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
    const { nav, queue, sent } = makeHarness({ footer: STATUS_ROW });
    nav.start("1gIeu-3A", "Android");
    answerOriginInfo(queue, "1gKF7GO4");
    expect(sent).toEqual(["Q", " sAndroid\r\f"]);
  });

  test("final open accepts a status-row bottom even if the classifier hesitates", () => {
    const { nav, queue } = makeHarness();
    nav.start("1gIeu-3A", "Android");
    answerOriginInfo(queue, "1gKF7GO4");
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
    vi.advanceTimersByTime(STEP_PROBE_AFTER_MS); // soft timeout → probe
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
  // 正向跳轉的第 0 步（Q）問到的「本篇自己的 AID」——返回唯一會開文的錨點。
  const ORIGIN = "1gOrigAA";

  // 列表列：標題區從 col 29 起（comment_parse.LIST_AUTHOR_COL_END）。
  const listRow = title => " ".repeat(29) + title;
  const SUBJECT = subjectOfListText(listRow("[閒聊] 原本那篇"));
  // 列表好讀開的文章（currentAnchor 帶序號）——序號只用來證明「從看板列表進來」，
  // 絕不拿來當返回錨點。
  const LIST_ANCHOR = { board: "C_Chat", num: 353218, subject: SUBJECT };

  // 走完一次成功的正向跳轉，stack 裡就有一層可以返回。
  // originAid = null ⇒ Q 的資訊框沒印 AID（升級不了）。
  function jumpForward(
    h,
    aid = "1gIeu-3A",
    board = "Android",
    originAid = ORIGIN,
    originBoard = "C_Chat"
  ) {
    h.nav.start(aid, board);
    answerOriginInfo(h.queue, originAid, originBoard);
    settle(h.queue, facts("clean-list", { boardName: board }));
    settle(
      h.queue,
      facts("clean-list", { boardName: board, cursorRowNum: 5, curY: 10 })
    );
    settle(h.queue, facts("article"));
    h.sent.length = 0;
    h.hints.length = 0;
  }

  // 返回：s<原板> → #<AID> 落地（游標停在有編號的列）→ ⏎ → 文章。
  function landBack(h, board = "C_Chat") {
    settle(h.queue, facts("clean-list", { boardName: board }));
    settle(
      h.queue,
      facts("transient", { boardName: board, cursorRowNum: 353218, curY: 12, curX: 1 })
    );
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
    expect(h.sent).toEqual(["Q"]);
    h.nav.back();
    expect(h.sent).toEqual(["Q"]);
  });

  test("列表開的文章：返回用 Q 問到的 #AID，絕不送列表序號", () => {
    const h = makeHarness({ listAnchor: LIST_ANCHOR });
    jumpForward(h);
    expect(h.nav.canGoBack()).toBe(true);

    h.nav.back();
    expect(h.nav.active).toBe(true);
    expect(h.sent).toEqual(["sC_Chat\r\f"]);
    settle(h.queue, facts("clean-list", { boardName: "c_chat" }));
    expect(h.sent[1]).toBe("#" + ORIGIN + "\r\f");
    expect(h.sent.some(s => s.indexOf("353218") !== -1)).toBe(false);
    settle(
      h.queue,
      facts("transient", { boardName: "C_Chat", cursorRowNum: 353218, curY: 12, curX: 1 })
    );
    expect(h.sent[2]).toBe("\r\f");
    settle(h.queue, facts("article"));
    expect(h.nav.active).toBe(false);
    expect(h.nav.canGoBack()).toBe(false); // 這層已經用掉
  });

  test("Q 問不到 AID：沒有序號備援 ⇒ 只回看板列表，不開文", () => {
    const h = makeHarness({ listAnchor: LIST_ANCHOR, articleBoard: "C_Chat" });
    jumpForward(h, "1gIeu-3A", "Android", null);
    expect(h.backButton.label).toBe("C_Chat 看板");
    h.nav.back();
    expect(h.sent).toEqual(["sC_Chat\r\f"]);
    settle(h.queue, facts("clean-list", { boardName: "C_Chat" }));
    expect(h.sent.length).toBe(1); // 沒有序號跳轉、沒有 ⏎
    expect(h.nav.active).toBe(false);
    expect(h.hints.some(hint => hint.includes("按 Enter 開啟"))).toBe(true);
  });

  test("Q 問不到 AID、也沒有看板可回 ⇒ 沒有返回鈕（不拿序號湊）", () => {
    const h = makeHarness({ listAnchor: LIST_ANCHOR });
    jumpForward(h, "1gIeu-3A", "Android", null);
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("aid 錨點（連跳兩層）：返回時用 #AID，逐層回到最初那篇", () => {
    const h = makeHarness({ listAnchor: LIST_ANCHOR });
    jumpForward(h, "1gIeu-3A", "Android"); // C_Chat → Android
    // Android → movie：此時人在 Android 那篇，Q 問到的就是它自己的 AID
    jumpForward(h, "2AbCdEf0", "movie", "1gIeu-3A", "Android");

    // 第一層返回：回 Android 那篇，用的是它的 AID（我們知道，因為是跳過去的）
    h.nav.back();
    expect(h.sent[0]).toBe("sAndroid\r\f");
    landBack(h, "Android");
    expect(h.sent[1]).toBe("#1gIeu-3A\r\f");
    expect(h.sent[2]).toBe("\r\f");
    settle(h.queue, facts("article"));
    expect(h.nav.canGoBack()).toBe(true); // 還有 C_Chat 那層

    // 第二層返回：回到最初那篇，同樣是 #AID
    h.sent.length = 0;
    h.nav.back();
    expect(h.sent[0]).toBe("sC_Chat\r\f");
    settle(h.queue, facts("clean-list", { boardName: "C_Chat" }));
    expect(h.sent[1]).toBe("#" + ORIGIN + "\r\f");
  });

  test("返回時 #AID 找不到（原文已刪）→ 停在列表、明講找不到，不退回序號", () => {
    const h = makeHarness({ listAnchor: LIST_ANCHOR });
    jumpForward(h);
    h.nav.back();
    settle(h.queue, facts("clean-list", { boardName: "C_Chat" }));
    expect(h.sent[1]).toBe("#" + ORIGIN + "\r\f");
    settle(h.queue, facts("prompt"));
    vi.advanceTimersByTime(STEP_PROBE_AFTER_MS); // probe
    settle(h.queue, facts("prompt")); // miss
    expect(h.nav.active).toBe(false);
    expect(h.sent.some(s => /^\d+\r/.test(s))).toBe(false);
    expect(h.hints.some(hint => hint.includes("找不到原文章 #" + ORIGIN))).toBe(true);
    expect(h.nav.canGoBack()).toBe(false);
  });

  // ---- 閱讀紀錄（reading_record）：身後的列表跟著返回錨走 ----------------------
  // 身後列表的紀錄（list_session.readingPosition 在文章期間回的那一份）。
  const BEHIND = {
    kind: "list",
    board: "C_Chat",
    mode: "plain",
    topNum: 353200,
    topPinnedKey: null,
    scrollFrac: 0,
    cursorNum: 353218,
  };
  function withListRecord(h, rec) {
    h.core.listSession.readingPosition = () => rec;
    h.core.listSession.requestViewportRestore = vi.fn();
    h.core.listSession.endExternalNavigation = vi.fn();
    return h;
  }

  test("返回錨帶著身後的列表；返回落地（回到原文）後交回閱讀紀錄，按 ← 回列表時還原", () => {
    const h = withListRecord(makeHarness({ listAnchor: LIST_ANCHOR }), BEHIND);
    jumpForward(h);
    expect(h.nav._history.peek().list).toEqual(BEHIND);
    h.nav.back();
    landBack(h);
    settle(h.queue, facts("article"));
    expect(recordFor(h.core).peekBehindList()).toEqual(BEHIND);
  });

  test("看板錨返回停在列表 ⇒ 列表視野交給列表好讀（只比板），外部 hold 交回探針", () => {
    const h = withListRecord(makeHarness({ articleBoard: "C_Chat" }), BEHIND);
    jumpForward(h, "1gIeu-3A", "Android", null);
    h.nav.back();
    settle(h.queue, facts("clean-list", { boardName: "C_Chat" }));
    expect(h.nav.active).toBe(false);
    expect(h.core.listSession.requestViewportRestore).toHaveBeenCalledWith(
      Object.assign({}, BEHIND, { matchBoardOnly: true })
    );
    expect(h.core.listSession.endExternalNavigation).toHaveBeenCalled();
  });

  test("跳文失敗（停在哪不知道）⇒ 仍把外部 hold 交回探針，列表好讀不會卡在原生", () => {
    const h = withListRecord(makeHarness({ listAnchor: LIST_ANCHOR }), BEHIND);
    h.nav.start("1gIeu-3A", "Android");
    answerOriginInfo(h.queue, ORIGIN);
    settle(h.queue, facts("prompt"));
    vi.advanceTimersByTime(BOARD_PROBE_AFTER_MS);
    vi.advanceTimersByTime(STEP_PROBE_WINDOW_MS);
    settle(h.queue, facts("prompt"));
    expect(h.nav.active).toBe(false);
    expect(h.core.listSession.endExternalNavigation).toHaveBeenCalled();
  });

  test("deep link 從文章列表帶進來（startExternal）⇒ 有返回，回到那份列表並還原視野", () => {
    const movie = Object.assign({}, BEHIND, { board: "movie", cursorNum: 77 });
    const h = withListRecord(makeHarness(), movie);
    h.termBuf.rowTexts = MAIN_MENU_SCREEN; // 走主功能表的快路徑（錨的取法與畫面無關）
    h.nav.startExternal("1gIeu-3A", "Gossiping");
    settle(h.queue, facts("clean-list", { boardName: "gossiping" }));
    settle(h.queue, facts("clean-list", { boardName: "gossiping", cursorRowNum: 42, curY: 10 }));
    settle(h.queue, facts("article"));
    expect(h.nav.canGoBack()).toBe(true);
    expect(h.backButton.label).toBe("movie 看板");
    h.termBuf.rowTexts = screen({ last: STATUS_ROW, mark: "文章內文" });
    h.sent.length = 0;
    h.nav.back();
    expect(h.sent[0]).toBe("smovie\r\f");
    settle(h.queue, facts("clean-list", { boardName: "movie" }));
    expect(h.nav.active).toBe(false);
    expect(h.core.listSession.requestViewportRestore).toHaveBeenCalledWith(
      Object.assign({}, movie, { matchBoardOnly: true })
    );
  });

  test("deep link 從主功能表帶進來（沒有列表紀錄）⇒ 照舊沒有返回", () => {
    const h = withListRecord(makeHarness(), null);
    h.termBuf.rowTexts = MAIN_MENU_SCREEN;
    h.nav.startExternal("1gIeu-3A", "Gossiping");
    settle(h.queue, facts("clean-list", { boardName: "gossiping" }));
    settle(h.queue, facts("clean-list", { boardName: "gossiping", cursorRowNum: 42, curY: 10 }));
    settle(h.queue, facts("article"));
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("原生 pmore 讀文時收到 deep link（start 帶 inPager）⇒ 不被好讀的 gate 擋掉，照樣問 Q 記原文", () => {
    const h = makeHarness({ articleBoard: "C_Chat" });
    h.termBuf.startedEasyReading = false;
    h.nav.start("1gIeu-3A", "Android");
    expect(h.sent).toEqual([]);
    h.nav.start("1gIeu-3A", "Android", { inPager: true });
    expect(h.sent).toEqual(["Q"]);
  });

  test("board 錨點：只回到看板列表就停手，不盲開文章", () => {
    const h = makeHarness({ articleBoard: "Gossiping" });
    jumpForward(h, "1gIeu-3A", "Android", null);

    h.nav.back();
    expect(h.sent).toEqual(["sGossiping\r\f"]);
    settle(h.queue, facts("clean-list", { boardName: "Gossiping" }));
    expect(h.sent.length).toBe(1); // 沒有第二個指令：Enter 留給使用者
    expect(h.nav.active).toBe(false);
    expect(h.hints.some(hint => hint.includes("按 Enter 開啟"))).toBe(true);
  });

  test("同板跳轉沒有 board 錨點（#aid 會覆寫該板 getkeep 游標）", () => {
    const h = makeHarness({ articleBoard: "Android" });
    jumpForward(h, "1gIeu-3A", "Android", null);
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
    const h = makeHarness({ listAnchor: LIST_ANCHOR });
    jumpForward(h);
    // 落地後的畫面變成判不出 currstat 的 footer（例如寬狀態列擠掉 part3）
    h.termBuf.rowTexts = screen({ last: FOOTERLESS_STATUS_ROW });
    h.nav.back();
    expect(h.sent).toEqual([ESC_LEFT]);
    expect(h.sent.some(s => s.indexOf("C_Chat") !== -1)).toBe(false);
  });

  test("順序不變量：列表證據必須在 beginExternalNavigation 之前擷取", () => {
    // harness 的 listSession 在 beginExternalNavigation() 內把 anchor 清成
    // null（真實的 _enterFunctionMode 就是這樣清 _openedNum）。擷取順序寫反的話，
    // 超長文（footer 被擠掉）就證明不了 READING ⇒ 第一步變成 ← 而不是文章內的 Q。
    const SQUEEZED_ROW =
      "  瀏覽 第 257/361 頁 ( 68%)  目前顯示: 第 6657~6683 行      (h)說明 (←/q)離開  ";
    const h = makeHarness({ listAnchor: LIST_ANCHOR, footer: SQUEEZED_ROW });
    h.nav.start("1gIeu-3A", "Android");
    expect(h.core.listSession.anchor).toBe(null);
    expect(h.sent).toEqual(["Q"]);
    answerOriginInfo(h.queue, ORIGIN);
    expect(h.sent[1]).toBe(" sAndroid\r\f");
  });

  test("正向跳文失敗 → 不入 stack（沒有可返回的東西）", () => {
    const h = makeHarness({ listAnchor: LIST_ANCHOR });
    h.nav.start("1gIeu-3A", "Android");
    answerOriginInfo(h.queue, "1gKF7GO4"); // Q 成功也一樣：沒落地就不入 stack
    vi.advanceTimersByTime(BOARD_PROBE_AFTER_MS); // probe
    vi.advanceTimersByTime(STEP_PROBE_WINDOW_MS); // probe timeout → fail
    expect(h.nav.active).toBe(false);
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("返回途中被 flush → 解鎖 active 且整個 stack 清空", () => {
    const h = makeHarness({ listAnchor: LIST_ANCHOR });
    jumpForward(h);
    h.nav.back();
    h.queue.flush();
    expect(h.nav.active).toBe(false);
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("使用者自己回到列表／選單（noteSettle）→ 錨點作廢", () => {
    const h = makeHarness({ listAnchor: LIST_ANCHOR });
    jumpForward(h);
    expect(h.nav.canGoBack()).toBe(true);
    h.nav.noteSettle(facts("clean-list", { boardName: "Android" }));
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("我方導航期間的中途 list/menu settle 不得清掉 stack", () => {
    const h = makeHarness({ listAnchor: LIST_ANCHOR });
    jumpForward(h);
    h.nav.back();
    h.nav.noteSettle(facts("clean-list", { boardName: "C_Chat" }));
    h.nav.noteLeftPost();
    settle(h.queue, facts("clean-list", { boardName: "C_Chat" }));
    expect(h.sent[1]).toBe("#" + ORIGIN + "\r\f"); // 流程沒被打斷
  });

  test("REGRESSION 我方落地自己會產生一次 leaveCurrentPost，不得清掉剛建立的 stack", () => {
    // live 實測（2026-08-13）：導航會進 easy reading 的 functionMode，目標文章
    // settle 時 functionMode 走 'leave' 分支 → leaveCurrentPost()，而那時 onDone
    // 已經把 active 清掉了。沒有這個 one-shot 的話，每次跳文結束都會立刻把
    // 自己剛 push 的那層抹掉 → 返回鈕永遠不出現。
    const h = makeHarness({ listAnchor: LIST_ANCHOR });
    jumpForward(h);
    h.nav.noteLeftPost(); // ← 落地造成的那一次
    expect(h.nav.canGoBack()).toBe(true);
  });

  test("使用者自己的文章→文章切換（落地那次之後）→ 錨點作廢", () => {
    const h = makeHarness({ listAnchor: LIST_ANCHOR });
    jumpForward(h);
    h.nav.noteLeftPost(); // 我方落地
    h.nav.noteLeftPost(); // 使用者按 ] 跳下一篇
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("斷線 reset() 清空", () => {
    const h = makeHarness({ listAnchor: LIST_ANCHOR });
    jumpForward(h);
    h.nav.reset();
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("返回鈕是 (active, stack) 的投影：跳完顯示、導航中隱藏、用掉後消失", () => {
    const h = makeHarness({ listAnchor: LIST_ANCHOR });
    expect(h.backButton.shown).toBe(false);
    jumpForward(h);
    expect(h.backButton.shown).toBe(true);
    expect(h.backButton.label).toBe("#" + ORIGIN);

    h.nav.back();
    expect(h.backButton.shown).toBe(false); // 導航中不給按第二次
    landBack(h);
    settle(h.queue, facts("article"));
    expect(h.backButton.shown).toBe(false); // stack 空了
  });

  test("捲動位置以「行索引」入錨點，返回開文後才交棒給好讀還原", () => {
    const h = makeHarness({ listAnchor: LIST_ANCHOR, scrollTop: 600, chh: 20 });
    jumpForward(h); // 離開時停在第 30 行
    h.core.easyReading.callOrder.length = 0; // 只看 back run 這一趟
    h.nav.back();
    landBack(h);
    // 還原請求只在文章真的開起來之後才發出
    expect(h.core.easyReading.restoreCalls).toEqual([]);
    settle(h.queue, facts("article"));
    expect(h.core.easyReading.restoreCalls).toEqual([30]);
    // ORDER INVARIANT：好讀要先被接回來，捲動還原才有東西可推進 —— restore 是靠
    // _onViewUpdated 驅動的，好讀沒開就沒有那個迴圈。
    expect(h.core.easyReading.callOrder).toEqual(["ensure", "restore"]);
  });

  test("原本就在文章開頭（行索引 0）→ 不要求還原", () => {
    const h = makeHarness({ listAnchor: LIST_ANCHOR, scrollTop: 0 });
    jumpForward(h);
    h.nav.back();
    landBack(h);
    settle(h.queue, facts("article"));
    expect(h.core.easyReading.restoreCalls).toEqual([]);
  });

  test("返回鈕的 callback 就是 back()", () => {
    const h = makeHarness({ listAnchor: LIST_ANCHOR });
    jumpForward(h);
    h.backButton.cb();
    expect(h.sent[0]).toBe("sC_Chat\r\f");
  });
});

// ---------------------------------------------------------------------------
// 離開前先問 server 要「本篇自己的 AID」（Q 資訊框）
//
// 症狀（使用者實測）：/ 搜尋 → 進文章 → 點 AID → 返回 → 回不到原本那篇。
// 根因：/ 搜尋在 server 端是 MODE_SELECT，read.c:661-665 把 currdirect 換成暫存
// 篩選檔 ⇒ **序號空間與主清單獨立**；而返回的 num 錨點只存一個裸序號。返回時
// s<board> 會離開 MODE_SELECT 回主清單，再送那個篩選序號 → 落在別篇文章。
// 修法：正向跳轉的第一步先按 Q 讀出本篇的 AID，把錨點升級成完全不受序號位移
// 影響的 aid 級（同 BePTT 拿畫面上「文章代碼(AID)」當 ground truth 的做法）。
// ---------------------------------------------------------------------------
describe("AidNavigation origin AID 錨點（/ 搜尋清單回不去的修法）", () => {
  const listRow = title => " ".repeat(29) + title;
  const SUBJECT = subjectOfListText(listRow("[閒聊] 原本那篇"));

  // 使用者按了 /，list session 交出的序號屬於**篩選空間**，拿去主清單跳一定錯。
  const FILTERED_ANCHOR = { board: "movie", num: 3, subject: SUBJECT };

  test("REGRESSION 主症狀：返回用 #AID，不用篩選清單的序號", () => {
    const h = makeHarness({ listAnchor: FILTERED_ANCHOR });
    h.nav.start("2AbCdEf0", "Gossiping");
    answerOriginInfo(h.queue, "1gIeu-3A", "movie");
    settle(h.queue, facts("clean-list", { boardName: "Gossiping" }));
    settle(
      h.queue,
      facts("clean-list", { boardName: "Gossiping", cursorRowNum: 9, curY: 10 })
    );
    settle(h.queue, facts("article"));
    h.sent.length = 0;

    h.nav.back();
    expect(h.sent[0]).toBe("smovie\r\f");
    settle(h.queue, facts("clean-list", { boardName: "movie" }));
    // 這裡才是本 bug 的判準：必須是 #AID，不可以是 "3\r\f"
    expect(h.sent[1]).toBe("#1gIeu-3A\r\f");
  });

  test("資訊框的板名優先於 list session 的（MODE_SELECT 下 _boardName 可能是錯的）", () => {
    const h = makeHarness({ listAnchor: { board: "wrongboard", num: 3 } });
    h.nav.start("2AbCdEf0", "Gossiping");
    answerOriginInfo(h.queue, "1gIeu-3A", "movie");
    settle(h.queue, facts("clean-list", { boardName: "Gossiping" }));
    settle(
      h.queue,
      facts("clean-list", { boardName: "Gossiping", cursorRowNum: 9, curY: 10 })
    );
    settle(h.queue, facts("article"));
    h.sent.length = 0;

    h.nav.back();
    expect(h.sent[0]).toBe("smovie\r\f");
  });

  test("同板跳轉現在也有返回鈕（過去 board 錨點被作廢就完全回不去）", () => {
    const h = makeHarness({ articleBoard: "movie" });
    h.nav.start("2AbCdEf0", "movie"); // 同板
    answerOriginInfo(h.queue, "1gIeu-3A", "movie");
    settle(h.queue, facts("clean-list", { boardName: "movie" }));
    settle(
      h.queue,
      facts("clean-list", { boardName: "movie", cursorRowNum: 9, curY: 10 })
    );
    settle(h.queue, facts("article"));
    expect(h.nav.canGoBack()).toBe(true);
    expect(h.backButton.label).toBe("#1gIeu-3A");
  });

  test("Q 逾時 → 照樣跳（不算失敗），但不拿篩選序號當返回錨點", () => {
    const h = makeHarness({ listAnchor: FILTERED_ANCHOR });
    h.nav.start("2AbCdEf0", "Gossiping");
    expect(h.sent[0]).toBe("Q");
    vi.advanceTimersByTime(STEP_PROBE_AFTER_MS); // soft timeout → probe \f
    expect(h.sent[1]).toBe("\f");
    vi.advanceTimersByTime(STEP_PROBE_WINDOW_MS); // 探針也沒回 → timeout
    // 不可 _fail：跳文本身還有救，今日行為就是地板
    expect(h.nav.active).toBe(true);
    expect(h.sent[2]).toBe(" sGossiping\r\f");

    settle(h.queue, facts("clean-list", { boardName: "Gossiping" }));
    settle(
      h.queue,
      facts("clean-list", { boardName: "Gossiping", cursorRowNum: 9, curY: 10 })
    );
    settle(h.queue, facts("article"));
    // 問不到 AID、也沒有文章 header 的看板 ⇒ 沒有返回（舊版會留一個「movie 第 3 篇」
    // 的序號錨點，那正是本 describe 開頭說的「回到別篇」）。
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("REGRESSION 關資訊框的鍵不可以是 \\f（Ctrl-L 根本送不到 handler）", () => {
    // live 實錯 2026-08-15：mbbsd/io.c#system_key_hook:196-203 把 Ctrl('L') 攔下
    // 做 redrawwin() 並回 KEY_INCOMPLETE，vkey() 對它 continue（io.c:432-434）⇒
    // 那個 byte **永遠不會被當成按鍵**（這也正是它可以當萬用探針的原因）。用它
    // 關 pressanykey ⇒ 框沒關掉、下一個 's' 被拿去關框，剩下的板名就被 pager 當
    // 快捷鍵吃掉（'h' 說明、'a' 作者下一篇）→ 人跑到別篇文章。
    const h = makeHarness({ listAnchor: FILTERED_ANCHOR });
    h.nav.start("2AbCdEf0", "Gossiping");
    answerOriginInfo(h.queue, "1gIeu-3A", "movie");
    expect(h.sent[1].startsWith("\f")).toBe(false);
    expect(h.sent[1]).toBe(" sGossiping\r\f");
  });

  test("資訊框沒有 AID（置底文之類）→ 一樣降級，不阻斷跳文", () => {
    const h = makeHarness({ listAnchor: FILTERED_ANCHOR });
    h.nav.start("2AbCdEf0", "Gossiping");
    answerOriginInfo(h.queue, null); // 框有出現，但沒印 AID
    expect(h.nav.active).toBe(true);
    expect(h.sent[1]).toBe(" sGossiping\r\f");
  });

  test("Q 在途時被 flush 掉 → 必須解鎖 active（不可降級硬送板名）", () => {
    // flush 代表整個導航脈絡已經不見（list cleanup／切原生／斷線），這時再把
    // s<board> 送進未知畫面就是亂打字，和其他步驟一樣要可見失敗。
    const h = makeHarness({ listAnchor: FILTERED_ANCHOR });
    h.nav.start("2AbCdEf0", "Gossiping");
    h.queue.flush();
    expect(h.nav.active).toBe(false);
    expect(h.sent.some(s => s.indexOf("Gossiping") !== -1)).toBe(false);
    expect(h.hints.some(hint => hint.includes("AID 跳文失敗"))).toBe(true);
  });

  test("返回途中不再問 Q（back run 的第一步就是 s<board>）", () => {
    const h = makeHarness({ listAnchor: FILTERED_ANCHOR });
    h.nav.start("2AbCdEf0", "Gossiping");
    answerOriginInfo(h.queue, "1gIeu-3A", "movie");
    settle(h.queue, facts("clean-list", { boardName: "Gossiping" }));
    settle(
      h.queue,
      facts("clean-list", { boardName: "Gossiping", cursorRowNum: 9, curY: 10 })
    );
    settle(h.queue, facts("article"));
    h.sent.length = 0;
    h.nav.back();
    expect(h.sent).toEqual(["smovie\r\f"]);
  });

  test("aid 錨點的 #搜尋 miss（文章已消失）→ 停在列表、不退回序號", () => {
    const h = makeHarness({ listAnchor: FILTERED_ANCHOR });
    h.nav.start("2AbCdEf0", "Gossiping");
    answerOriginInfo(h.queue, "1gIeu-3A", "movie");
    settle(h.queue, facts("clean-list", { boardName: "Gossiping" }));
    settle(
      h.queue,
      facts("clean-list", { boardName: "Gossiping", cursorRowNum: 9, curY: 10 })
    );
    settle(h.queue, facts("article"));
    h.sent.length = 0;

    h.nav.back();
    settle(h.queue, facts("clean-list", { boardName: "movie" }));
    expect(h.sent[1]).toBe("#1gIeu-3A\r\f");
    // 找不到：vmsg 把游標停在底列（read.c:466-476 + vtuikit.c#vshowmsg）⇒ 落在
    // entry 區之外 → probe → miss。**置底文不走這條**：它的 #搜尋是會中的
    // （read.c 先搜 .DIR.bottom），見 aidSearchLanded。
    settle(h.queue, facts("prompt"));
    vi.advanceTimersByTime(STEP_PROBE_AFTER_MS);
    settle(h.queue, facts("prompt"));
    expect(h.sent.some(s => /^\d+\r/.test(s))).toBe(false);
    expect(h.nav.active).toBe(false);
    expect(h.hints.some(hint => hint.includes("找不到原文章 #1gIeu-3A"))).toBe(true);
  });
});

// 外部 deep link（?/#Board/AID）觸發的跳轉。與 start() 的差別全在起手式：沒有
// 原文可回、可能根本沒開任何文章、而且落點幾乎都是剛登入的主功能表。
// #<aid>⏎ 的落地判準（aid_navigation 與 long_push_session 共用）。真實列文字取自
// tests/unit/comment_parse.test.js 用的實錄樣本。
describe("aidSearchLanded", () => {
  const f = over => ({
    boardName: "android",
    cursorRowNum: null,
    rows: 24,
    curY: 10,
    rowTexts: new Array(24).fill(""),
    ...over
  });
  const withRow = (y, text, over = {}) => {
    const rowTexts = new Array(24).fill("");
    rowTexts[y] = text;
    return f({ curY: y, rowTexts, ...over });
  };

  test("一般編號列 → true", () => {
    expect(aidSearchLanded(f({ cursorRowNum: 353218 }))).toBe(true);
  });

  test("置底 ★ 列（無序號）→ true（read.c 先搜 .DIR.bottom；bbs.c:843 印 ★ 取代序號）", () => {
    expect(aidSearchLanded(withRow(10, ">   ★  m 1 6/01 arrenwu      轉 [公告] 板規"))).toBe(true);
    expect(aidSearchLanded(withRow(10, "    ★  M 3 6/13 SaberTheBest □ [26夏] 夏番各作品首播時間"))).toBe(true);
    // 舊版游標壓在置底列上（● 蓋掉前兩格）也要認得
    expect(aidSearchLanded(withRow(10, "●  ★  m 1 6/01 arrenwu      轉 [公告] 板規"))).toBe(true);
  });

  test("「找不到這個文章代碼」→ false（游標被 vmsg 留在末列，落在 entry 區外）", () => {
    const rowTexts = new Array(24).fill("");
    rowTexts[22] = "找不到這個文章代碼(AID)，可能是文章已消失，或是你找錯看板了";
    rowTexts[23] = PRESS_ANY_KEY_ROW;
    expect(aidSearchLanded(f({ curY: 23, rowTexts }))).toBe(false);
  });

  test("「不合法的文章代碼」→ false（AID_NOT_FOUND_RE 要吃得到「不合法」）", () => {
    const rowTexts = new Array(24).fill("");
    rowTexts[23] = " ◆ 不合法的文章代碼(AID)，請確定輸入是正確的";
    // 就算游標意外留在 entry 區，末列的字樣仍要擋下來
    expect(aidSearchLanded(f({ curY: 10, rowTexts }))).toBe(false);
  });

  test("末列是 pressanykey bar → false（第二道防線）", () => {
    const rowTexts = new Array(24).fill("");
    rowTexts[10] = "    ★  m 1 6/01 arrenwu      轉 [公告] 板規";
    rowTexts[23] = PRESS_ANY_KEY_ROW;
    expect(aidSearchLanded(f({ curY: 10, rowTexts }))).toBe(false);
  });

  test("標題含「找不到」的正常文章列不得被誤殺（只掃末列，不往上掃）", () => {
    const rowTexts = new Array(24).fill("");
    rowTexts[22] = " 353218 + 6 9/02 someuser     □ [問題] 找不到藍牙裝置";
    expect(aidSearchLanded(f({ curY: 22, cursorRowNum: 353218, rowTexts }))).toBe(true);
  });

  test("boardName 為 null／游標在 entry 區外／facts 缺席 → false", () => {
    expect(aidSearchLanded(f({ boardName: null, cursorRowNum: 5 }))).toBe(false);
    expect(aidSearchLanded(f({ cursorRowNum: 5, curY: 2 }))).toBe(false);
    expect(aidSearchLanded(f({ cursorRowNum: 5, curY: 23 }))).toBe(false);
    expect(aidSearchLanded(null)).toBe(false);
  });

  test("空白／分隔列（讀不出作者）→ false，不可當成置底列", () => {
    expect(aidSearchLanded(withRow(10, ""))).toBe(false);
    expect(aidSearchLanded(withRow(10, "─".repeat(60)))).toBe(false);
  });
});

describe("startExternal（deep link）", () => {
  const atMainMenu = h => {
    h.termBuf.rowTexts = MAIN_MENU_SCREEN;
  };

  test("主功能表：直接 s<board>，不送 ←", () => {
    // _enqueueEscape 是「先送 ← 再判斷」，在主功能表送 ← 會把反白移到
    // G)oodbye（該函式自己的註解點名的 overshoot）。deep link 幾乎每次都
    // 落在這個畫面，所以起手就必須認出來。
    const h = makeHarness();
    atMainMenu(h);
    expect(h.nav.startExternal("1gIeu-3A", "Gossiping")).toBe(true);
    expect(h.sent).toEqual(["sGossiping\r\f"]);
    expect(h.nav.active).toBe(true);
  });

  test("主功能表：走 viaMenu 落點（進板畫面 + pressanykey 要被關掉）", () => {
    const h = makeHarness();
    atMainMenu(h);
    h.nav.startExternal("1gIeu-3A", "Gossiping");
    // ReadSelect() → Read() 在本 session 首次進板會先放進板畫面
    settle(
      h.queue,
      facts("transient", {
        rowTexts: screen({ last: PRESS_ANY_KEY_ROW, mark: "進板畫面" })
      })
    );
    expect(h.sent[1]).toBe("\x1b[D\f");
    settle(h.queue, facts("clean-list", { boardName: "gossiping" }));
    expect(h.sent[2]).toBe("#1gIeu-3A\r\f");
    settle(
      h.queue,
      facts("clean-list", { boardName: "gossiping", cursorRowNum: 42, curY: 10 })
    );
    expect(h.sent[3]).toBe("\r\f");
    settle(h.queue, facts("article"));
    expect(h.nav.active).toBe(false);
  });

  test("REGRESSION：沒有 footer 的進板畫面（PMORE_AUTO_EXIT）也要能關掉", () => {
    // 實測 2026-08-16（Steam 板）：跳轉卡死在進板畫面。
    // mbbsd/bbs.c#Read:4470 用 more(buf, NA)，NA = PMORE_AUTO_EXIT
    // （pmore.c:200）—— 這個模式**不畫 footer prompt**，所以末列是空的、游標
    // park 在末列 ⇒ classifier 說 'prompt'，而 _boardLandingExpect 原本的三個
    // 分支（clean-list / 請按任意鍵 / article）一個都不匹配 → 永遠等下去 →
    // probe → miss →「切換看板失敗」。
    const h = makeHarness();
    atMainMenu(h);
    h.nav.startExternal("1gIeu-3A", "Steam");
    expect(h.sent).toEqual(["sSteam\r\f"]);
    // 進板公告：row0 是公告內容（不再是主功能表），末列空白，游標停在末列。
    settle(
      h.queue,
      facts("prompt", {
        rowTexts: screen({ row0: "", mark: "  ◢██◣ Steam 板規", last: "" }),
        curY: 23
      })
    );
    expect(h.sent[1]).toBe("\x1b[D\f");
    settle(h.queue, facts("clean-list", { boardName: "steam" }));
    expect(h.sent[2]).toBe("#1gIeu-3A\r\f");
  });

  test("板跳後仍停在主功能表（s 沒吃到／板名有誤）→ 不當成進板畫面亂關", () => {
    // 這一幀跟上面同樣是 'prompt'，差別只在 row0 還是主功能表 —— 那代表我們
    // 根本沒離開，送 ← 只會把反白移到 G)oodbye。必須繼續等（→ probe → miss →
    // 明確失敗），不能沉默地亂按。
    const h = makeHarness();
    atMainMenu(h);
    h.nav.startExternal("1gIeu-3A", "NoSuchBoard");
    settle(
      h.queue,
      facts("prompt", { rowTexts: MAIN_MENU_SCREEN, curY: 23 })
    );
    expect(h.sent).toEqual(["sNoSuchBoard\r\f"]);
  });

  test("沒有開著的文章（startedEasyReading false）照樣能跳 —— start() 的那條 gate 不適用", () => {
    const h = makeHarness();
    atMainMenu(h);
    h.termBuf.startedEasyReading = false;
    expect(h.nav.startExternal("1gIeu-3A", "Gossiping")).toBe(true);
    expect(h.sent).toEqual(["sGossiping\r\f"]);
    // 對照組：同一個畫面用 start() 會被 gate 擋掉，什麼都不送
    const h2 = makeHarness();
    atMainMenu(h2);
    h2.termBuf.startedEasyReading = false;
    h2.nav.start("1gIeu-3A", "Gossiping");
    expect(h2.sent).toEqual([]);
  });

  test("不問 Q：沒有原文錨點就沒有東西可升級", () => {
    // 起點是一篇文章（footer 證明 currstat == READING）但仍是外部跳轉：
    // 這時 start() 會先按 Q，startExternal 直接切板。
    const h = makeHarness();
    h.nav.startExternal("1gIeu-3A", "Gossiping");
    expect(h.sent).toEqual(["sGossiping\r\f"]);
  });

  test("REGRESSION：落地時要把好讀接回來（active 已解鎖）", () => {
    // deep link 的目標文章是踩著 0→3 settle edge 進來的（前一步 AID 搜尋落地的
    // footer 列是空的 ⇒ pageState 0），nextEasyReadingState 的 1|2→3 永遠不成立；
    // 冷啟動又沒有 nativeArticleKey 可讓 reentry 那條路生效。所以落地必須明講。
    // 實測 2026-08-16：跳完停在原生模式，連 End 也切不回去。
    const h = makeHarness();
    atMainMenu(h);
    h.nav.startExternal("1gIeu-3A", "Gossiping");
    settle(h.queue, facts("clean-list", { boardName: "gossiping" }));
    settle(
      h.queue,
      facts("clean-list", { boardName: "gossiping", cursorRowNum: 42, curY: 10 })
    );
    expect(h.core.easyReading.ensureCalls).toBe(0); // 還沒落地
    settle(h.queue, facts("article"));
    expect(h.core.easyReading.ensureCalls).toBe(1);
    // 必須在 active 解鎖之後：easy_reading._send 的第一道閘門就是 active，
    // 沒解鎖就開好讀會讓它排出的第一個 PageDown 被整個吞掉（停在第一頁）。
    expect(h.core.easyReading.navActiveAtEnsure).toEqual([false]);
    // allowRetry=true：落地當下畫面可能還沒完整，留一次 one-shot 給下個 settle。
    expect(h.core.easyReading.ensureArgs).toEqual([true]);
  });

  test("跳完不出現「← 返回」pill（本來就沒有原文可回）", () => {
    const h = makeHarness({ articleBoard: "movie", scrollTop: 400 });
    atMainMenu(h);
    h.nav.startExternal("1gIeu-3A", "Gossiping");
    settle(h.queue, facts("clean-list", { boardName: "gossiping" }));
    settle(
      h.queue,
      facts("clean-list", { boardName: "gossiping", cursorRowNum: 42, curY: 10 })
    );
    settle(h.queue, facts("article"));
    expect(h.nav.active).toBe(false);
    expect(h.backButton.shown).toBe(false);
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("非主功能表、非文章（列表）→ 仍走 ← 退回主功能表的慢路徑", () => {
    const h = makeHarness({ footer: "" });
    h.termBuf.rowTexts = screen({ row0: "《Gossiping》", mark: "列表" });
    h.nav.startExternal("1gIeu-3A", "movie");
    expect(h.sent).toEqual(["\x1b[D\f"]);
  });

  test("進行中再來一個 deep link 會被拒絕（回 false，不插隊）", () => {
    const h = makeHarness();
    atMainMenu(h);
    expect(h.nav.startExternal("1gIeu-3A", "Gossiping")).toBe(true);
    expect(h.nav.startExternal("2AbCdEf0", "movie")).toBe(false);
    expect(h.sent).toEqual(["sGossiping\r\f"]);
  });

  // ---- 置底文（★ 列）----------------------------------------------------
  // read.c#select_by_aid **先**搜 .DIR.bottom 才搜 .DIR（read.c:403-424）⇒ 置底文
  // 的 #AID 搜尋會成功，游標就停在那一列上。而 PTT 在置底列印 ★ 取代序號
  // （bbs.c:843）⇒ 那一列的 cursorRowNum 必為 null。舊判準寫死
  // `cursorRowNum == null → false`，於是把「已經正確落地」讀成 miss、
  // 那個開文用的 ⏎ 永遠沒送出去（使用者回報：置底文跳過去卡在列表上進不了文章，
  // 例 https://www.ptt.cc/bbs/Android/M.1561302157.A.775.html）。
  const PINNED_ROW = ">   ★  m 1 6/01 arrenwu      轉 [公告] 板規";

  test("REGRESSION：#AID 落在置底 ★ 列（無序號）也要送 ⏎ 開文", () => {
    const h = makeHarness();
    atMainMenu(h);
    h.nav.startExternal("1gIeu-3A", "Android");
    settle(h.queue, facts("clean-list", { boardName: "android" }));
    expect(h.sent[1]).toBe("#1gIeu-3A\r\f");
    const rowTexts = new Array(24).fill("");
    rowTexts[10] = PINNED_ROW;
    settle(
      h.queue,
      facts("transient", {
        boardName: "android",
        cursorRowNum: null,
        curY: 10,
        rowTexts
      })
    );
    expect(h.sent[2]).toBe("\r\f");
    settle(h.queue, facts("article"));
    expect(h.nav.active).toBe(false);
    expect(h.hints[h.hints.length - 1]).toContain("已跳至");
  });

  // P51：從最近讀過／稍後再讀開回去（recent_articles.open 帶 quietLanding）落地不閃
  // 「已跳至 #AID」，但 15 秒的「跳至…」進度提示一樣要收掉，不能一路蓋進文章。
  test("quietLanding：落地不閃「已跳至」，只收掉進度提示；送的鍵不變", () => {
    const h = makeHarness();
    h.view.hideListHint = vi.fn();
    atMainMenu(h);
    expect(h.nav.startExternal("1gIeu-3A", "Android", null, { quietLanding: true })).toBe(true);
    expect(h.hints).toEqual(["跳至 #1gIeu-3A (Android)…"]);
    settle(h.queue, facts("clean-list", { boardName: "android" }));
    settle(h.queue, facts("clean-list", { boardName: "android", cursorRowNum: 123, curY: 10 }));
    settle(h.queue, facts("article"));
    expect(h.nav.active).toBe(false);
    expect(h.sent).toEqual(["sAndroid\r\f", "#1gIeu-3A\r\f", "\r\f"]);
    expect(h.hints.some((m) => m.includes("已跳至"))).toBe(false);
    expect(h.view.hideListHint).toHaveBeenCalledTimes(1);
    // 下一趟沒帶 ⇒ 照舊閃確認（旗標跟著 run，不會黏住）。
    atMainMenu(h);
    h.nav.startExternal("1gIeu-3A", "Android");
    settle(h.queue, facts("clean-list", { boardName: "android" }));
    settle(h.queue, facts("clean-list", { boardName: "android", cursorRowNum: 123, curY: 10 }));
    settle(h.queue, facts("article"));
    expect(h.hints[h.hints.length - 1]).toBe("已跳至 #1gIeu-3A");
    expect(h.view.hideListHint).toHaveBeenCalledTimes(1);
  });

  test("quietLanding：跳文失敗的提示照舊出現", () => {
    const h = makeHarness();
    h.view.hideListHint = vi.fn();
    atMainMenu(h);
    h.nav.startExternal("1gIeu-3A", "Android", null, { quietLanding: true });
    // 板跳之後一直沒有落地 ⇒ probe 逾時走 _fail。
    vi.advanceTimersByTime(60000);
    expect(h.nav.active).toBe(false);
    expect(h.hints[h.hints.length - 1]).toContain("AID 跳文失敗");
    expect(h.view.hideListHint).not.toHaveBeenCalled();
  });

  test("「找不到這個文章代碼」畫面仍判 miss（游標停在末列的 pressanykey）", () => {
    // read.c:466-476：move(21,0) clrtobot() → 訊息印在 rows-2、pressanykey bar
    // 在 rows-1（vtuikit.c#vshowmsg 的 move(b_lines,0)），游標留在 rows-1。
    const h = makeHarness();
    atMainMenu(h);
    h.nav.startExternal("1gIeu-3A", "Android");
    settle(h.queue, facts("clean-list", { boardName: "android" }));
    const rowTexts = new Array(24).fill("");
    rowTexts[22] = "找不到這個文章代碼(AID)，可能是文章已消失，或是你找錯看板了";
    rowTexts[23] = PRESS_ANY_KEY_ROW;
    const notFound = () =>
      facts("prompt", {
        boardName: "android",
        cursorRowNum: null,
        curY: 23,
        rowTexts
      });
    settle(h.queue, notFound());
    vi.advanceTimersByTime(STEP_PROBE_AFTER_MS); // soft → \f 探針
    settle(h.queue, notFound());
    expect(h.nav.active).toBe(false);
    expect(h.hints[h.hints.length - 1]).toContain("找不到文章");
  });

  test("缺 board 或 aid → 回 false，不送任何東西", () => {
    const h = makeHarness();
    atMainMenu(h);
    expect(h.nav.startExternal("1gIeu-3A", null)).toBe(false);
    expect(h.nav.startExternal(null, "Gossiping")).toBe(false);
    expect(h.sent).toEqual([]);
  });
});

// 「複製本篇連結」與跳轉共用同一段 Q 交易（queryPostAid），所以那三條 pttbbs
// 約束只會有一份實作。這裡守的是共用後的對外行為。
describe("queryPostAid / dismissPostInfo", () => {
  test("讀出 { aid, board }，且不可帶 fullRepaint", () => {
    const h = makeHarness();
    const got = [];
    h.nav.queryPostAid({ onDone: info => got.push(info), onFail: () => {} });
    expect(h.sent).toEqual(["Q"]); // 沒有 \f
    answerOriginInfo(h.queue, "1gKF7GO4", "movie");
    expect(got).toEqual([{ aid: "1gKF7GO4", board: "movie" }]);
  });

  test("框開了但這篇沒有 AID → onDone(null)，不是等到逾時", () => {
    const h = makeHarness();
    const got = [];
    h.nav.queryPostAid({ onDone: info => got.push(info), onFail: () => {} });
    answerOriginInfo(h.queue, null);
    expect(got).toEqual([null]);
  });

  test("REGRESSION：Q 之後 PTT 會回列表，reopenAfterPostInfo 要按 Enter 開回原篇", () => {
    // mbbsd/bbs.c:2375-2377：RET_DOQUERYINFO → view_postinfo(...) 之後
    // **return FULLUPDATE** ⇒ 離開 pager、重畫文章列表。跳轉路徑感覺不到是因為
    // 它下一步 s<board> 本來就是列表指令；「複製本篇連結」用同一個 Q，就會把
    // 使用者丟在列表上（實測 2026-08-16：複製完跳出文章）。
    const h = makeHarness();
    const done = [];
    h.nav.queryPostAid({ onDone: () => {}, onFail: () => {} });
    answerOriginInfo(h.queue, "1gKF7GO4");
    h.nav.reopenAfterPostInfo(12, { onDone: () => done.push(true) });
    // 空白關框（不可用 \f：io.c 的 system_key_hook 會吃掉，那不算一個按鍵）
    expect(h.sent[1]).toBe(" \f");
    settle(h.queue, facts("clean-list", { boardName: "C_Chat" }));
    // 游標還停在原篇（i_read 沒動過它）→ 一個 Enter 就開回去
    expect(h.sent[2]).toBe("\r\f");
    settle(h.queue, facts("article"));
    expect(done).toEqual([true]);
    // 閱讀位置一起帶回去
    expect(h.core.easyReading.restoreCalls).toEqual([12]);
  });

  test("關框後發現還在文章（框根本沒開）→ 不多按 Enter", () => {
    const h = makeHarness();
    const done = [];
    h.nav.queryPostAid({ onDone: () => {}, onFail: () => {} });
    answerOriginInfo(h.queue, "1gKF7GO4");
    h.nav.reopenAfterPostInfo(null, { onDone: () => done.push(true) });
    settle(h.queue, facts("article"));
    expect(h.sent).toHaveLength(2);
    expect(done).toEqual([true]);
  });

  test("跳轉路徑仍把關框併進 s<board>（回歸：抽共用後不可多送一鍵）", () => {
    const h = makeHarness();
    h.nav.start("1gIeu-3A", "Android");
    answerOriginInfo(h.queue, "1gKF7GO4");
    expect(h.sent[1]).toBe(" sAndroid\r\f");
  });
});

// ---------------------------------------------------------------------------
// 免費路徑：文章本文的「※ 文章網址:」那行就能換算出本篇 AID，省掉按 Q。
// 按 Q 的代價是 FULLUPDATE（bbs.c:2375-2377）＝被抛回文章列表，得再花 ␣ + ⏎
// 兩個指令回來，使用者看得到畫面在閃。
// 檔名 ⇄ AID 的換算對照值守在 aid_codec.test.js。
// ---------------------------------------------------------------------------
const URL_ROW = (board, fn) =>
  "※ 文章網址: https://www.ptt.cc/bbs/" + board + "/" + fn + ".html";
const BROWSERS_FN = "M.1786265274.A.5E3";
const BROWSERS_AID = "1gU3wwNZ";
// 網址列的前一列（mbbsd/edit.c#addsimplesignature 寫完「※ 發信站」，bbs.c 發文時 file_appendf
// 緊接著補「※ 文章網址」）。
const ORIGIN_ROW = "※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4 (臺灣)";
const OTHER_FN = "M.1700000000.A.ABC";

// 一個「人在文章裡、畫面上看得到文章網址那行」的原生畫面。
function articleScreenWithUrl(board = "Browsers", fn = BROWSERS_FN) {
  const rows = screen({ last: STATUS_ROW, mark: "文章內文" });
  rows[17] = ORIGIN_ROW;
  rows[18] = URL_ROW(board, fn);
  return rows;
}

describe("findLocalPostAid（免費取得本篇 AID）", () => {
  test("原生畫面上讀得到 ※ 文章網址 → 直接換算出 AID", () => {
    const { nav } = makeHarness({
      pageState: 3,
      articleBoard: "Browsers",
      screenRows: articleScreenWithUrl()
    });
    expect(nav.findLocalPostAid()).toEqual({
      board: "Browsers",
      aid: BROWSERS_AID
    });
  });

  test("看板比對不分大小寫", () => {
    const { nav } = makeHarness({
      pageState: 3,
      articleBoard: "browsers",
      screenRows: articleScreenWithUrl()
    });
    expect(nav.findLocalPostAid()).not.toBeNull();
  });

  // 轉錄文會原樣複製原文內容、連原文那行網址一起帶進來（bbs.c:2162-2179）。
  // pttbbs 擋掉同板轉錄（bbs.c:2097「同板不需轉錄。」）⇒ 看板不符就是原文，
  // 拿去用會複製到「別人那篇」的連結。
  test("看板不符（轉錄文帶進來的原文網址）→ null，退回按 Q", () => {
    const { nav } = makeHarness({
      pageState: 3,
      articleBoard: "Browsers",
      screenRows: articleScreenWithUrl("C_Chat")
    });
    expect(nav.findLocalPostAid()).toBeNull();
  });

  // REGRESSION（2026-10，scn-aid-back 錄製抓到；movie 板置底「電影板板規 2021/9/4」）：
  // 從**信箱**轉錄到看板（mbbsd/mail.c:2067 `※ [本文轉錄自 <id> 信箱]` ＋整封信 ＋
  // addforwardsignature）。信裡那篇可以來自同一個看板 ⇒ 看板守門擋不住；轉錄文本身
  // 沒有自己的「※ 文章網址」（只有 ※ 發信站／※ 轉錄者）。舊碼把原文的 AID 當本篇 ⇒
  // AID 跳文後「返回」落到原文、F2／右鍵複製到原文的連結。
  test("信箱轉錄文：轉錄標頭之後的網址屬於被轉錄的原文（即使同板）→ null，退回按 Q", () => {
    const rows = screen({ last: STATUS_ROW });
    rows[3] = "※ [本文轉錄自 someone 信箱]";
    rows[10] = URL_ROW("Browsers", BROWSERS_FN);
    rows[12] = "※ 轉錄者: someone (1.2.3.4 臺灣), 09/04/2021 19:59:47";
    const { nav } = makeHarness({ pageState: 3, articleBoard: "Browsers", screenRows: rows });
    expect(nav.findLocalPostAid()).toBeNull();
  });

  test("信箱轉錄文（好讀累積頁，標頭與網址分在不同次掃描）→ null", () => {
    const acc = ["作者 someone (某人) 看板 Browsers", "標題 Fw: [公告] 板規", "", "※ [本文轉錄自 someone 信箱]"];
    const { nav, termBuf } = makeHarness({ pageState: 3, articleBoard: "Browsers", pageLines: acc });
    expect(nav.findLocalPostAid()).toBeNull();
    termBuf.pageLines = acc.concat(["原文內文……", URL_ROW("Browsers", BROWSERS_FN)]);
    expect(nav.findLocalPostAid()).toBeNull();
  });

  // 內文裡貼了同板另一篇的「※ 文章網址」（系列文的前情提要常這樣貼）：系統寫的那行一定緊接在
  // 「※ 發信站」之後（edit.c#addsimplesignature＋bbs.c 的 file_appendf），內文貼的沒有。認錯的話
  // 新推文紀錄／最近讀過記到別篇，長推文的守門會送那篇的 #AID、推到別篇。
  test("內文貼的同板網址（前一列不是 ※ 發信站）不算本篇；文末系統寫的才算", () => {
    const rows = screen({ last: STATUS_ROW });
    rows[4] = "前情提要：";
    rows[5] = URL_ROW("Browsers", OTHER_FN);
    rows[17] = ORIGIN_ROW;
    rows[18] = URL_ROW("Browsers", BROWSERS_FN);
    const { nav } = makeHarness({ pageState: 3, articleBoard: "Browsers", screenRows: rows });
    expect(nav.findLocalPostAid()).toEqual({ board: "Browsers", aid: BROWSERS_AID });
  });

  test("內文貼的同板網址（好讀累積頁，系統那行還沒載到）→ null，不是那篇", () => {
    const acc = ["作者 someone (某人) 看板 Browsers", "標題 [心得] 續集", "", "前情提要：", URL_ROW("Browsers", OTHER_FN), "內文……"];
    const { nav, termBuf } = makeHarness({ pageState: 3, articleBoard: "Browsers", pageLines: acc });
    expect(nav.findLocalPostAid()).toBeNull();
    termBuf.pageLines = acc.concat(["--", ORIGIN_ROW, URL_ROW("Browsers", BROWSERS_FN)]);
    expect(nav.findLocalPostAid()).toEqual({ board: "Browsers", aid: BROWSERS_AID });
  });

  test("網址列在畫面第一列（發信站捲出畫面外）→ null，退回按 Q", () => {
    const rows = screen({ last: STATUS_ROW });
    rows[0] = URL_ROW("Browsers", BROWSERS_FN);
    const { nav } = makeHarness({ pageState: 3, articleBoard: "Browsers", screenRows: rows });
    expect(nav.findLocalPostAid()).toBeNull();
  });

  test("引言列（回文帶進來的原文網址）不算", () => {
    const rows = screen({ last: STATUS_ROW });
    rows[5] = ": " + URL_ROW("Browsers", BROWSERS_FN);
    const { nav } = makeHarness({
      pageState: 3,
      articleBoard: "Browsers",
      screenRows: rows
    });
    expect(nav.findLocalPostAid()).toBeNull();
  });

  test("不在文章裡（pageState ≠ 3）→ null", () => {
    const { nav } = makeHarness({
      pageState: 1,
      articleBoard: "Browsers",
      screenRows: articleScreenWithUrl()
    });
    expect(nav.findLocalPostAid()).toBeNull();
  });

  // 站內信／精華區沒有看板 ⇒ 守不了門，也組不出連結。
  test("沒有 _articleBoard → null", () => {
    const { nav } = makeHarness({
      pageState: 3,
      articleBoard: null,
      screenRows: articleScreenWithUrl()
    });
    expect(nav.findLocalPostAid()).toBeNull();
  });

  test("畫面上沒有那行 → null", () => {
    const { nav } = makeHarness({
      pageState: 3,
      articleBoard: "Browsers",
      screenRows: screen({ last: STATUS_ROW, mark: "文章內文" })
    });
    expect(nav.findLocalPostAid()).toBeNull();
  });

  describe("好讀累積長頁（pageLines）", () => {
    test("累積頁裡的那行也讀得到", () => {
      const acc = ["作者 someone (某人) 看板 Browsers", "標題 [問題] 測試"];
      acc[39] = ORIGIN_ROW;
      acc[40] = URL_ROW("Browsers", BROWSERS_FN);
      const { nav } = makeHarness({
        pageState: 3,
        articleBoard: "Browsers",
        pageLines: acc
      });
      expect(nav.findLocalPostAid()).toEqual({
        board: "Browsers",
        aid: BROWSERS_AID
      });
    });

    // 長文從第一頁開始讀時那行還沒進來；翻到末尾才會出現。之前掃過的列不重掃
    // （pageLines 只會往後 concat），但新來的列必須掃得到。
    test("長文：先掃不到，累積到末尾後掃得到", () => {
      const acc = ["作者 someone (某人) 看板 Browsers"];
      const { nav, termBuf } = makeHarness({
        pageState: 3,
        articleBoard: "Browsers",
        pageLines: acc
      });
      expect(nav.findLocalPostAid()).toBeNull();
      acc.push("內文……");
      acc.push(ORIGIN_ROW);
      acc.push(URL_ROW("Browsers", BROWSERS_FN));
      termBuf.pageLines = acc;
      expect(nav.findLocalPostAid()).toEqual({
        board: "Browsers",
        aid: BROWSERS_AID
      });
    });

    // 換文章時 pageLines 被清掉重建。快取沒歸零的話，下一篇會拿到上一篇的 AID
    // ——同一個看板的下一篇正好躲過看板守門，症狀是「複製到剛剛那篇的連結」。
    test("換文章（pageLines 重建）→ 快取歸零，不得沿用上一篇的 AID", () => {
      const first = ["作者 aaa (甲) 看板 Browsers", ORIGIN_ROW, URL_ROW("Browsers", BROWSERS_FN)];
      const { nav, termBuf } = makeHarness({
        pageState: 3,
        articleBoard: "Browsers",
        pageLines: first
      });
      expect(nav.findLocalPostAid().aid).toBe(BROWSERS_AID);
      // 同看板的下一篇，且累積頁還沒長到那行。
      termBuf.pageLines = ["作者 bbb (乙) 看板 Browsers", "內文……"];
      expect(nav.findLocalPostAid()).toBeNull();
    });

    test("累積頁變長但首列換了（同樣是換文章）→ 也要歸零", () => {
      const first = ["作者 aaa (甲) 看板 Browsers", ORIGIN_ROW, URL_ROW("Browsers", BROWSERS_FN)];
      const { nav, termBuf } = makeHarness({
        pageState: 3,
        articleBoard: "Browsers",
        pageLines: first
      });
      expect(nav.findLocalPostAid().aid).toBe(BROWSERS_AID);
      termBuf.pageLines = ["作者 bbb (乙) 看板 Browsers", "內文……", "更多內文"];
      expect(nav.findLocalPostAid()).toBeNull();
    });

    // 同作者、同看板的兩篇：首列（「作者 … 看板 …」）一字不差，下一篇又比較長 ⇒
    // 首列與長度兩個訊號都認不出換了文章。換文章的權威訊號是 term_view 在
    // accumulatePageLines 'rebuild' 分支 bump 的 _articleInstanceId。
    // 症狀：長推文的守門拿上一篇的 AID 送 #AID ⇒ 推到上一篇讀的那篇。
    test("同作者同看板、下一篇較長（首列相同）→ 換文章仍要歸零", () => {
      const HEAD = "作者 aaa (甲) 看板 Browsers";
      const first = [HEAD, ORIGIN_ROW, URL_ROW("Browsers", BROWSERS_FN)];
      const { nav, termBuf, view } = makeHarness({
        pageState: 3,
        articleBoard: "Browsers",
        pageLines: first
      });
      view._articleInstanceId = 1;
      expect(nav.findLocalPostAid().aid).toBe(BROWSERS_AID);

      view._articleInstanceId = 2;
      termBuf.pageLines = [HEAD, "內文……", "更多內文", "還有內文"];
      expect(nav.findLocalPostAid()).toBeNull();

      const OTHER_FN = "M.1786269999.A.123";
      termBuf.pageLines = termBuf.pageLines.concat([ORIGIN_ROW, URL_ROW("Browsers", OTHER_FN)]);
      expect(nav.findLocalPostAid()).toEqual({ board: "Browsers", aid: fnToAid(OTHER_FN) });
    });
  });
});

describe("resolvePostAid（免費路徑優先，落空才按 Q）", () => {
  test("免費路徑：一個指令都不送，meta.boxOpen 為 false", () => {
    const { nav, sent } = makeHarness({
      pageState: 3,
      articleBoard: "Browsers",
      screenRows: articleScreenWithUrl()
    });
    const done = [];
    nav.resolvePostAid({
      kind: "t",
      onDone: (info, meta) => done.push({ info, meta }),
      onFail: () => done.push("fail")
    });
    expect(sent).toEqual([]);
    expect(done).toEqual([
      {
        info: { board: "Browsers", aid: BROWSERS_AID },
        meta: { boxOpen: false }
      }
    ]);
  });

  test("落空：照舊送 Q，meta.boxOpen 為 true", () => {
    const { nav, queue, sent } = makeHarness();
    const done = [];
    nav.resolvePostAid({
      kind: "t",
      onDone: (info, meta) => done.push({ info, meta }),
      onFail: () => done.push("fail")
    });
    expect(sent).toEqual(["Q"]);
    answerOriginInfo(queue, "1gKF7GO4");
    expect(done).toEqual([
      {
        info: { aid: "1gKF7GO4", board: "C_Chat" },
        meta: { boxOpen: true }
      }
    ]);
  });
});

describe("正向跳轉走免費路徑", () => {
  test("不送 Q，板跳指令也不得帶關框用的前導空白", () => {
    // 帶前導空白的話，那個空白在 pager 裡是 PageDown（框根本沒開）。
    const { nav, sent } = makeHarness({
      pageState: 3,
      articleBoard: "Browsers",
      screenRows: articleScreenWithUrl()
    });
    nav.start("1gIeu-3A", "Android");
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toBe("Q");
    expect(sent[0].startsWith("sAndroid\r")).toBe(true);
  });

  test("免費路徑取得的 AID 一樣被升級成返回錨點", () => {
    const h = makeHarness({
      pageState: 3,
      articleBoard: "Browsers",
      screenRows: articleScreenWithUrl(),
      listAnchor: { board: "Browsers", num: 100, subject: "[閒聊] 原本那篇" }
    });
    h.nav.start("1gIeu-3A", "Android");
    // 沒有 Q 那一步，板跳是第一個指令 ⇒ 直接餵板跳之後的畫面。
    settle(h.queue, facts("clean-list", { boardName: "Android" }));
    settle(
      h.queue,
      facts("clean-list", { boardName: "Android", cursorRowNum: 5, curY: 10 })
    );
    settle(h.queue, facts("article"));
    expect(h.nav.canGoBack()).toBe(true);
    // 錨點升級成「本篇自己的 AID」——這正是免費路徑要拿到的東西（沒升級的話
    // 會退回列表第 100 篇那種會被刪文位移的錨點）。
    expect(h.backButton.label).toBe("#" + BROWSERS_AID);
  });
});

// ---------------------------------------------------------------------------
// 超長文（行號四位數以上）：more.c#common_pmore_footer_handler 依剩餘寬度挑
// footer，放不下「(y)回應」那段時退成「(h)說明 (←/q)離開」——跟站內信／精華區的
// 短版一字不差 ⇒ parsePagerFooterContext 只能說 'unknown'。
// 從 `/` 搜尋清單開的超長文點 AID → 不按 Q →
// 返回錨點只剩搜尋空間的序號 45 → 返回跑到主清單第 45 篇（別篇）。
// ---------------------------------------------------------------------------
describe("超長文（footer 被行號擠掉）", () => {
  const ESC_LEFT = "\x1b[D\f";
  // 錄製檔 t=6853 的末列原文。
  const SQUEEZED_ROW =
    "  瀏覽 第 257/361 頁 ( 68%)  目前顯示: 第 6657~6683 行      (h)說明 (←/q)離開  ";
  const listRow = title => " ".repeat(29) + title;
  const FILTERED_ANCHOR = {
    board: "EZsoft",
    num: 45,
    subject: subjectOfListText(listRow("[推薦] PTT Star瀏覽器"))
  };

  test("前提：這個 footer 單看確實分不出 currstat，但仍是 pager 狀態列", () => {
    const { nav } = makeHarness({ footer: SQUEEZED_ROW });
    expect(nav._pagerContext()).toBe("unknown");
    expect(parseStatusRow(SQUEEZED_ROW)).toBeTruthy();
  });

  test("REGRESSION：列表好讀開的文章 ⇒ 證明是 READING，照樣按 Q 升級成 AID 錨點", () => {
    const h = makeHarness({ footer: SQUEEZED_ROW, listAnchor: FILTERED_ANCHOR });
    h.nav.start("1ghhUROp", "PttCurrent");
    expect(h.sent).toEqual(["Q"]);
    answerOriginInfo(h.queue, "1gU3wwNZ", "EZsoft");
    expect(h.sent[1]).toBe(" sPttCurrent\r\f");
    settle(h.queue, facts("clean-list", { boardName: "PttCurrent" }));
    settle(
      h.queue,
      facts("clean-list", { boardName: "PttCurrent", cursorRowNum: 9, curY: 10 })
    );
    settle(h.queue, facts("article"));
    h.sent.length = 0;
    // 落地的目標是短文（錄製檔：PttCurrent 那篇 1/1 頁），footer 完整。
    h.termBuf.rowTexts = screen({ last: STATUS_ROW, mark: "目標文章" });
    h.nav.back();
    expect(h.sent[0]).toBe("sEZsoft\r\f");
    settle(h.queue, facts("clean-list", { boardName: "EZsoft" }));
    // 本 bug 的判準：#AID，不是搜尋空間的 "45\r\f"
    expect(h.sent[1]).toBe("#1gU3wwNZ\r\f");
  });

  test("沒有列表證據也沒有看板（站內信）⇒ 不按 Q，直接走退出路徑", () => {
    const { nav, sent } = makeHarness({ footer: SQUEEZED_ROW });
    nav.start("1ghhUROp", "PttCurrent");
    expect(sent).toEqual([ESC_LEFT]);
  });

  test("沒有列表證據但 header 有看板 ⇒ 照樣按 Q；資訊框出現＝證明 READING，走列表上的 s", () => {
    const h = makeHarness({ footer: SQUEEZED_ROW, articleBoard: "EZsoft" });
    h.nav.start("1ghhUROp", "PttCurrent");
    expect(h.sent).toEqual(["Q"]);
    answerOriginInfo(h.queue, "1gU3wwNZ", "EZsoft");
    expect(h.sent[1]).toBe(" sPttCurrent\r\f");
    settle(h.queue, facts("clean-list", { boardName: "PttCurrent" }));
    settle(
      h.queue,
      facts("clean-list", { boardName: "PttCurrent", cursorRowNum: 9, curY: 10 })
    );
    settle(h.queue, facts("article"));
    expect(h.backButton.label).toBe("#1gU3wwNZ");
  });

  test("精華區（Q 不出框，announce.c 直接退回目錄）⇒ probe → miss → 改走退出路徑，不失敗", () => {
    const h = makeHarness({ footer: SQUEEZED_ROW, articleBoard: "EZsoft" });
    h.nav.start("1ghhUROp", "PttCurrent");
    expect(h.sent).toEqual(["Q"]);
    const menu = screen({ row0: "【精華文章】", mark: "  1. ◆ 軟體介紹" });
    settle(h.queue, facts("transient", { rowTexts: menu }));
    vi.advanceTimersByTime(STEP_PROBE_AFTER_MS); // probe
    expect(h.sent[1]).toBe("\f");
    settle(h.queue, facts("transient", { rowTexts: menu })); // miss
    expect(h.nav.active).toBe(true);
    expect(h.sent[2]).toBe(ESC_LEFT);
    expect(h.sent.some(s => s.indexOf("PttCurrent") !== -1)).toBe(false);
    settle(h.queue, facts("menu", { rowTexts: MAIN_MENU_SCREEN }));
    expect(h.sent[3]).toBe("sPttCurrent\r\f");
  });

  test("退出路徑也先走免費路徑：累積頁讀得到本篇網址 ⇒ 返回錨點是 AID", () => {
    const acc = ["作者 someone (某人) 看板 Browsers"];
    acc[9299] = ORIGIN_ROW;
    acc[9300] = URL_ROW("Browsers", BROWSERS_FN);
    const h = makeHarness({
      footer: SQUEEZED_ROW,
      pageState: 3,
      articleBoard: "Browsers",
      pageLines: acc
    });
    h.nav.start("1ghhUROp", "PttCurrent");
    expect(h.sent).toEqual([ESC_LEFT]); // 免費路徑零指令
    settle(h.queue, facts("menu", { rowTexts: MAIN_MENU_SCREEN }));
    expect(h.sent[1]).toBe("sPttCurrent\r\f");
    settle(h.queue, facts("clean-list", { boardName: "PttCurrent" }));
    settle(
      h.queue,
      facts("clean-list", { boardName: "PttCurrent", cursorRowNum: 9, curY: 10 })
    );
    settle(h.queue, facts("article"));
    expect(h.backButton.label).toBe("#" + BROWSERS_AID);
  });

  // 好讀自動翻頁的 PageUp 回應晚於第一個 ← 才到。
  test("REGRESSION：退出途中的文章幀（遲到的翻頁回應）不算退了一層", () => {
    const { nav, queue, sent } = makeHarness({ footer: SQUEEZED_ROW });
    nav.start("1ghhUROp", "PttCurrent");
    expect(sent).toEqual([ESC_LEFT]);
    settle(
      queue,
      facts("article", { rowTexts: screen({ last: SQUEEZED_ROW, mark: "上一頁的內文" }) })
    );
    // 舊版：簽章不同 ⇒ 當成退了一層、立刻再送一個 ←（之後每步慢一拍，最後一個 ←
    // 落在主功能表上把反白移到 G)oodbye）。
    expect(sent).toHaveLength(1);
    expect(nav.active).toBe(true);
    settle(
      queue,
      facts("clean-list", { rowTexts: screen({ row0: "【板主:alicekey】", mark: "列表" }) })
    );
    expect(sent[1]).toBe(ESC_LEFT);
    settle(queue, facts("menu", { rowTexts: MAIN_MENU_SCREEN }));
    expect(sent[2]).toBe("sPttCurrent\r\f");
  });
});

// ---------------------------------------------------------------------------
// 重新整理本篇（screen_refresh.js 的文章分支）：跳到「同一篇」＋還原閱讀位置。
// 不用 ←→：← 回列表後 → 開的是 crs_ln 那個序號，列表重讀後可能已是別篇（置底文
// 在新文進來時整排後移）。docs/screen-refresh.md。
// ---------------------------------------------------------------------------
describe("refresh（重新整理本篇）", () => {
  const ARTICLE_LANDING = () =>
    facts("transient", { boardName: "C_Chat", cursorRowNum: 4321, curY: 10 });

  test("Q 取 AID → s本板⏎ → #AID⏎ → ⏎；不動返回堆疊；忙碌提示是「重新整理中」", () => {
    const { nav, queue, sent, hints, core, backButton } = makeHarness({
      pageState: 3,
      articleBoard: "C_Chat"
    });
    expect(nav.refresh()).toBe(true);
    expect(serializedOpHint({ aidNavigation: nav })).toBe("重新整理中，請稍候…");
    expect(sent).toEqual(["Q"]);
    answerOriginInfo(queue, "1gKF7GO4");
    expect(sent[1]).toBe(" sC_Chat\r\f");
    settle(queue, facts("clean-list", { boardName: "C_Chat" }));
    expect(sent[2]).toBe("#1gKF7GO4\r\f");
    settle(queue, ARTICLE_LANDING());
    expect(sent[3]).toBe("\r\f");
    settle(queue, facts("article"));
    expect(nav.active).toBe(false);
    expect(nav.opHint).toBe(null);
    expect(core.easyReading.ensureCalls).toBe(1);
    expect(hints.at(-1)).toBe("已重新整理");
    expect(backButton.shown).toBe(false);
    expect(nav.canGoBack()).toBe(false);
  });

  test("畫面上有 ※ 文章網址 ⇒ 免費取得 AID，不按 Q（畫面不閃）", () => {
    const { nav, sent } = makeHarness({
      pageState: 3,
      articleBoard: "Browsers",
      screenRows: articleScreenWithUrl()
    });
    nav.refresh();
    expect(sent).toEqual(["sBrowsers\r\f"]);
  });

  test("站內信／不在文章裡／不知道看板 ⇒ 不接，什麼都不送", () => {
    const mail = makeHarness({ pageState: 3, articleBoard: "C_Chat", footer: MAIL_STATUS_ROW });
    expect(mail.nav.refresh()).toBe(false);
    expect(mail.sent).toEqual([]);
    const list = makeHarness({ pageState: 2, articleBoard: "C_Chat" });
    expect(list.nav.refresh()).toBe(false);
    const noBoard = makeHarness({ pageState: 3 });
    expect(noBoard.nav.refresh()).toBe(false);
    expect(noBoard.nav.active).toBe(false);
  });

  test("好讀：還原原本那一列；原本在文末（已讀到底）⇒ 黏回文末看新推文", () => {
    const mid = makeHarness({ pageState: 3, articleBoard: "C_Chat", scrollTop: 400, chh: 20 });
    mid.core.easyReading._enabled = true;
    mid.view.mainDisplay.scrollHeight = 5000;
    mid.view.mainDisplay.clientHeight = 600;
    mid.nav.refresh();
    answerOriginInfo(mid.queue, "1gKF7GO4");
    settle(mid.queue, facts("clean-list", { boardName: "C_Chat" }));
    settle(mid.queue, ARTICLE_LANDING());
    settle(mid.queue, facts("article"));
    expect(mid.core.easyReading.restoreCalls).toEqual([20]);

    const end = makeHarness({ pageState: 3, articleBoard: "C_Chat", scrollTop: 4400, chh: 20 });
    const er = end.core.easyReading;
    er._enabled = true;
    er.easyReadingReachedPageEnd = true;
    er.requestScrollToBottom = vi.fn();
    end.view.mainDisplay.scrollHeight = 5000;
    end.view.mainDisplay.clientHeight = 600;
    end.nav.refresh();
    answerOriginInfo(end.queue, "1gKF7GO4");
    settle(end.queue, facts("clean-list", { boardName: "C_Chat" }));
    settle(end.queue, ARTICLE_LANDING());
    settle(end.queue, facts("article"));
    expect(er.requestScrollToBottom).toHaveBeenCalledTimes(1);
    expect(er.restoreCalls).toEqual([]);
  });

  test("原生 pmore 停在 100% ⇒ 重開後送原生 End", () => {
    const END_ROW = "  瀏覽 第 2/2 頁 (100%)  目前顯示: 第 24~40 行  (y)回應(X%)推文(h)說明(←)離開 ";
    const { nav, queue, core } = makeHarness({ pageState: 3, articleBoard: "C_Chat", footer: END_ROW });
    core.sendMachineBytes = vi.fn(() => true);
    nav.refresh();
    answerOriginInfo(queue, "1gKF7GO4");
    settle(queue, facts("clean-list", { boardName: "C_Chat" }));
    settle(queue, ARTICLE_LANDING());
    settle(queue, facts("article"));
    expect(core.sendMachineBytes).toHaveBeenCalledWith("\x1b[4~");
  });

  test("本篇沒有 AID ⇒ 關框＋⏎ 重開游標下那篇（Q 的 FULLUPDATE 已重讀列表），並明講", () => {
    const { nav, queue, sent, hints } = makeHarness({ pageState: 3, articleBoard: "C_Chat" });
    nav.refresh();
    answerOriginInfo(queue, null);
    expect(sent[1]).toBe(" \f");
    settle(queue, facts("clean-list", { boardName: "C_Chat" }));
    expect(sent[2]).toBe("\r\f");
    settle(queue, facts("article"));
    expect(nav.active).toBe(false);
    expect(hints.at(-1)).toContain("依列表位置重開");
  });

  test("找不到本篇（剛被刪）⇒ 看得到的失敗，解鎖", () => {
    const { nav, queue, hints } = makeHarness({ pageState: 3, articleBoard: "C_Chat" });
    nav.refresh();
    answerOriginInfo(queue, "1gKF7GO4");
    settle(queue, facts("clean-list", { boardName: "C_Chat" }));
    settle(queue, facts("prompt"));
    vi.advanceTimersByTime(STEP_PROBE_AFTER_MS);
    settle(queue, facts("prompt"));
    expect(nav.active).toBe(false);
    expect(nav.opHint).toBe(null);
    expect(hints.at(-1)).toMatch(/^重新整理失敗：找不到文章 #1gKF7GO4/);
    // 下一輪跳文的失敗訊息不可以沿用「重新整理」措辭。
    nav.start("1gIeu-3A", "Android");
    answerOriginInfo(queue, "1gKF7GO4");
    vi.advanceTimersByTime(BOARD_PROBE_AFTER_MS);
    vi.advanceTimersByTime(STEP_PROBE_WINDOW_MS);
    expect(hints.at(-1)).toMatch(/^AID 跳文失敗/);
  });
});

describe("agent 工具的跳法（startBoard／startNum）", () => {
  const atMainMenu = h => {
    h.termBuf.rowTexts = MAIN_MENU_SCREEN;
  };
  // 板尾畫面：條目在 3..10，游標停在最後一列（第 10 列），其下全空。
  const endScreen = () => {
    const rowTexts = new Array(24).fill("");
    for (let r = 3; r <= 10; r++) rowTexts[r] = " 78029" + r + " + 110/14 someone      □ [問卦] t";
    rowTexts[23] = " 文章選讀  (y)回應(X)推文";
    return rowTexts;
  };

  test("startBoard end：s<board>⏎ → End → 停在板尾，onEnd ok，不碰返回堆疊", () => {
    const h = makeHarness();
    atMainMenu(h);
    const ends = [];
    expect(h.nav.startBoard("Gossiping", { end: true }, r => ends.push(r))).toBe(true);
    expect(h.sent).toEqual(["sGossiping\r\f"]);
    settle(h.queue, facts("clean-list", { boardName: "gossiping", curY: 5 }));
    expect(h.sent[1]).toBe("\x1b[4~\f");
    settle(h.queue, facts("clean-list", { boardName: "gossiping", curY: 10, rowTexts: endScreen() }));
    expect(h.nav.active).toBe(false);
    expect(ends).toEqual([{ ok: true }]);
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("startBoard 不帶 end：落地即結束，不送 End", () => {
    const h = makeHarness();
    atMainMenu(h);
    const ends = [];
    h.nav.startBoard("Gossiping", {}, r => ends.push(r));
    settle(h.queue, facts("clean-list", { boardName: "gossiping" }));
    expect(h.sent).toEqual(["sGossiping\r\f"]);
    expect(ends).toEqual([{ ok: true }]);
  });

  test("End 的回應還不是板尾（游標下方還有條目）⇒ 不算落地", () => {
    const h = makeHarness();
    atMainMenu(h);
    h.nav.startBoard("Gossiping", { end: true });
    settle(h.queue, facts("clean-list", { boardName: "gossiping" }));
    settle(h.queue, facts("clean-list", { boardName: "gossiping", curY: 5, rowTexts: endScreen() }));
    expect(h.nav.active).toBe(true);
  });

  test("startNum：板跳 → <編號>⏎ → ⏎ 開文，好讀接手，onEnd ok", () => {
    const h = makeHarness();
    atMainMenu(h);
    const ends = [];
    expect(h.nav.startNum("Gossiping", 780297, r => ends.push(r))).toBe(true);
    settle(h.queue, facts("clean-list", { boardName: "gossiping" }));
    expect(h.sent[1]).toBe("780297\r\f");
    // 游標停在別篇 ⇒ 還沒落地
    settle(h.queue, facts("transient", { boardName: "gossiping", cursorRowNum: 780296, curY: 9 }));
    expect(h.sent.length).toBe(2);
    settle(h.queue, facts("transient", { boardName: "gossiping", cursorRowNum: 780297, curY: 10 }));
    expect(h.sent[2]).toBe("\r\f");
    settle(h.queue, facts("article"));
    expect(h.nav.active).toBe(false);
    expect(h.core.easyReading.ensureCalls).toBe(1);
    expect(ends).toEqual([{ ok: true }]);
  });

  // 雙欄閱讀／讀完接著讀：編號來自列表快照，之後有人刪文就是別篇。verify 認不出游標那列
  // ⇒ 不 ⏎，停在列表（開錯篇會把別篇記成讀過，收不回來）。
  test("startNum 帶 verify：游標那列認不出 ⇒ 不 ⏎、onEnd ok:false；認得出 ⇒ 照開", () => {
    const row = (num, title) => {
      const rowTexts = new Array(24).fill("");
      rowTexts[10] = ">" + String(num).padStart(6) + "   110/14 someone      □ " + title;
      return rowTexts;
    };
    const run = (title) => {
      const h = makeHarness();
      atMainMenu(h);
      const ends = [];
      const seen = [];
      const verify = (text) => {
        seen.push(text);
        return text.includes("[問卦] 要的那篇");
      };
      expect(h.nav.startNum("Gossiping", 780297, (r) => ends.push(r), verify)).toBe(true);
      settle(h.queue, facts("clean-list", { boardName: "gossiping" }));
      settle(h.queue, facts("transient", { boardName: "gossiping", cursorRowNum: 780297, curY: 10, rowTexts: row(780297, title) }));
      return { h, ends, seen };
    };
    const bad = run("[問卦] 別篇");
    expect(bad.seen).toEqual([row(780297, "[問卦] 別篇")[10]]);
    expect(bad.h.sent).toEqual(["sGossiping\r\f", "780297\r\f"]);
    expect(bad.h.nav.active).toBe(false);
    expect(bad.ends).toEqual([expect.objectContaining({ ok: false })]);

    const good = run("[問卦] 要的那篇");
    expect(good.h.sent[2]).toBe("\r\f");
  });

  test("板名錯（落不了地）⇒ onEnd ok:false 帶原因，解鎖", () => {
    const h = makeHarness();
    atMainMenu(h);
    const ends = [];
    h.nav.startBoard("NoSuchBoard", { end: true }, r => ends.push(r));
    vi.advanceTimersByTime(BOARD_PROBE_AFTER_MS);
    settle(h.queue, facts("menu", { rowTexts: MAIN_MENU_SCREEN }));
    expect(h.nav.active).toBe(false);
    expect(ends.length).toBe(1);
    expect(ends[0].ok).toBe(false);
    expect(ends[0].error).toContain("NoSuchBoard");
  });

  test("進行中拒絕再開；參數不合法拒絕", () => {
    const h = makeHarness();
    atMainMenu(h);
    h.nav.startBoard("Gossiping", {});
    expect(h.nav.startNum("Gossiping", 1)).toBe(false);
    expect(h.nav.startPinned("Gossiping", 0)).toBe(false);
    expect(makeHarness().nav.startNum("Gossiping", 0)).toBe(false);
    expect(makeHarness().nav.startBoard("", {})).toBe(false);
    expect(makeHarness().nav.startBoard("Gossiping", { num: 0 })).toBe(false);
    expect(makeHarness().nav.startPinned("Gossiping", -1)).toBe(false);
    expect(makeHarness().nav.startPinned("Gossiping", 1.5)).toBe(false);
  });

  test("startBoard num（agent 列更舊的頁）：板跳 → <編號>⏎ → 停在列表，不送 ⏎ 開文", () => {
    const h = makeHarness();
    atMainMenu(h);
    const ends = [];
    expect(h.nav.startBoard("Gossiping", { num: 780200 }, r => ends.push(r))).toBe(true);
    settle(h.queue, facts("clean-list", { boardName: "gossiping" }));
    expect(h.sent[1]).toBe("780200\r\f");
    settle(h.queue, facts("transient", { boardName: "gossiping", cursorRowNum: 780200, curY: 8 }));
    expect(h.sent.length).toBe(2);
    expect(h.nav.active).toBe(false);
    expect(h.core.easyReading.ensureCalls).toBe(0);
    expect(ends).toEqual([{ ok: true }]);
    expect(h.nav.canGoBack()).toBe(false);
  });

  // 板尾：一般文章 3..7，置底 8..10（★），游標停在最後一篇置底。
  const pinnedEndScreen = () => {
    const rowTexts = new Array(24).fill("");
    for (let r = 3; r <= 7; r++) rowTexts[r] = " 78029" + r + " + 110/14 someone      □ [問卦] t";
    for (let r = 8; r <= 10; r++) rowTexts[r] = "     ★  !   2/21 boardmod     □ [公告] 板規" + r;
    rowTexts[10] = ">" + rowTexts[10].slice(1);
    rowTexts[23] = " 文章選讀  (y)回應(X)推文";
    return rowTexts;
  };

  test("startPinned：板跳 → End → ↑×k 到第 index 篇置底 → ⏎ 開文，onEnd ok", () => {
    const h = makeHarness();
    atMainMenu(h);
    const ends = [];
    expect(h.nav.startPinned("Gossiping", 0, r => ends.push(r))).toBe(true);
    settle(h.queue, facts("clean-list", { boardName: "gossiping", curY: 5 }));
    expect(h.sent[1]).toBe("\x1b[4~\f");
    settle(h.queue, facts("clean-list", { boardName: "gossiping", curY: 10, rowTexts: pinnedEndScreen() }));
    // 第 0 篇置底在第 8 列，游標在第 10 列 ⇒ ↑ 兩次
    expect(h.sent[2]).toBe("\x1b[A\x1b[A\f");
    // 還沒到（停在第 9 列）⇒ 不開
    settle(h.queue, facts("clean-list", { boardName: "gossiping", curY: 9, rowTexts: pinnedEndScreen() }));
    expect(h.sent.length).toBe(3);
    settle(h.queue, facts("clean-list", { boardName: "gossiping", curY: 8, rowTexts: pinnedEndScreen() }));
    expect(h.sent[3]).toBe("\r\f");
    settle(h.queue, facts("article"));
    expect(h.nav.active).toBe(false);
    expect(ends).toEqual([{ ok: true }]);
  });

  test("startPinned：游標已在那一篇 ⇒ 不送 ↑，直接 ⏎", () => {
    const h = makeHarness();
    atMainMenu(h);
    h.nav.startPinned("Gossiping", 2);
    settle(h.queue, facts("clean-list", { boardName: "gossiping", curY: 5 }));
    settle(h.queue, facts("clean-list", { boardName: "gossiping", curY: 10, rowTexts: pinnedEndScreen() }));
    expect(h.sent[2]).toBe("\r\f");
  });

  test("startPinned：板尾沒有那一篇置底 ⇒ 停手失敗，不送 ↑ 也不開文", () => {
    const h = makeHarness();
    atMainMenu(h);
    const ends = [];
    h.nav.startPinned("Gossiping", 3, r => ends.push(r));
    settle(h.queue, facts("clean-list", { boardName: "gossiping", curY: 5 }));
    settle(h.queue, facts("clean-list", { boardName: "gossiping", curY: 10, rowTexts: pinnedEndScreen() }));
    expect(h.sent.length).toBe(2);
    expect(h.nav.active).toBe(false);
    expect(ends[0].ok).toBe(false);
    expect(ends[0].error).toContain("置底");
  });
});

describe("numJumpLanded／endLanded", () => {
  test("numJumpLanded 要編號相符且停在條目區行首", () => {
    const f = over => facts("transient", { boardName: "x", cursorRowNum: 5, curY: 10, ...over });
    expect(numJumpLanded(f(), 5)).toBe(true);
    expect(numJumpLanded(f(), 6)).toBe(false);
    expect(numJumpLanded(f({ curY: 23 }), 5)).toBe(false);
    expect(numJumpLanded(f({ boardName: null }), 5)).toBe(false);
  });

  test("endLanded：找不到／按任意鍵的底列不算", () => {
    const rowTexts = new Array(24).fill("");
    rowTexts[4] = " 1 + 110/14 someone      □ t";
    rowTexts[23] = "請按任意鍵繼續";
    expect(endLanded(facts("transient", { boardName: "x", curY: 4, rowTexts }))).toBe(false);
    rowTexts[23] = "";
    expect(endLanded(facts("transient", { boardName: "x", curY: 4, rowTexts }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 斷線重連後回到原處（startResume；reconnect_resume.js、docs/reading-record.md
//「斷線重連」）。從登入後的主功能表出發，落地交給閱讀紀錄的 'reconnect-resume'。
// ---------------------------------------------------------------------------
describe("startResume（斷線重連後回到原處）", () => {
  const LIST = {
    kind: "list",
    board: "C_Chat",
    mode: "plain",
    topNum: 353200,
    topPinnedKey: null,
    scrollFrac: 0,
    cursorNum: 353218
  };
  function resumeHarness() {
    const h = makeHarness({ listState: "idle" });
    h.termBuf.rowTexts = MAIN_MENU_SCREEN;
    h.core.listSession.beginExternalNavigation = vi.fn();
    h.core.listSession.requestViewportRestore = vi.fn();
    h.core.listSession.endExternalNavigation = vi.fn();
    h.core.easyReading.requestScrollToBottom = vi.fn();
    return h;
  }
  const articlePlan = (article, list = null) => ({
    kind: "article",
    board: "C_Chat",
    aid: "1gIeu-3A",
    bookmark: { feature: "reconnect-resume", article, list }
  });
  const listPlan = (num, list = LIST) => ({
    kind: "list",
    board: "C_Chat",
    num,
    bookmark: { feature: "reconnect-resume", article: null, list }
  });
  const ARTICLE = { kind: "article", board: "C_Chat", lineIndex: 37, atBottom: false, easy: true };

  test("文章：主功能表直接 s<板> → #<aid> → ⏎，落地回到斷線前那一列；列表 session 從 idle 也停泊", () => {
    const h = resumeHarness();
    expect(h.nav.startResume(articlePlan(ARTICLE))).toBe(true);
    expect(h.core.listSession.beginExternalNavigation).toHaveBeenCalledWith({ fromIdle: true });
    expect(h.sent).toEqual(["sC_Chat\r\f"]);
    settle(h.queue, facts("clean-list", { boardName: "c_chat" }));
    expect(h.sent[1]).toBe("#1gIeu-3A\r\f");
    settle(h.queue, facts("clean-list", { boardName: "c_chat", cursorRowNum: 353218, curY: 10 }));
    expect(h.sent[2]).toBe("\r\f");
    settle(h.queue, facts("article"));
    expect(h.nav.active).toBe(false);
    expect(h.core.easyReading.restoreCalls).toEqual([37]);
    expect(h.core.easyReading.requestScrollToBottom).not.toHaveBeenCalled();
    // 返回堆疊不動：斷線時已清空，回到原處不是一次跳文。
    expect(h.nav.canGoBack()).toBe(false);
    expect(h.hints[h.hints.length - 1]).toContain("已回到斷線前的文章");
  });

  test("一般跳文不會從 idle 停泊列表 session（fromIdle 只給回到原處）", () => {
    const h = resumeHarness();
    h.nav.startExternal("1gIeu-3A", "C_Chat");
    expect(h.core.listSession.beginExternalNavigation).toHaveBeenCalledWith({ fromIdle: false });
  });

  test("文章：斷線前在文末 ⇒ 黏回文末（新推文在那裡）", () => {
    const h = resumeHarness();
    h.nav.startResume(articlePlan({ ...ARTICLE, atBottom: true }));
    settle(h.queue, facts("clean-list", { boardName: "c_chat" }));
    settle(h.queue, facts("clean-list", { boardName: "c_chat", cursorRowNum: 1, curY: 10 }));
    settle(h.queue, facts("article"));
    expect(h.core.easyReading.requestScrollToBottom).toHaveBeenCalledTimes(1);
    expect(h.core.easyReading.restoreCalls).toEqual([]);
  });

  test("文章被刪（AID 找不到）⇒ 停在該板列表，列表視野回到斷線前（只比板），交回探針", () => {
    const h = resumeHarness();
    h.nav.startResume(articlePlan(ARTICLE, LIST));
    settle(h.queue, facts("clean-list", { boardName: "c_chat" }));
    // read.c:466-476：找不到 ⇒ 訊息在 rows-2、pressanykey 在末列，游標在末列。
    const rowTexts = new Array(24).fill("");
    rowTexts[22] = "找不到這個文章代碼(AID)，可能是文章已消失，或是你找錯看板了";
    rowTexts[23] = PRESS_ANY_KEY_ROW;
    const notFound = () => facts("transient", { boardName: "c_chat", curY: 23, rowTexts });
    settle(h.queue, notFound());
    vi.advanceTimersByTime(STEP_PROBE_AFTER_MS);
    settle(h.queue, notFound());
    vi.advanceTimersByTime(STEP_PROBE_WINDOW_MS);
    settle(h.queue, notFound());
    expect(h.nav.active).toBe(false);
    expect(h.sent).not.toContain("\r\f");
    expect(h.core.listSession.requestViewportRestore).toHaveBeenCalledWith({
      ...LIST,
      matchBoardOnly: true
    });
    expect(h.core.listSession.endExternalNavigation).toHaveBeenCalled();
    expect(h.hints[h.hints.length - 1]).toContain("找不到斷線前的文章");
  });

  test("列表：s<板> → <編號>⏎ 把游標放回斷線前那篇，不開文；視野交給列表好讀", () => {
    const h = resumeHarness();
    h.nav.startResume(listPlan(353218));
    settle(h.queue, facts("clean-list", { boardName: "c_chat" }));
    expect(h.sent[1]).toBe("353218\r\f");
    settle(h.queue, facts("clean-list", { boardName: "c_chat", cursorRowNum: 353218, curY: 10 }));
    expect(h.nav.active).toBe(false);
    expect(h.sent).toHaveLength(2); // 沒有開文的 ⏎
    expect(h.core.listSession.requestViewportRestore).toHaveBeenCalledWith({
      ...LIST,
      matchBoardOnly: true
    });
    expect(h.core.listSession.endExternalNavigation).toHaveBeenCalled();
  });

  test("列表：編號跳不到（刪文、超出）⇒ 照樣停在列表還原視野，不算失敗", () => {
    const h = resumeHarness();
    h.nav.startResume(listPlan(353218));
    settle(h.queue, facts("clean-list", { boardName: "c_chat" }));
    const off = () => facts("clean-list", { boardName: "c_chat", cursorRowNum: 353100, curY: 10 });
    settle(h.queue, off());
    vi.advanceTimersByTime(STEP_PROBE_AFTER_MS);
    settle(h.queue, off());
    vi.advanceTimersByTime(STEP_PROBE_WINDOW_MS);
    settle(h.queue, off());
    expect(h.nav.active).toBe(false);
    expect(h.core.listSession.requestViewportRestore).toHaveBeenCalled();
    expect(h.hints.some(m => m.includes("失敗"))).toBe(false);
  });

  test("列表沒有編號（置底、搜尋結果）⇒ 進板就停", () => {
    const h = resumeHarness();
    h.nav.startResume(listPlan(null, null));
    settle(h.queue, facts("clean-list", { boardName: "c_chat" }));
    expect(h.nav.active).toBe(false);
    expect(h.sent).toEqual(["sC_Chat\r\f"]);
    expect(h.core.listSession.requestViewportRestore).not.toHaveBeenCalled();
    expect(h.core.listSession.endExternalNavigation).toHaveBeenCalled();
  });

  test("切板失敗 ⇒ 看得到的失敗訊息，輸入解鎖", () => {
    const h = resumeHarness();
    const onEnd = vi.fn();
    h.nav.startResume(articlePlan(ARTICLE), onEnd);
    settle(h.queue, facts("prompt", { rowTexts: MAIN_MENU_SCREEN }));
    vi.advanceTimersByTime(BOARD_PROBE_AFTER_MS);
    settle(h.queue, facts("prompt", { rowTexts: MAIN_MENU_SCREEN }));
    vi.advanceTimersByTime(STEP_PROBE_WINDOW_MS);
    settle(h.queue, facts("prompt", { rowTexts: MAIN_MENU_SCREEN }));
    vi.advanceTimersByTime(BOARD_PROBE_AFTER_MS * 4);
    expect(h.nav.active).toBe(false);
    expect(h.hints[h.hints.length - 1]).toContain("回到斷線前的位置失敗");
    expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  test("跳文進行中 ⇒ 不開第二輪", () => {
    const h = resumeHarness();
    h.nav.startExternal("2AbCdEf0", "movie");
    expect(h.nav.startResume(articlePlan(ARTICLE))).toBe(false);
  });
});

describe("currentPostAid（斷線前記下本篇）", () => {
  test("免費網址列讀得到 ⇒ 用它", () => {
    const { nav } = makeHarness({
      pageState: 3,
      articleBoard: "Browsers",
      screenRows: articleScreenWithUrl()
    });
    expect(nav.currentPostAid()).toEqual({ board: "Browsers", aid: BROWSERS_AID });
  });

  test("讀不到網址列 ⇒ 用跳文落地記下的那篇（同板才算）", () => {
    const h = makeHarness({ pageState: 3, articleBoard: "Android" });
    h.nav._history.beginJump(null, { board: "Android", aid: "1gIeu-3A" });
    h.nav._history.commitJump();
    expect(h.nav.currentPostAid()).toEqual({ board: "Android", aid: "1gIeu-3A" });
    h.view._articleBoard = "C_Chat";
    expect(h.nav.currentPostAid()).toBeNull();
  });

  // 原生模式（好讀關著，deep link 在 pmore 裡收到）：文章→文章的鍵（] 同標題下一篇）不經過
  // easy_reading.leaveCurrentPost ⇒ noteLeftPost 沒被叫。畫面已是 C，landed 還說是 B：
  // 重連「回到原處」會打開 B、最近讀過把 C 記在 B 名下、下一次跳文把 B 當返回錨。
  test("REGRESSION 原生模式按 ] 換到同板另一篇 ⇒ landed 不再算本篇，返回堆疊作廢", () => {
    const h = makeHarness({ pageState: 3, articleBoard: "Android" });
    h.view._articleAuthor = "alice";
    h.view._articleTitle = "[問題] 第一篇";
    h.nav._history.beginJump({ kind: "board", board: "C_Chat", aid: null, label: "C_Chat 看板" }, {
      board: "Android",
      aid: "1gIeu-3A"
    });
    h.nav._history.commitJump(h.nav._articleContext());
    expect(h.nav.currentPostAid()).toEqual(expect.objectContaining({ board: "Android", aid: "1gIeu-3A" }));
    expect(h.nav.canGoBack()).toBe(true);
    // ] ⇒ 同標題下一篇（Re:），作者也換了；原生模式沒有任何 noteLeftPost。
    h.view._articleAuthor = "bob";
    h.view._articleTitle = "Re: [問題] 第一篇";
    expect(h.nav.currentPostAid()).toBeNull();
    expect(h.nav.canGoBack()).toBe(false);
    expect(h.sent).toEqual([]);
  });

  test("落地時讀不到檔頭（作者／標題 null）⇒ 不下結論，照舊用 landed", () => {
    const h = makeHarness({ pageState: 3, articleBoard: "Android" });
    h.nav._history.beginJump(null, { board: "Android", aid: "1gIeu-3A" });
    h.nav._history.commitJump(h.nav._articleContext());
    h.view._articleAuthor = "bob";
    h.view._articleTitle = "別篇";
    expect(h.nav.currentPostAid()).toEqual(expect.objectContaining({ aid: "1gIeu-3A" }));
  });

  test("不在文章裡 ⇒ null（不按 Q：斷線當下沒有連線可問）", () => {
    const h = makeHarness({ pageState: 2, articleBoard: "Android" });
    expect(h.nav.currentPostAid()).toBeNull();
    expect(h.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 搜尋結果（MODE_SELECT，底列「系列文章」）裡的 AID 跳文。
// 作者搜尋結果開的文章 → #AID ⇒ PTT 回
// 「此狀態下無法使用搜尋文章代碼(AID)功能」（read.c select_by_aid 對 MODE_SELECT 一律拒絕）。
// 新版 read.c 的搜尋條件住在 read_ctx：pager 的 `s<板>` 換板後**仍是**搜尋模式（同條件
// 篩新板，可能一篇都沒有＝「沒有文章...」），所以 # 之前要先 ←（read_cmd_quit 在
// MODE_SELECT 只離開搜尋，游標留在同一篇的真實位置）。
// ---------------------------------------------------------------------------
describe("AidNavigation 搜尋結果裡跳文", () => {
  // 搜尋結果列表：row0 標題「系列《板》」、底列 caption 系列文章。
  const subList = (board, entries = []) => {
    const rowTexts = new Array(24).fill("");
    rowTexts[0] = "【板主:someone】            看板描述                  系列《" + board + "》";
    rowTexts[2] = "   編號    日 期 作  者       文  章  標  題                    人氣:2";
    if (!entries.length) rowTexts[3] = "    沒有文章...";
    entries.forEach((t, i) => (rowTexts[3 + i] = t));
    rowTexts[23] = " 系列文章  (^P)發表 (y)回應 (X)推文 (d)刪除 (→)閱讀 (b)進板  (←)離開 (h)說明 ";
    return rowTexts;
  };
  const plainFooter = (rowTexts) => {
    const r = rowTexts.slice();
    r[23] = " 文章列表  (^P)發表 (y)回應 (X)推文 (d)刪除 (→)閱讀 (b)進板  (←)離開 (h)說明 ";
    return r;
  };
  const ENTRY = "      3   6 8/29 someuser     □ [問題] term.ptt.cc的未來";

  test("換板後落在空的搜尋結果（沒有文章...）⇒ 先 ← 離開搜尋，再 # aid", () => {
    const h = makeHarness();
    h.nav.start("1gIeu-3A", "Android");
    answerOriginInfo(h.queue, "1gKF7GO4");
    expect(h.sent[1]).toBe(" sAndroid\r\f");
    // 不是 clean-list（沒有編號列），但認得出是目標板的搜尋結果。
    settle(h.queue, facts("transient", { boardName: "Android", rowTexts: subList("Android") }));
    expect(h.sent[2]).toBe("\x1b[D\f");
    settle(
      h.queue,
      facts("clean-list", { boardName: "Android", rowTexts: plainFooter(subList("Android", [ENTRY])) })
    );
    expect(h.sent[3]).toBe("#1gIeu-3A\r\f");
  });

  test("同板（本版跳轉）落在有文章的搜尋結果 ⇒ 一樣先 ←", () => {
    const h = makeHarness();
    h.nav.start("1gIeu-3A", "SYSOP");
    answerOriginInfo(h.queue, null);
    settle(
      h.queue,
      facts("clean-list", { boardName: "SYSOP", rowTexts: subList("SYSOP", [ENTRY, ENTRY, ENTRY]) })
    );
    expect(h.sent[2]).toBe("\x1b[D\f");
  });

  test("← 之後仍是搜尋結果 ⇒ 不送 #，可見失敗", () => {
    const h = makeHarness();
    h.nav.start("1gIeu-3A", "Android");
    answerOriginInfo(h.queue, null);
    settle(h.queue, facts("transient", { boardName: "Android", rowTexts: subList("Android") }));
    settle(h.queue, facts("transient", { boardName: "Android", rowTexts: subList("Android") }));
    vi.advanceTimersByTime(60000);
    expect(h.sent.some((s) => s.startsWith("#"))).toBe(false);
    expect(h.nav.active).toBe(false);
  });

  test("完整列表（文章列表 caption）照舊直接 #，不多送 ←", () => {
    const h = makeHarness();
    h.nav.start("1gIeu-3A", "Android");
    answerOriginInfo(h.queue, null);
    settle(
      h.queue,
      facts("clean-list", { boardName: "Android", rowTexts: plainFooter(subList("Android", [ENTRY])) })
    );
    expect(h.sent[2]).toBe("#1gIeu-3A\r\f");
  });

  test("重新整理：列表好讀從搜尋結果開的這篇 ⇒ ← 回列表 → ⏎，不走 s／#", () => {
    const h = makeHarness({
      pageState: 3,
      articleBoard: "SYSOP",
      listAnchor: { board: "SYSOP", num: 3, subject: "x" }
    });
    h.core.listSession.readingPosition = () => ({ kind: "list", board: "SYSOP", mode: "select" });
    expect(h.nav.refresh()).toBe(true);
    expect(h.sent).toEqual(["\x1b[D\f"]);
    settle(
      h.queue,
      facts("clean-list", { boardName: "SYSOP", rowTexts: subList("SYSOP", [ENTRY, ENTRY, ENTRY]) })
    );
    expect(h.sent[1]).toBe("\r\f");
    settle(h.queue, facts("article"));
    expect(h.nav.active).toBe(false);
    expect(h.hints.at(-1)).toBe("已重新整理");
    expect(h.sent.join("")).not.toMatch(/sSYSOP|#/);
  });

  test("重新整理：Q 把我們丟回搜尋結果（標題列 系列《》）⇒ 關框＋⏎，不繞 s<板>", () => {
    const h = makeHarness({ pageState: 3, articleBoard: "SYSOP" });
    h.nav.refresh();
    expect(h.sent).toEqual(["Q"]);
    const rowTexts = subList("SYSOP", [ENTRY, ENTRY, ENTRY]);
    rowTexts[19] = "│ 文章代碼(AID): #1gabdGC8 (SYSOP) [ptt.cc] [問題] term.ptt.cc的未來";
    rowTexts[23] = PRESS_ANY_KEY_ROW;
    h.termBuf.rowTexts = rowTexts; // Q 的框蓋在搜尋結果上（第 0 列還看得到）
    settle(h.queue, facts("transient", { rowTexts }));
    expect(h.sent[1]).toBe(" \f");
    expect(h.sent.join("")).not.toContain("sSYSOP");
  });

  test("isSubListTitle：只認標題列右段的 系列《》／文摘《》", () => {
    expect(isSubListTitle("【板主:x】   描述   系列《SYSOP》")).toBe(true);
    expect(isSubListTitle("【板主:x】   描述   文摘《SYSOP》")).toBe(true);
    expect(isSubListTitle("【板主:x】   描述   看板《SYSOP》")).toBe(false);
    expect(isSubListTitle("")).toBe(false);
  });

  test("挑板取消落在搜尋結果 ⇒ 不 ←、不 #，直接 ⏎ 開游標上的原文", () => {
    const h = makeHarness({ articleBoard: "SYSOP" });
    const token = h.nav.preparePicked("1gabdGC8");
    h.nav.reopenPicked(token);
    settle(
      h.queue,
      facts("clean-list", { boardName: "SYSOP", rowTexts: subList("SYSOP", [ENTRY, ENTRY, ENTRY]) })
    );
    expect(h.sent[1]).toBe("\r\f");
  });
});

// ---------------------------------------------------------------------------
// 指定看板的 AID 跳文（無看板 #AID →「跳到其他看板…」）：挑板交給 `s` 看板搜尋
// 彈窗的原生補全，它一開 `s` 就離開文章 ⇒ preparePicked 先在文章裡記返回錨，
// 橋接進板之後 continuePicked 從目標板列表接手 #AID。
// ---------------------------------------------------------------------------
describe("AidNavigation 指定看板（preparePicked → continuePicked）", () => {
  test("prepare 一個 byte 都不送；進板後先確認落地再 # aid ⏎ ⏎，沒有板跳那一步", () => {
    const h = makeHarness({ articleBoard: "Gossiping" });
    const token = h.nav.preparePicked("1gIeu-3A");
    expect(token).not.toBeNull();
    expect(h.sent).toEqual([]);
    expect(h.nav.active).toBe(false);

    // 橋接已在背景 prompt 上送出 Android⏎（不經 aidNavigation）。
    expect(h.nav.continuePicked(token, "Android")).toBe(true);
    expect(h.nav.active).toBe(true);
    expect(h.sent).toEqual(["\f"]);
    settle(h.queue, facts("clean-list", { boardName: "Android" }));
    expect(h.sent[1]).toBe("#1gIeu-3A\r\f");
    settle(h.queue, facts("clean-list", { boardName: "Android", cursorRowNum: 5, curY: 10 }));
    expect(h.sent[2]).toBe("\r\f");
    settle(h.queue, facts("article"));
    expect(h.nav.active).toBe(false);
    expect(h.sent.join("")).not.toContain("sAndroid");
  });

  test("返回錨是開彈窗前的文章：跳完可返回原文的看板", () => {
    const h = makeHarness({ articleBoard: "Gossiping" });
    const token = h.nav.preparePicked("1gIeu-3A");
    // 開了 `s` 之後人已經不在文章裡：目前看板換掉也不影響錨。
    h.view._articleBoard = null;
    h.nav.continuePicked(token, "Android");
    settle(h.queue, facts("clean-list", { boardName: "Android" }));
    settle(h.queue, facts("clean-list", { boardName: "Android", cursorRowNum: 5, curY: 10 }));
    settle(h.queue, facts("article"));
    expect(h.nav.canGoBack()).toBe(true);
    h.sent.length = 0;
    h.nav.back();
    expect(h.sent).toEqual(["sGossiping\r\f"]);
  });

  test("文末網址列讀得到本篇 AID ⇒ 返回錨升級成 #AID（Q 用不了：人已離開文章）", () => {
    const h = makeHarness({
      pageState: 3,
      articleBoard: "Browsers",
      screenRows: articleScreenWithUrl()
    });
    const token = h.nav.preparePicked("1gIeu-3A");
    h.nav.continuePicked(token, "Android");
    expect(h.sent).toEqual(["\f"]); // 沒按 Q
    settle(h.queue, facts("clean-list", { boardName: "Android" }));
    settle(h.queue, facts("clean-list", { boardName: "Android", cursorRowNum: 5, curY: 10 }));
    settle(h.queue, facts("article"));
    const top = h.nav._history.peek();
    expect(top.kind).toBe("aid");
    expect(top.aid).toBe(BROWSERS_AID);
  });

  test("落在別的看板（PTT 判成別的板）⇒ 不送 #，可見失敗", () => {
    const h = makeHarness({ articleBoard: "Gossiping" });
    const token = h.nav.preparePicked("1gIeu-3A");
    h.nav.continuePicked(token, "Android");
    settle(h.queue, facts("clean-list", { boardName: "AndroidDev" }));
    vi.advanceTimersByTime(60000);
    expect(h.sent.some((s) => s.startsWith("#"))).toBe(false);
    expect(h.nav.active).toBe(false);
    expect(h.hints.some((m) => m.includes("Android"))).toBe(true);
  });

  // 在補全彈窗取消 ＝ 原生 `s` 取消 ⇒ 停在原文所在板的文章列表（游標在原文上）。
  test("取消後重開原文：先確認是原文的看板列表 → ⏎ → 落地後還原原列", () => {
    // 閱讀紀錄只在好讀開著、人在文章裡（pageState 3）時量得到原列。
    const h = makeHarness({ articleBoard: "Gossiping", scrollTop: 200, pageState: 3 });
    h.core.easyReading._enabled = true;
    const token = h.nav.preparePicked("1gIeu-3A");
    expect(token.bm.article.lineIndex).toBe(10);
    expect(h.nav.reopenPicked(token)).toBe(true);
    expect(h.sent).toEqual(["\f"]);
    settle(h.queue, facts("clean-list", { boardName: "Gossiping", cursorRowNum: 9, curY: 10 }));
    expect(h.sent[1]).toBe("\r\f");
    settle(h.queue, facts("article"));
    expect(h.nav.active).toBe(false);
    expect(h.core.easyReading.restoreCalls).toEqual([10]);
    expect(h.hints[h.hints.length - 1]).toContain("已回到原文");
  });

  // Ctrl-C 取消是 FULLUPDATE 不是 NEWDIRECT：游標本來就停在原文 ⇒ 知道 AID 也不送 #
  // （搜尋結果裡 # 會被拒，見「搜尋結果裡跳文」）。
  test("取消後重開原文：知道本篇 AID 也直接 ⏎（游標就在原文上）", () => {
    const h = makeHarness({
      pageState: 3,
      articleBoard: "Browsers",
      screenRows: articleScreenWithUrl()
    });
    const token = h.nav.preparePicked("1gIeu-3A");
    h.nav.reopenPicked(token);
    settle(h.queue, facts("clean-list", { boardName: "Browsers" }));
    expect(h.sent[1]).toBe("\r\f");
    expect(h.sent.some((s) => s.startsWith("#"))).toBe(false);
  });

  test("取消後落在別的畫面 ⇒ 不送 ⏎（可見失敗）", () => {
    const h = makeHarness({ articleBoard: "Gossiping" });
    const token = h.nav.preparePicked("1gIeu-3A");
    h.nav.reopenPicked(token);
    settle(h.queue, facts("menu"));
    vi.advanceTimersByTime(60000);
    expect(h.sent.some((s) => s.startsWith("\r"))).toBe(false);
    expect(h.nav.active).toBe(false);
  });

  test("挑板期間背景 prompt 造成的離開文章／列表 settle 不清返回堆疊；取消回原文後仍可返回", () => {
    const h = makeHarness({ articleBoard: "Gossiping" });
    // 先跳一次，堆疊裡有一層。
    h.nav.start("1gIeu-3A", "Android");
    answerOriginInfo(h.queue, null);
    settle(h.queue, facts("clean-list", { boardName: "Android" }));
    settle(h.queue, facts("clean-list", { boardName: "Android", cursorRowNum: 5, curY: 10 }));
    settle(h.queue, facts("article"));
    h.nav.noteLeftPost(); // 我方落地那一次（_ownedLeave）
    expect(h.nav.canGoBack()).toBe(true);

    h.view._articleBoard = "Android";
    const token = h.nav.preparePicked("2AbCdEf0");
    h.nav.noteLeftPost(); // 背景 `s` 離開文章
    h.nav.noteSettle(facts("clean-list", { boardName: "Android" })); // Ctrl-C 落在列表
    expect(h.nav.canGoBack()).toBe(true);
    h.nav.reopenPicked(token);
    settle(h.queue, facts("clean-list", { boardName: "Android", cursorRowNum: 5, curY: 10 }));
    settle(h.queue, facts("article"));
    expect(h.nav.canGoBack()).toBe(true);
  });

  test("endPicked：prompt 沒開出來（還在原文）堆疊保留；停在哪不確定就作廢", () => {
    const h = makeHarness({ articleBoard: "Gossiping" });
    h.nav.start("1gIeu-3A", "Android");
    answerOriginInfo(h.queue, null);
    settle(h.queue, facts("clean-list", { boardName: "Android" }));
    settle(h.queue, facts("clean-list", { boardName: "Android", cursorRowNum: 5, curY: 10 }));
    settle(h.queue, facts("article"));
    h.nav.noteLeftPost();
    h.nav.endPicked(h.nav.preparePicked("2AbCdEf0"), true);
    expect(h.nav.canGoBack()).toBe(true);
    h.nav.endPicked(h.nav.preparePicked("2AbCdEf0"), false);
    expect(h.nav.canGoBack()).toBe(false);
  });

  test("不在好讀文章裡／另一趟在跑 ⇒ prepare 回 null", () => {
    const h = makeHarness();
    h.termBuf.startedEasyReading = false;
    expect(h.nav.preparePicked("1gIeu-3A")).toBeNull();
    h.termBuf.startedEasyReading = true;
    h.nav.start("2AbCdEf0", "C_Chat");
    expect(h.nav.preparePicked("1gIeu-3A")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// startSubNum（next_article 的搜尋結果換文）：搜尋結果的編號是子列表自己的空間
// （read.c MODE_SELECT 重新編號），s<板>／# 都會離開它 ⇒ 文章內 ← 回到同一份結果
// → `<編號>⏎`（read_cmd_num 只看目前列表）→ 游標那列認得出才 ⏎。
// C_Chat 搜「史萊姆」開第 317 篇，讀到文末沒有下一篇卡片。
// ---------------------------------------------------------------------------
describe("AidNavigation.startSubNum：搜尋結果裡的第 N 篇", () => {
  const subList = (rows, cursorRow) => {
    const rowTexts = new Array(24).fill("");
    rowTexts[0] = "【板主:someone】[希洽] 這裡是希洽版                      系列《C_Chat》";
    rowTexts[2] = "   編號    日 期 作  者       文  章  標  題                    人氣:2";
    rows.forEach((t, i) => (rowTexts[3 + i] = i === cursorRow ? ">" + t.slice(1) : t));
    rowTexts[23] = " 系列文章  (^P)發表 (y)回應 (X)推文 (d)刪除 (→)閱讀 (b)進板  (←)離開 (h)說明 ";
    return rowTexts;
  };
  const ROWS = [
    "    317   3 10/20 hanx5566     □ [閒聊] 持續狩獵史萊姆300年 10月最終卷",
    "    318  12 10/20 someone      □ [26秋] 轉生史萊姆 五期 03"
  ];
  const at = (rowTexts, curY, cursorRowNum) =>
    facts("clean-list", { boardName: "C_Chat", rowTexts, curY, cursorRowNum });
  const verifier = (want) => {
    const calls = [];
    const fn = (text) => {
      calls.push(text);
      return text.includes(want);
    };
    fn.calls = calls;
    return fn;
  };

  test("← 回搜尋結果 → 318⏎ → 游標那列認得出 → ⏎ 開文；不送 s／#", () => {
    const h = makeHarness();
    const ends = [];
    const verify = verifier("轉生史萊姆 五期 03");
    expect(h.nav.startSubNum("C_Chat", 318, verify, (r) => ends.push(r))).toBe(true);
    expect(h.sent).toEqual(["\x1b[D\f"]);
    settle(h.queue, at(subList(ROWS, 0), 3, 317));
    expect(h.sent[1]).toBe("318\r\f");
    settle(h.queue, at(subList(ROWS, 1), 4, 318));
    expect(verify.calls).toEqual([subList(ROWS, 1)[4]]);
    expect(h.sent[2]).toBe("\r\f");
    settle(h.queue, facts("article"));
    expect(h.nav.active).toBe(false);
    expect(ends).toEqual([{ ok: true }]);
    expect(h.sent.some((s) => s.startsWith("s") || s.startsWith("#"))).toBe(false);
  });

  test("游標那列不是要的那篇（搜尋結果已經不是快照那一份）⇒ 不 ⏎，停在列表、onEnd ok:false", () => {
    const h = makeHarness();
    const ends = [];
    h.nav.startSubNum("C_Chat", 318, verifier("別篇"), (r) => ends.push(r));
    settle(h.queue, at(subList(ROWS, 0), 3, 317));
    settle(h.queue, at(subList(ROWS, 1), 4, 318));
    expect(h.sent).toEqual(["\x1b[D\f", "318\r\f"]);
    expect(h.nav.active).toBe(false);
    expect(ends).toEqual([expect.objectContaining({ ok: false })]);
  });

  test("← 落在完整列表（不是搜尋結果）⇒ 不跳號（那裡的編號是另一個空間）", () => {
    const h = makeHarness();
    const ends = [];
    h.nav.startSubNum("C_Chat", 318, verifier("五期"), (r) => ends.push(r));
    const plain = subList(ROWS, 0);
    plain[23] = " 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面 ";
    settle(h.queue, at(plain, 3, 317));
    vi.advanceTimersByTime(60000);
    expect(h.sent).toEqual(["\x1b[D\f", "\f"]);
    expect(h.nav.active).toBe(false);
    expect(ends).toEqual([expect.objectContaining({ ok: false })]);
  });

  test("不在文章 pager（站內信、footer 被擠掉）、進行中、參數不合法 ⇒ 拒絕、什麼都不送", () => {
    expect(makeHarness({ footer: MAIL_STATUS_ROW }).nav.startSubNum("C_Chat", 1, () => true)).toBe(false);
    expect(makeHarness({ footer: FOOTERLESS_STATUS_ROW }).nav.startSubNum("C_Chat", 1, () => true)).toBe(false);
    expect(makeHarness().nav.startSubNum("C_Chat", 0, () => true)).toBe(false);
    expect(makeHarness().nav.startSubNum("C_Chat", 1)).toBe(false);
    const h = makeHarness();
    h.nav.startSubNum("C_Chat", 318, () => true);
    expect(h.nav.startSubNum("C_Chat", 318, () => true)).toBe(false);
    expect(h.sent).toEqual(["\x1b[D\f"]);
  });
});
