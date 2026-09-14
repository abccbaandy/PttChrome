// macOS 的 dead key 防線（Alt 全面 remap 成 PTT 的 Ctrl，2026-09）。
//
// 背景：Option 是**組字修飾鍵**。US 佈局的 ⌥E/⌥I/⌥N/⌥U 是組合重音的 dead key，
// Chrome 對它們的 keydown 回報 keyCode 229（Firefox 有時是 0）—— 與真 IME 組字
// 一模一樣的訊號。term_view 的入口守門本來看到 229 就丟掉，於是會同時壞兩件事：
//   1. Alt+E/I/N/U 在 mac 上是啞巴鍵（送不出 ^E/^I/^N/^U）；
//   2. 沒有人跑到 preventDefault ⇒ 組字照開，é/î/ñ/ü 會從 compositionend →
//      onInput → onTextInput → _convSend 漏進 PTT（使用者按的明明是控制鍵）。
//
// 三道防線：入口守門開例外（acceptsKeyEvent）、compositionstart 不設 isComposition、
// onInput 不放行。後兩道用時間窗而不是一次性旗標 —— 組字事件不保證會來
//（Windows 上根本不來），旗標沒有正確的清除時機，會洩漏成永久狀態。
import {
  TermView,
  acceptsKeyEvent,
  altRemapRecently,
  cancelsLiveHelper,
  ALT_COMPOSITION_SUPPRESS_MS,
} from "../../src/js/term_view";

function keyEvent(key, mods = {}) {
  return {
    key,
    code: mods.code,
    keyCode: mods.keyCode === undefined ? 65 : mods.keyCode,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    shiftKey: !!mods.shiftKey,
    metaKey: !!mods.metaKey,
  };
}

describe("acceptsKeyEvent：keyCode 229/0 的 Alt remap 例外", () => {
  test("mac dead key（⌥E/⌥I/⌥N/⌥U，keyCode 229）必須放行", () => {
    for (const L of ["E", "I", "N", "U"]) {
      const e = keyEvent("Dead", { altKey: true, code: "Key" + L, keyCode: 229 });
      expect(acceptsKeyEvent(e, false)).toBe(true);
    }
  });

  test("Firefox 的 keyCode 0 形態同樣放行", () => {
    const e = keyEvent("Dead", { altKey: true, code: "KeyN", keyCode: 0 });
    expect(acceptsKeyEvent(e, false)).toBe(true);
  });

  test("真 IME 的 229 仍被擋掉（那時 altKey 是 false）", () => {
    expect(acceptsKeyEvent(keyEvent("Process", { keyCode: 229 }), false)).toBe(false);
    expect(acceptsKeyEvent(keyEvent("ㄅ", { keyCode: 229 }), false)).toBe(false);
    expect(acceptsKeyEvent(keyEvent("", { keyCode: 0 }), false)).toBe(false);
  });

  test("例外只開給真的 remap 得了的鍵：Alt+229 但沒有可用的 code 仍被擋", () => {
    // 合成事件／非字母鍵：altRemapCharCode 回 null ⇒ 不是 remap，維持原本的丟棄。
    expect(
      acceptsKeyEvent(keyEvent("Dead", { altKey: true, keyCode: 229 }), false)
    ).toBe(false);
    expect(
      acceptsKeyEvent(
        keyEvent("Dead", { altKey: true, code: "Digit5", keyCode: 229 }),
        false
      )
    ).toBe(false);
  });

  test("AltGr（ctrl+alt）的 229 不得被當成 remap 放行", () => {
    const e = keyEvent("é", { ctrlKey: true, altKey: true, code: "KeyE", keyCode: 229 });
    expect(acceptsKeyEvent(e, false)).toBe(false);
  });

  test("其餘既有守門不變：組字中吞非控制鍵、Meta 讓給瀏覽器", () => {
    expect(acceptsKeyEvent(keyEvent("a"), true)).toBe(false);
    expect(acceptsKeyEvent(keyEvent("a", { ctrlKey: true }), true)).toBe(true);
    expect(acceptsKeyEvent(keyEvent("a", { altKey: true, code: "KeyA" }), true)).toBe(
      true
    );
    expect(acceptsKeyEvent(keyEvent("c", { metaKey: true }), false)).toBe(false);
    expect(acceptsKeyEvent(keyEvent("a"), false)).toBe(true);
  });
});

