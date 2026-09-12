// 推文鍵（X／%）改開長推文輸入框——**三條入口**的行為。
//
// 使用者原本的假設是「攔了鍵盤 X，滑鼠點底列的推文按鈕也會一起被攔」。實際不會：
// 鍵盤走 term_view.onKeyDown → term_keyboard → view._send，底列按鈕走
// App.onFunctionKey → view._send，IME 走 term_view.onTextInput → _convSend，
// 三條在應用層沒有交會點，各要攔一次。本檔就是釘這三條不准漏。
//
// 最重要的一條在最後：openLongPushModal 回 falsy（ContextMenu 還沒 mount）時
// **不准吞掉按鍵**——吞了又不開輸入框＝使用者按 X 完全沒反應。
import { TermView } from "../../src/js/term_view";
import { App } from "../../src/js/pttchrome";
import { writeValues, readValuesWithDefault } from "../../src/js/pref_storage";

const READ_ROW =
  "  瀏覽 第 1/2 頁 ( 45%)  目前顯示: 第 1~23 行  (y)回應(X%)推文(h)說明(←)離開 ";
const MAIL_ROW =
  "  瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~18 行  (y)回信 (h)說明 (←/q)離開 ";
const LIST_ROW =
  "  文章選讀  (y)回應 (X)推文 (^Z)離開 (b)上頁 (f)下頁 (q)離開                  ";
const PROMPT_ROW = "請輸入看板名稱(按空白鍵自動搜尋)：XBO";

const makeBuf = (over) => ({
  pageState: 3,
  rows: 24,
  cols: 80,
  getRowText: () => READ_ROW,
  easyReadingFunctionMode: false,
  startedEasyReading: false,
  listRenderMode: "native",
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  // 預設值就是「攔」，這裡明寫出來當文件。
  writeValues({
    ...readValuesWithDefault(),
    enableLongPush: true,
    pushKeyOpensLongPush: true,
  });
});

// --- 入口 1：鍵盤 -----------------------------------------------------------
function keyCtx(over) {
  const o = over || {};
  const keyboard = { onKeyDown: vi.fn() };
  const easyReading = {
    tryReenterFromNative: () => false,
    _onKeyDown: vi.fn(),
  };
  const buf = makeBuf(o.buf);
  const openLongPushModal = vi.fn(
    o.opens === false ? () => undefined : () => true,
  );
  const ctx = {
    bbscore: {
      aidNavigation: { active: !!o.aidActive },
      longPush: { active: !!o.pushActive },
      easyReading,
      buf,
      openLongPushModal,
      activeListSession: () => null,
      noteListNativeInput: vi.fn(),
    },
    buf,
    useEasyReadingMode: !!o.easyReading,
    _keyboard: keyboard,
    flashListHint: vi.fn(),
  };
  return { ctx, keyboard, easyReading, openLongPushModal };
}

const keyEvent = (key, over) => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: true, // X 與 % 本來就要按 Shift
  defaultPrevented: false,
  preventDefault: vi.fn(),
  ...over,
});

