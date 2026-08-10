import { cursorColorForBg, workModeBgColor, WORK_MODE_CURSOR_COLOR } from '../../src/js/cursor_color';
import { termInvColors } from '../../src/js/term_buf';

// 打字用的閃爍底線游標（#cursor）顏色是 inline style，由 term_view.updateCursorPos
// 依「當前字元的 ANSI 背景 index」決定。上班模式只是 CSS 覆寫 .b*（color.css 的
// .work-mode-active 生成區塊），改不到 inline style —— 兩者一旦脫鉤，游標色算的是
// 原生背景的反色、實際卻畫在灰階背景上：b7/b15（PTT 反白輸入列，推文/標題/搜尋列
// 都是）原本 #3F3F3F / #000000 落在 #374151 上，對比 ≈1.0 → 游標等於隱形。
//
// 這裡鎖的是「游標與**實際渲染背景**的對比」這個症狀，而不是某個色碼字串。
const srgb = c => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

const luminance = hex => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb color: ${hex}`);
  const n = parseInt(m[1], 16);
  return 0.2126 * srgb((n >> 16) & 0xff) + 0.7152 * srgb((n >> 8) & 0xff) + 0.0722 * srgb(n & 0xff);
};

const contrast = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

describe('cursorColorForBg', () => {
  test('上班模式：16 種背景下游標對實際背景的對比都 ≥ 4.5（b7/b15 反白列曾經隱形）', () => {
    const tooLow = [];
    for (let bg = 0; bg < 16; ++bg) {
      const ratio = contrast(cursorColorForBg(bg, true), workModeBgColor(bg));
      if (ratio < 4.5) tooLow.push(`b${bg}=${ratio.toFixed(2)}`);
    }
    expect(tooLow).toEqual([]);
  });

  test('上班模式：游標仍是灰階（不因為要顯眼就跳出偽裝色）', () => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(WORK_MODE_CURSOR_COLOR);
    expect(m).not.toBeNull();
    const [r, g, b] = m.slice(1).map(h => parseInt(h, 16));
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(16);
  });

  test('原生模式：逐項維持既有反色表（不回歸）', () => {
    for (let bg = 0; bg < 16; ++bg) {
      expect(cursorColorForBg(bg, false)).toBe(termInvColors[bg]);
    }
  });

  test('bg 越界／非法時回退成看得見的白色，不吐 undefined', () => {
    expect(cursorColorForBg(99, false)).toBe('#FFFFFF');
    expect(cursorColorForBg(-1, false)).toBe('#FFFFFF');
    expect(cursorColorForBg(undefined, false)).toBe('#FFFFFF');
    expect(cursorColorForBg(99, true)).toBe(WORK_MODE_CURSOR_COLOR);
  });
});

describe('workModeBgColor', () => {
  // 這張表是 color.css .work-mode-active .b* 的鏡像；改一邊必須改另一邊，
  // 否則上面的對比斷言就是在對不存在的背景做保證。
  test('b7/b15 是較亮的 #374151，其餘彩色底統一 #1f2937，b0 沿用 body 黑底', () => {
    expect(workModeBgColor(0)).toBe('#000000');
    expect(workModeBgColor(7)).toBe('#374151');
    expect(workModeBgColor(15)).toBe('#374151');
    for (const bg of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14]) {
      expect(workModeBgColor(bg)).toBe('#1f2937');
    }
  });
});
