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
