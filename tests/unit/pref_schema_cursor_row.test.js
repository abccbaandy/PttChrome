// 游標所在列標示的 pref schema 契約（2026-08 加入「整列提亮」樣式）。
//
// 分兩層：來源層（哪一列）與樣式層（畫什麼）。這裡鎖的是**預設值**與**為什麼底色
// 要開新 key**：readValuesWithDefault 是 { ...DEFAULT_PREFS, ...localStorage } 的
// 淺層合併，而 PrefModal 關閉時整包 writeValues ⇒ 任何開過一次設定頁的人
// localStorage 裡已經有 keyboardCursorHighlight 的舊值，把舊 key 的預設翻成 false
// 對他們完全無效。開一個新 key（cursorRowBackground）才是唯一能讓既有使用者也拿到
// 新預設的做法。本 repo 刻意沒有 pref 遷移機制，見 docs/mouse.md「舊 → 新 key 對照」。
import { DEFAULT_PREFS, readValuesWithDefault } from "../../src/js/pref_storage";

const PREF_KEY = "pttchrome.pref.v1";

beforeEach(() => window.localStorage.clear());

describe("DEFAULT_PREFS（樣式層）", () => {
  test("整列提亮預設開、整列底色預設關", () => {
    expect(DEFAULT_PREFS.cursorRowBrighten).toBe(true);
    expect(DEFAULT_PREFS.cursorRowBackground).toBe(false);
  });

  test("來源層三兄弟原樣保留（語意是「哪一列」，與樣式正交）", () => {
    expect(DEFAULT_PREFS.mouseBrowsingHighlight).toBe(true);
    expect(DEFAULT_PREFS.keyboardCursorHighlight).toBe(true);
    expect(DEFAULT_PREFS.mouseBrowsingHighlightColor).toBe(2);
  });
});

describe("localStorage 既有值", () => {
  test("開過設定頁的舊使用者（localStorage 有來源層舊值）照樣拿到新樣式預設", () => {
    window.localStorage.setItem(
      PREF_KEY,
      JSON.stringify({
        values: {
          keyboardCursorHighlight: true,
          mouseBrowsingHighlight: true,
          mouseBrowsingHighlightColor: 6,
        },
      }),
    );
    const v = readValuesWithDefault();
    expect(v.cursorRowBrighten).toBe(true);
    expect(v.cursorRowBackground).toBe(false);
    expect(v.mouseBrowsingHighlightColor).toBe(6); // 選過的顏色不會被吃掉
  });

  test("使用者關過提亮的話照樣尊重", () => {
    window.localStorage.setItem(
      PREF_KEY,
      JSON.stringify({ values: { cursorRowBrighten: false } }),
    );
    expect(readValuesWithDefault().cursorRowBrighten).toBe(false);
  });

  test("使用者開過底色的話照樣尊重", () => {
    window.localStorage.setItem(
      PREF_KEY,
      JSON.stringify({ values: { cursorRowBackground: true } }),
    );
    expect(readValuesWithDefault().cursorRowBackground).toBe(true);
  });
});
