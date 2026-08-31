// 序列化操作（AID 跳文／長推文）在途時，**送 bytes 給 PTT 的四條使用者入口都必須
// 吞掉輸入並給提示**。
//
// 病灶（2026-08-31 handoff）：四條入口裡只有鍵盤與滑鼠功能鍵有守門，IME 送字
// （term_view.onTextInput）與貼上（App.onPasteDone）裸走 _convSend ⇒ 與序列化命令
// 競態（pttbbs typeahead 吞掉中間那幀，docs/pttbbs-screen-protocol.md §2），長推文
// 還會打亂 X → 型別 → 內容 → y 的配對。
//
// 長推文期間 IME 曾被 modalShown（進度遮罩推導出來的）**間接**擋住——那是巧合式
// 覆蓋，不是守門：繞過 onInput 的呼叫端（App.onPasteDone、image_upload_controller、
// doPaste）照樣裸送。本檔釘的是四條入口各自的守門，不靠那個巧合。
import { serializedOpHint } from "../../src/js/serialized_op_gate";
import { TermView } from "../../src/js/term_view";
import { App } from "../../src/js/pttchrome";

const AID_HINT = "AID 跳文中，請稍候…";
const PUSH_HINT = "長推文送出中，請稍候…";

describe("serializedOpHint 述詞", () => {
  test("線路空著 → null", () => {
    expect(
      serializedOpHint({ aidNavigation: { active: false }, longPush: { active: false } })
    ).toBe(null);
  });

  test("AID 跳文在途 → AID 提示", () => {
    expect(serializedOpHint({ aidNavigation: { active: true } })).toBe(AID_HINT);
  });

  test("長推文送出中 → 長推文提示", () => {
    expect(serializedOpHint({ longPush: { active: true } })).toBe(PUSH_HINT);
  });

  test("兩者同時（理論上不會，共用同一條 CommandQueue）→ AID 優先，不得回 null", () => {
    expect(
      serializedOpHint({ aidNavigation: { active: true }, longPush: { active: true } })
    ).toBe(AID_HINT);
  });

  test("物件還沒建立／core 不存在都不炸", () => {
    expect(serializedOpHint(undefined)).toBe(null);
    expect(serializedOpHint({})).toBe(null);
  });
});

// --- 入口 1：鍵盤 -----------------------------------------------------------
function keyCtx(busy) {
  const hints = [];
  const keyboard = { onKeyDown: vi.fn() };
  const ctx = {
    bbscore: {
      aidNavigation: { active: busy === "aid" },
      longPush: { active: busy === "longPush" },
      easyReading: { tryReenterFromNative: () => false },
      buf: { pageState: 3 },
    },
    buf: {
      pageState: 3,
      easyReadingFunctionMode: false,
      startedEasyReading: false,
      listRenderMode: "native",
    },
    useEasyReadingMode: false,
    _keyboard: keyboard,
    flashListHint(msg) {
      hints.push(msg);
    },
  };
  return { ctx, hints, keyboard };
}

const keyEvent = (key) => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  preventDefault: vi.fn(),
});

describe("入口 1／4：term_view.onKeyDown", () => {
  test.each([
    ["aid", AID_HINT],
    ["longPush", PUSH_HINT],
  ])("%s 在途 → 吞掉按鍵並提示", (busy, hint) => {
    const { ctx, hints, keyboard } = keyCtx(busy);
    const e = keyEvent("a");
    TermView.prototype.onKeyDown.call(ctx, e);
    expect(keyboard.onKeyDown).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
    expect(hints).toEqual([hint]);
  });

  test("線路空著 → 照舊落到原生鍵盤路徑", () => {
    const { ctx, hints, keyboard } = keyCtx(null);
    TermView.prototype.onKeyDown.call(ctx, keyEvent("a"));
    expect(keyboard.onKeyDown).toHaveBeenCalled();
    expect(hints).toEqual([]);
  });
});

// --- 入口 2：文字輸入（IME） -------------------------------------------------
function textCtx(busy) {
  const hints = [];
  const calls = { convSend: [], listNote: 0, easyNote: 0 };
  const ctx = {
    lineWrap: 0,
    bbscore: {
      aidNavigation: { active: busy === "aid" },
      longPush: { active: busy === "longPush" },
      easyReading: {
        noteTextInput() {
          calls.easyNote++;
        },
      },
      listSession: {
        noteTextInput() {
          calls.listNote++;
          return false;
        },
      },
    },
    _convSend(text) {
      calls.convSend.push(text);
    },
    flashListHint(msg) {
      hints.push(msg);
    },
  };
  return { ctx, hints, calls };
}