describe("altRemapRecently（組字抑制窗）", () => {
  test("窗內為 true、窗外為 false", () => {
    expect(altRemapRecently(1000, 1000)).toBe(true);
    expect(altRemapRecently(1000, 1000 + ALT_COMPOSITION_SUPPRESS_MS - 1)).toBe(true);
    expect(altRemapRecently(1000, 1000 + ALT_COMPOSITION_SUPPRESS_MS)).toBe(false);
    expect(altRemapRecently(1000, 5000)).toBe(false);
  });

  test("從未 remap 過（undefined / 0）一律 false —— 不得誤傷正常組字", () => {
    expect(altRemapRecently(undefined, 1000)).toBe(false);
    expect(altRemapRecently(0, 1000)).toBe(false);
  });
});

describe("onCompositionStart：dead key 開起來的組字不得生效", () => {
  function ctx(altRemapAt) {
    return {
      _altRemapAt: altRemapAt,
      isComposition: false,
      input: {
        value: "",
        attrs: {},
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
      },
      updateInputBufferPos() {
        this.posUpdated = true;
      },
    };
  }

  test("剛 remap 過 → 不設 isComposition、不亮 #t 浮層、清掉 input", () => {
    // isComposition 一旦卡在 true，acceptsKeyEvent 的
    // `isComposition && !ctrl && !alt` 之後會把一般打字全吞掉，只能重整頁面。
    const c = ctx(Date.now());
    c.input.value = "e";
    TermView.prototype.onCompositionStart.call(c, {});
    expect(c.isComposition).toBe(false);
    expect(c.input.attrs.bshow).toBeUndefined();
    expect(c.input.value).toBe("");
    expect(c.posUpdated).toBeUndefined();
  });

  test("沒有剛 remap（真 IME）→ 照常開始組字", () => {
    const c = ctx(0);
    TermView.prototype.onCompositionStart.call(c, {});
    expect(c.isComposition).toBe(true);
    expect(c.input.attrs.bshow).toBe("1");
    expect(c.posUpdated).toBe(true);
  });

  test("時間窗過期後真 IME 照常運作", () => {
    const c = ctx(Date.now() - ALT_COMPOSITION_SUPPRESS_MS - 10);
    TermView.prototype.onCompositionStart.call(c, {});
    expect(c.isComposition).toBe(true);
  });
});

describe("onInput：dead key commit 出來的重音字元不得送進 PTT", () => {
  function ctx(altRemapAt) {
    const got = [];
    const c = {
      _altRemapAt: altRemapAt,
      bbscore: { modalShown: false, contextMenuShown: false },
      isComposition: false,
      updateInputBufferWidth() {},
      onTextInput(text) {
        got.push(text);
      },
    };
    return { c, got };
  }

  test("剛 remap 過 → 吞掉並清空（使用者的本意是送控制碼）", () => {
    const { c, got } = ctx(Date.now());
    const e = { target: { value: "é" } };
    TermView.prototype.onInput.call(c, e);
    expect(got).toEqual([]);
    expect(e.target.value).toBe("");
  });

  test("沒有剛 remap → 正常送字（不得誤傷真 IME）", () => {
    const { c, got } = ctx(0);
    const e = { target: { value: "測試" } };
    TermView.prototype.onInput.call(c, e);
    expect(got).toEqual(["測試"]);
  });

  test("時間窗過期後正常送字", () => {
    const { c, got } = ctx(Date.now() - ALT_COMPOSITION_SUPPRESS_MS - 10);
    TermView.prototype.onInput.call(c, { target: { value: "中" } });
    expect(got).toEqual(["中"]);
  });
});

describe("cancelsLiveHelper：Alt remap 算下指令", () => {
  test("Alt remap 與一般鍵都關掉實況更新", () => {
    expect(cancelsLiveHelper(keyEvent("a", { altKey: true, code: "KeyA" }))).toBe(true);
    expect(cancelsLiveHelper(keyEvent("√", { altKey: true, code: "KeyV" }))).toBe(true);
    expect(cancelsLiveHelper(keyEvent("a"))).toBe(true);
    expect(cancelsLiveHelper(keyEvent("a", { ctrlKey: true }))).toBe(true);
  });

  test("單獨輕點 Alt（要去開瀏覽器選單）不關 —— 不可簡化成一律 true", () => {
    expect(cancelsLiveHelper(keyEvent("Alt", { altKey: true, code: "AltLeft" }))).toBe(
      false
    );
  });

  test("非 remap 的 Alt 組合（瀏覽器的）不關", () => {
    expect(
      cancelsLiveHelper(keyEvent("ArrowLeft", { altKey: true, code: "ArrowLeft" }))
    ).toBe(false);
    expect(cancelsLiveHelper(keyEvent("5", { altKey: true, code: "Digit5" }))).toBe(
      false
    );
  });
});