describe("入口 1／3：鍵盤（term_view.onKeyDown）", () => {
  test.each(["X", "%"])("文章畫面按 %s → 開輸入框、一個 byte 都不送", (key) => {
    const { ctx, keyboard, easyReading, openLongPushModal } = keyCtx();
    const e = keyEvent(key);
    TermView.prototype.onKeyDown.call(ctx, e);
    expect(openLongPushModal).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
    // 這兩條就是「攔截點排在所有 dispatch 之前」：落到 _keyboard 會把 X 送出去，
    // 落到 easyReading._onKeyDown 會提前 _enterFunctionMode（scrollTop 歸零，毀掉
    // LongPushSession.start 的 ORDER INVARIANT）。
    expect(keyboard.onKeyDown).not.toHaveBeenCalled();
    expect(easyReading._onKeyDown).not.toHaveBeenCalled();
  });

  test("好讀模式下同樣不先進 functionMode", () => {
    const { ctx, easyReading, openLongPushModal } = keyCtx({
      easyReading: true,
      buf: { startedEasyReading: true },
    });
    TermView.prototype.onKeyDown.call(ctx, keyEvent("X"));
    expect(openLongPushModal).toHaveBeenCalledTimes(1);
    expect(easyReading._onKeyDown).not.toHaveBeenCalled();
  });

  // **最重要的一條**：沒開成就不准吞。
  test("openLongPushModal 回 falsy → 不吞按鍵，X 照原生路徑送出", () => {
    const { ctx, keyboard, openLongPushModal } = keyCtx({ opens: false });
    const e = keyEvent("X");
    TermView.prototype.onKeyDown.call(ctx, e);
    expect(openLongPushModal).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(keyboard.onKeyDown).toHaveBeenCalled();
  });

  test("小寫 x 不攔（pager 沒綁這個鍵）", () => {
    const { ctx, keyboard, openLongPushModal } = keyCtx();
    TermView.prototype.onKeyDown.call(ctx, keyEvent("x"));
    expect(openLongPushModal).not.toHaveBeenCalled();
    expect(keyboard.onKeyDown).toHaveBeenCalled();
  });

  test.each([
    ["pref 關掉", { pref: { pushKeyOpensLongPush: false } }],
    ["總開關關掉", { pref: { enableLongPush: false } }],
    ["文章列表", { buf: { pageState: 2, getRowText: () => LIST_ROW } }],
    ["站內信 pager", { buf: { getRowText: () => MAIL_ROW } }],
    ["prompt 幀（陳舊的 pageState 3）", { buf: { getRowText: () => PROMPT_ROW } }],
  ])("%s → 不攔，落回原生鍵盤路徑", (_name, over) => {
    if (over.pref) writeValues({ ...readValuesWithDefault(), ...over.pref });
    const { ctx, keyboard, openLongPushModal } = keyCtx({ buf: over.buf });
    const e = keyEvent("X");
    TermView.prototype.onKeyDown.call(ctx, e);
    expect(openLongPushModal).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(keyboard.onKeyDown).toHaveBeenCalled();
  });

  // 遞迴保險：長推文自己送的 X 走 CommandQueue → conn.send，不經這裡；萬一日後有人
  // 改路徑，serializedOpHint 這道也必須先攔下來。
  test.each(["aidActive", "pushActive"])(
    "%s 在途 → 走既有的吞鍵＋提示，不開第二個輸入框",
    (flag) => {
      const { ctx, openLongPushModal } = keyCtx({ [flag]: true });
      const e = keyEvent("X");
      TermView.prototype.onKeyDown.call(ctx, e);
      expect(openLongPushModal).not.toHaveBeenCalled();
      expect(ctx.flashListHint).toHaveBeenCalled();
      expect(e.preventDefault).toHaveBeenCalled();
    },
  );
});

// --- 入口 2：IME（onTextInput） ---------------------------------------------
function textCtx(over) {
  const o = over || {};
  const buf = makeBuf(o.buf);
  const openLongPushModal = vi.fn(
    o.opens === false ? () => undefined : () => true,
  );
  const calls = { convSend: [], easyNote: 0 };
  const ctx = {
    lineWrap: 0,
    buf,
    bbscore: {
      aidNavigation: { active: false },
      longPush: { active: false },
      easyReading: {
        noteTextInput() {
          calls.easyNote++;
        },
      },
      buf,
      openLongPushModal,
      activeListSession: () => null,
      noteListNativeInput: vi.fn(),
    },
    _convSend(text) {
      calls.convSend.push(text);
    },
    flashListHint: vi.fn(),
  };
  return { ctx, calls, openLongPushModal };
}

