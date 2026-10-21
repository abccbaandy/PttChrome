// @unit-env browser
// 畫面位元組由 **upstream pttbbs 原始碼本身**產生（編譯 mbbsd 物件檔＋假 SHM／假使用者的
// driver 從指定入口直接呼叫 upstream 的畫面函式，不架站、不登入），經 app 自己的
// AnsiParser → TermBuf 落格子，再跑本專案的畫面判定與解析器。手抄排版（ptt_vcol_list_layout）
// 的 row 1 是自己寫的，抓不到 upstream 在 row 1 加指令說明列（72718d5）這類改動；
// 這裡的每一個位元組都是 upstream 程式碼吐的。
//
// fixture 由 tools/ptt-src-screens/generate.sh 重產（場景表 scenes.mjs、種子 seed.tsv）。
// 平常跑 repo 裡那份（產自 pttbbs 3b8596b9）；nightly（.github/workflows/ptt-src-screens.yml）
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
} from "../../src/js/comment_parse";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import articleListFx from "./fixtures/ptt_src_screens/article_list.json";
import articleListTallFx from "./fixtures/ptt_src_screens/article_list_tall.json";
import articleFx from "./fixtures/ptt_src_screens/article.json";
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
import articlePromptsFx from "./fixtures/ptt_src_screens/article_prompts.json";
import { pushGateFacts, shouldInterceptPushKey } from "../../src/js/long_push_gate";
import { isSearchPromptFrame, searchGateFacts } from "../../src/js/article_search";
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

loadBig5Tables();

// 場景的第 0..i 幀依序餵進同一個 TermBuf（每幀只是上一幀之後 server 多吐的位元組），
// 拍下「名為 name 的那一幀畫完」的畫面。
function screenAt(fx, name) {
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
  for (let i = 0; i <= idx; ++i) parser.feed(fx.frames[i].bytes);
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
      // seed 的 Test／Notes 有文章、Gossip／Movie 沒有
      expect(parseFavRow(t)).toMatchObject({ num: i + 1, name, unread: i < 2 });
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

describe("upstream pttbbs 產的推文畫面（bbs.c#recommend）", () => {
  test("文章列表按 X ⇒ 推文輸入列（→ 自己的 id:），打字後仍是輸入列", () => {
    expect(classifyPushScreen(screenAt(pushFx, "push-1").rowTexts)).toEqual({
      kind: "inputPrompt",
      type: "→",
      userId: "tester",
    });
    expect(classifyPushScreen(screenAt(pushFx, "push-2").rowTexts)).toMatchObject({
      kind: "inputPrompt",
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

describe("upstream pttbbs 產的推文流程（bbs.c#recommend 輸入 → 確認 → 寫入）", () => {
  const kind = (name) => classifyPushScreen(screenAt(pushFlowFx, name).rowTexts);

  test("打完內容 ⏎ ⇒ 確定[y/N]；y⏎ 之後離開推文畫面", () => {
    expect(kind("input")).toMatchObject({ kind: "inputPrompt", userId: "tester" });
    expect(kind("confirm")).toEqual({ kind: "confirm" });
    expect(kind("done")).toEqual({ kind: "other" });
  });

  test("寫進文章的推文列帶時間戳 ⇒ 不是輸入列；Test 板不記 IP ⇒ detectIpLogged 為 false（不是 null）", () => {
    const { rowTexts } = screenAt(pushFlowFx, "article");
    const row = rowTexts.find((t) => /^→ tester *:hello/.test(t));
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
