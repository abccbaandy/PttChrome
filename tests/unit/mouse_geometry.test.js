// 左側提示帶與可點區的對齊。這是「帶子亮著卻點不到／點得到卻沒亮」的回歸鎖。
//
// 專案裡有兩套原點公式（clientToPos 與 convertMN2XYEx，後者多了 +10 與
// bbsViewMargin），差幾個到十幾個像素。帶子只能與 clientToPos 同源，所以兩邊
// 共用 mouse_geometry，這裡用「往返」把它釘死。
import {
  EXIT_COL_END,
  cellWidth,
  colFromClientX,
  exitBandRect,
  gridOriginX,
  isScaled,
} from "../../src/js/mouse_geometry";

// 三組真實幾何：未縮放（一般）／縮放（fontFitWindowWidth）／有 margin 的未縮放。
const GEOMS = {
  plain: {
    innerWidth: 1200,
    chw: 12,
    cols: 80,
    scaleX: 1,
    scaleY: 1,
    firstGridLeft: 120,
  },
  scaled: {
    innerWidth: 1000,
    chw: 12,
    cols: 80,
    scaleX: 1.04,
    scaleY: 1.04,
    firstGridLeft: 0,
  },
  offset: {
    innerWidth: 1600,
    chw: 9.6,
    cols: 80,
    scaleX: 1,
    scaleY: 1,
    firstGridLeft: "412.5",
  },
};

describe.each(Object.entries(GEOMS))("幾何 %s", (name, geom) => {
  test("帶子右緣正好是第 7 欄的邊界", () => {
    const rect = exitBandRect(geom);
    const right = rect.left + rect.width;
    expect(colFromClientX(right - 0.5, geom)).toBe(EXIT_COL_END - 1);
    expect(colFromClientX(right + 0.5, geom)).toBe(EXIT_COL_END);
  });

  test("帶子左緣正好是第 0 欄", () => {
    const rect = exitBandRect(geom);
    expect(colFromClientX(rect.left + 0.5, geom)).toBe(0);
  });

  test("帶子涵蓋且只涵蓋 EXIT_COL_END 欄", () => {
    const rect = exitBandRect(geom);
    expect(rect.width).toBeCloseTo(EXIT_COL_END * cellWidth(geom), 6);
  });
});

describe("原點分支與 clientToPos 一致", () => {
  test("未縮放用 DOM 量到的第一格左緣", () => {
    expect(isScaled(GEOMS.plain)).toBe(false);
    expect(gridOriginX(GEOMS.plain)).toBe(120);
  });

  test("firstGridLeft 是字串（parseFloat 的既有行為）照樣可用", () => {
    expect(gridOriginX(GEOMS.offset)).toBeCloseTo(412.5, 6);
  });

  test("縮放時原點改由視窗寬左右均分推得", () => {
    const g = GEOMS.scaled;
    expect(isScaled(g)).toBe(true);
    expect(gridOriginX(g)).toBeCloseTo(
      (g.innerWidth - g.chw * g.cols * g.scaleX) / 2,
      6,
    );
  });

  test("只有 scaleY ≠ 1 也算縮放（分支條件與 clientToPos 逐字相同）", () => {
    expect(isScaled({ scaleX: 1, scaleY: 1.02 })).toBe(true);
  });
});

describe("clamp 與退化輸入", () => {
  test("超出左右邊界一律夾進 [0, cols-1]", () => {
    expect(colFromClientX(-9999, GEOMS.plain)).toBe(0);
    expect(colFromClientX(999999, GEOMS.plain)).toBe(GEOMS.plain.cols - 1);
  });

  test("字寬還沒量到時不生出 NaN 幾何", () => {
    const g = { innerWidth: 0, chw: 0, cols: 80, scaleX: 1, scaleY: 1 };
    expect(colFromClientX(100, g)).toBe(0);
    expect(exitBandRect(g).width).toBe(0);
  });
});