describe("入口 2／4：term_view.onTextInput（IME 送字）", () => {
  test.each([
    ["aid", AID_HINT],
    ["longPush", PUSH_HINT],
  ])("%s 在途 → 不裸送、不進好讀分派，且必有提示", (busy, hint) => {
    const { ctx, hints, calls } = textCtx(busy);
    TermView.prototype.onTextInput.call(ctx, "測");
    expect(calls.convSend).toEqual([]);
    // 守門必須排在列表好讀分派**之前**：noteTextInput 自己會 _enterFunctionMode()
    // 並排 native-input，在途時那本身就是競態。
    expect(calls.listNote).toBe(0);
    expect(calls.easyNote).toBe(0);
    expect(hints).toEqual([hint]); // 吞掉不得無聲
  });

  test("貼上路徑（isPasting）同樣擋下——onPasteDone 已擋一層，這裡是自保", () => {
    const { ctx, hints, calls } = textCtx("aid");
    TermView.prototype.onTextInput.call(ctx, "測", true);
    expect(calls.convSend).toEqual([]);
    expect(hints).toEqual([AID_HINT]);
  });

  test("線路空著 → 照舊送出", () => {
    const { ctx, hints, calls } = textCtx(null);
    TermView.prototype.onTextInput.call(ctx, "測");
    expect(calls.convSend).toEqual(["測"]);
    expect(hints).toEqual([]);
  });
});

// --- 入口 3／4：滑鼠功能鍵與貼上（App 上的兩條漏斗） -------------------------
function makeApp(busy) {
  const hints = [];
  const app = Object.create(App.prototype);
  app.modalShown = false;
  app.aidNavigation = { active: busy === "aid" };
  app.longPush = { active: busy === "longPush" };
  app.commandQueue = { inFlightKind: null };
  app.buf = { startedEasyReading: false, pageState: 3 };
  app.easyReading = { _enterFunctionMode: vi.fn(), stopEasyReading: vi.fn() };
  app.listSession = {
    onFunctionKey: vi.fn(() => false),
    onPaste: vi.fn(() => false),
  };
  app.view = {
    useEasyReadingMode: false,
    _send: vi.fn(),
    onTextInput: vi.fn(),
    flashListHint(msg) {
      hints.push(msg);
    },
  };
  return { app, hints };
}

describe("入口 3／4：App.onFunctionKey（滑鼠點功能鍵）", () => {
  test.each([
    ["aid", AID_HINT],
    ["longPush", PUSH_HINT],
  ])("%s 在途 → 不送 byte，且必有提示", (busy, hint) => {
    const { app, hints } = makeApp(busy);
    app.onFunctionKey("\x1b[D", "←");
    expect(app.view._send).not.toHaveBeenCalled();
    expect(app.listSession.onFunctionKey).not.toHaveBeenCalled();
    expect(hints).toEqual([hint]);
  });

  test("線路空著 → 照舊送出", () => {
    const { app, hints } = makeApp(null);
    app.onFunctionKey("\r", "Enter");
    expect(app.view._send).toHaveBeenCalledWith("\r");
    expect(hints).toEqual([]);
  });
});

describe("入口 4／4：App.onPasteDone（所有貼上路由的漏斗）", () => {
  test.each([
    ["aid", AID_HINT],
    ["longPush", PUSH_HINT],
  ])("%s 在途 → 不送出、不交給列表好讀，且必有提示", (busy, hint) => {
    const { app, hints } = makeApp(busy);
    app.onPasteDone("#1gIeu-3A");
    expect(app.view.onTextInput).not.toHaveBeenCalled();
    // 守門排在 listSession.onPaste 之前：那條會排進 CommandQueue，在途時同樣是競態。
    expect(app.listSession.onPaste).not.toHaveBeenCalled();
    expect(app.easyReading._enterFunctionMode).not.toHaveBeenCalled();
    expect(hints).toEqual([hint]);
  });

  test("線路空著 → 照舊走原路", () => {
    const { app, hints } = makeApp(null);
    app.onPasteDone("安安");
    expect(app.listSession.onPaste).toHaveBeenCalledWith("安安");
    expect(app.view.onTextInput).toHaveBeenCalledWith("安安", true);
    expect(hints).toEqual([]);
  });
});
