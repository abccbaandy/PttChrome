// @unit-env browser
// 畫面位元組由 **upstream pttbbs 原始碼本身**產生（編譯 mbbsd 物件檔＋假 SHM／假使用者的
// driver 從指定入口直接呼叫 upstream 的畫面函式，不架站、不登入），經 app 自己的
// AnsiParser → TermBuf 落格子，再跑本專案的畫面判定與解析器。手抄排版（ptt_vcol_list_layout）
// 的 row 1 是自己寫的，抓不到 upstream 在 row 1 加指令說明列（72718d5）這類改動；
// 這裡的每一個位元組都是 upstream 程式碼吐的。
//
// fixture 由 tools/ptt-src-screens/generate.sh 重產（場景表 scenes.mjs、種子 seed.tsv）。
// 平常跑 repo 裡那份（產自 pttbbs 3c7d9af）；nightly（.github/workflows/ptt-src-screens.yml）
// 換成 upstream HEAD 產的。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { classifyListScreen } from "../../src/js/list_session";
import { boardEntryArms, boardNoteDecision } from "../../src/js/board_note_skip";
import {
  boardListContextKind,
  classifyBoardListScreen,
  parseBoardListName,
} from "../../src/js/board_list_parse";
import { parseHelpMenuScreen } from "../../src/js/help_menu";
import { isHomeScreen, parseFavRow } from "../../src/js/home_dashboard";
import { parseStatusRow } from "../../src/js/string_util";
import { subjectMatches } from "../../src/js/long_push_anchor";
import {
  articleContextFromScreen,
  isPinnedListRow,
  pageArticleNums,
  parseListArticleNum,
  parseListAuthor,
  subjectOfListText,
  annotateComment,
  FloorCounter,
  ModernCommentThread,
} from "../../src/js/comment_parse";
import { parseArticleLines } from "../../src/js/agent_parse";
import modernCommentsFx from "./fixtures/ptt_src_screens/modern_comments.json";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import articleListFx from "./fixtures/ptt_src_screens/article_list.json";
import articleListTallFx from "./fixtures/ptt_src_screens/article_list_tall.json";
import articleFx from "./fixtures/ptt_src_screens/article.json";
import articleLiveFx from "./fixtures/ptt_src_screens/article_live.json";
import helpMenuFx from "./fixtures/ptt_src_screens/help_menu.json";
import boardNoteFx from "./fixtures/ptt_src_screens/board_note.json";
import boardListFx from "./fixtures/ptt_src_screens/board_list.json";
import mainMenuFx from "./fixtures/ptt_src_screens/main_menu.json";
import waterballDefaultFx from "./fixtures/ptt_src_screens/waterball_default.json";
import waterballOfoFx from "./fixtures/ptt_src_screens/waterball_ofo.json";
import mainMenuNewMailFx from "./fixtures/ptt_src_screens/main_menu_newmail.json";
import pushFx from "./fixtures/ptt_src_screens/push.json";
import { classifyReplyScreen, nextReplyStep } from "../../src/js/waterball_reply";
import { newMailOnScreen } from "../../src/js/message_inbox";
import { hasNewMail } from "../../src/js/home_dashboard";
import { appBarFromFacts } from "../../src/js/mobile_app_bar";
import { classifyPushScreen, detectIpLogged } from "../../src/js/push_screen";
import pushFlowFx from "./fixtures/ptt_src_screens/push_flow.json";
import pushAgainFx from "./fixtures/ptt_src_screens/push_again.json";
import pushOwnerFx from "./fixtures/ptt_src_screens/push_owner.json";
import pushSearchFx from "./fixtures/ptt_src_screens/push_search.json";
import { pushMaxBytes } from "../../src/js/long_push";
import { navKeyBlockReason } from "../../src/js/nav_key_gate";
import { App } from "../../src/js/pttchrome";
import articleHelpFx from "./fixtures/ptt_src_screens/article_help.json";
import liveShortFx from "./fixtures/ptt_src_screens/live_short.json";
import liveLongFx from "./fixtures/ptt_src_screens/live_long.json";
import { isShortPageGrowth } from "../../src/js/comment_parse";
import postInfoFx from "./fixtures/ptt_src_screens/post_info.json";
import { parsePostInfoAid, parsePostInfoUrl } from "../../src/js/aid_parse";
import articlePrefFx from "./fixtures/ptt_src_screens/article_pref.json";
import boardCompleteFx from "./fixtures/ptt_src_screens/board_complete.json";
import editorFx from "./fixtures/ptt_src_screens/editor.json";
import mailListFx from "./fixtures/ptt_src_screens/mail_list.json";
import mailReadFx from "./fixtures/ptt_src_screens/mail_read.json";
import { parseMailRow } from "../../src/js/mail_list";
import { footerCaption, isArticleListFooter, MAIL_LIST_CAPTIONS } from "../../src/js/screen_captions";
import { decideInsertMode } from "../../src/js/image_upload";
import {
  boardQueryResult,
  parseBoardPromptFrame,
  resolvedBoardName,
} from "../../src/js/board_search_bridge";
import {
  aidSearchLanded,
  isSubListTitle,
  landedOnBoardList,
  postInfoAnswer,
} from "../../src/js/aid_navigation";
import digestFx from "./fixtures/ptt_src_screens/digest.json";
import digestAidFx from "./fixtures/ptt_src_screens/digest_aid.json";
import essenceFx from "./fixtures/ptt_src_screens/essence.json";
import { aidToFn, toPostAid } from "../../src/js/aid_codec";
import { parsePagerFooterContext } from "../../src/js/string_util";
import { isSubListFooter } from "../../src/js/screen_captions";
import { listModeOf } from "../../src/js/list_session";
import {
  MFDISP_RAW_NA,
  MFDISP_RAW_NOANSI,
  MFDISP_RAW_PLAIN,
  parseRawModeFromPrefRow,
  pmorePrefScreenSeen,
  rawModePrefRowVisible,
} from "../../src/js/pmore_pref";
import { CommandQueue } from "../../src/js/command_queue";
import articlePromptsFx from "./fixtures/ptt_src_screens/article_prompts.json";
import { pushGateFacts, shouldInterceptPushKey } from "../../src/js/long_push_gate";
import {
  isSearchPromptFrame,
  searchGateFacts,
  submitSearch,
  submitSerializedSteps,
  submitBlockedHint,
  PROMPT_PENDING_HINT,
} from "../../src/js/article_search";
import { BoardTabs } from "../../src/js/board_tabs";
import { AidNavigation } from "../../src/js/aid_navigation";
import { DeepLinkController } from "../../src/js/deep_link_controller";
import { toolbarContextFromFacts } from "../../src/js/mobile_toolbar";
import {
  refreshTargetFromFacts,
  buildBoardListRefreshSteps,
  isBoardKeywordPromptFrame,
} from "../../src/js/screen_refresh";
import boardListRefreshFx from "./fixtures/ptt_src_screens/board_list_refresh.json";
import aidMissFx from "./fixtures/ptt_src_screens/aid_miss.json";
import { AID_NOT_FOUND_RE } from "../../src/js/aid_navigation";
import searchPromptsFx from "./fixtures/ptt_src_screens/search_prompts.json";
import searchRefineFx from "./fixtures/ptt_src_screens/search_refine.json";
import menuSearchFx from "./fixtures/ptt_src_screens/menu_search.json";
import boardListTogglesFx from "./fixtures/ptt_src_screens/board_list_toggles.json";
import markReadPromptFx from "./fixtures/ptt_src_screens/mark_read_prompt.json";
import goodbyeFx from "./fixtures/ptt_src_screens/goodbye.json";
import { markReadPromptShown } from "../../src/js/mark_read_prompt";
import { resolveDismiss, DISMISS_INPUT } from "../../src/js/screen_dismiss";
import { isGoodbyeConfirm, isAnyKeyPause, logoutEscapeKey } from "../../src/js/logout_session";
import replyPromptFx from "./fixtures/ptt_src_screens/reply_prompt.json";
import postFlowFx from "./fixtures/ptt_src_screens/post_flow.json";
import classListFx from "./fixtures/ptt_src_screens/class_list.json";
import { editorInputAvailable } from "../../src/js/editor_input";

loadBig5Tables();

// 場景的第 0..i 幀依序餵進同一個 TermBuf（每幀只是上一幀之後 server 多吐的位元組），
// 拍下「名為 name 的那一幀畫完」的畫面。opts.perFrame：每幀之後都 notify（跟 app 一樣
// 每幀跑一次 setPageState）——要驗「前面某一幀留下的狀態」時用。
function screenAt(fx, name, opts) {
  const idx = fx.frames.findIndex((f) => f.name === name);
  if (idx < 0) throw new Error(`fixture 沒有名為 ${name} 的幀`);
  const buf = new TermBuf(fx.cols, fx.rows);
  buf.setView({
    update() {},
    updateCursorPos() {},
    refreshCursorVisibility() {},
    blinkOn: false,
  });
  buf.useMouseBrowsing = false;
  const parser = new AnsiParser(buf);
  for (let i = 0; i <= idx; ++i) {
    parser.feed(fx.frames[i].bytes);
    if (opts && opts.perFrame && i < idx) buf.notify();
  }
  buf.notify(); // updateCharAttr＋pageState
  clearTimeout(buf.timerUpdate);
  if (buf._settleTimer) clearTimeout(buf._settleTimer);
  const rowTexts = Array.from({ length: buf.rows }, (_, y) => buf.getRowText(y, 0, buf.cols));
  return {
    buf,
    rowTexts,
    facts: {
      rowTexts,
      rows: buf.rows,
      curX: buf.cur_x,
      curY: buf.cur_y,
      // 同 easy_reading.js／board_note_skip.js 的呼叫端
      row0Reversed: buf.isUnicolor(0, 0, 29),
      row2Reversed: buf.isUnicolor(2, 0, buf.cols - 10),
    },
  };
}

// tools/ptt-src-screens/seed.tsv 的 Test 板（依 .DIR 順序）。
const LONG_TITLE =
  "[心得] 這是一個非常非常長的標題用來測試列表欄寬不夠時會不會被截斷成刪節號";
const TEST_BOARD = [
  { num: 1, owner: "alice", subject: "[問題] 第一篇測試文章" },
  { num: 2, owner: "bob", subject: "[問題] 第一篇測試文章" },
  { num: 3, owner: "carol", subject: "[新聞] 轉錄的新聞" },
  { num: 4, owner: "dave", subject: "[公告] 版規" },
  { num: 5, owner: "erin", subject: LONG_TITLE, truncated: true },
  { num: 6, owner: "SYSOP", subject: "[公告] 置底公告" },
];

