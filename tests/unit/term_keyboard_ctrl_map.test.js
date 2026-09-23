// Ctrl+符號鍵必須送 ASCII 控制碼，不是舊式 keyCode（upstream fork 來的 bug）。
//
// 舊 CtrlShiftMap：'[':219 '\\':220 ']':221 '@':50 '^':54 '_':109 —— 那是 keyCode，
// websocket.js#send 原封當單一 byte 送出（0xDB/0xDC/0xDD）。這不是「沒作用」而已：
// pttbbs 預設 VKEY_IS_MB=1（include/cmsys.h），vtkbd 把 ≥0x80 的 byte 原封交給呼叫端
// （common/sys/vtkbd.c VKSTATE_NORMAL），而 vgetstring 的過濾 vkey_isprint 對非 ASCII
// 回真（include/vtkbd.h、mbbsd/vtuikit.c）⇒ 孤兒 0xDD 被插進輸入緩衝，下一個字母
// （0x40–0x7E＝Big5 trail 區）跟它拼成一個亂碼 Big5 字 ⇒ getdata／編輯器裡「下一個字被吃掉」。
//
// 兩條送出路徑（TermKeyboard._onKeyDown＝原生、keyEventToBytes＝列表好讀 passthrough）
// 共用這張表，這裡同時釘兩邊並驗等值。
import { TermKeyboard, KeyMap, keyEventToBytes } from "../../src/js/term_keyboard";

function keyEvent(key, mods = {}) {
  return {
    key,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    shiftKey: !!mods.shiftKey,
    metaKey: false,
    getModifierState: () => false,
    preventDefault() {},
  };
}

function nativeBytes(e) {
  const sent = [];
  const kb = new TermKeyboard(() => false, () => false, (d) => sent.push(d));
  kb._onKeyDown(e);
  return sent.length ? sent.join("") : null;
}

const TABLE = [
  ["@", "\x00"],
  ["[", "\x1b"],
  ["\\", "\x1c"],
  ["]", "\x1d"],
  ["^", "\x1e"],
  ["_", "\x1f"],
  ["?", "\x7f"],
  ["a", "\x01"],
  ["q", "\x11"],
  ["z", "\x1a"],
];

describe("CtrlShiftMap：Ctrl+鍵 → ASCII 控制碼", () => {
  test.each(TABLE)("Ctrl+%j：keyEventToBytes 與原生路徑都送 %j", (key, bytes) => {
    const e = keyEvent(key, { ctrlKey: true });
    expect(keyEventToBytes(e)).toBe(bytes);
    expect(nativeBytes(e)).toBe(bytes);
  });

  test("Ctrl+@ 的控制碼是 0：不可被 truthiness 判斷當成「沒對應」", () => {
    const e = keyEvent("@", { ctrlKey: true });
    expect(keyEventToBytes(e)).not.toBeNull();
    expect(nativeBytes(e)).not.toBeNull();
  });

  test("Ctrl+[ 與 Esc 鍵逐 byte 相同", () => {
    expect(keyEventToBytes(keyEvent("[", { ctrlKey: true }))).toBe(KeyMap["Escape"]);
  });

  test("反向守護：任何 Ctrl 組合都不得送出 ≥0x80 的 byte（會被 PTT 當 Big5 前導 byte）", () => {
    const keys = "@[\\]^_?abcdefghijklmnopqrstuvwxyz".split("");
    for (const k of keys) {
      const b = keyEventToBytes(keyEvent(k, { ctrlKey: true }));
      if (b == null) continue;
      expect([k, b.charCodeAt(0) < 0x80]).toEqual([k, true]);
    }
  });

  test("沒對應的 Ctrl 組合仍回 null（Ctrl+數字）", () => {
    expect(keyEventToBytes(keyEvent("5", { ctrlKey: true }))).toBeNull();
    expect(nativeBytes(keyEvent("5", { ctrlKey: true }))).toBeNull();
  });
});
