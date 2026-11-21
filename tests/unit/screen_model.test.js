// @unit-env browser
// 單一畫面模型外殼（架構 review A3 步驟 a，docs/screen-model.md）：
//   1. 真畫面（upstream pttbbs 原始碼產的 ptt-src-screens）經真 TermBuf／AnsiParser，kind 認得對。
//   2. 每個事實都等於直接問 TermBuf 的既有判定（外殼不改規則）。
//   3. 一幀一份：同一幀問幾次都是同一個物件、事實只算一次；notify／pageState／游標變了就換新的。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { parseBoardName } from "../../src/js/screen_titles";
import { PAGE_STATE, SCREEN_FACTS, SCREEN_KIND, screenOf } from "../../src/js/screen_model";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import mainMenuFx from "./fixtures/ptt_src_screens/main_menu.json";
import boardListFx from "./fixtures/ptt_src_screens/board_list.json";
import articleListFx from "./fixtures/ptt_src_screens/article_list.json";
import mailListFx from "./fixtures/ptt_src_screens/mail_list.json";
import articleFx from "./fixtures/ptt_src_screens/article.json";
import editorFx from "./fixtures/ptt_src_screens/editor.json";
import editorPromptFx from "./fixtures/ptt_src_screens/editor_prompt.json";
import essenceFx from "./fixtures/ptt_src_screens/essence.json";
import boardNoteFx from "./fixtures/ptt_src_screens/board_note.json";
import pushFlowFx from "./fixtures/ptt_src_screens/push_flow.json";
import pushFx from "./fixtures/ptt_src_screens/push.json";
import liveFx from "./fixtures/ptt_src_screens/live_short.json";

loadBig5Tables();

function bufAt(fx, name) {
  const idx = fx.frames.findIndex((f) => f.name === name);
  if (idx < 0) throw new Error(`no frame ${name}`);
  const buf = new TermBuf(fx.cols, fx.rows);
  buf.setView({ update() {}, updateCursorPos() {}, refreshCursorVisibility() {}, blinkOn: false });
  buf.useMouseBrowsing = false;
  const parser = new AnsiParser(buf);
  for (let i = 0; i <= idx; ++i) parser.feed(fx.frames[i].bytes);
  buf.notify();
  clearTimeout(buf.timerUpdate);
  if (buf._settleTimer) clearTimeout(buf._settleTimer);
  return buf;
}

const CASES = [
  ["主功能表", mainMenuFx, "menu", SCREEN_KIND.MENU],
  ["看板列表（我的最愛）：pageState 2，跟文章列表同一種", boardListFx, "fav", SCREEN_KIND.LIST],
  ["文章列表", articleListFx, "list", SCREEN_KIND.LIST],
  ["信件列表", mailListFx, "mail", SCREEN_KIND.MAIL_LIST],
  ["文章", articleFx, "article", SCREEN_KIND.ARTICLE],
  ["編輯器", editorFx, "edit", SCREEN_KIND.EDITOR],
  ["編輯器裡的搜尋 prompt（pageState 黏在 6）", editorPromptFx, "search", SCREEN_KIND.EDITOR],
  ["精華區選單", essenceFx, "menu", SCREEN_KIND.OTHER_MENU],
  ["進板畫面", boardNoteFx, "note", SCREEN_KIND.PASS],
  ["文章列表上的推文輸入列", pushFlowFx, "input", SCREEN_KIND.LIST],
  ["推文類型選單（不是輸入欄的 prompt）", pushFx, "push-1", SCREEN_KIND.LIST],
  ["推文實況", liveFx, "live-1", SCREEN_KIND.LIVE],
];

const DIRECT = {
  row0Text: (b) => b.getRowText(0, 0, b.cols),
  lastRowText: (b) => b.getRowText(b.rows - 1, 0, b.cols),
  pass: (b) => b.isPassScreenNow(),
  editor: (b) => b.isEditorScreenNow(),
  editorTyping: (b) => b.isEditorTypingNow(),
  live: (b) => b.isLiveScreenNow(),
  mailList: (b) => b.isMailListScreen(),
  boardList: (b) => b.isBoardListScreen(),
  menu: (b) => b.isMenuScreen(),
  cursorOnInputField: (b) => b.isCursorOnInputField(),
  promptPending: (b) => b.isPromptPending(),
  pagerContext: (b) => b.pagerContext(),
  boardName: (b) => parseBoardName(b.getRowText(0, 0, b.cols)),
};

