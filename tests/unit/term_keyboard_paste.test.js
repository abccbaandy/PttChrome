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
import { TermKeyboard, altRemapCharCode } from "../../src/js/term_keyboard";

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
// code 刻意「未給就是 undefined」：既有 Windows 風格事件必須原封不動地過，
// 那正是「e.code 缺失時不得炸」的守護。
function keyEvent(key, mods = {}) {
  return {
    key,
    code: mods.code,
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

// 跨平台回歸：macOS 的 Option 是「組字鍵」，⌥+字母 在輸入法層被組成符號
//（US 佈局 ⌥V→√ U+221A、⌥R→®、⌥T→†、⌥W→∑），KeyboardEvent.key 因此不再是字母。
// 舊版 alt 分支比對 e.key.toLowerCase() ⇒ Mac 上四個 remap 全部匹配不到而靜默失效，
// 其中 ^V 尤其致命：Ctrl+V 已讓給瀏覽器貼上，Alt+V 是送得出 \x16 的唯一路。
// 這組測試用 Mac 風格事件（key 失真 + code 為實體鍵位）鎖住行為。
describe("TermKeyboard：Mac Option 組字字元（e.key 失真）", () => {
  test("⌥V 仍送 ^V（Mac 上 e.key 是 √ 而非 v）", () => {
    const { kb, sent } = makeKeyboard();
    const e = keyEvent("\u221a", { altKey: true, code: "KeyV" });
    kb.onKeyDown(e);
    expect(sent).toEqual(["\x16"]);
    expect(e.defaultPrevented).toBe(true);
  });

  test("⌥R/⌥T/⌥W 同樣照送控制碼", () => {
    for (const [key, code, out] of [
      ["\u00ae", "KeyR", "\x12"],
      ["\u2020", "KeyT", "\x14"],
      ["\u2211", "KeyW", "\x17"],
    ]) {
      const { kb, sent } = makeKeyboard();
      const e = keyEvent(key, { altKey: true, code });
      kb.onKeyDown(e);
      expect(sent).toEqual([out]);
      expect(e.defaultPrevented).toBe(true);
    }
  });

  test("反向：不在 remap 名單的 ⌥A 不送也不攔（留給瀏覽器）", () => {
    const { kb, sent } = makeKeyboard();
    const e = keyEvent("\u00e5", { altKey: true, code: "KeyA" });
    kb.onKeyDown(e);
    expect(sent).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  test("反向：⌥⇧V 不由本層處理（alt 分支排除 shift）", () => {
    const { kb, sent } = makeKeyboard();
    const e = keyEvent("\u221a", { altKey: true, shiftKey: true, code: "KeyV" });
    kb.onKeyDown(e);
    expect(sent).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("altRemapCharCode（純函式邊界）", () => {
  test("e.key 是字母時優先採用（Win/Linux 佈局照舊）", () => {
    expect(altRemapCharCode({ key: "v", code: "KeyV" })).toBe(22);
    // 佈局讓 e.key 與實體鍵位不一致時，以使用者實際打出的字母為準。
    expect(altRemapCharCode({ key: "r", code: "KeyP" })).toBe(18);
    expect(altRemapCharCode({ key: "V" })).toBe(22); // CapsLock
  });

  test("e.key 失真才回退 e.code", () => {
    expect(altRemapCharCode({ key: "\u221a", code: "KeyV" })).toBe(22);
    expect(altRemapCharCode({ key: "Dead", code: "KeyW" })).toBe(23);
  });

  test("沒有 e.code 也不得丟例外（合成事件／舊測試）", () => {
    expect(altRemapCharCode({ key: "q" })).toBe(null);
    expect(altRemapCharCode({ key: "\u221a" })).toBe(null);
  });

  test("空字串 e.key 不得誤中（indexOf('') === 0 的陷阱）", () => {
    expect(altRemapCharCode({ key: "", code: "KeyA" })).toBe(null);
    expect(altRemapCharCode({})).toBe(null);
  });

  test("不在名單的鍵一律 null", () => {
    expect(altRemapCharCode({ key: "a", code: "KeyA" })).toBe(null);
    expect(altRemapCharCode({ key: "Enter", code: "Enter" })).toBe(null);
    expect(altRemapCharCode({ key: "5", code: "Digit5" })).toBe(null);
  });
});
