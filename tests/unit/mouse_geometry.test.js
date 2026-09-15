// 左側提示帶與可點區的對齊。這是「帶子亮著卻點不到／點得到卻沒亮」的回歸鎖。
//
// 專案裡有兩套原點公式（clientToPos 與 convertMN2XYEx，後者多了 +10 與
// bbsViewMargin），差幾個到十幾個像素。帶子只能與 clientToPos 同源，所以兩邊
// 共用 mouse_geometry，這裡用「往返」把它釘死。
import {
  EXIT_COL_END,
  cellWidth,
  colFromClientX,
  edgeBandRect,
  exitBandRect,
  gridOriginX,
  gridOriginY,
  isScaled,
  rowFromClientY,
  rowHeight,
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
    innerHeight: 800,
    chh: 24,
    rows: 24,
    firstGridTop: 40,
  },
  scaled: {
    innerWidth: 1000,
    chw: 12,
    cols: 80,
    scaleX: 1.04,
    scaleY: 1.04,
    firstGridLeft: 0,
    innerHeight: 700,
    chh: 24,
    rows: 24,
    firstGridTop: 0,
  },
  offset: {
    innerWidth: 1600,
    chw: 9.6,
    cols: 80,
    scaleX: 1,
    scaleY: 1,
    firstGridLeft: "412.5",
    innerHeight: 1000,
    chh: 19.2,
    rows: 24,
    firstGridTop: "27.5",
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

// ── 邊緣翻頁提示帶（#edgeHintBand）─────────────────────────────────────────────
//
// 同一條「帶子亮＝點得下去」的合約，只是這條帶子四邊都算得出來。矩形由
// mouse_regions 的 hintBand 給（格子空間），這裡只鎖換算與 clientToPos 的往返。
describe.each(Object.entries(GEOMS))("邊緣帶幾何 %s", (name, geom) => {
  test("右緣帶：左緣的前一格不在帶內、帶內第一格就是 colStart", () => {
    const band = { colStart: 64, colEnd: 80, rowStart: 3, rowEnd: 13 };
    const rect = edgeBandRect(band, geom);
    expect(colFromClientX(rect.left + 0.5, geom)).toBe(64);
    expect(colFromClientX(rect.left - 0.5, geom)).toBe(63);
    expect(rect.width).toBeCloseTo(16 * cellWidth(geom), 6);
  });

  test("上下邊界逐列對齊 rowFromClientY", () => {
    const band = { colStart: 0, colEnd: 80, rowStart: 13, rowEnd: 23 };
    const rect = edgeBandRect(band, geom);
    expect(rowFromClientY(rect.top + 0.5, geom)).toBe(13);
    expect(rowFromClientY(rect.top - 0.5, geom)).toBe(12);
    expect(rowFromClientY(rect.top + rect.height - 0.5, geom)).toBe(22);
    expect(rect.height).toBeCloseTo(10 * rowHeight(geom), 6);
  });

  test("頂列與底列各只有一列高", () => {
    const top = edgeBandRect({ colStart: 0, colEnd: 80, rowStart: 0, rowEnd: 1 }, geom);
    expect(rowFromClientY(top.top + 0.5, geom)).toBe(0);
    expect(top.height).toBeCloseTo(rowHeight(geom), 6);
    const bottom = edgeBandRect(
      { colStart: 0, colEnd: 80, rowStart: 23, rowEnd: 24 },
      geom,
    );
    expect(rowFromClientY(bottom.top + 0.5, geom)).toBe(23);
  });
});

describe("垂直原點與 clamp", () => {
  test("未縮放用 DOM 量到的第一格上緣（字串也吃）", () => {
    expect(gridOriginY(GEOMS.plain)).toBe(40);
    expect(gridOriginY(GEOMS.offset)).toBeCloseTo(27.5, 6);
  });

  test("縮放時原點改由視窗高上下均分推得（與 clientToPos 逐字相同）", () => {
    const g = GEOMS.scaled;
    expect(gridOriginY(g)).toBeCloseTo(
      (g.innerHeight - g.chh * g.rows * g.scaleY) / 2,
      6,
    );
  });

  test("超出上下邊界一律夾進 [0, rows-1]", () => {
    expect(rowFromClientY(-9999, GEOMS.plain)).toBe(0);
    expect(rowFromClientY(999999, GEOMS.plain)).toBe(23);
  });

  test("字高還沒量到時不生出 NaN 幾何", () => {
    const g = { innerHeight: 0, chh: 0, rows: 24, scaleX: 1, scaleY: 1 };
    expect(rowFromClientY(100, g)).toBe(0);
    expect(edgeBandRect({ colStart: 0, colEnd: 80, rowStart: 0, rowEnd: 1 }, g)).toBe(
      null,
    );
  });

  test("沒有 band 就沒有矩形（收掉帶子的那一條路）", () => {
    expect(edgeBandRect(null, GEOMS.plain)).toBe(null);
  });
});
