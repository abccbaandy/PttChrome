// 游標底色決策層。守護兩個實際壞過的行為：
//  (1) 顏色設定永遠無效（畫面恆綠）—— highlightClass 必須真的由 pref 推導；
//  (2) 底色綁死滑鼠 —— 鍵盤游標也要能上色，且只在該上色的畫面上色。
import {
  DEFAULT_HIGHLIGHT_BG,
  highlightClass,
  highlightColStart,
  resolveHighlightRow,
} from "../../src/js/cursor_highlight";
import {
  LIST_TITLE_COL_START,
} from "../../src/js/comment_parse";
import { MENU_COL_START } from "../../src/js/mouse_regions";

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

// 2026-08 回歸：滑鼠底色開啟時，鍵盤游標移動底色不跟著動。
// 舊規則是「滑鼠恆勝」（mouseEnabled && mouseRow >= 0 就回 hover 列），而 hover 列是
// 黏著狀態（只有真的收到 mousemove 才會變）⇒ 滑鼠停過一次之後，鍵盤怎麼按都搶不回來。
// 新規則：誰最後動誰贏（lastMover），但鍵盤只有在該畫面真的有游標列時才搶得走。
describe("resolveHighlightRow：誰最後動誰贏（lastMover）", () => {
  const native = {
    mode: "native",
    mouseEnabled: true,
    keyboardEnabled: true,
    mouseRow: 11,
    cursorRow: 5,
    pageState: 2,
  };
  const listBuffer = {
    mode: "listBuffer",
    mouseEnabled: true,
    keyboardEnabled: true,
    mouseRow: 15,
    listCursorRow: 8,
    cursorRow: 3,
    pageState: 3,
  };

  test("原生：hover 列黏著，但最後動的是鍵盤 ⇒ 上色鍵盤游標列", () => {
    expect(resolveHighlightRow({ ...native, lastMover: "keyboard" })).toBe(5);
  });

  test("列表好讀：hover 列黏著，但最後動的是鍵盤 ⇒ 上色虛擬游標列", () => {
    expect(resolveHighlightRow({ ...listBuffer, lastMover: "keyboard" })).toBe(8);
  });

  test("最後動的是滑鼠 ⇒ 回 hover 列", () => {
    expect(resolveHighlightRow({ ...native, lastMover: "mouse" })).toBe(11);
    expect(resolveHighlightRow({ ...listBuffer, lastMover: "mouse" })).toBe(15);
  });

  test("沒給 lastMover（舊呼叫端）⇒ 行為與改版前相同：滑鼠優先", () => {
    expect(resolveHighlightRow(native)).toBe(11);
    expect(resolveHighlightRow(listBuffer)).toBe(15);
  });

  test("鍵盤底色關掉：就算最後動的是鍵盤，hover 底色照舊生效", () => {
    expect(
      resolveHighlightRow({ ...native, keyboardEnabled: false, lastMover: "keyboard" })
    ).toBe(11);
  });

  test("該畫面沒有鍵盤游標列（文章頁／游標列缺值）：hover 底色照舊生效", () => {
    expect(
      resolveHighlightRow({ ...native, pageState: 3, lastMover: "keyboard" })
    ).toBe(11);
    expect(
      resolveHighlightRow({ ...listBuffer, listCursorRow: -1, lastMover: "keyboard" })
    ).toBe(15);
  });

  test("好讀長頁一律不上色，lastMover 不影響", () => {
    expect(
      resolveHighlightRow({ ...native, mode: "article", lastMover: "keyboard" })
    ).toBe(-1);
  });
});

// 底色範圍＝可點區範圍（使用者 2026-08 定案「點擊區域＝底色區域」），唯一真相源是
// mouse_regions.clickableColStart。**不分 lastMover**：鍵盤游標與滑鼠 hover 共用
// 同一個寬度。
describe("highlightColStart", () => {
  test("防誤觸開啟：原生列表 30、選單 8", () => {
    expect(highlightColStart({ mode: "native", pageState: 2, misclickGuard: true }))
      .toBe(LIST_TITLE_COL_START);
    expect(highlightColStart({ mode: "native", pageState: 4, misclickGuard: true }))
      .toBe(LIST_TITLE_COL_START);
    expect(highlightColStart({ mode: "native", pageState: 1, misclickGuard: true }))
      .toBe(MENU_COL_START);
  });

  test("列表好讀的虛擬視窗與原生列表同一套欄位", () => {
    // listBuffer 的 pageState 在轉場幀可能不是 2（buildListWindowLines 自己組畫面），
    // 但欄位逐格對齊 readdoent ⇒ 一律套列表的欄位表。
    expect(
      highlightColStart({ mode: "listBuffer", pageState: 0, misclickGuard: true })
    ).toBe(LIST_TITLE_COL_START);
  });

  test("好讀長頁（article）一律 0 —— 它本來就不上色", () => {
    expect(
      highlightColStart({ mode: "article", pageState: 3, misclickGuard: true })
    ).toBe(0);
  });

  test("防誤觸關閉：一律整列", () => {
    [1, 2, 4].forEach((pageState) => {
      expect(highlightColStart({ mode: "native", pageState, misclickGuard: false }))
        .toBe(0);
    });
    expect(
      highlightColStart({ mode: "listBuffer", misclickGuard: false })
    ).toBe(0);
  });

  test("缺值不會炸，回整列", () => {
    expect(highlightColStart()).toBe(0);
    expect(highlightColStart({})).toBe(0);
  });
});

// 2026-08 回歸：在看板列表按 s（搜尋全站看板）叫出輸入框時，prompt 那一列被上底色。
// setPageState 沒有 reset 分支 ⇒ 只重畫 row 0/1 的 prompt 畫面讓 pageState 黏在 2，
// 而 vgetstring 把游標移進 row 1 的反白輸入欄 ⇒「pageState 2 有鍵盤游標列」成立。
// 修法：呼叫端偵測到輸入欄（term_buf.isCursorOnInputField）就整個畫面不上色 ——
// 鍵盤與滑鼠共用這個唯一決策點，行為與文章裡的推文輸入框一致。
describe("resolveHighlightRow：PTT 開著輸入框（inputPrompt）", () => {
  const base = {
    mode: "native",
    mouseEnabled: true,
    keyboardEnabled: true,
    mouseRow: -1,
    cursorRow: 1,
    pageState: 2,
    inputPrompt: true,
  };

  test("鍵盤游標列不上色", () => {
    expect(resolveHighlightRow(base)).toBe(-1);
    expect(resolveHighlightRow({ ...base, lastMover: "keyboard" })).toBe(-1);
  });

  test("滑鼠 hover 列也不上色（點擊同時被 mouse_regions 擋掉）", () => {
    expect(resolveHighlightRow({ ...base, mouseRow: 11 })).toBe(-1);
    expect(
      resolveHighlightRow({ ...base, mouseRow: 11, lastMover: "mouse" })
    ).toBe(-1);
  });

  test("選單（pageState 1）上叫出的輸入框同樣不上色", () => {
    expect(resolveHighlightRow({ ...base, pageState: 1 })).toBe(-1);
  });

  test("關掉輸入框後底色照舊（gate 只在輸入框存在時生效）", () => {
    expect(resolveHighlightRow({ ...base, inputPrompt: false, cursorRow: 5 }))
      .toBe(5);
  });
});