describe("upstream pttbbs 產的文章列表畫面", () => {
  const { buf, rowTexts, facts } = screenAt(articleListFx, "list");

  test("整幀判成文章列表", () => {
    expect(classifyListScreen(facts).kind).toBe("clean-list");
    expect(buf.pageState).toBe(2);
  });

  test("列表列解析出種子資料的編號／作者／標題", () => {
    TEST_BOARD.forEach((a, i) => {
      const t = rowTexts[3 + i];
      expect(parseListArticleNum(t)).toBe(a.num);
      expect(parseListAuthor(t)).toBe(a.owner.toLowerCase()); // 解析器刻意轉小寫
      expect(isPinnedListRow(t)).toBe(false);
      if (!a.truncated) expect(subjectOfListText(t)).toContain(a.subject);
    });
  });

  test("長標題截成「…」，前綴比對仍認得原標題", () => {
    const subject = subjectOfListText(rowTexts[3 + 4]);
    expect(subject.endsWith("…")).toBe(true);
    expect(subject.length).toBeLessThan(LONG_TITLE.length);
    expect(subjectMatches(subject, LONG_TITLE)).toBe(true);
    expect(subjectMatches(subject, "[心得] 別篇")).toBe(false);
  });

  test("置底文：列表尾端多一列 ★（沒有編號、有作者）", () => {
    const pinned = rowTexts[3 + TEST_BOARD.length];
    expect(pinned).toContain("★");
    expect(isPinnedListRow(pinned)).toBe(true);
    expect(parseListAuthor(pinned)).toBe("sysop");
    expect(subjectOfListText(pinned)).toContain("[公告] 置底公告");
    // ★ 列之後就沒有文章列了
    expect(rowTexts[3 + TEST_BOARD.length + 1].trim()).toBe("");
  });

  test("在文章列表按 ⏎ 開文不會被當成進板而 arm（72718d5）", () => {
    expect(boardEntryArms(rowTexts, "\r")).toBe(false);
  });
});

describe("upstream pttbbs 產的文章列表畫面（40 列）", () => {
  const { facts } = screenAt(articleListTallFx, "list");

  test("一頁 rows-4 列，全判成文章列表且編號連續", () => {
    expect(facts.rows).toBe(40);
    expect(classifyListScreen(facts).kind).toBe("clean-list");
    const nums = pageArticleNums(facts.rowTexts, facts.curY).slice(3, facts.rows - 1);
    expect(nums).toHaveLength(facts.rows - 4);
    // Long 板 50 篇，進板停在最後一篇 ⇒ 最後一頁是 50-(rows-4)+1 .. 50。
    const first = 50 - (facts.rows - 4) + 1;
    expect(nums).toEqual(Array.from({ length: facts.rows - 4 }, (_, i) => first + i));
    expect(facts.curY).toBe(facts.rows - 2);
  });
});

describe("upstream pttbbs 產的文章畫面（pmore）", () => {
  test("跳號之後游標停在第 1 篇", () => {
    const { rowTexts, facts } = screenAt(articleFx, "list-jumped");
    expect(classifyListScreen(facts).kind).toBe("clean-list");
    expect(facts.curY).toBe(3);
    expect(parseListArticleNum(rowTexts[3])).toBe(1);
  });

  test("狀態列解析出頁數與行號，整幀判成文章", () => {
    const { buf, rowTexts, facts } = screenAt(articleFx, "article");
    const status = parseStatusRow(rowTexts[facts.rows - 1]);
    expect(status).toMatchObject({ pageIndex: 1, pageTotal: 1, pagePercent: 100, rowIndexStart: 1 });
    expect(status.rowIndexEnd).toBeGreaterThanOrEqual(4);
    expect(classifyListScreen(facts).kind).toBe("article");
    expect(buf.pageState).toBe(3);
  });

  test("檔頭解析出作者／看板／標題", () => {
    const { rowTexts, facts } = screenAt(articleFx, "article");
    const status = parseStatusRow(rowTexts[facts.rows - 1]);
    expect(articleContextFromScreen(rowTexts[0], rowTexts[1], status)).toEqual({
      author: "alice",
      board: "Test",
      title: "[問題] 第一篇測試文章",
    });
  });
});

// upstream 3c7d9af 實況模式：文章裡按 v。driver 沒有 IPC service ⇒ live_toggle 失敗，狀態列 part2
// 換成 override_msg「[系統連線服務異常]」。這一幀認不出 ⇒ pageState 掉出 3、好讀累積頁被清空。
// （切換成功時 part1 的「瀏覽」變「實況」，driver 產不出來，由 string_util.test.js 守。）
describe("upstream pttbbs 產的文章實況切換（v，連不上 IPC service）", () => {
  test("「[系統連線服務異常]」的狀態列仍是文章頁", () => {
    const { buf, rowTexts, facts } = screenAt(articleLiveFx, "live-failed");
    const last = rowTexts[facts.rows - 1];
    expect(last).toContain("[系統連線服務異常]");
    expect(parseStatusRow(last)).toMatchObject({ pageIndex: 1, rowsUnknown: true });
    expect(classifyListScreen(facts).kind).toBe("article");
    expect(buf.pageState).toBe(3);
  });
});

describe("upstream pttbbs 產的實況模式（v 切換成功＋別人推文送到，3c7d9af）", () => {
  const status = (fx, name) => {
    const { buf, rowTexts, facts } = screenAt(fx, name);
    return { buf, rowTexts, facts, st: parseStatusRow(rowTexts[facts.rows - 1]) };
  };

  test("「實況」狀態列仍是文章頁，推文寫上畫面、E 跟著加", () => {
    const on = status(liveLongFx, "live-on");
    expect(on.rowTexts[on.facts.rows - 1]).toContain("實況");
    expect(on.buf.pageState).toBe(3);
    const one = status(liveLongFx, "live-1");
    expect(one.buf.pageState).toBe(3);
    expect(one.rowTexts[one.facts.rows - 2]).toContain("first live comment");
    expect(one.st.rowIndexStart).toBe(on.st.rowIndexStart + 1);
    expect(one.st.rowIndexEnd).toBe(on.st.rowIndexEnd + 1);
  });

  test("長文（畫面已滿）：上捲一列，照一般往後接就接得上（不是原地長高）", () => {
    const on = status(liveLongFx, "live-on");
    const one = status(liveLongFx, "live-1");
    expect(
      isShortPageGrowth({
        accEndRow: on.st.rowIndexEnd,
        statusStart: one.st.rowIndexStart,
        statusEnd: one.st.rowIndexEnd,
        accTexts: on.rowTexts.slice(0, -1),
        newTexts: one.rowTexts.slice(0, -1),
      }),
    ).toBe(false);
    expect(one.rowTexts.slice(0, -2)).toEqual(on.rowTexts.slice(1, -1));
  });

  test("短文（畫面沒滿）：原地長高，第一則蓋掉內文最後一列", () => {
    const art = status(liveShortFx, "article");
    const one = status(liveShortFx, "live-1");
    const two = status(liveShortFx, "live-2");
    expect([art.st.rowIndexStart, art.st.rowIndexEnd]).toEqual([1, 5]);
    expect([one.st.rowIndexStart, one.st.rowIndexEnd]).toEqual([1, 6]);
    expect([two.st.rowIndexStart, two.st.rowIndexEnd]).toEqual([1, 7]);
    // pmore_print_live_line 寫在 move(dispedlines, 0)：檔頭分隔線多佔一列 ⇒ 落在 body 那列上。
    const bodyRow = art.rowTexts.findIndex((t) => t.trim() === "body");
    expect(one.rowTexts[bodyRow]).toContain("first live comment");
    expect(two.rowTexts[bodyRow + 1]).toContain("second live comment");
    const grow = (a, b) =>
      isShortPageGrowth({
        accEndRow: a.st.rowIndexEnd,
        statusStart: b.st.rowIndexStart,
        statusEnd: b.st.rowIndexEnd,
        accTexts: a.rowTexts.slice(0, -1),
        newTexts: b.rowTexts.slice(0, -1),
      });
    expect(grow(art, one)).toBe(true);
    expect(grow(one, two)).toBe(true);
    // 關掉實況：mmap 的舊檔重畫回來，E 變回 5 ⇒ 不是長高。
    expect(grow(two, status(liveShortFx, "live-off"))).toBe(false);
  });
});

