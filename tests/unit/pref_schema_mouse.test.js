// 滑鼠 pref 的 schema 契約（2026-08 重新設計）。
//
// 重點是「舊 key 的殘值不可以復活」：readValuesWithDefault 是
// { ...DEFAULT_PREFS, ...localStorage } 的淺層合併，localStorage 與 Firestore 上
// 仍留著改版前的 mouseLeftFunction / mouseWheelFunction1..3。它們不該有任何讀取
// 點，也不該讓新 key 拿不到預設值。
import { DEFAULT_PREFS, readValuesWithDefault } from "../../src/js/pref_storage";

const PREF_KEY = "pttchrome.pref.v1";

const LEGACY_KEYS = [
  "mouseLeftFunction",
  "mouseMiddleFunction",
  "mouseWheelFunction1",
  "mouseWheelFunction2",
  "mouseWheelFunction3",
];

beforeEach(() => window.localStorage.clear());

describe("DEFAULT_PREFS", () => {
  test("新 key 齊備且值域正確", () => {
    // 總開關現在也管中鍵與滾輪 ⇒ 必須預設開，否則滾輪翻頁這種本來就會動的功能
    // 會在升級後憑空消失。
    expect(DEFAULT_PREFS.useMouseBrowsing).toBe(true);
    expect(DEFAULT_PREFS.mouseLeftClick).toBe(true);
    // 防誤觸模式（可點區＝底色區的欄位限制）預設開：它就是「點日期／作者欄不會
    // 誤開文章」與「文章左側點得到退出帶」這兩件事的來源。
    expect(DEFAULT_PREFS.mouseMisclickGuard).toBe(true);
    // 功能鍵可點預設開：`[d]刪除`／`(y)回應` 這類提示變按鈕（js/footer_keys.js）。
    expect(DEFAULT_PREFS.mouseFunctionKeys).toBe(true);
    expect(DEFAULT_PREFS.mouseMiddleClick).toBe(0); // 0=關閉 1=貼上 2=左方向鍵
    expect(DEFAULT_PREFS.mouseWheel).toBe(1); // 0=關閉 1=上下頁
    // 逐行捲動是**新 key**，所以既有使用者（localStorage 已存 mouseWheel:1）
    // 也吃得到這個預設 —— 淺層合併只補得到缺少的 key。
    expect(DEFAULT_PREFS.mouseWheelSmoothScroll).toBe(true);
  });

  test("底色三兄弟原樣保留（key 刻意不改名，避免兩邊寫遷移）", () => {
    expect(DEFAULT_PREFS.mouseBrowsingHighlight).toBe(true);
    expect(DEFAULT_PREFS.keyboardCursorHighlight).toBe(true);
    expect(DEFAULT_PREFS.mouseBrowsingHighlightColor).toBe(2);
  });

  test("五個舊 key 已從 schema 移除", () => {
    LEGACY_KEYS.forEach((key) =>
      expect(Object.prototype.hasOwnProperty.call(DEFAULT_PREFS, key)).toBe(false),
    );
  });
});

describe("既有使用者的 localStorage 殘值", () => {
  test("帶著舊 key 的持久化資料，新 key 仍拿到預設值", () => {
    window.localStorage.setItem(
      PREF_KEY,
      JSON.stringify({
        values: {
          mouseLeftFunction: 2,
          mouseMiddleFunction: 1, // 舊值域的 1 是 Enter，與新的「貼上」不同語意
          mouseWheelFunction1: 1,
          mouseWheelFunction2: 2,
          mouseWheelFunction3: 3,
        },
      }),
    );
    const v = readValuesWithDefault();
    expect(v.mouseLeftClick).toBe(true);
    expect(v.mouseMisclickGuard).toBe(true);
    expect(v.mouseFunctionKeys).toBe(true);
    expect(v.mouseMiddleClick).toBe(0);
    expect(v.mouseWheel).toBe(1);
    expect(v.useMouseBrowsing).toBe(true);
  });

  test("使用者關過防誤觸的話照樣尊重", () => {
    window.localStorage.setItem(
      PREF_KEY,
      JSON.stringify({ values: { mouseMisclickGuard: false } }),
    );
    expect(readValuesWithDefault().mouseMisclickGuard).toBe(false);
  });

  test("使用者關過功能鍵可點的話照樣尊重", () => {
    window.localStorage.setItem(
      PREF_KEY,
      JSON.stringify({ values: { mouseFunctionKeys: false } }),
    );
    expect(readValuesWithDefault().mouseFunctionKeys).toBe(false);
  });

  test("使用者自己關過總開關的話照樣尊重", () => {
    window.localStorage.setItem(
      PREF_KEY,
      JSON.stringify({ values: { useMouseBrowsing: false } }),
    );
    expect(readValuesWithDefault().useMouseBrowsing).toBe(false);
  });
});
