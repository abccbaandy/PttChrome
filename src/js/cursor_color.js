// 打字用的閃爍底線游標（#cursor）要用什麼顏色。
//
// 游標色是 inline style（term_view.updateCursorPos），原生模式沿用 fork 來的做法：
// 取「當前字元 ANSI 背景色的反色」termInvColors[bg]，所以游標永遠壓得過它踩著的那格。
// 但上班模式（enableWorkMode）是純 CSS 覆寫 .b*（color.css 的 .work-mode-active
// 生成區塊），碰不到 inline style —— 反色算的是原生背景、畫出來的卻是灰階背景，
// 兩者一脫鉤最慘的就是 PTT 的反白輸入列（b7/b15：推文列、標題列、搜尋列）：
// #3F3F3F 的游標畫在 #374151 上，對比 ≈1.0，等於隱形。
//
// 因此上班模式改成「與 bg 無關的固定淺灰」：work mode 的背景只有三種灰（見
// workModeBgColor），一個淺灰即可對三者都達 WCAG AA（≥4.5:1），且本身仍是灰階、
// 不破壞偽裝。守護：tests/unit/cursor_color.test.js。
import { termInvColors } from './term_buf';

export const WORK_MODE_CURSOR_COLOR = '#e5e7eb';

// color.css `.work-mode-active .b*` 的鏡像：b7/b15（反白）較亮，其餘彩色底一律
// #1f2937，b0 沒被覆寫 → 維持 transparent，看到的是 body 的黑底。
// **改一邊必須改另一邊**，否則對比保證是對不存在的背景做的。
export function workModeBgColor(bg) {
  if (bg === 0) return '#000000';
  if (bg === 7 || bg === 15) return '#374151';
  return '#1f2937';
}

export function cursorColorForBg(bg, workMode) {
  if (workMode) return WORK_MODE_CURSOR_COLOR;
  return termInvColors[bg] || '#FFFFFF';
}