describe("upstream pttbbs 產的 pmore prompt（pmore.c#pmore_do_goto、pmore_search_keyword）", () => {
  const at = (name) => {
    const { buf, rowTexts, facts } = screenAt(articlePromptsFx, name);
    return { buf, rowTexts, facts, last: rowTexts[facts.rows - 1] };
  };
  const LONG_PUSH_ON = { enableLongPush: true, pushKeyOpensLongPush: true };
  const intercepts = (name) => {
    const f = pushGateFacts({ buf: at(name).buf });
    return shouldInterceptPushKey(Object.assign({ key: "X", prefs: LONG_PUSH_ON }, f));
  };

  test("prompt 畫在倒數第二列，狀態列留在底列照樣認得", () => {
    for (const name of ["goto", "search"]) {
      const { rowTexts, facts, last } = at(name);
      expect(rowTexts[facts.rows - 2]).toContain(name === "goto" ? "跳至此行" : "關鍵字");
      expect(parseStatusRow(last)).toMatchObject({ pageIndex: 1, pageTotal: 1, rowIndexStart: 1 });
    }
  });

  test("prompt 幀游標停在輸入欄、沒停回右下角 ⇒ 好讀累積的 complete 閘門擋得住；落地幀才停回去", () => {
    const g = at("goto");
    expect(g.buf.isCursorOnInputField()).toBe(true);
    expect([g.facts.curY, g.facts.curX]).not.toEqual([g.facts.rows - 1, g.buf.cols - 1]);
    const l = at("landed");
    expect(l.buf.isCursorOnInputField()).toBe(false);
    expect([l.facts.curY, l.facts.curX]).toEqual([l.facts.rows - 1, l.buf.cols - 1]);
  });

  test("在 pmore 搜尋／跳行 prompt 裡打 X 是在打字，不改開長推文", () => {
    expect(intercepts("article")).toBe(true);
    expect(intercepts("goto")).toBe(false);
    expect(intercepts("search")).toBe(false);
    expect(intercepts("search-typed")).toBe(false);
    expect(intercepts("landed")).toBe(true);
  });

  test("手機工具列：prompt 開著時不給推／回文／到底／文章導覽（點了只會打進 prompt）", () => {
    const ctx = (name) => {
      const { buf } = at(name);
      return toolbarContextFromFacts(searchGateFacts({ buf }), buf.pageState, {});
    };
    expect(ctx("article")).toMatchObject({ push: true, reply: true, end: true, threadNav: true });
    for (const name of ["goto", "search", "search-typed"])
      expect(ctx(name)).toMatchObject({ push: false, reply: false, end: false, threadNav: false, share: false });
    expect(ctx("landed")).toMatchObject({ push: true, reply: true, end: true });
  });

  test("重新整理：prompt 開著時不重整（重開文章的鍵會打進 prompt）", () => {
    const target = (name) => {
      const { buf } = at(name);
      return refreshTargetFromFacts(searchGateFacts({ buf }), buf.pageState, { articleBoard: "Test" });
    };
    expect(target("article")).toEqual({ kind: "article", board: "Test" });
    for (const name of ["goto", "search", "search-typed"]) expect(target(name)).toBe(null);
    expect(target("landed")).toEqual({ kind: "article", board: "Test" });
  });

  // 開燈鈕（軌 B）替使用者送 `\` 叫 pmore 快速設定：浮動按鈕在 prompt 開著時還按得到，
  // `\` 會打進跳行／搜尋輸入欄，推文型別選單（vkey）則當成「推」。
  test("開燈切色彩模式：文章照送 `\\`，跳行／搜尋 prompt 與推文型別選單一個 byte 都不送", () => {
    const fire = (buf) => {
      const sent = [];
      const hints = [];
      const app = Object.create(App.prototype);
      app.modalShown = false;
      app.aidNavigation = { active: false };
      app.longPush = { active: false };
      app.easyReading = { _rawMode: null, _enterFunctionMode() {} };
      app.buf = buf;
      app.view = { useEasyReadingMode: false, _send: (d) => sent.push(d), flashListHint: (m) => hints.push(m) };
      app.commandQueue = new CommandQueue({ send: (d) => sent.push(d) });
      app.onLightsRawMode(MFDISP_RAW_PLAIN);
      return { sent, hints };
    };
    expect(fire(at("article").buf).sent).toEqual(["\\"]);
    expect(fire(at("landed").buf).sent).toEqual(["\\"]);
    for (const buf of [at("goto").buf, at("search").buf, at("search-typed").buf, screenAt(pushFx, "push-1").buf]) {
      const r = fire(buf);
      expect(r.sent).toEqual([]);
      expect(r.hints.length).toBe(1);
    }
  });
});

describe("upstream pttbbs 產的說明選單（文章列表的 h）", () => {
  const { rowTexts } = screenAt(helpMenuFx, "help");
  const menu = parseHelpMenuScreen(rowTexts);

  test("認得出說明選單，第 1 頁、游標在第一項", () => {
    expect(menu).not.toBeNull();
    expect(menu.caption).toBe("文章列表");
    expect(menu.page).toBe(1);
    expect(menu.totalPages).toBeGreaterThanOrEqual(1);
    expect(menu.cursorIndex).toBe(0);
    expect(menu.items.length).toBe(rowTexts.length - 3); // 每頁 t_lines - 3 項
  });

  test("項目解析出鍵與名稱", () => {
    const byLabel = Object.fromEntries(menu.items.map((it) => [it.label, it]));
    expect(byLabel["發表"].keys).toEqual(["^P"]);
    expect(byLabel["推文"].keys).toContain("X");
    expect(byLabel["閱讀"].keys).toContain("Enter");
  });

  test("在說明選單按 ⏎ 不會被當成進板而 arm", () => {
    expect(boardEntryArms(rowTexts, "\r")).toBe(false);
  });
});

describe("upstream pttbbs 產的說明選單（文章裡的 h）", () => {
  const at = (name) => screenAt(articleHelpFx, name);

  test("同一套 psb 說明選單：caption「文章閱讀」、3 頁，第 1 頁游標在第一項", () => {
    const menu = parseHelpMenuScreen(at("help").rowTexts);
    expect(menu).not.toBeNull();
    expect(menu.caption).toBe("文章閱讀");
    expect(menu.page).toBe(1);
    expect(menu.totalPages).toBe(3);
    expect(menu.cursorIndex).toBe(0);
  });

  test("只有鍵、沒有名稱的項目（(Space)、(→)）也解析得出來，不會讓整頁認不出", () => {
    const { items } = parseHelpMenuScreen(at("help").rowTexts);
    expect(items.length).toBe(at("help").rowTexts.length - 3);
    expect(items.some((it) => it.keys.includes("Space"))).toBe(true);
    expect(items.find((it) => it.label === "推文").keys).toContain("X");
  });

  // 最後一頁不滿：項目數隨 upstream 加指令變（3c7d9af 加了 v「切換實況」⇒ 1 項變 2 項），
  // 只鎖「不滿一頁也解析得出來」。
  test("空白翻到第 2、3 頁（最後一頁不滿一頁）", () => {
    expect(parseHelpMenuScreen(at("help-2").rowTexts)).toMatchObject({ page: 2, totalPages: 3 });
    const last = parseHelpMenuScreen(at("help-3").rowTexts);
    expect(last).toMatchObject({ page: 3, totalPages: 3 });
    expect(last.items.length).toBeGreaterThanOrEqual(1);
    expect(last.items.length).toBeLessThan(at("help-3").rowTexts.length - 3);
  });

  test("說明選單不是文章：沒有 pmore 狀態列、不判成 article；q 回到文章", () => {
    const { rowTexts, facts } = at("help");
    expect(parseStatusRow(rowTexts[facts.rows - 1])).toBeNull();
    expect(classifyListScreen(facts).kind).not.toBe("article");
    expect(boardEntryArms(rowTexts, "\r")).toBe(false);
    const back = at("back");
    expect(parseHelpMenuScreen(back.rowTexts)).toBeNull();
    expect(classifyListScreen(back.facts).kind).toBe("article");
  });
});

describe("upstream pttbbs 產的 pmore 設定頁（o 完整設定、\\ 快速設定）", () => {
  const rows = (name) => screenAt(articlePrefFx, name).rowTexts;

  test("兩種設定頁都認得；文章本身不是設定頁", () => {
    for (const name of ["pref", "pref-cycled", "quick"]) expect(pmorePrefScreenSeen(rows(name)), name).toBe(true);
    for (const name of ["article", "pref-closed", "back"]) expect(pmorePrefScreenSeen(rows(name)), name).toBe(false);
  });

  test("只有快速設定頁算「可以直選 1-3」", () => {
    expect(rawModePrefRowVisible(rows("quick"))).toBe(true);
    expect(rawModePrefRowVisible(rows("pref"))).toBe(false);
  });

  test("讀得出選中的色彩模式：完整設定頁沒有數字熱鍵（「 *預設格式化內容 | …」）也要讀得出", () => {
    expect(parseRawModeFromPrefRow(rows("pref"))).toBe(MFDISP_RAW_NA);
    expect(parseRawModeFromPrefRow(rows("pref-cycled"))).toBe(MFDISP_RAW_NOANSI);
    expect(parseRawModeFromPrefRow(rows("quick"))).toBe(MFDISP_RAW_NOANSI);
  });

  test("完整設定頁多出「留言色彩主題」列（upstream f30655b，同樣三段＋*）不會被當成色彩顯示方式", () => {
    for (const name of ["pref", "pref-cycled"]) {
      const theme = rows(name).find((t) => t.includes("留言色彩主題"));
      expect(theme, name).toMatch(/\*經典醒目 \| 單純易讀 \| 典雅邊框/);
    }
    // 循環的是色彩顯示方式：主題列的 * 停在第 0 段，讀到的仍是第 1 段（原始ANSI控制碼）
    expect(parseRawModeFromPrefRow(rows("pref-cycled"))).toBe(MFDISP_RAW_NOANSI);
  });

  test("回到文章（含原始ANSI模式的檔頭）pmore 狀態列照樣認得", () => {
    for (const name of ["pref-closed", "back"]) {
      const { rowTexts, facts } = screenAt(articlePrefFx, name);
      expect(parseStatusRow(rowTexts[facts.rows - 1]), name).not.toBeNull();
    }
  });
});

describe("upstream pttbbs 產的信件列表（主功能表 Ctrl+Z m）", () => {
  const { rowTexts, facts } = screenAt(mailListFx, "mail");

  test("底列 caption「信件列表」：不是文章列表、也不是看板列表 ⇒ 列表好讀／看板列表都不接管", () => {
    expect(footerCaption(rowTexts[facts.rows - 1])).toBe("信件列表");
    expect(MAIL_LIST_CAPTIONS).toContain(footerCaption(rowTexts[facts.rows - 1]));
    expect(isArticleListFooter(rowTexts[facts.rows - 1])).toBe(false);
    expect(classifyListScreen(facts).kind).not.toBe("clean-list");
    expect(classifyBoardListScreen(facts)).toBeNull();
  });

  test("首頁儀表板的「新信」落地判準：已離開主功能表", () => {
    expect(isHomeScreen(screenAt(mailListFx, "menu").facts)).toBe(true);
    expect(isHomeScreen(facts)).toBe(false);
  });
});

describe("upstream pttbbs 產的讀信（信件列表 ⏎ → mail.c#mail_read 的 more() → ← 回列表）", () => {
  const at = (name) => {
    const s = screenAt(mailReadFx, name, { perFrame: true });
    s.buf.useMouseBrowsing = true;
    return s;
  };

  test("讀信是同一個 pmore 狀態列 ⇒ pageState 3（好讀接手）", () => {
    const { buf, rowTexts, facts } = at("read");
    expect(parseStatusRow(rowTexts[facts.rows - 1])).not.toBeNull();
    expect(buf.pageState).toBe(3);
  });

  // setPageState 以前認不出信件列表（欄位標題列右端「(大小:N篇)」另一個底色），pageState 沿用
  // 上一幀 ⇒ 從主功能表進來是 1、讀完回來黏在 3：點信件沒反應、游標列沒底色、App Bar 是信的標題。
  test("讀完 ← 回信件列表：pageState 跟從主功能表進來一樣是 1，不黏在文章的 3", () => {
    expect(at("mail").buf.pageState).toBe(1);
    const { buf } = at("back");
    expect(buf.isMailListScreen()).toBe(true);
    expect(buf.pageState).toBe(1);
  });

  // read.c#read_move_cursor：↓ 夾在最後一封、第一封再 ↑ 繞到最後一封 ⇒ 點說明列／欄位標題列／
  // 下面的空列以前會送「移游標＋⏎」，打開最後一封信。
  test("滑鼠：只有信件列點得下去（兩種進來的路都一樣）", () => {
    for (const name of ["mail", "back"]) {
      const { buf, rowTexts } = at(name);
      const items = rowTexts.map((t, y) => (parseMailRow(t) ? y : -1)).filter((y) => y >= 0);
      expect(items, name).toEqual([3, 4, 5]);
      for (const y of items) expect(buf._resolveMouseRegionAt(40, y), `${name} row ${y}`).toMatchObject({ action: "enter", row: y });
      for (const y of [1, 2, 6, 12, buf.rows - 2])
        expect(buf._resolveMouseRegionAt(40, y).action, `${name} row ${y}`).toBe("none");
    }
  });
});

