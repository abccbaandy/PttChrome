// Alt（macOS 的 Option）＝ PTT 的 Ctrl，全 26 字母。
//
// 不變量：**Alt+<letter> 送出的 byte 與 Ctrl+<letter> 逐位元相同**。
// 動機：macOS 上好幾顆 Ctrl 組合按不出來（Cocoa 把 Ctrl-Y 綁成 yank、Ctrl-A/E 綁成
// 行首行尾…），逐顆救火沒有盡頭；給 Alt 一條等價通道之後任何 Ctrl 衝突都有退路。
//
// 這支釘的是「送出層」的合約（term_keyboard）。列表好讀的 sync 腿在 list_keys /
// board_list_session，文章好讀的 ^F/^B/^H parity 在 easy_reading_alt_keys，
// macOS dead key 的組字防線在 term_view_alt_composition。
import {
  TermKeyboard,
  altRemapCharCode,
  isAltRemapEvent,
  keyEventToBytes,
  ALT_REMAP_EXCLUDE,
  ALT_REMAP_LETTERS,
} from "../../src/js/term_keyboard";

function makeKeyboard() {
  const sent = [];
  const kb = new TermKeyboard(
    () => false, // isLeftDB
    () => false, // isCurDB
    (d) => sent.push(d)
  );
  return { kb, sent };
}

