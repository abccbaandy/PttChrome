// 終端機尺寸與版面位移的純函式（src/js/term_size.js）。
//
// 兩條規則是這支測試的重點，兩條都是「一行就能被順手改掉、改掉之後靜默壞掉」：
//   1. 欄數恆 80（改成依視窗寬反推 ⇒ 列表欄位解析要重新驗證，右側整片留白）
//   2. 這裡**不算**水平位移（水平置中由 #BBSWindow 的 align="center" 提供，
//      在這裡再加一次就是雙重置中）
import {
  TERM_COLS,
  MIN_ROWS,
  MAX_ROWS,
  calcTermSize,
  termLayoutOffsets,
} from "../../src/js/term_size";

describe("calcTermSize（固定字體大小模式的尺寸來源）", () => {
  test("欄數恆 80，與視窗寬無關", () => {
    expect(TERM_COLS).toBe(80);
    for (const height of [600, 1200]) {
      expect(calcTermSize({ height, fontSizePx: 20 }).cols).toBe(80);
      expect(calcTermSize({ height, fontSizePx: 12 }).cols).toBe(80);
    }
  });

  test("列數 = floor(視窗高 / 字級)", () => {
    expect(calcTermSize({ height: 900, fontSizePx: 20 }).rows).toBe(45);
    expect(calcTermSize({ height: 905, fontSizePx: 20 }).rows).toBe(45);
  });

  test("字級無條件進位到偶數（半形格寬是 chh/2，奇數會帶 .5px）", () => {
    // 15 → 16 ⇒ floor(960/16) = 60，而不是 floor(960/15) = 64
    expect(calcTermSize({ height: 960, fontSizePx: 15 }).rows).toBe(60);
    expect(calcTermSize({ height: 960, fontSizePx: 16 }).rows).toBe(60);
  });

  test("列數夾在 [24, 100]（照抄 server 端 mbbsd/term.c:55 的 clamp）", () => {
    expect(MIN_ROWS).toBe(24);
    expect(MAX_ROWS).toBe(100);
    // 矮視窗：算出來只有 10 列也要送 24（server 不接受更小的）
    expect(calcTermSize({ height: 200, fontSizePx: 20 }).rows).toBe(24);
    // 極高視窗：封頂 100
    expect(calcTermSize({ height: 8000, fontSizePx: 20 }).rows).toBe(100);
  });

  test("預設字級 20 在一般視窗高度下必定 > 24 列（本次 bug 的前提）", () => {
    // 可視高 > 480px 就超過 24 列 ⇒ 舊碼 `rows === 24` 的門檻必定落空。
    expect(calcTermSize({ height: 700, fontSizePx: 20 }).rows).toBeGreaterThan(24);
  });
});

describe("termLayoutOffsets（.main 的垂直位移）", () => {
  const base = { chh: 24, rows: 24 }; // 內容高 576

  test("內容比視窗矮 → 垂直置中", () => {
    expect(termLayoutOffsets({ ...base, innerHeight: 1000 }).marginTop).toBe(212);
  });

  test("內容塞滿或超出視窗 → 只留 margin，不算負的位移", () => {
    expect(termLayoutOffsets({ ...base, innerHeight: 576 }).marginTop).toBe(0);
    expect(termLayoutOffsets({ ...base, innerHeight: 400 }).marginTop).toBe(0);
  });

  test("bbsMargin 疊加在垂直位移上", () => {
    expect(termLayoutOffsets({ ...base, innerHeight: 1000, margin: 8 }).marginTop).toBe(220);
    expect(termLayoutOffsets({ ...base, innerHeight: 400, margin: 8 }).marginTop).toBe(8);
  });

  // 手機軟鍵盤（docs/mobile.md Phase 2）：Android 叫鍵盤只縮 visualViewport，
  // layout 高度不變 ⇒ 不處理的話，PTT 底列的輸入列就在鍵盤底下。
  test("bottomInset：在沒被鍵盤蓋住的區域裡置中", () => {
    // 可視 1000-300=700，內容 576 ⇒ (700-576)/2
    expect(termLayoutOffsets({ ...base, innerHeight: 1000, bottomInset: 300 }).marginTop).toBe(62);
  });

  test("bottomInset：放不下時底對齊可視區（輸入列在底列），頂端被推出畫面", () => {
    // 可視 800-300=500 < 576 ⇒ 底部貼齊 500 ⇒ marginTop = 500-576
    expect(termLayoutOffsets({ ...base, innerHeight: 800, bottomInset: 300 }).marginTop).toBe(-76);
  });

  test("bottomInset 0／未給：行為與以前完全相同（桌機零改動）", () => {
    expect(termLayoutOffsets({ ...base, innerHeight: 400, bottomInset: 0 }).marginTop).toBe(0);
    expect(termLayoutOffsets({ ...base, innerHeight: 1000 }).marginTop).toBe(212);
  });

  // 手機頂部 App Bar：可視區從它下面算起，三個分支都以它為原點。
  test("topInset：置中在 App Bar 與底部 inset 之間", () => {
    // avail = 1000 - 48 - 48 = 904；(904 - 576)/2 = 164；+48
    expect(termLayoutOffsets({ ...base, innerHeight: 1000, topInset: 48, bottomInset: 48 }).marginTop).toBe(212);
  });

  test("topInset：放不下＋有底部 inset ⇒ 底對齊（頂端被推到 App Bar 底下）", () => {
    // avail = 600 - 48 - 48 = 504；48 + 504 - 576 = -24
    expect(termLayoutOffsets({ ...base, innerHeight: 600, topInset: 48, bottomInset: 48 }).marginTop).toBe(-24);
  });

  test("topInset：放不下且沒有底部 inset ⇒ 貼在 App Bar 下面", () => {
    expect(termLayoutOffsets({ ...base, innerHeight: 400, topInset: 48, margin: 8 }).marginTop).toBe(56);
  });

  test("topInset 0／未給：與以前完全相同（桌機零改動）", () => {
    for (const h of [400, 576, 800, 1000])
      for (const b of [0, 48, 300])
        expect(termLayoutOffsets({ ...base, innerHeight: h, bottomInset: b, topInset: 0 })).toEqual(
          termLayoutOffsets({ ...base, innerHeight: h, bottomInset: b })
        );
  });

  test("LOCKED：不回傳任何水平位移（置中是 BBSWin 的 align=center 在做）", () => {
    const o = termLayoutOffsets({ ...base, innerHeight: 1000 });
    expect(o.marginLeft).toBeUndefined();
    expect(Object.keys(o)).toEqual(["marginTop"]);
  });
});