describe("真畫面的 kind", () => {
  test.each(CASES)("%s", (_label, fx, frame, kind) => {
    const s = screenOf(bufAt(fx, frame));
    expect(s.kind).toBe(kind);
    expect(s.unknown).toBe(false);
    // inArticle ＝「文章或實況」，其他畫面都不是。
    expect(s.inArticle).toBe(kind === SCREEN_KIND.ARTICLE || kind === SCREEN_KIND.LIVE);
  });

  test("推文輸入列：kind 仍是列表，prompt 由事實回答（兩個問題不合併）", () => {
    const s = screenOf(bufAt(pushFlowFx, "input"));
    expect(s.promptPending).toBe(true);
    expect(s.cursorOnInputField).toBe(true);
  });

  test("編輯器 prompt：kind 跟著 pageState 黏在編輯器，editorTyping 說不是在打內文", () => {
    const s = screenOf(bufAt(editorPromptFx, "search"));
    expect(s.editorTyping).toBe(false);
  });

  test("推文類型選單：promptPending 但游標不在輸入欄（兩個事實分得開）", () => {
    const s = screenOf(bufAt(pushFx, "push-1"));
    expect(s.promptPending).toBe(true);
    expect(s.cursorOnInputField).toBe(false);
  });

  test("文章列表讀得到板名", () => {
    expect(screenOf(bufAt(articleListFx, "list")).boardName).toBeTruthy();
  });
});