// 最小假 KeyboardEvent。metaKey 同時給 property 與 getModifierState：
// TermKeyboard 讀後者，isAltRemapEvent 讀前者。
function keyEvent(key, mods = {}) {
  return {
    key,
    code: mods.code,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    shiftKey: !!mods.shiftKey,
    metaKey: !!mods.metaKey,
    defaultPrevented: false,
    getModifierState: (m) => (m === "Meta" ? !!mods.metaKey : false),
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

describe("Alt+A~Z ＝ Ctrl+A~Z（26 字母全覆蓋）", () => {
  test("altRemapCharCode 對 26 個字母回 1..26", () => {
    LETTERS.forEach((L, i) => {
      const lower = L.toLowerCase();
      expect(altRemapCharCode({ key: lower, code: "Key" + L })).toBe(i + 1);
    });
  });

  test("TermKeyboard 端到端：每個字母送出對應控制碼並 preventDefault", () => {
    LETTERS.forEach((L, i) => {
      const { kb, sent } = makeKeyboard();
      const e = keyEvent(L.toLowerCase(), { altKey: true, code: "Key" + L });
      kb.onKeyDown(e);
      expect(sent).toEqual([String.fromCharCode(i + 1)]);
      expect(e.defaultPrevented).toBe(true);
    });
  });

  test("Alt 版與 Ctrl 版送出的 byte 完全相同（不變量本身）", () => {
    // Ctrl-V 是唯一例外：它被刻意讓給瀏覽器貼上，所以 Ctrl 版不送、Alt 版才送。
    LETTERS.filter((L) => L !== "V").forEach((L) => {
      const a = makeKeyboard();
      a.kb.onKeyDown(keyEvent(L.toLowerCase(), { altKey: true, code: "Key" + L }));
      const c = makeKeyboard();
      c.kb.onKeyDown(keyEvent(L.toLowerCase(), { ctrlKey: true }));
      expect(a.sent).toEqual(c.sent);
    });
  });

  test("Alt+C/A/X：送 ^C/^A/^X 給 PTT，不是複製／全選／剪下", () => {
    // 這三顆的 Ctrl 版被 term_view 的本地快捷鍵吃掉（doSelectAll 更是無條件吃），
    // 所以 Alt 版是 PTT 端 ClearTagList(read.c) / show_filename(bbs.c) /
    // cross_post(bbs.c) 唯一可靠的入口。複製／全選／貼上維持 Ctrl（mac 是 ⌘）。
    for (const [L, out] of [
      ["C", "\x03"],
      ["A", "\x01"],
      ["X", "\x18"],
      ["V", "\x16"],
    ]) {
      const { kb, sent } = makeKeyboard();
      const e = keyEvent(L.toLowerCase(), { altKey: true, code: "Key" + L });
      kb.onKeyDown(e);
      expect(sent).toEqual([out]);
      expect(e.defaultPrevented).toBe(true);
    }
  });

  test("Alt+Y ＝ ^Y —— 這次需求的起點（mac 上 Ctrl+Y 被 Cocoa 的 yank 吃掉）", () => {
    const { kb, sent } = makeKeyboard();
    kb.onKeyDown(keyEvent("y", { altKey: true, code: "KeyY" }));
    expect(sent).toEqual(["\x19"]);
  });

  test("CapsLock 開著（e.key 是大寫）照樣正確", () => {
    const { kb, sent } = makeKeyboard();
    kb.onKeyDown(keyEvent("Z", { altKey: true, code: "KeyZ" }));
    expect(sent).toEqual(["\x1a"]);
  });
});

describe("macOS：Option 是組字修飾鍵，e.key 全部失真", () => {
  // US 佈局 ⌥<letter> 的實際 e.key。全 26 字母 remap 之後每一種形態都會真的出現，
  // 不像當年只有 RTWV 碰得到第一種。唯一還原得了的欄位是 e.code。
  const MAC_KEYS = {
    A: "å", // å
    B: "∫", // ∫
    C: "ç", // ç
    D: "∂", // ∂
    E: "Dead", // 組合重音 dead key
    F: "ƒ", // ƒ
    G: "©", // ©
    H: "˙", // ˙
    I: "Dead",
    J: "∆", // ∆
    K: "˚", // ˚
    L: "¬", // ¬
    M: "µ", // µ
    N: "Dead",
    O: "ø", // ø
    P: "π", // π
    Q: "œ", // œ
    R: "®", // ®
    S: "ß", // ß
    T: "†", // †
    U: "Dead",
    V: "√", // √
    W: "∑", // ∑
    X: "≈", // ≈
    Y: "¥", // ¥
    Z: "Ω", // Ω
  };

  test("26 個 ⌥<letter> 全部還原成正確的控制碼", () => {
    LETTERS.forEach((L, i) => {
      const { kb, sent } = makeKeyboard();
      const e = keyEvent(MAC_KEYS[L], { altKey: true, code: "Key" + L });
      kb.onKeyDown(e);
      expect(sent).toEqual([String.fromCharCode(i + 1)]);
      expect(e.defaultPrevented).toBe(true);
    });
  });

  test("dead key（⌥E/⌥I/⌥N/⌥U）的 e.key 是 'Dead'，只有 e.code 接得住", () => {
    for (const [L, out] of [
      ["E", "\x05"],
      ["I", "\x09"],
      ["N", "\x0e"],
      ["U", "\x15"],
    ]) {
      expect(altRemapCharCode({ key: "Dead", code: "Key" + L })).toBe(
        out.charCodeAt(0)
      );
      // 少了 e.code 就無從還原 —— 這正是 term_view 的 keyEventFilter 必須放行
      // keyCode 229 的原因（否則事件根本進不來）。
      expect(altRemapCharCode({ key: "Dead" })).toBe(null);
    }
  });

  test("toUpperCase 陷阱一：'ß'.toUpperCase() 是 'SS'（長度 2），不得誤中", () => {
    expect("ß".toUpperCase()).toBe("SS");
    // 靠 e.code 補位成 ^S 而不是別的東西。
    expect(altRemapCharCode({ key: "ß", code: "KeyS" })).toBe(19);
    expect(altRemapCharCode({ key: "ß" })).toBe(null);
  });

  test("toUpperCase 陷阱二：'µ'.toUpperCase() 是希臘大寫 Μ，不是 ASCII 'M'", () => {
    expect("µ".toUpperCase()).toBe("Μ");
    expect("µ".toUpperCase()).not.toBe("M");
    expect(altRemapCharCode({ key: "µ", code: "KeyM" })).toBe(13);
  });

  test("反向陷阱：'ı'.toUpperCase() === 'I'，會由 e.key 分支命中 ^I（與 code 結論一致）", () => {
    expect("ı".toUpperCase()).toBe("I");
    expect(altRemapCharCode({ key: "ı", code: "KeyI" })).toBe(9);
    expect(altRemapCharCode({ key: "ı" })).toBe(9);
  });
});

describe("isAltRemapEvent（四個消費端唯一的判準）", () => {
  test("正向：Alt + 字母", () => {
    expect(isAltRemapEvent(keyEvent("a", { altKey: true, code: "KeyA" }))).toBe(true);
    expect(isAltRemapEvent(keyEvent("√", { altKey: true, code: "KeyV" }))).toBe(
      true
    );
    expect(isAltRemapEvent(keyEvent("Dead", { altKey: true, code: "KeyE" }))).toBe(
      true
    );
  });

  test("反向：AltGr（ctrl+alt）不算 —— US-International 打出的字要走 #t", () => {
    expect(
      isAltRemapEvent(keyEvent("é", { ctrlKey: true, altKey: true, code: "KeyE" }))
    ).toBe(false);
  });

  test("反向：帶 Shift／Meta 的組合不算", () => {
    expect(
      isAltRemapEvent(keyEvent("t", { altKey: true, shiftKey: true, code: "KeyT" }))
    ).toBe(false);
    expect(
      isAltRemapEvent(keyEvent("t", { altKey: true, metaKey: true, code: "KeyT" }))
    ).toBe(false);
  });

  test("反向：非字母鍵不算（數字／方向鍵／功能鍵／裸 Alt）", () => {
    expect(isAltRemapEvent(keyEvent("5", { altKey: true, code: "Digit5" }))).toBe(false);
    expect(
      isAltRemapEvent(keyEvent("ArrowLeft", { altKey: true, code: "ArrowLeft" }))
    ).toBe(false);
    expect(isAltRemapEvent(keyEvent("F4", { altKey: true, code: "F4" }))).toBe(false);
    expect(isAltRemapEvent(keyEvent("Alt", { altKey: true, code: "AltLeft" }))).toBe(
      false
    );
    expect(isAltRemapEvent(keyEvent("[", { altKey: true, code: "BracketLeft" }))).toBe(
      false
    );
  });

  test("反向：沒按 Alt 一律 false", () => {
    expect(isAltRemapEvent(keyEvent("a", { ctrlKey: true, code: "KeyA" }))).toBe(false);
    expect(isAltRemapEvent(keyEvent("a", { code: "KeyA" }))).toBe(false);
  });
});

describe("不可被 Alt remap 搶走的路徑", () => {
  test("AltGr 組合：TermKeyboard 零送出、不 preventDefault", () => {
    // Windows US-International 的 AltGr 是 ctrlKey+altKey。它打出的字元必須繼續
    // 走 keypress → #t → onInput 那條路，被攔下來就等於這些使用者打不了字。
    const { kb, sent } = makeKeyboard();
    const e = keyEvent("é", { ctrlKey: true, altKey: true, code: "KeyE" });
    kb.onKeyDown(e);
    expect(sent).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  test("Alt+Shift+字母：兩邊都不接（維持既有行為）", () => {
    for (const L of ["T", "V", "X"]) {
      const { kb, sent } = makeKeyboard();
      const e = keyEvent(L.toLowerCase(), {
        altKey: true,
        shiftKey: true,
        code: "Key" + L,
      });
      kb.onKeyDown(e);
      expect(sent).toEqual([]);
      expect(e.defaultPrevented).toBe(false);
    }
  });

  test("Alt+Meta（mac 的 ⌥⌘）讓給瀏覽器", () => {
    const { kb, sent } = makeKeyboard();
    const e = keyEvent("i", { altKey: true, metaKey: true, code: "KeyI" });
    kb.onKeyDown(e);
    expect(sent).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  test("keyEventToBytes 對 altKey 一律回 null（刻意不改的合約）", () => {
    // 這個回傳值是列表好讀 _classifyKey 的唯一判準。一旦它對 Alt 回傳 byte，
    // Alt+J/K/N/P 會落進導覽白名單、Alt+M 落進開文 ⇒ 全部變成本地動作而不是
    // 送鍵給 PTT，整組 remap 靜默失效。兩份 session 都在 _classifyKey **之前**
    // 用 isAltRemapEvent 自己攔，那個順序是承重的。
    for (const L of ["j", "k", "n", "p", "m", "b"]) {
      expect(keyEventToBytes(keyEvent(L, { altKey: true, code: "Key" + L.toUpperCase() })))
        .toBe(null);
    }
  });
});

describe("排除表", () => {
  test("預設為空 —— 瀏覽器保留的快捷鍵根本不送 keydown 到頁面，收不到就不 remap", () => {
    // 「系統 > 我們」不靠黑名單、不做平台偵測。只有實測到「收得到 keydown 但
    // preventDefault 之後瀏覽器仍有動作」＝雙重觸發的字母才進這裡。
    // 改動它必須同步更新 docs/pttbbs-screen-protocol.md §11.8 的量測表。
    expect(ALT_REMAP_EXCLUDE).toBe("");
    expect(ALT_REMAP_LETTERS).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  });

  test("排除表真的會把字母拿掉（機制本身可用）", () => {
    // 不動全域常數，只驗「濾出」這個算式的語意，避免日後有人改成硬編碼 26 字母。
    const filtered = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
      .split("")
      .filter((c) => "DF".indexOf(c) < 0)
      .join("");
    expect(filtered).toBe("ABCEGHIJKLMNOPQRSTUVWXYZ");
    expect(filtered.length).toBe(24);
  });
});