describe("upstream pttbbs 產的回文 prompt（bbs.c#do_reply，文章裡按 y）", () => {
  const LONG_PUSH_ON = { enableLongPush: true, pushKeyOpensLongPush: true };
  const at = (name) => screenAt(replyPromptFx, name, { perFrame: true });

  test("prompt 畫在倒數第二列，狀態列照樣認得、還是文章（pageState 3）", () => {
    const { buf, rowTexts, facts } = at("reply");
    expect(rowTexts[facts.rows - 2]).toMatch(/回應至/);
    expect(parseStatusRow(rowTexts[facts.rows - 1])).not.toBeNull();
    expect(buf.pageState).toBe(3);
  });

  test("prompt 幀游標在輸入欄 ⇒ 好讀累積的 complete 閘門擋得住；文章幀停在右下角", () => {
    expect(at("reply").buf.isCursorOnInputField()).toBe(true);
    expect(at("article").buf.isCursorOnInputField()).toBe(false);
  });

  test("在回文 prompt 裡打 X 是在回答 prompt，不改開長推文；文章幀照常攔", () => {
    const intercepts = (name) =>
      shouldInterceptPushKey(Object.assign({ key: "X", prefs: LONG_PUSH_ON }, pushGateFacts({ buf: at(name).buf })));
    expect(intercepts("article")).toBe(true);
    expect(intercepts("reply")).toBe(false);
  });

  test("上傳完的網址：prompt 只收一個字 ⇒ 走剪貼簿；編輯器輸入框不出現", () => {
    const { buf, rowTexts, facts } = at("reply");
    expect(decideInsertMode({ pageState: buf.pageState, lastRowText: rowTexts[facts.rows - 1], hasTextTarget: false })).toBe(
      "clipboard",
    );
    expect(editorInputAvailable({ enabled: true, safeMode: false, pageState: buf.pageState })).toBe(false);
  });
});

describe("upstream pttbbs 產的發文 prompt（bbs.c#do_post，文章列表 ^P）", () => {
  const at = (name) => screenAt(postFlowFx, name, { perFrame: true });

  test("種類 prompt：不是文章列表、不是編輯器 ⇒ 列表好讀不接管、編輯器輸入框不出現", () => {
    const { buf, rowTexts, facts } = at("post");
    expect(rowTexts.join("\n")).toMatch(/種類：1\.問題/);
    expect(classifyListScreen(facts).kind).not.toBe("clean-list");
    expect(buf.pageState).not.toBe(6);
    expect(editorInputAvailable({ enabled: true, safeMode: false, pageState: buf.pageState })).toBe(false);
  });

  test("上傳完的網址：種類 prompt 只收一個字 ⇒ 走剪貼簿，不送字", () => {
    const { buf, rowTexts, facts } = at("post");
    expect(decideInsertMode({ pageState: buf.pageState, lastRowText: rowTexts[facts.rows - 1], hasTextTarget: false })).toBe(
      "clipboard",
    );
  });

  test("列表幀是 clean-list（對照組）", () => {
    expect(classifyListScreen(at("list").facts).kind).toBe("clean-list");
  });
});

describe("upstream pttbbs 產的編輯器（edit.c，自己的文章按 E）", () => {
  test("底列「編輯文章」＋狀態框 ⇒ pageState 6", () => {
    const { buf, rowTexts, facts } = screenAt(editorFx, "edit");
    expect(rowTexts[facts.rows - 1]).toMatch(/^ 編輯文章 /);
    expect(buf.pageState).toBe(6);
  });

  // 編輯器內文本身可以是白底黑字（Ctrl-V 彩色預覽下的 ESC[30;47m、水平捲動時的區塊選取
  // ESC[0;7m 跟在「<」後面）：游標停在那種字上不是輸入欄。誤認的後果是點空白處送 ^C，
  // 在編輯器裡是「插入色碼」（edit.c#edit_cmd_ansi_code → insert_ansi_code：非彩色模式直接
  // 插入 ESC[m、彩色模式開色碼 prompt）⇒ 草稿被改。
  const paint = (buf, bytes) => {
    new AnsiParser(buf).feed(bytes);
    buf.notify();
    clearTimeout(buf.timerUpdate);
    if (buf._settleTimer) clearTimeout(buf._settleTimer);
  };

  test("內文的白底黑字不是輸入欄：點空白處不送 ^C", () => {
    const { buf } = screenAt(editorFx, "edit");
    paint(buf, "\x1b[5;11H\x1b[30;47mAB\x1b[m\x1b[5;11H");
    expect(buf.isEditorScreenNow()).toBe(true);
    expect(buf.cur_y).toBe(4);
    expect(buf.isCursorOnInputField()).toBe(false);
    expect(buf.dismissTarget()).toBeNull();
  });

  // 彩色模式的 ^C 色碼 prompt 是 getdata(b_lines - 1, …)：底列的「編輯文章」還在，輸入欄在倒數
  // 第二列 ⇒ 那一列照舊認得是輸入欄（點空白處送 ^C 取消它）。
  test("彩色模式的色碼 prompt（倒數第二列）照舊是輸入欄", () => {
    const { buf } = screenAt(editorFx, "edit");
    paint(buf, "\x1b[23;1H\x1b[mcolor: \x1b[0;7m   \x1b[m\x1b[23;8H");
    expect(buf.isEditorScreenNow()).toBe(true);
    expect(buf.isCursorOnInputField()).toBe(true);
  });

  // ^X 的「檔案處理」（edit.c#write_file）：getdata(2, 0, "確定要儲存檔案嗎？ ")。vgetstring 的 ^C
  // 是「清空並送出」，而這裡的空答案落到 switch 之外＝第 1 列寫的 [S]（發文／發信／存檔）。
  // 點空白處送 ^C 就等於替使用者把文章發出去。
  test("編輯器的「檔案處理」輸入欄：點空白處不送 ^C（空答案＝存檔／發文）", () => {
    const { buf, rowTexts } = screenAt(editorFx, "save-menu");
    expect(rowTexts[0]).toContain("檔案處理");
    expect(rowTexts[2]).toContain("確定要儲存檔案嗎");
    expect(buf.cur_y).toBe(2);
    expect(buf.isCursorOnInputField()).toBe(true);
    expect(buf.dismissTarget()).toBeNull();
    // 一鍵登出的逃生同一個判斷：不送 ^C（改送 ←，在輸入欄裡只移游標 ⇒ 畫面沒變 ⇒ 停手）。
    const esc = logoutEscapeKey({
      row0: rowTexts[0],
      lastRowText: rowTexts[buf.rows - 1],
      cursorOnInputField: buf.isCursorOnInputField(),
      inputPromptText: buf.inputPromptText(),
    });
    expect(esc.bytes).not.toBe("\x03");
  });

  // 上傳完的網址插到哪：image_upload.decideInsertMode（底列分類共用 classifyPushScreen）。
  test("圖片上傳插入位置：編輯器與推文內容列送字，型別選單／確定／列表一律剪貼簿", () => {
    const mode = (fx, name) => {
      const { buf, rowTexts, facts } = screenAt(fx, name);
      return decideInsertMode({
        pageState: buf.pageState,
        lastRowText: rowTexts[facts.rows - 1],
        hasTextTarget: false,
      });
    };
    expect(mode(editorFx, "edit")).toBe("send");
    expect(mode(pushFx, "push-2")).toBe("send");
    expect(mode(pushAgainFx, "too-close")).toBe("send");
    expect(mode(pushFx, "push-1")).toBe("clipboard"); // vkey 只吃 1 byte
    expect(mode(pushFlowFx, "confirm")).toBe("clipboard");
    expect(mode(editorFx, "list")).toBe("clipboard");
    expect(mode(articleFx, "article")).toBe("clipboard");
  });

  // 返回手勢／邊緣翻頁的方向鍵（nav_key_gate）：型別選單 vkey 收到 ← 會當成「推」前進到輸入列。
  // 列表按 X 之後 pageState 黏在列表（setPageState 沒有 reset 分支），只靠 pageState 擋不住。
  test("返回手勢：列表照送，型別選單與推文內容列不送", () => {
    const reason = (name) =>
      navKeyBlockReason({ modalShown: false, conn: { isConnected: true }, buf: screenAt(pushFx, name).buf });
    expect(reason("list")).toBe(null);
    expect(screenAt(pushFx, "push-1").buf.pageState).toBe(screenAt(pushFx, "list").buf.pageState);
    expect(reason("push-1")).toBe("pushTypeMenu");
    expect(reason("push-2")).toBe("inputField");
  });

  // 原生畫面的滾輪（PgUp／PgDn）與中鍵「左方向鍵」：型別選單 vkey 收到它們一樣當成「推」。
  test("滾輪翻頁、中鍵 ←：列表照送，型別選單與推文內容列不送", () => {
    const appAt = (name) => {
      const app = Object.create(App.prototype);
      app.modalShown = false;
      app.mouseButtons = { syncFromButtons() {}, right: false, left: false };
      app.aidNavigation = { active: false };
      app._onUploadLayer = () => false;
      app.mouseGates = () => ({ wheel: true, wheelSmoothScroll: false, middleClick: 2 });
      app.buf = screenAt(pushFx, name).buf;
      app.view = { useEasyReadingMode: false, _send: vi.fn() };
      app.CmdHandler = { setAttribute() {} };
      app.setBBSCmd = vi.fn();
      return app;
    };
    const wheel = { deltaX: 0, deltaY: 120, buttons: 0, preventDefault() {}, stopPropagation() {} };
    const middle = { button: 1, target: document.body };
    const list = appAt("list");
    list.mouse_scroll(wheel);
    expect(list.setBBSCmd).toHaveBeenCalledWith("doPageDown");
    list.middleMouse_down(middle);
    expect(list.view._send).toHaveBeenCalledWith("\x1b[D");
    for (const name of ["push-1", "push-2"]) {
      const app = appAt(name);
      app.mouse_scroll(wheel);
      app.middleMouse_down(middle);
      expect(app.setBBSCmd).not.toHaveBeenCalled();
      expect(app.view._send).not.toHaveBeenCalled();
    }
  });

  // 滑鼠點列（mouse_regions）與游標底色（cursor_highlight）同一個道理：型別選單開著時下方的列表
  // 是殘影，點下去送的方向鍵＋⏎ 會被 vkey 當成「推」。跟輸入框同一條早退（buf.isPromptPending）。
  test("滑鼠：列表的文章列點得下去，型別選單與推文內容列整幀不可點", () => {
    const at = (name) => {
      const { buf } = screenAt(pushFx, name);
      buf.useMouseBrowsing = true;
      return buf;
    };
    const list = at("list");
    const row = list.cur_y; // 列表游標所在的文章列
    expect(list.isPromptPending()).toBe(false);
    expect(list._resolveMouseRegionAt(40, row).action).not.toBe("none");
    for (const name of ["push-1", "push-2"]) {
      const buf = at(name);
      expect(buf.isPromptPending()).toBe(true);
      expect(buf._resolveMouseRegionAt(40, row).action).toBe("none");
    }
  });
});

