// Row 0（頂端標題列）的畫面判定 —— 純函式，零 DOM、零狀態。
//
// pttbbs 的標題列有三種形狀（`mbbsd/vtuikit.c`）。舊版 CONFIRMED @ 03cdf5eb；
// 新版 CONFIRMED 讀碼 @ pttbbs origin/piaip.newui 7e35b24e（PTT2 09/20、PTT1 10/04）：
//   三段式 vs_header(title, mid, right, mid_cb)  →  `【title】` + 中段 + 右段（新舊相同）
//   單段式 vs_hdr(title)   →  舊 `【 title 】`；新 `【title】`（VMSG_HDR_* 改指向 VMSG_HEADER_*）
//   兩段式 vs_draw_hdr2(left, right)  →  舊：呼叫端自帶【】；新：`" " left " "`
//          ＋ VCLR_HDR2_RIGHT（0;30;47）的右段
// 本專案用來判畫面的四個標題（主功能表／分類看板／精華文章／看板列表）**全部走
// 三段式**（menu.c#showtitle → vs_header），所以字面值是 `【X】`，改版不受影響。
// 但括號形狀會動，判定收斂成一個地方、同時吃兩種形狀，下次再動時不必再翻八個檔案。
//
// 兩種形狀：
//   `【X】…`（三段式／新版單段式）
//   ` X …`  （新版兩段式：前後各一格半形空白）
// 兩者都要求從 **col 0** 起算——`indexOf(...) === 0` 的語意不可放寬成 `>= 0`：
// 文章內文與看板標題裡到處都有【】，只認開頭才是指紋。
//
// 已有自己 fallback 的兩處**刻意不改**，避免開第三份真相源，但登記在這裡：
//   src/js/auto_login.js          `MAIN_MENU = ['主功能表', '【主功能表】']`
//                                  （用 includes 做寬鬆比對，本來就吃得下新舊）
//   tests/e2e/helpers/login_flow.js `MAIN_MENU_MARKERS = ['主功能表','【主功能表】']`
//
// 守護：tests/unit/screen_titles.test.js

export const MAIN_MENU = '主功能表';
export const CLASS_LIST = '分類看板';
export const ARCHIVE_LIST = '精華文章';
export const BOARD_LIST = '看板列表';
export const FAVOURITE = '我的最愛';

// row 0 的文字是否以 `name` 這個標題開頭（兩種括號形狀都算）。
export function rowHasTitle(rowText, name) {
  if (!rowText || !name) return false;
  return rowText.indexOf('【' + name + '】') === 0 ||
         rowText.indexOf(' ' + name + ' ') === 0;
}

// 任一命中即為真。呼叫端多半是「這是不是某種選單畫面」這種白名單判斷。
export function rowHasAnyTitle(rowText, names) {
  if (!rowText || !names) return false;
  for (var i = 0; i < names.length; ++i) {
    if (rowHasTitle(rowText, names[i])) return true;
  }
  return false;
}

// setPageState / classifyListScreen / boardListContextKind 共用的「選單畫面」
// 白名單。三份原本各自抄一遍字面值，這裡收成一處。
export const MENU_TITLES = [MAIN_MENU, CLASS_LIST, ARCHIVE_LIST];
