// 手機模式 —— 純函式，零 DOM、零狀態。DOM 端（matchMedia 監聽、#t 的 inputmode）
// 在 pttchrome.jsx 的 App.applyMobileLayout。設計見 docs/mobile.md。
//
// **手機模式是 runtime 覆寫，絕不寫回 prefs**：prefs 會經 pref_sync 同步到使用者的
// 其他裝置。手機上把某個顯示設定「修正」後存回去，桌機下次開站就會吃到手機的值
// （反方向就是手機被桌機的 fixed-font-size 20px 切掉右半邊的成因）。

import { TERM_COLS, calcTermSize } from './term_size';

// pref `mobileLayout` 的值域。auto ＝依裝置判斷；on/off ＝使用者強制（誤判逃生門，
// 也讓桌機可以直接看手機版面）。
export const MOBILE_LAYOUT_MODES = ['auto', 'on', 'off'];

// 「手機」的判準：主要指標是手指（pointer: coarse）且不能 hover（hover: none）。
// 兩者 AND —— 平板接了觸控筆／觸控筆電的 primary pointer 仍是 fine，不該被當手機。
// 短邊上限是第二道保險：大尺寸平板（短邊 ≥ 800 CSS px）能完整顯示 80 欄，
// 桌機版面在上面本來就可用。
export const MOBILE_MAX_SHORT_SIDE = 800;

export function isMobileEnv({ mode, coarse, hoverNone, width, height }) {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  const shortSide = Math.min(Number(width) || 0, Number(height) || 0);
  return !!coarse && !!hoverNone && shortSide > 0 && shortSide < MOBILE_MAX_SHORT_SIDE;
}

// 虛擬按鍵列的按鍵。`key` 是 KeyboardEvent.key 的名稱，交給
// term_view.sendKeyAsUser —— 那條路走完整的 onKeyDown 分派（文章好讀／列表好讀／
// 原生三種語意各自處理），**不可**改成直接送 byte。每個 key 都必須在
// term_keyboard.KeyMap 裡（守護 tests/unit/mobile_layout.test.js）。
// 兩列排版，方向鍵排成倒 T（↑ 在 ↓ 正上方）。
export const MOBILE_KEYPAD_ROWS = [
  [
    { key: 'PageUp', label: 'PgUp', aria: 'Page Up' },
    { key: 'Home', label: 'Home', aria: 'Home' },
    { key: 'ArrowUp', label: '↑', aria: 'Up' },
    { key: 'End', label: 'End', aria: 'End' },
    { key: 'Backspace', label: '⌫', aria: 'Backspace' }
  ],
  [
    { key: 'PageDown', label: 'PgDn', aria: 'Page Down' },
    { key: 'ArrowLeft', label: '←', aria: 'Left' },
    { key: 'ArrowDown', label: '↓', aria: 'Down' },
    { key: 'ArrowRight', label: '→', aria: 'Right' },
    { key: 'Enter', label: 'Enter', aria: 'Enter' }
  ]
];

// #t 的 inputmode。手機上預設 'none'：焦點照舊停在 #t（既有十幾個 setInputAreaFocus
// 呼叫點、實體鍵盤全部不動），但瀏覽器不會因為 focus 就叫出軟鍵盤 —— 否則每一次
// tap（合成 mousedown/up/click）都同時是「滑鼠瀏覽點擊」＋「叫鍵盤」。
// 軟鍵盤只由按鍵列的鍵盤鈕明確叫出。非手機回 null ＝移除屬性（桌機零改動）。
export function inputModeFor({ mobile, softKeyboard }) {
  if (!mobile) return null;
  return softKeyboard ? 'text' : 'none';
}

// ---- Phase 2：版面幾何 ------------------------------------------------------

// 決定列數用的字級（px）。列數＝視窗高 / 這個字級，與目前畫的是哪種畫面無關 ——
// 畫面切換（Phase 3 起文章換行、Phase 4 列表卡片會用這個字級畫）時列數不變，
// 就不會重送 NAWS。
export const MOBILE_ROW_FONT_PX = 16;

// 手機模式的終端機幾何。**無視 termSizeMode**（那組 pref 會跨裝置同步，桌機的
// fixed-font-size 20px ＝ 800px 寬，手機必定被切）。
//   rows：calcTermSize（欄數恆 80、列數夾在 24..100，見 term_size.js 的 LOCKED）
//   chh ：「80 欄塞滿寬」與「rows 列塞滿高」取小，再對齊裝置像素（fixedResize 同規則，
//         再做一次是冪等的）。刻意**不用** transform scale：縮小時 layout box 比視窗
//         寬，align=center 置中失效、mouse_geometry 的縮放分支前提（box 置中）不成立。
//   -10：.main 的寬高都多 10px（term_view.setTermFontSize：chw*cols+10、chh*rows+10）。
export function mobileTermGeometry({ width, height, dpr }) {
  const rows = calcTermSize({ height: height, fontSizePx: MOBILE_ROW_FONT_PX }).rows;
  const byWidth = (2 * (width - 10)) / TERM_COLS;
  const byHeight = (height - 10) / rows;
  const raw = Math.max(0, Math.min(byWidth, byHeight));
  const d = dpr > 0 ? dpr : 1;
  return { cols: TERM_COLS, rows: rows, chh: Math.floor(raw * d) / d };
}

// 軟鍵盤蓋住 layout viewport 底部的高度（px）。Android Chrome 預設
// interactive-widget=resizes-visual：鍵盤只縮 visualViewport，layout 高度不變
// （所以列數不會因為叫鍵盤而變）。
//   - 只在使用者用鍵盤鈕叫出鍵盤時算：雙指縮放也會讓 visualViewport 變小，
//     另外以 scale ≠ 1 排除。
//   - 小於 KEYBOARD_MIN_PX 視為雜訊（網址列伸縮之類），不是鍵盤。
export const KEYBOARD_MIN_PX = 80;

export function keyboardInset({ mobile, softKeyboard, layoutHeight, vvHeight, vvOffsetTop, vvScale }) {
  if (!mobile || !softKeyboard) return 0;
  if (Math.abs((Number(vvScale) || 1) - 1) > 0.01) return 0;
  const hidden = (Number(layoutHeight) || 0) - ((Number(vvOffsetTop) || 0) + (Number(vvHeight) || 0));
  return hidden >= KEYBOARD_MIN_PX ? Math.round(hidden) : 0;
}
