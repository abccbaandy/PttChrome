// 游標底色決策層。守護兩個實際壞過的行為：
//  (1) 顏色設定永遠無效（畫面恆綠）—— highlightClass 必須真的由 pref 推導；
//  (2) 底色綁死滑鼠 —— 鍵盤游標也要能上色，且只在該上色的畫面上色。
import {
  DEFAULT_HIGHLIGHT_BG,
  highlightClass,
  resolveHighlightRow,
} from "../../src/js/cursor_highlight";

describe("highlightClass", () => {
  test("1..15 對映 color.css 的 bN", () => {
    expect(highlightClass(1)).toBe("b1");
    expect(highlightClass(2)).toBe("b2");
    expect(highlightClass(4)).toBe("b4");
    expect(highlightClass(15)).toBe("b15");
  });

  test("越界／非整數／缺值一律回預設綠（壞掉的持久化值不能讓光棒消失）", () => {
    const fallback = "b" + DEFAULT_HIGHLIGHT_BG;
    expect(highlightClass(0)).toBe(fallback); // b0 = transparent 等於沒上色
    expect(highlightClass(16)).toBe(fallback);
    expect(highlightClass(-1)).toBe(fallback);
    expect(highlightClass(2.5)).toBe(fallback);
    expect(highlightClass(undefined)).toBe(fallback);
    expect(highlightClass(null)).toBe(fallback);
    expect(highlightClass("abc")).toBe(fallback);
  });

  test("數字字串（設定頁可能存成字串）照樣可用", () => {
    expect(highlightClass("7")).toBe("b7");
  });
});

describe("resolveHighlightRow：原生畫面", () => {
  const base = {
    mode: "native",
    mouseEnabled: true,
    keyboardEnabled: true,
    mouseRow: -1,
    cursorRow: 5,
    pageState: 2,
  };

  test("滑鼠 hover 中：用 hover 列（滑鼠優先於鍵盤）", () => {
    expect(resolveHighlightRow({ ...base, mouseRow: 11 })).toBe(11);
  });

  test("滑鼠沒 hover：落回真實游標列 buf.cur_y", () => {
    expect(resolveHighlightRow(base)).toBe(5);
  });

  test("滑鼠瀏覽關閉（或底色開關關）時 hover 不上色", () => {
    expect(
      resolveHighlightRow({ ...base, mouseEnabled: false, mouseRow: 11 })
    ).toBe(5);
  });

  test("鍵盤底色關：沒 hover 就不上色", () => {
    expect(resolveHighlightRow({ ...base, keyboardEnabled: false })).toBe(-1);
  });

  test("鍵盤底色只作用於選單(1)與列表(2/4)", () => {
    expect(resolveHighlightRow({ ...base, pageState: 1 })).toBe(5);
    expect(resolveHighlightRow({ ...base, pageState: 4 })).toBe(5);
    // 文章閱讀頁：游標停在底部狀態列，整列變色只會干擾
    expect(resolveHighlightRow({ ...base, pageState: 3 })).toBe(-1);
    expect(resolveHighlightRow({ ...base, pageState: 0 })).toBe(-1);
  });

  test("pageState 3 仍允許滑鼠 hover 上色（維持原生既有行為）", () => {
    expect(resolveHighlightRow({ ...base, pageState: 3, mouseRow: 9 })).toBe(9);
  });

  test("游標列缺值時不上色", () => {
    expect(resolveHighlightRow({ ...base, cursorRow: undefined })).toBe(-1);
    expect(resolveHighlightRow({ ...base, cursorRow: -1 })).toBe(-1);
  });
});

describe("resolveHighlightRow：列表好讀模式", () => {
  const base = {
    mode: "listBuffer",
    mouseEnabled: true,
    keyboardEnabled: true,
    mouseRow: -1,
    listCursorRow: 8,
    // server 的真實游標與 pageState 在這個模式下完全不該被採用
    cursorRow: 3,
    pageState: 3,
  };

  test("沒 hover：上色我們的虛擬游標列，不受 server pageState/cur_y 影響", () => {
    expect(resolveHighlightRow(base)).toBe(8);
  });

  test("hover 中：用 hover 列", () => {
    expect(resolveHighlightRow({ ...base, mouseRow: 15 })).toBe(15);
  });

  test("鍵盤底色關且沒 hover：不上色", () => {
    expect(resolveHighlightRow({ ...base, keyboardEnabled: false })).toBe(-1);
  });

  test("視窗還沒建立（虛擬游標列未知）時不上色", () => {
    expect(resolveHighlightRow({ ...base, listCursorRow: null })).toBe(-1);
    expect(resolveHighlightRow({ ...base, listCursorRow: -1 })).toBe(-1);
  });
});

describe("resolveHighlightRow：好讀文章長頁", () => {
  test("一律不上色（連 hover 都不上，長頁沒有『游標列』的概念）", () => {
    expect(
      resolveHighlightRow({
        mode: "article",
        mouseEnabled: true,
        keyboardEnabled: true,
        mouseRow: 42,
        cursorRow: 7,
        pageState: 3,
      })
    ).toBe(-1);
  });
});
