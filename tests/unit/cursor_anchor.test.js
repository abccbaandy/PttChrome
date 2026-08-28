import { cursorOffsets } from "../../src/js/cursor_anchor";

// #cursor 的位置決策。核心不變量：**有真實列節點就以它為錨**，不要相信 cur_y*chh。
// 症狀端見 tests/e2e/offline/cursor_shape.offline.spec.js（推文反白帶）。
const BASE = { cur_x: 10, cur_y: 5, cols: 80, rows: 24, chw: 12, chh: 24 };

describe("cursorOffsets", () => {
  it("有列節點時垂直錨在它的 offsetTop，不是 cur_y*chh", () => {
    // 這一列被前面某列撐高了 7px（標註／字型／padding 都可能造成）
    const g = cursorOffsets({ ...BASE, row: { offsetTop: 5 * 24 + 7, offsetLeft: 0 } });
    expect(g.visible).toBe(true);
    expect(g.anchored).toBe(true);
    expect(g.top).toBe(127);
    expect(g.top).not.toBe(BASE.cur_y * BASE.chh);
  });

  it("水平以列節點左緣為基準加上欄位偏移", () => {
    const g = cursorOffsets({ ...BASE, row: { offsetTop: 120, offsetLeft: 4 } });
    expect(g.left).toBe(4 + 10 * 12);
  });

  it("量不到列節點就退回舊算術（不是變成 0）", () => {
    const g = cursorOffsets({ ...BASE, row: null });
    expect(g.visible).toBe(true);
    expect(g.anchored).toBe(false);
    expect(g.top).toBe(5 * 24);
    expect(g.left).toBe(10 * 12);
  });

  it("列節點的 offset 不是有限數也退回算術（防呆）", () => {
    const g = cursorOffsets({ ...BASE, row: { offsetTop: NaN, offsetLeft: 0 } });
    expect(g.anchored).toBe(false);
    expect(g.top).toBe(5 * 24);
  });

  // PTT 偶爾把 cur_x 送成 cols。舊版在這裡 early-return ⇒ 游標仍然可見卻停在
  // 上一次的座標；必須改成「藏起來」。
  it("cur_x 超界 → 不可見", () => {
    expect(cursorOffsets({ ...BASE, cur_x: 80, row: null }).visible).toBe(false);
  });

  it("cur_y 超界 → 不可見", () => {
    expect(cursorOffsets({ ...BASE, cur_y: 24, row: null }).visible).toBe(false);
  });

  it("負座標／格線尺寸缺失 → 不可見（不丟例外）", () => {
    expect(cursorOffsets({ ...BASE, cur_x: -1, row: null }).visible).toBe(false);
    expect(cursorOffsets({ ...BASE, cols: 0, row: null }).visible).toBe(false);
    expect(cursorOffsets({ ...BASE, rows: undefined, row: null }).visible).toBe(false);
  });
});