describe("外殼不改規則：每個事實都等於直接問 TermBuf", () => {
  test("對照表涵蓋全部事實", () => {
    expect(Object.keys(DIRECT).sort()).toEqual([...SCREEN_FACTS].sort());
  });

  test.each(CASES)("%s", (_label, fx, frame) => {
    const buf = bufAt(fx, frame);
    const s = screenOf(buf);
    for (const name of SCREEN_FACTS) expect(s[name], name).toEqual(DIRECT[name](buf));
    expect(s.pageState).toBe(buf.pageState);
  });

  // 只比值會漏掉「兩條事實互換」或「一條恆回 false」：每條都要叫到同名的那支判定。
  const METHOD = {
    pass: "isPassScreenNow",
    editor: "isEditorScreenNow",
    editorTyping: "isEditorTypingNow",
    live: "isLiveScreenNow",
    mailList: "isMailListScreen",
    boardList: "isBoardListScreen",
    menu: "isMenuScreen",
    cursorOnInputField: "isCursorOnInputField",
    promptPending: "isPromptPending",
    pagerContext: "pagerContext",
  };
  test.each(Object.entries(METHOD))("%s 叫的是 %s", (fact, method) => {
    const buf = bufAt(articleFx, "article");
    const spy = vi.spyOn(buf, method).mockReturnValue("SENTINEL");
    expect(screenOf(buf)[fact]).toBe("SENTINEL");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("CASES 裡每個布林事實都出現過真與假（對照不是恆等式）", () => {
    for (const name of ["pass", "editor", "editorTyping", "live", "mailList", "menu", "cursorOnInputField", "promptPending"]) {
      const seen = new Set(CASES.map(([, fx, frame]) => screenOf(bufAt(fx, frame))[name]));
      expect([...seen].sort(), name).toEqual([false, true]);
    }
  });
});

describe("kind 只由 pageState 與子判定推出", () => {
  function fakeBuf(pageState, facts = {}) {
    return {
      frameSeq: 1,
      pageState,
      cur_x: 0,
      cur_y: 0,
      cols: 80,
      rows: 24,
      getRowText: () => "",
      isLiveScreenNow: () => !!facts.live,
      isMailListScreen: () => !!facts.mailList,
      isBoardListScreen: () => !!facts.boardList,
      isMenuScreen: () => !!facts.menu,
    };
  }
  test.each([
    [PAGE_STATE.NORMAL, {}, SCREEN_KIND.UNKNOWN],
    [PAGE_STATE.LEGACY_4, {}, SCREEN_KIND.UNKNOWN],
    [PAGE_STATE.PASS, {}, SCREEN_KIND.PASS],
    [PAGE_STATE.EDITOR, {}, SCREEN_KIND.EDITOR],
    [PAGE_STATE.READING, {}, SCREEN_KIND.ARTICLE],
    [PAGE_STATE.READING, { live: true }, SCREEN_KIND.LIVE],
    [PAGE_STATE.LIST, {}, SCREEN_KIND.LIST],
    [PAGE_STATE.MENU, { mailList: true, boardList: true }, SCREEN_KIND.MAIL_LIST],
    [PAGE_STATE.MENU, { boardList: true, menu: true }, SCREEN_KIND.BOARD_LIST],
    [PAGE_STATE.MENU, { menu: true }, SCREEN_KIND.MENU],
    [PAGE_STATE.MENU, {}, SCREEN_KIND.OTHER_MENU],
  ])("pageState %i %o → %s", (ps, facts, kind) => {
    expect(screenOf(fakeBuf(ps, facts)).kind).toBe(kind);
  });

  test("常數凍結", () => {
    expect(Object.isFrozen(PAGE_STATE)).toBe(true);
    expect(Object.isFrozen(SCREEN_KIND)).toBe(true);
  });
});

describe("一幀一份", () => {
  test("同一幀同一個物件，事實只算一次", () => {
    const buf = bufAt(articleFx, "article");
    const spy = vi.spyOn(buf, "isPassScreenNow");
    const a = screenOf(buf);
    expect(screenOf(buf)).toBe(a);
    void a.pass;
    void a.pass;
    void screenOf(buf).pass;
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // 不是 TermBuf（沒有 frameSeq）看不出幀的邊界：快取的話內容換了（pageState、游標都沒動）還會拿到
  // 上一份答案。每次現算＝跟各功能直接呼叫判定函式一樣。
  test("沒有 frameSeq 的 buf ⇒ 不快取，內容換了就是新答案", () => {
    let live = true;
    const buf = {
      pageState: PAGE_STATE.READING,
      cur_x: 0,
      cur_y: 0,
      cols: 80,
      rows: 24,
      getRowText: () => "",
      isLiveScreenNow: () => live,
    };
    expect(screenOf(buf).kind).toBe(SCREEN_KIND.LIVE);
    live = false;
    expect(screenOf(buf).kind).toBe(SCREEN_KIND.ARTICLE);
  });

  test("沒人問的事實不算", () => {
    const buf = bufAt(articleFx, "article");
    const spy = vi.spyOn(buf, "isPromptPending");
    void screenOf(buf).kind;
    expect(spy).not.toHaveBeenCalled();
  });

  test("notify 處理了新內容 ⇒ 新的一幀", () => {
    const buf = bufAt(articleListFx, "list");
    const a = screenOf(buf);
    const seq = buf.frameSeq;
    buf.changed = true;
    buf.notify();
    if (buf._settleTimer) clearTimeout(buf._settleTimer);
    expect(buf.frameSeq).toBe(seq + 1);
    expect(screenOf(buf)).not.toBe(a);
  });

  test("只有游標動的 notify（游標停到底列那種幀）也換幀", () => {
    const buf = bufAt(articleListFx, "list");
    const a = screenOf(buf);
    const seq = buf.frameSeq;
    buf.posChanged = true;
    buf.notify();
    if (buf._settleTimer) clearTimeout(buf._settleTimer);
    expect(buf.frameSeq).toBe(seq + 1);
    expect(screenOf(buf)).not.toBe(a);
  });

  test("resize 不經 notify ⇒ 不沿用舊尺寸算的事實", () => {
    const buf = bufAt(articleFx, "article");
    const a = screenOf(buf);
    void a.lastRowText;
    buf.resize(buf.cols, buf.rows + 2);
    const b = screenOf(buf);
    expect(b).not.toBe(a);
    expect(b.lastRowText).toBe(buf.getRowText(buf.rows - 1, 0, buf.cols));
  });

  test("沒有任何變動的 notify 不換幀", () => {
    const buf = bufAt(articleListFx, "list");
    const seq = buf.frameSeq;
    buf.notify();
    expect(buf.frameSeq).toBe(seq);
  });

  test("notify 以外改了 pageState（好讀的 pageStateOverride）或游標 ⇒ 不沿用舊的", () => {
    const buf = bufAt(articleFx, "article");
    const a = screenOf(buf);
    expect(a.kind).toBe(SCREEN_KIND.ARTICLE);
    buf.pageState = PAGE_STATE.PASS;
    const b = screenOf(buf);
    expect(b).not.toBe(a);
    expect(b.kind).toBe(SCREEN_KIND.PASS);
    buf.cur_x += 1;
    expect(screenOf(buf)).not.toBe(b);
  });
});

// A3 步驟 d：upstream 產的**每一幀**都登記 kind（nightly 換 upstream HEAD 重產 fixture 後跑這支 ⇒
// upstream 改了畫面、kind 跟著變，當晚就紅，不用等某個功能的斷言剛好踩到）。
// 表上記的是**現在的答案**，不全是理想答案：pageState 會黏（說明選單疊在文章上仍是 article、
// 水球 prompt 疊在主選單上是 otherMenu），認不出的 prompt 是 unknown（認不出 ⇒ 原生）。改判定讓某格變了
// ＝刻意的行為改動，逐格看過再改表。重放方式同 app：每幀 feed 完都 notify。
// 新場景（tools/ptt-src-screens/scenes.mjs）要在這裡補一列，不然紅。
const ALL_FX = import.meta.glob("./fixtures/ptt_src_screens/*.json", { eager: true, import: "default" });
const KIND_CENSUS = {
  activity_denied: "list=list aid-denied=pass aid-back=list search-denied=pass search-back=list",
  activity_slow: "board-slow=pass list=list read-slow=pass article=article back=list aid-slow=pass aid-after=pass",
  aid_miss: "list=list prompt=list not-found=pass back=list invalid=pass",
  article: "list=list list-jumped=list article=article",
  article_help: "list=list article=article help=article help-2=article help-3=article back=article",
  article_list: "list=list",
  article_list_tall: "list=list",
  article_live: "list=list article=article live-failed=pass",
  article_pref: "list=list article=article pref=pass pref-cycled=pass pref-closed=article quick=pass back=article",
  article_prompts: "list=list article=article goto=article landed=article search=article search-typed=article",
  board_complete: "menu=menu board=menu typed=menu candidates=otherMenu rejected=otherMenu typed-2=otherMenu completed=otherMenu",
  board_list: "fav=list",
  board_list_refresh: "fav=list keyword=list reloaded=list",
  board_list_toggles: "fav=list all=list fav-again=list newflag=list",
  board_note: "note=pass list=list",
  board_switch:
    "list=list article=article prompt=article note=pass notes-list=list test-list=list article-2=article rejected=list note-again=pass notes-list-again=list",
  class_list: "menu=menu root=otherMenu group=list",
  digest: "list=list digest=list info=pass article=article back=list plain=list",
  digest_aid: "list=list at-1=list g-aid=list m-aid=list",
  editor: "list=list edit=editor save-menu=unknown",
  editor_prompt: "list=list edit=editor search=editor search-typed=editor case-prompt=editor",
  essence: "list=list menu=otherMenu article=article back=otherMenu list-again=list",
  goodbye: "menu=menu confirm=menu pause=pass",
  help_menu: "list=list help=list",
  live_countdown: "list=list article=article live-on=live countdown=live countdown-1=live count-up=live live-off=list",
  live_long: "list=list article=article live-on=live live-1=live live-2=live live-off=list",
  live_long_read:
    "list=list article=article page-2=article page-3=article live-on=live " +
    Array.from({ length: 26 }, (_, i) => `live-${i + 1}=live`).join(" ") +
    " live-off=list",
  live_repeat_prompt: "list=list live-prompt=list live-prompt-n=list article=article",
  live_repeat_yes: "list=list live-prompt=list live-on=live live-off=list",
  live_short: "list=list article=article live-on=live live-1=live live-2=live live-off=list",
  mail_list: "menu=menu mail=mailList",
  mail_read: "menu=menu mail=mailList read=article back=mailList",
  main_menu: "menu=menu",
  main_menu_newmail: "menu=menu",
  mark_read_prompt: "list=list prompt=unknown",
  menu_search: "menu=menu board=menu",
  modern_comments: "list=list classic=article simple=article bordered=article",
  post_flow: "list=list post=unknown",
  post_info: "list=list info=pass dismissed=list",
  push: "list=list push-1=list push-2=list",
  push_again: "list=list done=list too-close=list confirm=list",
  push_content_denied: "list=list confirm=list denied=pass after=list",
  push_flow: "list=list menu=list input=list confirm=list done=list article=article",
  push_owner: "list=list owner=list",
  push_search: "list=list result=list menu=list input=list",
  reply_prompt: "list=list article=article reply=article",
  search_prompts: "list=list title=list author=list push=list board=list",
  search_refine: "list=list result=list title=list",
  waterball_default: "menu=menu prompt=otherMenu panel-1=otherMenu panel-2=otherMenu panel-3=otherMenu",
  // 一對一水球：row 0 被「丟<id>:」蓋掉 ⇒ 不是選單（手機主功能表卡片讓開，輸入列與名單才看得到）。
  waterball_ofo: "menu=menu ofo-1=otherMenu ofo-2=otherMenu ofo-3=otherMenu",
};

// 每個有名字的幀：{ file, frame, kind, pass }（kind／pass 取該幀 notify 之後的畫面物件）。
function censusOf(file, fx) {
  const buf = new TermBuf(fx.cols, fx.rows);
  buf.setView({ update() {}, updateCursorPos() {}, refreshCursorVisibility() {}, blinkOn: false });
  buf.useMouseBrowsing = false;
  const parser = new AnsiParser(buf);
  const out = [];
  for (const f of fx.frames) {
    parser.feed(f.bytes);
    buf.notify();
    if (!f.name) continue;
    const s = screenOf(buf);
    out.push({ file, frame: f.name, kind: s.kind, pass: s.pass });
  }
  clearTimeout(buf.timerUpdate);
  if (buf._settleTimer) clearTimeout(buf._settleTimer);
  return out;
}
const CENSUS = Object.entries(ALL_FX).flatMap(([p, fx]) => censusOf(p.replace(/^.*\//, "").replace(/\.json$/, ""), fx));

describe("upstream 產的每一幀都登記了 kind（A3 步驟 d）", () => {
  test("表跟 fixture 一一對應（新場景要登記、拿掉的場景要刪）", () => {
    const files = [...new Set(CENSUS.map((c) => c.file))].sort();
    expect(files.length).toBeGreaterThan(40);
    expect(Object.keys(KIND_CENSUS).sort()).toEqual(files);
    for (const file of files) {
      const frames = CENSUS.filter((c) => c.file === file).map((c) => c.frame);
      const listed = KIND_CENSUS[file].split(" ").map((e) => e.split("=")[0]);
      expect(listed, file).toEqual(frames);
    }
  });

  test.each(Object.keys(KIND_CENSUS))("%s", (file) => {
    const actual = CENSUS.filter((c) => c.file === file)
      .map((c) => `${c.frame}=${c.kind}`)
      .join(" ");
    expect(actual).toBe(KIND_CENSUS[file]);
  });

  test("表上的 kind 都是具名常數", () => {
    const names = new Set(Object.values(SCREEN_KIND));
    for (const c of Object.values(KIND_CENSUS).flatMap((s) => s.split(" ")))
      expect(names.has(c.split("=")[1]), c).toBe(true);
  });

  // pass 事實＝「此刻真的是 pass 畫面」：在 upstream 的每一幀上都要跟 kind 說法一致。
  // pmore 的狀態列也是「末列中段同色＋游標停右下角」，以前 _isAnsiPassFrame 不排除 ⇒ 每一頁文章都說是
  // pass（setPageState 先認狀態列所以 pageState 沒事，但直接問 pass 的人會把文章當成按任意鍵畫面）。
  test("pass 事實只在 pass 畫面為真（文章頁不是）", () => {
    const mismatch = CENSUS.filter((c) => c.pass !== (c.kind === SCREEN_KIND.PASS)).map((c) => `${c.file}/${c.frame}=${c.kind}`);
    expect(mismatch).toEqual([]);
  });
});
