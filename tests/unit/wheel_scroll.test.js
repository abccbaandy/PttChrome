// 滾輪 delta → 像素（src/js/wheel_scroll.js）。
//
// 這支鎖的是「列表好讀模式滾輪平滑捲動」最容易靜默壞掉的換算：deltaMode。
// Firefox 的滑鼠滾輪送的是**列**（deltaY=3）不是像素，只看 deltaY 會幾乎不動。
import {
  wheelDeltaToPx,
  WHEEL_FALLBACK_LINE_PX,
} from "../../src/js/wheel_scroll";

const GEOM = { lineHeight: 20, pageLines: 20 };

describe("wheelDeltaToPx", () => {
  test("deltaMode 0（像素）原樣", () => {
    expect(wheelDeltaToPx({ deltaY: 100, deltaMode: 0 }, GEOM)).toBe(100);
    expect(wheelDeltaToPx({ deltaY: -100, deltaMode: 0 }, GEOM)).toBe(-100);
  });

  test("deltaMode 1（列）乘上列高 —— Firefox 滑鼠滾輪的一格是 3 列", () => {
    expect(wheelDeltaToPx({ deltaY: 3, deltaMode: 1 }, GEOM)).toBe(60);
  });

  test("deltaMode 2（頁）乘上一頁的高度", () => {
    expect(wheelDeltaToPx({ deltaY: 1, deltaMode: 2 }, GEOM)).toBe(400);
  });

  test("列高還沒量出來（0／NaN）時用保底值，不得回 Infinity/NaN", () => {
    expect(wheelDeltaToPx({ deltaY: 3, deltaMode: 1 }, { lineHeight: 0 })).toBe(
      3 * WHEEL_FALLBACK_LINE_PX,
    );
    expect(Number.isFinite(wheelDeltaToPx({ deltaY: 3, deltaMode: 1 }, {}))).toBe(
      true,
    );
  });

  test("舊式 mousewheel 事件（只有 wheelDelta，正負相反）也認得", () => {
    expect(wheelDeltaToPx({ wheelDelta: 120 }, GEOM)).toBe(-120);
  });

  test("沒有可用 delta 就是 0", () => {
    expect(wheelDeltaToPx({}, GEOM)).toBe(0);
    expect(wheelDeltaToPx({ deltaY: 0, deltaMode: 0 }, GEOM)).toBe(0);
  });
});
