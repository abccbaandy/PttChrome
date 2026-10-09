// 手機模式 —— 純函式，零 DOM、零狀態。DOM 端（matchMedia 監聽、#t 的 inputmode）
// 在 pttchrome.jsx 的 App.applyMobileLayout。設計見 docs/mobile.md。
//
// **手機模式是 runtime 覆寫，絕不寫回 prefs**：prefs 會經 pref_sync 同步到使用者的
// 其他裝置。手機上把某個顯示設定「修正」後存回去，桌機下次開站就會吃到手機的值
// （反方向就是手機被桌機的 fixed-font-size 20px 切掉右半邊的成因）。

import { TERM_COLS, calcTermSize, termLayoutOffsets } from './term_size';

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

// 第三列：手機軟鍵盤打不出來的鍵（Gboard／三星鍵盤都沒有 Esc、Tab、Delete，也沒有
// Ctrl）。Ctrl 不是一個鍵而是「下一個按鍵加上 Ctrl」的黏滯開關，元件自己畫
// （key '__ctrl'），其餘同樣必須在 KeyMap 裡。
export const MOBILE_KEYPAD_EXTRA_ROW = [
  { key: 'Escape', label: 'Esc', aria: 'Escape' },
  { key: 'Tab', label: 'Tab', aria: 'Tab' },
  { key: 'Delete', label: 'Del', aria: 'Delete' }
];

//   X     推文鍵 —— 單一字元，同樣走 sendKeyAsUser（term_view 對單字元補 keypress）；
//         預設 pref pushKeyOpensLongPush 下會開長推文輸入框，跟實體鍵盤按 X 一樣。
//         2026-10 起由底部工具列的「推」送出（MobileToolbar）。
export const MOBILE_KEYPAD_PUSH_KEY = 'X';

// 底部工具列的高度（px）。**常駐**，所以直接從終端機可用高度扣掉
// （App.getWindowInnerBounds）⇒ 列數穩定，只在進出手機模式時重算一次。
// 必須與 MobileToolbar.css 的 .mobileToolbarBar height 一致（守護
// tests/unit/mobile_toolbar.test.jsx）。
export const MOBILE_TOOLBAR_PX = 48;

// 頂部 App Bar（components/MobileAppBar）的高度（px）。同樣**常駐**（手機模式下每個畫面
// 都有）⇒ 列數從兩條 bar 中間的高度算，畫面切換不重送 NAWS。必須與 MobileAppBar.css 的
// .mobileAppBar height 一致（守護 tests/unit/mobile_app_bar.test.jsx）。
export const MOBILE_APPBAR_PX = 48;

// 手機模式下終端機可用的高度（決定列數）：視窗高扣掉兩條常駐 bar。軟鍵盤／按鍵面板
// 是暫態，不在這裡扣（它們只改位置，見 term_size.termLayoutOffsets 的 inset）。
// safe：瀏海／手勢列的 safe-area（viewport-fit=cover 時 env(safe-area-inset-*)，
// App._readSafeInsets 量），兩條 bar 各自往內讓，同樣常駐 ⇒ 一起扣。
export function mobileRowsHeight(innerHeight, safe) {
  const s = safe || {};
  return Math.max(
    0,
    (Number(innerHeight) || 0) - MOBILE_APPBAR_PX - MOBILE_TOOLBAR_PX -
      (Number(s.top) || 0) - (Number(s.bottom) || 0)
  );
}

// 終端機的上／下 inset（px）與底部 safe-area 的實際值。
//   top    ＝ App Bar ＋ 上緣 safe-area
//   bottom ＝ 軟鍵盤 ＋ 工具列 ＋ 展開中的按鍵面板 ＋ 下緣 safe-area
//   safeBottom：軟鍵盤升起時手勢列被鍵盤蓋住 ⇒ 0（不然工具列下面多一截空白）。
// 呼叫端：App._onVisualViewport（寫 view 的 inset 與 CSS 變數 --safe-top/--safe-bottom）。
export function mobileChromeInsets({ kb, keysPanel, safeTop, safeBottom }) {
  const k = kb > 0 ? kb : 0;
  const sb = k > 0 ? 0 : Math.max(0, Number(safeBottom) || 0);
  const st = Math.max(0, Number(safeTop) || 0);
  return {
    top: MOBILE_APPBAR_PX + st,
    bottom: k + MOBILE_TOOLBAR_PX + (keysPanel > 0 ? keysPanel : 0) + sb,
    safeTop: st,
    safeBottom: sb
  };
}