describe("upstream pttbbs 產的選看板自動完成（name.c#generalnamecomplete）", () => {
  const frame = (name) => parseBoardPromptFrame(screenAt(boardCompleteFx, name).facts);

  test("剛開 prompt／打字還沒按空白：讀得出輸入欄、沒有清單", () => {
    expect(frame("board")).toEqual({ field: "", candidates: null, more: false });
    expect(frame("typed")).toEqual({ field: "M", candidates: null, more: false });
  });

  test("空白 ⇒ 清單依板名排序；查 M 的結論是兩個候選、Enter 進不了板", () => {
    const f = frame("candidates");
    expect(f).toEqual({ field: "M", candidates: ["Mine", "Movie"], more: false });
    const r = boardQueryResult("M", f);
    expect(r).toMatchObject({ rejected: false, completion: "M", candidates: ["Mine", "Movie"] });
    expect(resolvedBoardName(r, "M")).toBe("");
  });

  test("打 x 沒有看板以 Mx 開頭 ⇒ 輸入欄不變，查 Mx 判成被拒", () => {
    const f = frame("rejected");
    expect(f.field).toBe("M");
    expect(boardQueryResult("Mx", f)).toMatchObject({ accepted: 1, rejected: true, candidates: [] });
  });

  test("Mo 再空白 ⇒ 唯一的 Movie 補完，Enter 會進 Movie", () => {
    // 中間幀：輸入欄已是 Mo，清單還是上一趟的（Mine 不以 Mo 開頭，不能拿來當 Mo 的結論）
    expect(frame("typed-2")).toMatchObject({ field: "Mo", candidates: ["Mine", "Movie"] });
    const f = frame("completed");
    expect(f).toEqual({ field: "Movie", candidates: ["Movie"], more: false });
    expect(resolvedBoardName(boardQueryResult("Mo", f), "Mo")).toBe("Movie");
  });

  test("主功能表本身不是 prompt", () => {
    expect(frame("menu")).toBeNull();
  });
});

describe("upstream pttbbs 產的搜尋結果列表（系列文章）", () => {
  test("標題列「系列《板》」、底列「系列文章」⇒ 認成子列表（select 編號空間）", () => {
    for (const [fx, name] of [
      [searchRefineFx, "result"],
      [pushSearchFx, "result"],
    ]) {
      const { rowTexts, facts } = screenAt(fx, name);
      expect(isSubListTitle(rowTexts[0])).toBe(true);
      expect(isSubListFooter(rowTexts[facts.rows - 1])).toBe(true);
      expect(listModeOf(facts)).toBe("select");
    }
  });

  test("一般文章列表不是子列表", () => {
    const { rowTexts, facts } = screenAt(articleListFx, "list");
    expect(isSubListTitle(rowTexts[0])).toBe(false);
    expect(isSubListFooter(rowTexts[facts.rows - 1])).toBe(false);
    expect(listModeOf(facts)).toBe("plain");
  });
});

describe("upstream pttbbs 產的文摘（Tab，bbs.c#board_digest）", () => {
  test("標題列「文摘《板》」、底列「文摘列表」⇒ 子列表，重新整理不接手（s 會離開文摘）", () => {
    const { buf, rowTexts, facts } = screenAt(digestFx, "digest");
    expect(rowTexts[0]).toMatch(/文摘《Gossip》/);
    expect(isSubListTitle(rowTexts[0])).toBe(true);
    expect(isSubListFooter(rowTexts[facts.rows - 1])).toBe(true);
    expect(listModeOf(facts)).toBe("select");
    expect(buf.pageState).toBe(2);
    expect(refreshTargetFromFacts(facts, buf.pageState, {})).toBeNull();
  });

  test("文摘的編號是自己的：只有收進文摘的兩篇，從 1 重新編", () => {
    const { rowTexts } = screenAt(digestFx, "digest");
    const rows = rowTexts.filter((t) => parseListArticleNum(t) != null);
    expect(rows.map((t) => [parseListArticleNum(t), subjectOfListText(t)])).toEqual([
      [1, "[爆卦] 收進文摘的文章"],
      [2, "[新聞] 第二篇文摘"],
    ]);
  });

  test("文摘裡的 Q：AID 是 G 檔名（type 1），換得回 G.<時間>.A.<hex>", () => {
    const { rowTexts } = screenAt(digestFx, "info");
    const found = rowTexts.map(parsePostInfoAid).filter(Boolean);
    expect(found).toHaveLength(1);
    expect(found[0].board).toBe("Gossip");
    expect(aidToFn(found[0].aid)).toMatch(/^G\.\d+\.A\.[0-9A-F]{3}$/);
  });

  // read.c#select_by_aid 在 fn_mandex 找到 type 1 的 AID 時只設 default_ch=Tab，
  // read_cmd_aid 卻沒用它 ⇒ 不切文摘、游標不動、也沒有「找不到」⇒ 落地檢查照樣過，
  // 接著 ⏎ 開的是游標原本那篇。所以送 # 之前一律換回原文的 M（toPostAid）。
  test("完整列表上 # 文摘的 G AID：游標不動、沒有錯誤 ⇒ 落地檢查會誤判；換成 M 才落在原文", () => {
    const g = screenAt(digestFx, "info").rowTexts.map(parsePostInfoAid).filter(Boolean)[0].aid;
    expect(g).toBe("5giJk-0-");

    const at1 = screenAt(digestAidFx, "at-1");
    const miss = screenAt(digestAidFx, "g-aid");
    expect(miss.facts.curY).toBe(at1.facts.curY); // 游標沒動
    // 同 list_session 組給 command queue 的 facts（kind／boardName／cursorRowNum）
    const nums = pageArticleNums(miss.rowTexts, miss.facts.curY);
    const missFacts = {
      ...miss.facts,
      ...classifyListScreen(miss.facts),
      cursorRowNum: nums[miss.facts.curY],
    };
    expect(aidSearchLanded(missFacts)).toBe(true); // 畫面上分不出來
    expect(subjectOfListText(miss.rowTexts[miss.facts.curY])).toBe("[爆卦] 收進文摘的文章");

    expect(toPostAid(g)).toBe("1giJk-0-");
    const hit = screenAt(digestAidFx, "m-aid");
    expect(subjectOfListText(hit.rowTexts[hit.facts.curY])).toBe("[新聞] 第二篇文摘");
  });

  test("文摘裡開的文章是 READING；← 回文摘（子列表），文摘上再 ← 回完整列表（不是離板）", () => {
    const article = screenAt(digestFx, "article");
    expect(article.buf.pageState).toBe(3);
    expect(parsePagerFooterContext(article.rowTexts[article.facts.rows - 1])).toBe("reading");

    const back = screenAt(digestFx, "back");
    const backFacts = { ...back.facts, ...classifyListScreen(back.facts) };
    expect(landedOnBoardList(backFacts, "gossip")).toEqual({ sub: true });

    const plain = screenAt(digestFx, "plain");
    const plainFacts = { ...plain.facts, ...classifyListScreen(plain.facts) };
    expect(listModeOf(plain.facts)).toBe("plain");
    expect(landedOnBoardList(plainFacts, "gossip")).toEqual({ sub: false });
  });
});

describe("upstream pttbbs 產的看板精華區（z，bbs.c#b_man → announce.c#a_menu）", () => {
  const PREFS = { enableLongPush: true, pushKeyOpensLongPush: true };

  test("精華區選單：標題列【精華文章】、pageState 1；不是文章列表／看板列表，重新整理不接手", () => {
    const { buf, rowTexts, facts } = screenAt(essenceFx, "menu", { perFrame: true });
    expect(rowTexts[0]).toMatch(/^【精華文章】/);
    expect(buf.pageState).toBe(1);
    expect(classifyListScreen(facts).kind).not.toBe("clean-list");
    expect(classifyBoardListScreen(facts)).toBeNull();
    expect(refreshTargetFromFacts(searchGateFacts({ buf }), buf.pageState, {})).toBeNull();
  });

  // b_man 不 setutmpmode（只有主功能表的 Announce() 設 ANNOUNCE）⇒ currstat 還是 READING，
  // more.c#common_pmore_footer_handler 照樣疊 pager_reading_cmds，footer 跟看板文章一字不差。
  // 但這時 pager 回傳的 s／#／Q／X／y 都只會讓 announce_cmd_select 的迴圈 break 回精華區選單，
  // 後面送的字全打進選單 ⇒ 只看 footer 會認錯。
  test("從精華區開的文章：footer 跟 READING 一字不差，但不得當成看板文章", () => {
    const { buf, rowTexts, facts } = screenAt(essenceFx, "article", { perFrame: true });
    expect(buf.pageState).toBe(3);
    expect(parsePagerFooterContext(rowTexts[facts.rows - 1])).toBe("reading");

    const gate = searchGateFacts({ buf });
    expect(
      refreshTargetFromFacts(gate, buf.pageState, { articleBoard: "Gossip", listOpened: true }),
    ).toBeNull();
    expect(toolbarContextFromFacts(gate, buf.pageState, { articleBoard: "Gossip" })).toMatchObject({
      push: false,
      reply: false,
      share: false,
      threadNav: false,
      end: true,
    });
    const push = pushGateFacts({ buf });
    expect(shouldInterceptPushKey({ key: "X", prefs: PREFS, ...push })).toBe(false);
    // aid_navigation（重新整理／返回／跳文）問的也是這個
    expect(buf.pagerContext()).toBe("essence");
  });

  test("回到文章列表後再開的文章是看板文章（精華區的標記不殘留）", () => {
    const list = screenAt(essenceFx, "list-again", { perFrame: true });
    expect(list.buf.pagerFromEssence).toBe(false);

    const { buf } = screenAt(digestFx, "article", { perFrame: true });
    expect(buf.pagerContext()).toBe("reading");
    const gate = searchGateFacts({ buf });
    expect(refreshTargetFromFacts(gate, buf.pageState, { articleBoard: "Gossip" })).toEqual({
      kind: "article",
      board: "Gossip",
    });
    expect(toolbarContextFromFacts(gate, buf.pageState, {})).toMatchObject({ push: true, share: true });
    const push = pushGateFacts({ buf });
    expect(shouldInterceptPushKey({ key: "X", prefs: PREFS, ...push })).toBe(true);
  });
});