describe("入口 2／3：IME（term_view.onTextInput）", () => {
  // IME 開著時 keydown 的 keyCode 是 229，被 keyEventFilter 擋在 onKeyDown 之外
  // ⇒ 少了這條，「中文輸入法開著按 X」會得到原生推文，行為與另外兩條不一致。
  test.each(["X", "%"])("IME 上字 %s → 開輸入框、不送字", (text) => {
    const { ctx, calls, openLongPushModal } = textCtx();
    TermView.prototype.onTextInput.call(ctx, text);
    expect(openLongPushModal).toHaveBeenCalledTimes(1);
    expect(calls.convSend).toEqual([]);
    expect(calls.easyNote).toBe(0); // 沒有提前進 functionMode
  });

  test("貼上一個 X 不是按鍵 → 照舊送出", () => {
    const { ctx, calls, openLongPushModal } = textCtx();
    TermView.prototype.onTextInput.call(ctx, "X", true);
    expect(openLongPushModal).not.toHaveBeenCalled();
    expect(calls.convSend).toEqual(["X"]);
  });

  test("一次上字多個字元（XD）不攔", () => {
    const { ctx, calls, openLongPushModal } = textCtx();
    TermView.prototype.onTextInput.call(ctx, "XD");
    expect(openLongPushModal).not.toHaveBeenCalled();
    expect(calls.convSend).toEqual(["XD"]);
  });

  test("沒開成 → 照舊送出", () => {
    const { ctx, calls } = textCtx({ opens: false });
    TermView.prototype.onTextInput.call(ctx, "X");
    expect(calls.convSend).toEqual(["X"]);
  });
});

// --- 入口 3：底列功能鍵按鈕（App.onFunctionKey） -----------------------------
function makeApp(over) {
  const o = over || {};
  const openLongPushModal = vi.fn(
    o.opens === false ? () => undefined : () => true,
  );
  const app = Object.create(App.prototype);
  app.modalShown = !!o.modalShown;
  app.aidNavigation = { active: false };
  app.longPush = { active: false };
  app.commandQueue = { inFlightKind: null };
  app.buf = makeBuf(o.buf);
  app.easyReading = { _enterFunctionMode: vi.fn(), stopEasyReading: vi.fn() };
  app.listSession = { onFunctionKey: vi.fn(() => false) };
  app.openLongPushModal = openLongPushModal;
  app.noteListNativeInput = vi.fn();
  app.view = {
    useEasyReadingMode: false,
    _send: vi.fn(),
    flashListHint: vi.fn(),
  };
  return { app, openLongPushModal };
}

describe("入口 3／3：底列功能鍵按鈕（App.onFunctionKey）", () => {
  // (X%)推文 會被 footer_keys.tokenizeKeyGroup 拆成兩顆按鈕，漏掉 % 那顆就變成
  // 「點這顆是長推文、點旁邊那顆是原生」。
  test.each(["X", "%"])("點 (%s) → 開輸入框、不送 byte", (bytes) => {
    const { app, openLongPushModal } = makeApp();
    App.prototype.onFunctionKey.call(app, bytes);
    expect(openLongPushModal).toHaveBeenCalledTimes(1);
    expect(app.view._send).not.toHaveBeenCalled();
    expect(app.easyReading._enterFunctionMode).not.toHaveBeenCalled();
  });

  test("沒開成 → 退回原生，照樣送出 X", () => {
    const { app, openLongPushModal } = makeApp({ opens: false });
    App.prototype.onFunctionKey.call(app, "X");
    expect(openLongPushModal).toHaveBeenCalledTimes(1);
    expect(app.view._send).toHaveBeenCalledWith("X");
  });

  test("其他功能鍵照舊送出", () => {
    const { app, openLongPushModal } = makeApp();
    App.prototype.onFunctionKey.call(app, "y");
    expect(openLongPushModal).not.toHaveBeenCalled();
    expect(app.view._send).toHaveBeenCalledWith("y");
  });

  test("已有 modal 開著 → 什麼都不做", () => {
    const { app, openLongPushModal } = makeApp({ modalShown: true });
    App.prototype.onFunctionKey.call(app, "X");
    expect(openLongPushModal).not.toHaveBeenCalled();
    expect(app.view._send).not.toHaveBeenCalled();
  });

  test("文章列表 → 不攔", () => {
    const { app, openLongPushModal } = makeApp({
      buf: { pageState: 2, getRowText: () => LIST_ROW },
    });
    App.prototype.onFunctionKey.call(app, "X");
    expect(openLongPushModal).not.toHaveBeenCalled();
    expect(app.view._send).toHaveBeenCalledWith("X");
  });
});