// 黏滯 Ctrl：按了 Ctrl 之後的下一個字元 → 要合成的按鍵（交給 term_view.sendKeyAsUser）。
//   - 字母走 **Alt remap**（term_keyboard.isAltRemapEvent：Alt+字母 ＝ PTT 的 Ctrl，
//     byte 逐位元相同）。不走 ctrlKey 是刻意的：term_view 會把 Ctrl+A／Ctrl+C 攔成
//     全選／複製、term_keyboard 會把 Ctrl+V 讓給瀏覽器貼上 ——那些是實體鍵盤的 UI 快捷
//     鍵，手機上按 Ctrl 再按 V 的人要的是 ^V。Alt 那條路正是「繞過 app 的 UI 快捷鍵、
//     但不繞過好讀模式的模擬」（term_keyboard.js 檔頭不變量）。
//   - CtrlShiftMap 的符號（@ [ \ ] ^ _ ?）沒有 Alt 對應 ⇒ 用 ctrlKey。
//   - 其他字元回 null ＝ 沒有對應的控制碼（解除 Ctrl、字照常送出）。
const CTRL_SYMBOLS = '@[\\]^_?';
export function mobileCtrlKey(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return null;
  if (/^[a-zA-Z]$/.test(ch)) return { key: ch.toLowerCase(), altKey: true };
  if (CTRL_SYMBOLS.indexOf(ch) >= 0) return { key: ch, ctrlKey: true };
  return null;
}

// ---- 浮動元件的位置 -----------------------------------------------------------
// 拖多遠才算拖曳（「⋯」圓鈕：小於這個就是點擊＝展開）。
export const KEYPAD_DRAG_THRESHOLD_PX = 8;

// 浮動工具鈕（render/merge_buttons.js#createFloatingTools：開燈／圖文並排／AI
// 校正／debug 錄製收成的「⋯」）的位置：以「離視窗右緣／下緣的距離（px）」表示。**存
// localStorage、不寫 prefs**：prefs 經 pref_sync 同步到其他裝置（同「手機模式是
// runtime 覆寫」那條規則）。預設＝桌機舊位置；手機上在底部工具列（MOBILE_TOOLBAR_PX）
// 上方 16px。
export const FLOAT_TOOLS_POS_STORAGE_KEY = 'pttchrome.floatToolsPos';
export const FLOAT_TOOLS_DEFAULT_POS = { right: 16, bottom: 64 };

// 把位置夾回視窗內：整個浮層（w×h）都要看得到。視窗比浮層還小時貼齊左上。
export function clampFloatPos(pos, { vw, vh, w, h }, defaults) {
  const p = pos || defaults;
  const maxRight = Math.max(0, (Number(vw) || 0) - (Number(w) || 0));
  const maxBottom = Math.max(0, (Number(vh) || 0) - (Number(h) || 0));
  const clamp = (v, max, d) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return Math.min(d, max);
    return Math.round(Math.min(Math.max(n, 0), max));
  };
  return {
    right: clamp(p.right, maxRight, defaults.right),
    bottom: clamp(p.bottom, maxBottom, defaults.bottom)
  };
}

// storage 注入（測試用）；預設 window.localStorage。私密視窗／封鎖網站資料時存取會
// throw ⇒ 一律退回預設位置，不影響功能。
export function loadFloatPos(key, defaults, storage) {
  try {
    const st = storage || window.localStorage;
    const raw = st.getItem(key);
    if (!raw) return { ...defaults };
    const v = JSON.parse(raw);
    if (!v || !Number.isFinite(v.right) || !Number.isFinite(v.bottom))
      return { ...defaults };
    return { right: v.right, bottom: v.bottom };
  } catch (e) {
    return { ...defaults };
  }
}