describe("upstream pttbbs 產的文章資訊框（文章列表的 Q）", () => {
  const { rowTexts, facts } = screenAt(postInfoFx, "info");

  test("框裡讀得出 AID 與看板；底列是 pressanykey", () => {
    const found = rowTexts.map(parsePostInfoAid).filter(Boolean);
    expect(found).toEqual([{ aid: expect.stringMatching(/^[0-9A-Za-z_-]{8}$/), board: "Test" }]);
    expect(rowTexts[facts.rows - 1]).toMatch(/請按任意鍵繼續/);
  });

  test("列表列本身不會被當成文章資訊", () => {
    const list = screenAt(postInfoFx, "list").rowTexts;
    expect(list.map(parsePostInfoAid).filter(Boolean)).toEqual([]);
    expect(list.map(parsePostInfoUrl).filter(Boolean)).toEqual([]);
  });

  // 列表的稍後再讀（list_session.readLaterAt）的兩步判準：Q 那一步只在框出現時算數，
  // 關框那一步要回到乾淨的列表、框不在了。
  test("postInfoAnswer：列表幀＝還沒出現；框＝AID；空白關框＝乾淨的列表、游標沒動", () => {
    const list = screenAt(postInfoFx, "list");
    expect(postInfoAnswer(list.facts.rowTexts, list.facts.rows)).toBe(false);
    expect(postInfoAnswer(rowTexts, facts.rows)).toEqual({
      info: { aid: expect.stringMatching(/^[0-9A-Za-z_-]{8}$/), board: "Test" },
    });
    expect(classifyListScreen(facts).kind).not.toBe("clean-list");
    const back = screenAt(postInfoFx, "dismissed");
    expect(postInfoAnswer(back.facts.rowTexts, back.facts.rows)).toBe(false);
    expect(classifyListScreen(back.facts).kind).toBe("clean-list");
    expect(back.facts.curY).toBe(list.facts.curY);
  });
});

describe("upstream pttbbs 產的進板畫面", () => {
  test("進板畫面（notes＋請按任意鍵繼續）判成要送鍵跳過", () => {
    const { rowTexts, facts } = screenAt(boardNoteFx, "note");
    expect(rowTexts[0]).toContain("歡迎來到 Notes 板");
    expect(boardNoteDecision(facts)).toEqual({ action: "skip", key: " ", shape: "pause" });
  });

  test("按鍵之後落地文章列表 ⇒ 解除", () => {
    const { facts } = screenAt(boardNoteFx, "list");
    expect(classifyListScreen(facts)).toEqual({ kind: "clean-list", boardName: "Notes" });
    expect(boardNoteDecision(facts)).toEqual({ action: "landed" });
  });
});

describe("upstream pttbbs 產的看板列表（我的最愛）", () => {
  const { rowTexts, facts } = screenAt(boardListFx, "fav");
  const FAV = ["Test", "Notes", "Gossip", "Movie"];

  test("判成可接手的我的最愛", () => {
    const brd = classifyBoardListScreen(facts);
    expect(brd).toMatchObject({
      variant: "fav",
      newflag: false,
      parked: true,
      cursorNum: 1,
      topNum: 1,
      engageable: true,
    });
    expect(boardListContextKind(facts)).toBe("brdlist");
  });

  test("逐列解析出編號／板名／未讀", () => {
    FAV.forEach((name, i) => {
      const t = rowTexts[3 + i];
      expect(parseBoardListName(t)).toBe(name);
      // seed 的 Test／Notes／Gossip 有文章、Movie 沒有
      expect(parseFavRow(t)).toMatchObject({ num: i + 1, name, unread: name !== "Movie" });
    });
    expect(parseFavRow(rowTexts[3]).desc).toBe("測試看板");
  });

  test("在看板列表按 ⏎ 是進板 ⇒ arm", () => {
    expect(boardEntryArms(rowTexts, "\r")).toBe(true);
  });
});

describe("upstream pttbbs 產的主功能表", () => {
  const { buf, facts } = screenAt(mainMenuFx, "menu");

  test("認得出主功能表（有 (F)avorite）", () => {
    expect(isHomeScreen(facts)).toBe(true);
    expect(classifyListScreen(facts).kind).toBe("menu");
    expect(buf.pageState).toBe(1);
  });
});

describe("upstream pttbbs 產的看板列表切換（y 全部看板、c 文章總數）", () => {
  const at = (name) => screenAt(boardListTogglesFx, name).facts;

  test("y 列出全部看板：caption 不變但認成 all，不接管", () => {
    expect(classifyBoardListScreen(at("all"))).toMatchObject({ variant: "all", engageable: false });
    expect(boardListContextKind(at("all"))).toBe("brdlist-other");
  });

  test("再按 y 回我的最愛：認回 fav、可接管", () => {
    expect(classifyBoardListScreen(at("fav-again"))).toMatchObject({ variant: "fav", engageable: true });
    expect(boardListContextKind(at("fav-again"))).toBe("brdlist");
  });

  test("c 切成文章總數：newflag、不接管（編號欄印的是總數）", () => {
    expect(classifyBoardListScreen(at("newflag"))).toMatchObject({ newflag: true, engageable: false });
    expect(boardListContextKind(at("newflag"))).toBe("brdlist-other");
  });
});

describe("upstream pttbbs 產的分類看板（主功能表 C，board.c#Class）", () => {
  const at = (name) => screenAt(classListFx, name);

  test("分類根（class_bid 1）：不是可接管的看板列表、也不是文章列表", () => {
    const { facts } = at("root");
    expect(facts.rowTexts[0]).toContain("分類看板");
    expect(classifyBoardListScreen(facts)).toBeNull();
    expect(classifyListScreen(facts).kind).not.toBe("clean-list");
  });

  test("進群組（class_bid>1）：認成 class 變體、可接管，列解析得出板名", () => {
    const { facts, rowTexts } = at("group");
    expect(classifyBoardListScreen(facts)).toMatchObject({
      variant: "class",
      newflag: false,
      cursorNum: 1,
      topNum: 1,
      engageable: true,
    });
    expect(boardListContextKind(facts)).toBe("brdlist");
    expect(parseBoardListName(rowTexts[3])).toBe("Child");
  });
});

describe("upstream pttbbs 產的新信提示（menu.c#redraw_title）", () => {
  const plain = screenAt(mainMenuFx, "menu");
  const mail = screenAt(mainMenuNewMailFx, "menu");

  test("有新信：收件匣、首頁儀表板、手機 App Bar 都看得出來；主功能表照樣認得", () => {
    expect(newMailOnScreen(mail.rowTexts[0], mail.buf.pageState)).toBe(true);
    expect(hasNewMail(mail.rowTexts[0])).toBe(true);
    expect(appBarFromFacts(mail.facts, { pageState: mail.buf.pageState })).toMatchObject({
      kind: "menu",
      newMail: true,
    });
    expect(isHomeScreen(mail.facts)).toBe(true);
  });

  test("沒有新信：三處都是 false", () => {
    expect(newMailOnScreen(plain.rowTexts[0], plain.buf.pageState)).toBe(false);
    expect(hasNewMail(plain.rowTexts[0])).toBe(false);
    expect(appBarFromFacts(plain.facts, { pageState: plain.buf.pageState })).toMatchObject({
      kind: "menu",
      newMail: false,
    });
  });
});

// generate.sh 關掉 sample conf 的 CONFIG_OLD_RECOMMEND（PTT 實跑推／噓／→）。以前開著產的 fixture
// 按 X 直接是「→ id:」，型別選單從沒被 upstream 畫面驗過。
// 非 IP 板的輸入欄寬＝bbs.c#comment 的 maxlength：78-3-6-1-6 - strlen("tester")。
const PUSH_FIELD = 62 - "tester".length;

describe("upstream pttbbs 產的推文畫面（bbs.c#comment）", () => {
  test("文章列表按 X ⇒ 型別選單（可噓），按 1 ⇒「推 自己的 id:」輸入列", () => {
    expect(classifyPushScreen(screenAt(pushFx, "push-1").rowTexts)).toEqual({
      kind: "typeMenu",
      booAllowed: true,
    });
    const { buf, rowTexts } = screenAt(pushFx, "push-2");
    expect(classifyPushScreen(rowTexts)).toEqual({ kind: "inputPrompt", type: "推", userId: "tester" });
    expect(buf.inputFieldWidth()).toBe(PUSH_FIELD);
    expect(pushMaxBytes({ fieldWidth: buf.inputFieldWidth() })).toBe(PUSH_FIELD - 1);
  });

  test("型別選單不是輸入欄（vkey 單鍵）⇒ 量不到欄寬", () => {
    expect(screenAt(pushFx, "push-1").buf.inputFieldWidth()).toBeNull();
  });
});

describe("upstream pttbbs 產的長推文續推（90 秒內再按 X）", () => {
  const at = (name) => screenAt(pushAgainFx, name);

  test("推完回到列表；再按 X 沒有型別選單，倒數第二列「時間太近」＋直接是 → 輸入列", () => {
    expect(classifyPushScreen(at("done").rowTexts)).toEqual({ kind: "other" });
    const { buf, rowTexts } = at("too-close");
    expect(rowTexts[22]).toMatch(/^時間太近, 使用 → 加註方式/);
    expect(classifyPushScreen(rowTexts)).toEqual({ kind: "inputPrompt", type: "→", userId: "tester" });
    expect(buf.inputFieldWidth()).toBe(PUSH_FIELD);
  });

  test("續推的內容 ⏎ 一樣到確定[y/N]", () => {
    expect(classifyPushScreen(at("confirm").rowTexts)).toEqual({ kind: "confirm" });
  });
});

