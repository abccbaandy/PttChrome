// 「點了畫面上的功能鍵按鈕」對好讀狀態機的決策（App.onFunctionKey 的純函式部分）。
//
// 兩件必須鎖住的事：
//  1. 文章好讀模式下，送 byte **之前**要先進 functionMode（原生鏡像）。PTT 會開
//     prompt（(y)回應 / (X)推文 / (h)說明），但好讀的累積長頁原封不動 ⇒ 使用者
//     看不到輸入框。docs/easy-reading.md 的「貼上驅動」「IME 驅動」補過同一個洞
//     兩次，滑鼠點功能鍵是第三個入口。
//  2. `←` 走與鍵盤 ArrowLeft 完全同一條路（stopEasyReading），離開文章時才不會
//     先閃一下原生 24 列。
import {
  functionKeyClickPlan,
  LEFT_ARROW,
} from "../../src/js/function_key_plan";

describe("原生模式（非文章好讀）", () => {
  test("什麼都不做，直接送", () => {
    const p = functionKeyClickPlan({ bytes: "d", mode: "native" });
    expect(p).toEqual({
      enterFunctionMode: false,
      stopEasyReading: false,
      send: true,
    });
  });

  test("← 也只是直接送（原生本來就沒有累積長頁要收）", () => {
    const p = functionKeyClickPlan({ bytes: LEFT_ARROW, mode: "native" });
    expect(p.stopEasyReading).toBe(false);
    expect(p.enterFunctionMode).toBe(false);
    expect(p.send).toBe(true);
  });

  test("mode 缺值當原生處理（方向安全：至少鍵送得出去）", () => {
    expect(functionKeyClickPlan({ bytes: "y" }).send).toBe(true);
  });
});

describe("文章好讀模式", () => {
  const plan = (bytes) => functionKeyClickPlan({ bytes, mode: "article-easy" });

  test("REGRESSION：(y)回應 / (X)推文 / (h)說明 一律先進 functionMode 再送", () => {
    ["y", "X", "h", "\x18"].forEach((b) => {
      const p = plan(b);
      expect(p.enterFunctionMode).toBe(true);
      expect(p.send).toBe(true);
      expect(p.stopEasyReading).toBe(false);
    });
  });

  test("← 走 stopEasyReading，**不**進 functionMode（不然會白閃一下原生畫面）", () => {
    const p = plan(LEFT_ARROW);
    expect(p.stopEasyReading).toBe(true);
    expect(p.enterFunctionMode).toBe(false);
    expect(p.send).toBe(true);
  });

  test("LEFT_ARROW 與 term_keyboard 的 ArrowLeft 是同一個序列", () => {
    expect(LEFT_ARROW).toBe("\x1b[D");
  });
});

test("沒有 bytes 就什麼都不做（不可以誤送空鍵）", () => {
  [null, undefined, ""].forEach((b) => {
    const p = functionKeyClickPlan({ bytes: b, mode: "article-easy" });
    expect(p.send).toBe(false);
    expect(p.enterFunctionMode).toBe(false);
    expect(p.stopEasyReading).toBe(false);
  });
  expect(functionKeyClickPlan().send).toBe(false);
});