export function saveFloatPos(key, pos, storage) {
  try {
    const st = storage || window.localStorage;
    st.setItem(key, JSON.stringify({ right: pos.right, bottom: pos.bottom }));
  } catch (e) {
    // 存不了就只在這次開頁有效。
  }
}

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
//
// surface：
//   'article'（Phase 3）＝好讀文章長頁（term_view.reflow），超寬列由 CSS `mobileReflow` 換行。
//   'list'   （Phase 4）＝列表好讀視窗（term_view.listCards），body 列畫成卡片（render/list_card.js）。
// 兩者都改用正常字級 MOBILE_ROW_FONT_PX（仍不超過「rows 列塞滿高」，`.main` 高度
// chh*rows+10 才不出視窗）、`.main` 寬＝視窗寬（mainWidth）。
//   'menu'   （Phase 5）＝主功能表（term_view.menuCards）：幾何與 'grid' 相同（ANSI 圖仍縮小
//            塞滿寬），只有選單項畫成固定 px 高的大按鈕（render/menu_card.js）。
// **rows 與 surface 無關** ⇒ 畫面切換不重送 NAWS。'grid'／'menu' 的 mainWidth 為 null（照 80 欄算）。
export const MOBILE_SURFACES = ['grid', 'article', 'list', 'menu'];

export function mobileTermGeometry({ width, height, dpr, surface }) {
  const rows = calcTermSize({ height: height, fontSizePx: MOBILE_ROW_FONT_PX }).rows;
  const byWidth = (2 * (width - 10)) / TERM_COLS;
  const byHeight = (height - 10) / rows;
  const wide = surface === 'article' || surface === 'list';
  const raw = Math.max(0, Math.min(wide ? MOBILE_ROW_FONT_PX : byWidth, byHeight));
  const d = dpr > 0 ? dpr : 1;
  return {
    cols: TERM_COLS,
    rows: rows,
    chh: Math.floor(raw * d) / d,
    mainWidth: wide ? Math.max(0, Math.floor(Number(width) || 0)) : null
  };
}

// ---- Phase 4：列表卡片 -------------------------------------------------------

// 一張卡片佔幾個列高：兩行內容（標題一行＋推文數・日期・作者一行，LIST_CARD_LINES）
// ＋ 0.5 列的卡片間距（css `.listCard` 的 padding-block，防誤點）。**固定高**是承重
// 條件：list_scroll.js 的「序列位置 ↔ scrollTop」是純乘除（每列等高），卡片模式下
// 列高換成 LIST_CARD_ROWS*chh，那套數學原封不動（list_session/_rowHeight）。
// 必須與 main.css `.listCard` 的 height（em）一致，守護 tests/unit/list_card_css.test.js。
export const LIST_CARD_ROWS = 2.5;
export const LIST_CARD_LINES = 2;

// 列表 session 用：卡片模式下一列（＝一筆）佔幾個 chh，以及一屏放得下幾筆。
// bodyRows ＝ server 的 p_lines（rows-4），視口高度仍是 bodyRows*chh。
export function listRowSpan(cards) {
  return cards ? LIST_CARD_ROWS : 1;
}

export function listPageRows(bodyRows, cards) {
  return Math.max(1, Math.floor((Number(bodyRows) || 0) / listRowSpan(cards)));
}

// 列表好讀的捲動視口在終端機裡的位置與高度（單位：chh 列）。
//   桌機／格線：header（headerRows 列）在上、footer 一列在下，視口＝中間 rows-4 列。
//   手機卡片：header／footer 收起（資訊已在 App Bar／底部導覽，render/collapsed_row.js），
//            視口從頂端起、吃下整個終端機高 rows 列。
// 三個消費端必須同源：term_view 的視口 px、App.clientToPos 的列號換算、兩個列表
// session 的 _pageRows（PgUp/PgDn 一次幾筆）。**不是**抓頁單位：_bodyRows（server 的
// p_lines ＝ rows-4）與這裡無關。
export function listViewportGeometry({ rows, headerRows, cards }) {
  const r = Number(rows) || 0;
  if (cards) return { bodyTopRows: 0, viewportRows: r };
  return { bodyTopRows: Number(headerRows) || 0, viewportRows: Math.max(0, r - 4) };
}