describe("upstream pttbbs 產的推自己的文章", () => {
  test("沒有型別選單，倒數第二列「作者本人」＋→ 輸入列", () => {
    const { buf, rowTexts } = screenAt(pushOwnerFx, "owner");
    expect(rowTexts[22]).toMatch(/^作者本人, 使用 → 加註方式/);
    expect(classifyPushScreen(rowTexts)).toEqual({ kind: "inputPrompt", type: "→", userId: "tester" });
    expect(buf.inputFieldWidth()).toBe(PUSH_FIELD);
  });
});

describe("upstream pttbbs 產的搜尋結果裡推文", () => {
  test("系列文章列表按 X ⇒ 型別選單，1 ⇒ 推 輸入列", () => {
    expect(classifyPushScreen(screenAt(pushSearchFx, "result").rowTexts)).toEqual({ kind: "other" });
    expect(classifyPushScreen(screenAt(pushSearchFx, "menu").rowTexts)).toMatchObject({ kind: "typeMenu" });
    expect(classifyPushScreen(screenAt(pushSearchFx, "input").rowTexts)).toEqual({
      kind: "inputPrompt",
      type: "推",
      userId: "tester",
    });
  });
});

describe("upstream pttbbs 產的搜尋 prompt（read.c#ask_filter_predicate、do_select）", () => {
  const KINDS = ["title", "author", "push", "board"];
  const only = (fx, name, kind) => {
    const { facts } = screenAt(fx, name);
    for (const k of KINDS) expect(isSearchPromptFrame(k, facts), `${name} 當成 ${k}`).toBe(k === kind);
  };

  test("文章列表的 / a Z s 各自認成對的那一種，其他種不認", () => {
    only(searchPromptsFx, "title", "title");
    only(searchPromptsFx, "author", "author");
    only(searchPromptsFx, "push", "push");
    only(searchPromptsFx, "board", "board");
  });

  test("已在搜尋結果裡再按 /：「增加條件 標題:」也認得", () => {
    only(searchRefineFx, "title", "title");
  });

  test("列表本身、主功能表都不是 prompt；主功能表的 s 是選看板 prompt", () => {
    only(searchPromptsFx, "list", null);
    only(searchRefineFx, "result", null);
    only(menuSearchFx, "menu", null);
    only(menuSearchFx, "board", "board");
  });
});

// seed.tsv 的 W 列：依序收 alice、bob、carol ⇒ 最新一位是 carol（swater_get_slot 把最新的
// 寄件人提到 swater[0]）。收件匣的解析不在這裡測：pfterm 只在等鍵前送出最後的畫面，一次收三顆
// 時前兩顆的底列早被蓋掉，跟真的連線上一顆一包不同。

describe("upstream pttbbs 產的回水球畫面（一般模式）", () => {
  const step = (name) => classifyReplyScreen(screenAt(waterballDefaultFx, name).rowTexts);

  test("第一下 ^R：訊息傳過去 prompt，對象是最新一位 ⇒ 回 carol 直接交給使用者", () => {
    const s = step("prompt");
    expect(s).toEqual({ mode: "default", selected: null, panel: false });
    expect(nextReplyStep(s, "carol", "carol", 1)).toBe("done");
    expect(nextReplyStep(s, "alice", "carol", 1)).toBe("next");
  });

  test("再按 ^R：訊息回顧，選中那則由新往舊（carol → bob → alice）", () => {
    expect(step("panel-1")).toEqual({ mode: "default", selected: "carol", panel: true });
    expect(step("panel-2")).toEqual({ mode: "default", selected: "bob", panel: true });
    expect(step("panel-3")).toEqual({ mode: "default", selected: "alice", panel: true });
    expect(nextReplyStep(step("panel-2"), "bob", "carol", 3)).toBe("done");
    expect(nextReplyStep(step("panel-2"), "alice", "carol", 3)).toBe("next");
  });
});

describe("upstream pttbbs 產的回水球畫面（一對一模式）", () => {
  const step = (name) => classifyReplyScreen(screenAt(waterballOfoFx, name).rowTexts);

  test("^R 開名單，預設選最新一位，每按一下換下一位", () => {
    expect(step("ofo-1")).toEqual({ mode: "ofo", selected: "carol", panel: false });
    expect(step("ofo-2")).toEqual({ mode: "ofo", selected: "bob", panel: false });
    expect(step("ofo-3")).toEqual({ mode: "ofo", selected: "alice", panel: false });
    expect(nextReplyStep(step("ofo-1"), "carol", "carol", 1)).toBe("done");
    expect(nextReplyStep(step("ofo-1"), "alice", "carol", 1)).toBe("next");
  });

  test("主功能表那一幀不是回覆畫面 ⇒ 認不出（不送鍵）", () => {
    expect(step("menu")).toBe(null);
  });
});

describe("upstream pttbbs 產的推文流程（bbs.c#comment 型別 → 輸入 → 確認 → 寫入）", () => {
  const kind = (name) => classifyPushScreen(screenAt(pushFlowFx, name).rowTexts);

  test("打完內容 ⏎ ⇒ 確定[y/N]；y⏎ 之後離開推文畫面", () => {
    expect(kind("menu")).toMatchObject({ kind: "typeMenu" });
    expect(kind("input")).toMatchObject({ kind: "inputPrompt", type: "推", userId: "tester" });
    expect(kind("confirm")).toEqual({ kind: "confirm" });
    expect(kind("done")).toEqual({ kind: "other" });
  });

  test("寫進文章的推文列帶時間戳 ⇒ 不是輸入列；Test 板不記 IP ⇒ detectIpLogged 為 false（不是 null）", () => {
    const { rowTexts } = screenAt(pushFlowFx, "article");
    const row = rowTexts.find((t) => /^推 tester *:hello/.test(t));
    expect(row).toBeTruthy();
    expect(classifyPushScreen([row])).toEqual({ kind: "other" });
    expect(detectIpLogged(rowTexts)).toBe(false);
  });
});

describe("upstream pttbbs 產的 #AID 找不到（read.c 的 AID 搜尋）", () => {
  const at = (name) => {
    const { buf, rowTexts, facts } = screenAt(aidMissFx, name);
    return { rowTexts, facts, last: rowTexts[buf.rows - 1] };
  };
  const hit = (rowTexts) => rowTexts.some((t) => AID_NOT_FOUND_RE.test(t));

  test("找不到／不合法兩種訊息都認得，而且是按任意鍵（送空白收掉）", () => {
    for (const [name, text] of [
      ["not-found", "找不到這個文章代碼"],
      ["invalid", "不合法的文章代碼"],
    ]) {
      // 訊息印在 prompt 那一列，底列是 pressanykey 的「請按任意鍵繼續」橫幅。
      const { rowTexts, last } = at(name);
      expect(rowTexts.some((t) => t.includes(text))).toBe(true);
      expect(hit(rowTexts)).toBe(true);
      expect(resolveDismiss({ lastRowText: last, cursorOnInputField: false })).toMatchObject({ bytes: " " });
    }
  });

  test("列表本身與收掉訊息後的列表不會被當成找不到", () => {
    expect(hit(at("list").rowTexts)).toBe(false);
    const back = at("back");
    expect(hit(back.rowTexts)).toBe(false);
    expect(classifyListScreen(back.facts).kind).toBe("clean-list");
  });
});

describe("upstream pttbbs 產的看板列表重新整理（board.c 的 / 關鍵字 prompt）", () => {
  const [open, submit] = buildBoardListRefreshSteps({});
  const facts = (name) => screenAt(boardListRefreshFx, name).facts;

  test("重整目標是看板列表；/ 開出關鍵字 prompt 才算第一步落地", () => {
    expect(refreshTargetFromFacts(facts("fav"), 0, {})).toEqual({ kind: "board-list" });
    expect(isBoardKeywordPromptFrame(facts("fav"))).toBe(false);
    expect(isBoardKeywordPromptFrame(facts("keyword"))).toBe(true);
    expect(open.keys).toBe("/");
    expect(open.expect(null, facts("keyword"))).toBe(true);
    expect(open.expect(null, facts("fav"))).toBe(false);
  });

  test("⏎ 送出後回到看板列表，第二步落地；prompt 那一幀游標不在列上 ⇒ 平滑捲動不接管", () => {
    expect(submit.expect(null, facts("reloaded"))).toBe(true);
    expect(classifyBoardListScreen(facts("reloaded"))).toMatchObject({ parked: true, engageable: true });
    // prompt 畫在倒數第二列，列表與 footer 都還在 ⇒ 仍認得是看板列表，但游標停在輸入欄。
    expect(classifyBoardListScreen(facts("keyword"))).toMatchObject({ parked: false, engageable: false });
  });
});

describe("upstream pttbbs 產的文章列表 v prompt（bbs.c#b_mark_read_unread）", () => {
  test("v 開出的 getdata prompt 認得、列表那一幀不認", () => {
    const prompt = screenAt(markReadPromptFx, "prompt");
    expect(markReadPromptShown(prompt.rowTexts)).toBe(true);
    expect(markReadPromptShown(screenAt(markReadPromptFx, "list").rowTexts)).toBe(false);
  });

  test("prompt 是輸入欄 ⇒ 關閉／逃生送 ^C，不是空白", () => {
    const { buf, rowTexts } = screenAt(markReadPromptFx, "prompt");
    expect(buf.isCursorOnInputField()).toBe(true);
    const d = resolveDismiss({ lastRowText: rowTexts[buf.rows - 1], cursorOnInputField: true });
    expect(d.kind).toBe(DISMISS_INPUT);
  });
});

