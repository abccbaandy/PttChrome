// 文章好讀模式底下，Alt 版的 ^F/^B/^H 必須與 Ctrl 版走同一條路（2026-09）。
//
// Alt 全面 remap 成 PTT 的 Ctrl 之後，多數字母是「裸送給 server」——但這三顆不行：
// pmore.c:2564/2573/2678 的 Ctrl('F')/Ctrl('B')/Ctrl('H') 直接移動 pmore 的頁指標，
// 而好讀模式的狀態機自己在驅動 PageDown 累積長頁。裸送會讓 server 的頁指標被移走
// 而長頁不知道 ⇒ 失同步（症狀：之後翻頁跳格／重複段落）。
//
// 這與「Alt 繞過 app 的 UI 快捷鍵」不衝突：繞過的是複製／全選／貼上那種純 UI 動作，
// 不是「app 代替 PTT 管狀態」的模擬。
import { EasyReading, ctrlLetterOf } from "../../src/js/easy_reading";

function keyEvent(key, mods = {}) {
  return {
    key,
    code: mods.code,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    shiftKey: !!mods.shiftKey,
    metaKey: !!mods.metaKey,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

describe("ctrlLetterOf（純函式）", () => {
  test("Ctrl+字母 → 小寫字母", () => {
    expect(ctrlLetterOf(keyEvent("f", { ctrlKey: true }))).toBe("f");
    expect(ctrlLetterOf(keyEvent("h", { ctrlKey: true }))).toBe("h");
  });

  test("CapsLock 開著的 Ctrl+F（e.key 是 'F'）也接得到", () => {
    // 原碼直接比 'f'，CapsLock 開著時接不到 —— 順手修掉的小 bug。
    expect(ctrlLetterOf(keyEvent("F", { ctrlKey: true }))).toBe("f");
  });

  test("Alt+字母 → 同一顆字母", () => {
    expect(ctrlLetterOf(keyEvent("f", { altKey: true, code: "KeyF" }))).toBe("f");
    expect(ctrlLetterOf(keyEvent("b", { altKey: true, code: "KeyB" }))).toBe("b");
  });

  test("macOS 形態：⌥F/⌥B/⌥H 的 e.key 是 ƒ/∫/˙，只有 e.code 還原得了", () => {
    // 比對 e.key 的話 parity 在 mac 上是**假的**（同 docs/enhanced-addon.md）。
    expect(ctrlLetterOf(keyEvent("ƒ", { altKey: true, code: "KeyF" }))).toBe("f");
    expect(ctrlLetterOf(keyEvent("∫", { altKey: true, code: "KeyB" }))).toBe("b");
    expect(ctrlLetterOf(keyEvent("˙", { altKey: true, code: "KeyH" }))).toBe("h");
  });

  test("反向：AltGr／Alt+Shift／非字母／裸鍵一律 null", () => {
    expect(
      ctrlLetterOf(keyEvent("é", { ctrlKey: true, altKey: true, code: "KeyE" }))
    ).toBe(null);
    expect(
      ctrlLetterOf(keyEvent("f", { altKey: true, shiftKey: true, code: "KeyF" }))
    ).toBe(null);
    expect(ctrlLetterOf(keyEvent("ArrowUp", { ctrlKey: true }))).toBe(null);
    expect(ctrlLetterOf(keyEvent("f"))).toBe(null);
  });
});

// ---------------------------------------------------------------------------

function makeEasyReading({ scrollTop = 500 } = {}) {
  const sent = [];
  const calls = { left: 0 };
  const mainDisplay = { scrollTop, scrollHeight: 10000 };
  const ctx = {
    _enabled: true,
    startedEasyReading: true,
    _pendingScrollRestore: null,
    _turnPageLines: 20,
    _view: {
      mainDisplay,
      mainContainer: { clientHeight: 10000 },
      chh: 20,
    },
    _termBuf: { rows: 24 },
    _send: (d) => sent.push(d),
    _scrollBy: EasyReading.prototype._scrollBy,
    _onKeyDownProcessUI: () => {}, // UI 那層另有守護，這裡只看 ctrl/alt 分支
    leaveCurrentPost: () => {
      calls.left += 1;
    },
  };
  return { ctx, sent, calls, mainDisplay };
}

const onKeyDown = (ctx, e) => EasyReading.prototype._onKeyDown.call(ctx, e);
const onKeyDownUI = (ctx, e) => EasyReading.prototype._onKeyDownProcessUI.call(ctx, e);

describe("_onKeyDown：Alt+H ≡ Ctrl+H（上一篇）", () => {
  test("兩者都送 left+up+right 並 preventDefault", () => {
    for (const mods of [
      { ctrlKey: true },
      { altKey: true, code: "KeyH" },
      { altKey: true, code: "KeyH", key: "˙" }, // macOS 形態
    ]) {
      const { ctx, sent } = makeEasyReading();
      const e = keyEvent(mods.key || "h", mods);
      onKeyDown(ctx, e);
      expect(sent).toEqual(["\x1b[D\x1b[A\x1b[C"]);
      expect(e.defaultPrevented).toBe(true);
    }
  });

  test("反向：不在 parity 名單的 Alt+Z 不被好讀吃掉（交給下游裸送）", () => {
    const { ctx, sent } = makeEasyReading();
    const e = keyEvent("z", { altKey: true, code: "KeyZ" });
    onKeyDown(ctx, e);
    expect(sent).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  test("反向：AltGr 不被當成 Ctrl", () => {
    const { ctx, sent } = makeEasyReading();
    const e = keyEvent("ĥ", { ctrlKey: true, altKey: true, code: "KeyH" });
    onKeyDown(ctx, e);
    expect(sent).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("_onKeyDownProcessUI：Alt+F/B/H ≡ Ctrl+F/B/H（本地捲動，零送出）", () => {
  test("Alt+F 往下一頁、Alt+B 往上一頁，都不送 byte 給 server", () => {
    for (const [mods, delta] of [
      [{ ctrlKey: true, key: "f" }, +400],
      [{ altKey: true, code: "KeyF", key: "f" }, +400],
      [{ altKey: true, code: "KeyF", key: "ƒ" }, +400], // macOS 形態
      [{ ctrlKey: true, key: "b" }, -400],
      [{ altKey: true, code: "KeyB", key: "b" }, -400],
      [{ altKey: true, code: "KeyB", key: "∫" }, -400],
    ]) {
      const { ctx, sent, mainDisplay } = makeEasyReading({ scrollTop: 2000 });
      const e = keyEvent(mods.key, mods);
      onKeyDownUI(ctx, e);
      // _turnPageLines(20) * chh(20) = 400
      expect(mainDisplay.scrollTop).toBe(2000 + delta);
      expect(sent).toEqual([]); // **關鍵**：不得裸送給 server
      expect(e.defaultPrevented).toBe(true);
    }
  });

  test("Alt+H：捲得動就往上捲（不離開文章）", () => {
    const { ctx, calls, mainDisplay } = makeEasyReading({ scrollTop: 2000 });
    const e = keyEvent("˙", { altKey: true, code: "KeyH" });
    onKeyDownUI(ctx, e);
    expect(mainDisplay.scrollTop).toBe(1600);
    expect(calls.left).toBe(0);
    expect(e.defaultPrevented).toBe(true);
  });

  test("Alt+H：已在頂端捲不動 → 離開文章（＝pmore 的 READ_PREV）", () => {
    const { ctx, calls } = makeEasyReading({ scrollTop: 0 });
    const e = keyEvent("˙", { altKey: true, code: "KeyH" });
    onKeyDownUI(ctx, e);
    expect(calls.left).toBe(1);
    expect(e.defaultPrevented).toBe(false); // 與 Ctrl 版一致：stop 為 false
  });

  test("Ctrl+H 在同樣情境下行為完全相同（parity 本身）", () => {
    const a = makeEasyReading({ scrollTop: 0 });
    onKeyDownUI(a.ctx, keyEvent("h", { ctrlKey: true }));
    const b = makeEasyReading({ scrollTop: 0 });
    onKeyDownUI(b.ctx, keyEvent("˙", { altKey: true, code: "KeyH" }));
    expect(a.calls).toEqual(b.calls);
    expect(a.sent).toEqual(b.sent);
    expect(a.mainDisplay.scrollTop).toBe(b.mainDisplay.scrollTop);
  });

  test("Ctrl+符號（@^_?）維持吞掉 —— 符號鍵不在 Alt remap 範圍", () => {
    for (const k of ["@", "^", "_", "?"]) {
      const { ctx, sent } = makeEasyReading();
      const e = keyEvent(k, { ctrlKey: true });
      onKeyDownUI(ctx, e);
      expect(e.defaultPrevented).toBe(true);
      expect(sent).toEqual([]);
    }
  });

  test("反向：Alt+Z 不被這層吃掉", () => {
    const { ctx, sent, mainDisplay } = makeEasyReading({ scrollTop: 2000 });
    const e = keyEvent("Ω", { altKey: true, code: "KeyZ" });
    onKeyDownUI(ctx, e);
    expect(mainDisplay.scrollTop).toBe(2000);
    expect(sent).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });
});
