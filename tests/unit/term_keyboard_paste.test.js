// Ctrl+V 必須讓給瀏覽器原生貼上（回歸：2026-08-21 回報「Ctrl+V 貼不上，Shift+Insert 正常」）。
//
// 症狀鏈：TermKeyboard._onKeyDown 的 ctrl 分支把 v 經 CtrlShiftMap['v']=22 送出 \x16 並回 true
// → TermKeyboard.onKeyDown 執行 e.preventDefault() → 瀏覽器不再產生 paste 事件 → 綁在隱藏
// input #t 上的 listener（pttchrome.jsx）永不觸發 → App.onDOMPaste 沒跑 → 文字貼上與
// imageUpload.tryClipboardImage（截圖上傳）兩條路一起死。與 Shift+Insert 曾踩的坑同型
// （tests/unit/list_keys.test.js「Shift+Insert（貼上快捷鍵）同樣放行」）。
//
// ^V 本身在 PTT 有實作（pttbbs edit.c Ctrl('V') 切 ANSI 彩色模式、bbs.c read_comms
// do_post_vote），Ctrl+Shift+V 已被 term_view 佔去當貼上，所以改由 Alt+V 送出。
import { TermKeyboard } from "../../src/js/term_keyboard";

function makeKeyboard() {
  const sent = [];
  const kb = new TermKeyboard(
    () => false, // isLeftDB
    () => false, // isCurDB
    (d) => sent.push(d)
  );
  return { kb, sent };
}

// 最小假 KeyboardEvent：_onKeyDown 只讀這幾個欄位。
function keyEvent(key, mods = {}) {
  return {
    key,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    shiftKey: !!mods.shiftKey,
    defaultPrevented: false,
    getModifierState: (m) => (m === "Meta" ? !!mods.metaKey : false),
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

describe("TermKeyboard：Ctrl+V 讓給瀏覽器貼上", () => {
  test("Ctrl+V 不 preventDefault、不送 ^V（preventDefault 會取消瀏覽器貼上）", () => {
    const { kb, sent } = makeKeyboard();
    const e = keyEvent("v", { ctrlKey: true });
    kb.onKeyDown(e);
    expect(e.defaultPrevented).toBe(false); // 放行 → paste 事件才生得出來
    expect(sent).toEqual([]); // 不得送 \x16
  });

  test("CapsLock 開著（key='V'）也一樣放行", () => {
    const { kb, sent } = makeKeyboard();
    const e = keyEvent("V", { ctrlKey: true });
    kb.onKeyDown(e);
    expect(e.defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
  });

  test("Ctrl+Shift+V 不由本層處理（留給 term_view 的 doPaste）", () => {
    const { kb, sent } = makeKeyboard();
    const e = keyEvent("V", { ctrlKey: true, shiftKey: true });
    kb.onKeyDown(e);
    expect(e.defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
  });

  test("反向守護：其餘 Ctrl 組合仍照送控制碼", () => {
    for (const [key, code] of [
      ["c", "\x03"],
      ["x", "\x18"],
      ["p", "\x10"],
    ]) {
      const { kb, sent } = makeKeyboard();
      const e = keyEvent(key, { ctrlKey: true });
      kb.onKeyDown(e);
      expect(sent).toEqual([code]);
      expect(e.defaultPrevented).toBe(true);
    }
  });
});

describe("TermKeyboard：Alt remap", () => {
  test("Alt+V 送 ^V（Ctrl+V 讓位後唯一送得出 \x16 的路）", () => {
    const { kb, sent } = makeKeyboard();
    const e = keyEvent("v", { altKey: true });
    kb.onKeyDown(e);
    expect(sent).toEqual(["\x16"]);
    expect(e.defaultPrevented).toBe(true);
  });

  test("既有 Alt+R/T/W remap 不受影響", () => {
    for (const [key, code] of [
      ["r", "\x12"],
      ["t", "\x14"],
      ["w", "\x17"],
    ]) {
      const { kb, sent } = makeKeyboard();
      const e = keyEvent(key, { altKey: true });
      kb.onKeyDown(e);
      expect(sent).toEqual([code]);
      expect(e.defaultPrevented).toBe(true);
    }
  });
});