// 點的是卡片本體嗎（App.mouse_click 卡片模式只在這時開文）。卡片間距（`.listCard` 的
// padding）不算 ⇒ 防誤點；header／footer 收起之後（listViewportGeometry），視口以外只剩
// `.main` 的留白，同樣不能落回列號換算去開某一筆。
export function isListCardBodyTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return !!target.closest('.listBodyView .listCardBody');
}

// 手機主功能表（Phase 5）的 `.main` 高與上緣位移。grid 幾何是「80 欄塞滿寬」⇒ 直式手機上
// chh*rows 只佔可視高的六成左右，而大按鈕（固定 px 高）比格線列高得多 ⇒ 把 `.main`
// 撐到整個可視高（扣軟鍵盤／工具列 inset），貼頂；可視高本來就不夠時退回格線規則
// （term_size.termLayoutOffsets，內容超出由 .main 的 overflow-y:auto 捲動）。
export function mobileMenuLayout({ innerHeight, bottomInset, topInset, chh, rows, margin }) {
  const base = chh * rows + 10;
  const inset = bottomInset > 0 ? bottomInset : 0;
  const top = topInset > 0 ? topInset : 0;
  const avail = Math.floor((Number(innerHeight) || 0) - inset - top);
  if (avail > base) return { height: avail, marginTop: top };
  return {
    height: base,
    marginTop: termLayoutOffsets({
      innerHeight, chh, rows, margin: margin || 0, bottomInset: inset, topInset: top
    }).marginTop
  };
}

// 手機主功能表（Phase 5）：點到的是哪一顆選單按鈕（render/menu_card.js 的
// data-menu-row ＝ buf 列號）。不是按鈕回 -1。按鈕高 ≠ chh ⇒ 不可用 clientToPos 換算。
export function menuCardTargetRow(target) {
  if (!target || typeof target.closest !== 'function') return -1;
  var card = target.closest('[data-menu-row]');
  if (!card) return -1;
  var row = Number(card.getAttribute('data-menu-row'));
  return Number.isInteger(row) && row >= 0 ? row : -1;
}

// 軟鍵盤蓋住 layout viewport 底部的高度（px）。Android Chrome 預設
// interactive-widget=resizes-visual：鍵盤只縮 visualViewport，layout 高度不變
// （所以列數不會因為叫鍵盤而變）。
//   - 只在使用者用鍵盤鈕叫出鍵盤時算：雙指縮放也會讓 visualViewport 變小，
//     另外以 scale ≠ 1 排除。
//   - 小於 KEYBOARD_MIN_PX 視為雜訊（網址列伸縮之類），不是鍵盤。
export const KEYBOARD_MIN_PX = 80;

// hostInset：Android APK 殼回報的鍵盤高度（android_bridge.js#androidImeInset）。
// APK 裡鍵盤疊在 WebView 上、visualViewport 量不到，取兩者較大者（不相加：
// 若某版 WebView 自己也縮了 visualViewport，兩邊量的是同一塊）。
// 頁內浮層（手機 bottom sheet 裡的搜尋框）叫出的鍵盤：同一套量法，但**不看**終端機的
// softKeyboard 閘門（那個鍵盤不是按鍵面板的 ⌨ 叫的）。結果只寫 CSS 變數 --vv-kb-inset
// 讓浮層讓位，不碰終端機幾何（不改列數、不推終端機）。
export function overlayKeyboardInset(o) {
  return keyboardInset({ ...(o || {}), softKeyboard: true });
}

export function keyboardInset({ mobile, softKeyboard, layoutHeight, vvHeight, vvOffsetTop, vvScale, hostInset }) {
  if (!mobile || !softKeyboard) return 0;
  if (Math.abs((Number(vvScale) || 1) - 1) > 0.01) return 0;
  const hidden = Math.max(
    (Number(layoutHeight) || 0) - ((Number(vvOffsetTop) || 0) + (Number(vvHeight) || 0)),
    Number(hostInset) || 0
  );
  return hidden >= KEYBOARD_MIN_PX ? Math.round(hidden) : 0;
}
