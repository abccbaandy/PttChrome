// @unit-env browser
// real-input: tests/e2e/offline/mobile_toolbar.offline.spec.js
// 手機黏滯 Ctrl（按鍵面板的 Ctrl → 下一個字元送控制碼）在 term_view 的兩條入口：
//   - onKeyDown：實體鍵盤／面板上的合成鍵
//   - onTextInput：Android 軟鍵盤（字幾乎都走 input 事件，keydown 是 229）
// 只用一次就解除；字母必須走 Alt remap（Ctrl+A/C/V 會被 app 的 UI 快捷鍵攔走）。
import { TermView } from "../../src/js/term_view";

function ctx() {
  const core = {
    mobileCtrlArmed: true,
    setMobileCtrlArmed: vi.fn((on) => (core.mobileCtrlArmed = !!on)),
    aidNavigation: { active: false },
    longPush: { active: false },
    easyReading: { tryReenterFromNative: () => false, _onKeyDown: vi.fn(), noteTextInput: vi.fn() },
    activeListSession: () => null,
    noteListNativeInput: vi.fn(),
  };
  const view = {
    bbscore: core,
    buf: { pageState: 0 },
    useEasyReadingMode: false,
    sendKeyAsUser: vi.fn(),
    _convSend: vi.fn(),
    _keyboard: { onKeyDown: vi.fn() },
    flashListHint: vi.fn(),
  };
  // onTextInput 的剩餘字元會遞迴呼叫自己
  view.onTextInput = TermView.prototype.onTextInput;
  return { core, view };
}

const keyEvent = (key, over) => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  preventDefault: vi.fn(),
  ...over,
});

describe("onKeyDown", () => {
  test("armed 後按 p ⇒ 改送 Alt+p（＝^P），並解除", () => {
    const { core, view } = ctx();
    const e = keyEvent("p");
    TermView.prototype.onKeyDown.call(view, e);
    expect(view.sendKeyAsUser).toHaveBeenCalledWith("p", { key: "p", altKey: true });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(core.mobileCtrlArmed).toBe(false);
    expect(view._keyboard.onKeyDown).not.toHaveBeenCalled();
  });

  test("單按 Shift 不算下一個鍵（不解除）", () => {
    const { core, view } = ctx();
    TermView.prototype.onKeyDown.call(view, keyEvent("Shift"));
    expect(core.mobileCtrlArmed).toBe(true);
    expect(view.sendKeyAsUser).not.toHaveBeenCalled();
  });

  test("沒有控制碼的鍵（方向鍵）⇒ 解除、照常送出", () => {
    const { core, view } = ctx();
    TermView.prototype.onKeyDown.call(view, keyEvent("ArrowUp"));
    expect(core.mobileCtrlArmed).toBe(false);
    expect(view.sendKeyAsUser).not.toHaveBeenCalled();
    expect(view._keyboard.onKeyDown).toHaveBeenCalled();
  });
});

describe("onTextInput（軟鍵盤）", () => {
  test("armed 後打 u ⇒ 送 ^U，不送字", () => {
    const { core, view } = ctx();
    view.onTextInput("u");
    expect(view.sendKeyAsUser).toHaveBeenCalledWith("u", { key: "u", altKey: true });
    expect(view._convSend).not.toHaveBeenCalled();
    expect(core.mobileCtrlArmed).toBe(false);
  });

  test("一次上多個字 ⇒ 只有第一個變控制碼，其餘照常", () => {
    const { view } = ctx();
    view.onTextInput("xy");
    expect(view.sendKeyAsUser).toHaveBeenCalledWith("x", { key: "x", altKey: true });
    expect(view._convSend).toHaveBeenCalledWith("y");
  });

  test("貼上不吃 Ctrl", () => {
    const { core, view } = ctx();
    view.onTextInput("u", true);
    expect(view.sendKeyAsUser).not.toHaveBeenCalled();
    expect(core.mobileCtrlArmed).toBe(true);
  });
});

test("sendKeyAsUser 帶 altKey ⇒ 合成的 keydown 帶修飾鍵、不補 keypress", () => {
  const seen = [];
  const view = {
    onKeyDown: (e) => seen.push({ key: e.key, alt: e.altKey, ctrl: e.ctrlKey }),
    _keyboard: { onKeyPress: vi.fn() },
  };
  TermView.prototype.sendKeyAsUser.call(view, "p", { altKey: true });
  expect(seen).toEqual([{ key: "p", alt: true, ctrl: false }]);
  expect(view._keyboard.onKeyPress).not.toHaveBeenCalled();
});