describe("upstream pttbbs 產的離站流程（xyz.c#Goodbye）", () => {
  const facts = (name) => {
    const { buf, rowTexts } = screenAt(goodbyeFx, name);
    return {
      buf,
      rowTexts,
      screen: { row0: rowTexts[0], lastRowText: rowTexts[buf.rows - 1], cursorOnInputField: buf.isCursorOnInputField() },
    };
  };

  test("主功能表 ⇒ 不送逃生鍵，直接 G⏎", () => {
    expect(logoutEscapeKey(facts("menu").screen)).toEqual({ menu: true });
    expect(isGoodbyeConfirm(facts("menu").rowTexts)).toBe(false);
  });

  test("G⏎ 開出確認 prompt", () => {
    const { rowTexts, screen } = facts("confirm");
    expect(isGoodbyeConfirm(rowTexts)).toBe(true);
    expect(isAnyKeyPause(screen.lastRowText)).toBe(false);
    expect(screen.cursorOnInputField).toBe(true);
  });

  test("y⏎ 之後的停留時間是 pressanykey ⇒ 送空白讓 server 關線", () => {
    const { screen, rowTexts } = facts("pause");
    expect(isAnyKeyPause(screen.lastRowText)).toBe(true);
    expect(isGoodbyeConfirm(rowTexts)).toBe(false);
  });
});

describe("upstream pttbbs 產的新格式推文（post.svc 檔尾＋pmore 三種留言色彩主題）", () => {
  // seed.tsv 的 Comment 板：作者 nina；[1] alice（帶 IP）、[2] bob（兩列內容）、[3] nina（原PO）、
  // [4] carol 本人刪、[5] dave 別人刪、[6] erin。
  const annotate = (rowTexts, blacklist) => {
    const ctx = {
      blacklist: new Set(blacklist),
      showFloorNumbers: true,
      floorCounter: new FloorCounter(),
      highlightAuthor: true,
      articleAuthor: "nina",
      modernThread: new ModernCommentThread(),
    };
    return rowTexts.map((t) => annotateComment(t, ctx));
  };
  const rowOf = (rowTexts, re) => rowTexts.findIndex((t) => re.test(t));

  for (const theme of ["classic", "simple", "bordered"]) {
    describe(theme, () => {
      const { buf, rowTexts } = screenAt(modernCommentsFx, theme);

      test("六則的標頭列都認得（含刪除的兩種），樓號照 server 給的", () => {
        const a = annotate(rowTexts, []);
        const heads = a.filter((x) => x && x.modern && x.userid);
        expect(heads.map((x) => x.userid)).toEqual(["alice", "bob", "nina", "carol", "dave", "erin"]);
        expect(heads.every((x) => x.floor === undefined)).toBe(true);
      });

      test("黑名單連內容列一起藏；刪除的推文那一列也藏", () => {
        const a = annotate(rowTexts, ["bob", "carol"]);
        const bob = rowOf(rowTexts, /\[2\] bob /);
        expect([a[bob], a[bob + 1], a[bob + 2]].map((x) => x && x.hidden)).toEqual([true, true, true]);
        expect(a[bob + 3]).toMatchObject({ userid: "nina", hidden: false });
        expect(a[rowOf(rowTexts, /\[4\] carol /)]).toMatchObject({ hidden: true });
        expect(a[rowOf(rowTexts, /\[5\] dave /)]).toMatchObject({ hidden: false });
      });

      test("原PO 高亮的 id 欄落在畫面上 id 的那幾格（典雅邊框的「╭ 」「├ 」佔 3 格）", () => {
        const a = annotate(rowTexts, []);
        const row = rowOf(rowTexts, /\[3\] nina /);
        const { authorIdStart, authorIdEnd } = a[row];
        expect(buf.getRowText(row, authorIdStart, authorIdEnd)).toBe("nina");
      });

      test("agent 全文解析：六則、內容接上、刪除的帶原因", () => {
        const { comments } = parseArticleLines(rowTexts.slice(0, -1));
        expect(comments.map((c) => [c.seq, c.user, c.content])).toEqual([
          [1, "alice", "第一則推文"],
          [2, "bob", "第二則推文第一行\n第二行回 >>1"],
          [3, "nina", "原PO回覆"],
          [4, "carol", "留言已刪除"],
          [5, "dave", "留言不顯示 (廣告)"],
          [6, "erin", "最後一則"],
        ]);
        expect(comments[0]).toMatchObject({ ip: "1.2.3.4", time: "10/28/2026 12:00" });
      });
    });
  }
});

// 浮在畫面上的送鍵入口（看板分頁、首頁看板卡片、搜尋送出、F5 重整、找未讀、全部已讀）在使用者
// 自己按出 prompt 之後還按得到。多步序列的第一個鍵（s、/、a、Z、End…）會被打進輸入欄
// （「搜尋標題:」「跳至第幾項」）或被型別選單／一鍵 prompt 當成答案 ⇒ 共用漏斗
// submitSerializedSteps／submitSearch 用本幀事實（buf.isPromptPending）擋下，一個 byte 都不送。
describe("upstream pttbbs 產的 prompt 開著時，替使用者送的多步序列不出發", () => {
  function coreAt(fx, name) {
    const { buf } = screenAt(fx, name);
    const sent = [];
    const queue = new CommandQueue({
      send: (d) => sent.push(d),
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    return { core: { buf, commandQueue: queue, activeListSession: () => null }, sent };
  }
  const PROMPT_FRAMES = [
    [searchPromptsFx, "title"],
    [searchPromptsFx, "author"],
    [searchPromptsFx, "push"],
    [pushFx, "push-1"],
  ];

  test("列表上沒有 prompt：照常出發（對照組）", () => {
    const { core, sent } = coreAt(searchPromptsFx, "list");
    expect(submitBlockedHint(core)).not.toBe(PROMPT_PENDING_HINT);
    expect(submitSearch(core, "board", "Movie")).toBe(true);
    expect(sent).toEqual(["s\f"]);
  });

  test.each(PROMPT_FRAMES.map(([fx, name]) => [name, fx]))("%s：搜尋／換板／多步序列都不送", (name, fx) => {
    const { core, sent } = coreAt(fx, name);
    expect(core.buf.isPromptPending()).toBe(true);
    expect(submitSearch(core, "board", "Movie")).toBe(false);
    expect(submitSearch(core, "title", "測試")).toBe(false);
    expect(submitSerializedSteps(core, [{ keys: "\x1b[4~", kind: "unread-jump" }], {})).toBe(false);
    expect(sent).toEqual([]);
    expect(core.searchInFlight).toBeFalsy();
    expect(submitBlockedHint(core)).toBe(PROMPT_PENDING_HINT);
  });

  test("看板分頁：「搜尋標題」prompt 開著時點分頁 ⇒ 不送 s、提示先完成輸入", () => {
    const { core, sent } = coreAt(searchPromptsFx, "title");
    const hints = [];
    core.view = { flashListHint: (msg) => hints.push(msg) };
    const tabs = new BoardTabs(core, { storage: null });
    tabs._state = { ...tabs._state, visible: true, current: "Test", tabs: ["Test", "Movie"] };
    expect(tabs.open("Movie")).toBe(false);
    expect(sent).toEqual([]);
    expect(hints).toEqual([PROMPT_PENDING_HINT]);
  });
});

// 文章裡的 #AID 連結在原生畫面（含好讀切原生鏡像）也畫得出來，使用者按出「:」跳行、「/」搜尋、
// X 推文型別選單後還點得到；外部連結（別的分頁交接、hashchange）也隨時會到。AID 跳文出發的
// 第一個鍵（離開文章）會被打進輸入欄或被型別選單當成「推」⇒ 本幀有 prompt 就不出發。
describe("upstream pttbbs 產的文章 prompt 開著時，AID 跳文不出發", () => {
  const PROMPTS = [
    [articlePromptsFx, "goto"],
    [articlePromptsFx, "search"],
    [articlePromptsFx, "search-typed"],
    [pushFx, "push-1"],
  ];

  test.each(PROMPTS.map(([fx, name]) => [name, fx]))("%s：點 #AID ⇒ 不送鍵、提示先完成輸入", (name, fx) => {
    const { buf } = screenAt(fx, name);
    buf.startedEasyReading = true;
    const hints = [];
    const begin = vi.fn();
    const self = Object.assign(Object.create(AidNavigation.prototype), {
      active: false,
      _termBuf: buf,
      _hint: (m) => hints.push(m),
      _begin: begin,
    });
    self.start("1AAAAAAA", "Test");
    expect(begin).not.toHaveBeenCalled();
    expect(hints).toEqual([PROMPT_PENDING_HINT]);
  });

  // 其他從 UI 出發的 AID 序列：F9／「← 返回」（back）、雙欄閱讀左欄（startNum）、讀完接著讀
  // 搜尋結果（startSubNum）、agent 的開板／置底文（startBoard／startPinned）。
  const ENTRIES = [
    ["back", (nav) => nav.back()],
    ["startNum", (nav) => nav.startNum("Test", 3, null, () => true)],
    ["startSubNum", (nav) => nav.startSubNum("Test", 3, () => true)],
    ["startBoard", (nav) => nav.startBoard("Test", {})],
    ["startPinned", (nav) => nav.startPinned("Test", 0)],
  ];
  const navOn = (buf) => {
    const hints = [];
    const begin = vi.fn();
    const nav = Object.assign(Object.create(AidNavigation.prototype), {
      active: false,
      _termBuf: buf,
      _hint: (m) => hints.push(m),
      _begin: begin,
      _pagerContext: () => "reading",
      _history: { beginBack: () => ({ label: "#1AAAAAAA", board: "Test", aid: "1AAAAAAA", kind: "aid" }) },
    });
    return { nav, hints, begin };
  };

  test.each(ENTRIES)("%s：文章畫面（對照組）照常出發", (name, go) => {
    const { nav, begin } = navOn(screenAt(articlePromptsFx, "article").buf);
    go(nav);
    expect(begin).toHaveBeenCalledTimes(1);
  });

  test.each(ENTRIES)("%s：prompt 開著 ⇒ 不出發、提示先完成輸入", (name, go) => {
    for (const [fx, frame] of PROMPTS) {
      const { nav, hints, begin } = navOn(screenAt(fx, frame).buf);
      go(nav);
      expect(begin, frame).not.toHaveBeenCalled();
      expect(hints, frame).toEqual([PROMPT_PENDING_HINT]);
    }
  });

  test("外部連結：prompt 開著先收著，文章畫面（對照組）才出發", () => {
    const can = (fx, name) =>
      DeepLinkController.prototype._canNavigate.call({
        _core: { connectState: 1, aidNavigation: { active: false } },
        _loggedIn: true,
        _termBuf: screenAt(fx, name).buf,
      });
    expect(can(articlePromptsFx, "article")).toBe(true);
    for (const [fx, name] of PROMPTS) expect(can(fx, name)).toBe(false);
    expect(can(searchPromptsFx, "title")).toBe(false);
  });
});
