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
    expect(sent).toEqual(["Q"]);
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
    vi.advanceTimersByTime(4000);
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
    vi.advanceTimersByTime(6000); // probe
    expect(sent[2]).toBe("\f");
    vi.advanceTimersByTime(6000); // probe timeout
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
  // originAid = null ⇒ Q 問不到本篇 AID（資訊框沒印 AID），錨點維持既有級別，
  // 這才是舊行為（num／board 錨點）的測試路徑。
  function jumpForward(h, aid = "1gIeu-3A", board = "Android", originAid = null) {
    h.nav.start(aid, board);
    answerOriginInfo(h.queue, originAid);
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
    expect(h.sent).toEqual(["Q"]);
    h.nav.back();
    expect(h.sent).toEqual(["Q"]);
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
    answerOriginInfo(h.queue, "1gKF7GO4"); // Q 成功也一樣：沒落地就不入 stack
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
    h.core.easyReading.callOrder.length = 0; // 只看 back run 這一趟
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
    // ORDER INVARIANT：好讀要先被接回來，捲動還原才有東西可推進 —— restore 是靠
    // _onViewUpdated 驅動的，好讀沒開就沒有那個迴圈。
    expect(h.core.easyReading.callOrder).toEqual(["ensure", "restore"]);
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

  test("Q 逾時 → 降級成今日行為（照樣跳，錨點維持 num 級），不算失敗", () => {
    const h = makeHarness({ listAnchor: FILTERED_ANCHOR });
    h.nav.start("2AbCdEf0", "Gossiping");
    expect(h.sent[0]).toBe("Q");
    vi.advanceTimersByTime(2500); // soft timeout → probe \f
    expect(h.sent[1]).toBe("\f");
    vi.advanceTimersByTime(2500); // 探針也沒回 → timeout
    // 不可 _fail：跳文本身還有救，今日行為就是地板
    expect(h.nav.active).toBe(true);
    expect(h.sent[2]).toBe(" sGossiping\r\f");

    settle(h.queue, facts("clean-list", { boardName: "Gossiping" }));
    settle(
      h.queue,
      facts("clean-list", { boardName: "Gossiping", cursorRowNum: 9, curY: 10 })
    );
    settle(h.queue, facts("article"));
    h.sent.length = 0;
    h.nav.back();
    settle(h.queue, facts("clean-list", { boardName: "movie" }));
    expect(h.sent[1]).toBe("3\r\f"); // 退回舊的序號錨點
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

  test("aid 錨點的 #搜尋 miss（置底文，read.c:404 FIXME）→ 退回 num 備援，不清空 stack", () => {
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
    // 找不到：vmsg 把游標停在底列 → cursorRowNum null → probe → miss
    settle(h.queue, facts("prompt"));
    vi.advanceTimersByTime(4000);
    settle(h.queue, facts("prompt"));
    // 備援：改用序號（仍會驗 subject 才開文）
    expect(h.sent[h.sent.length - 1]).toBe("3\r\f");
    expect(h.nav.active).toBe(true);
  });
});

// 外部 deep link（?/#Board/AID）觸發的跳轉。與 start() 的差別全在起手式：沒有
// 原文可回、可能根本沒開任何文章、而且落點幾乎都是剛登入的主功能表。
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
