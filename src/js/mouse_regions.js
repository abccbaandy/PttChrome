// 滑鼠區域決策層 —— 純函式，零 DOM、零狀態。
//
// 2026-08 整套滑鼠功能重新設計之前，這份決策散在 term_buf.onMouse_move 的
// `switch (pageState)` 裡，輸出是一個 0..14 的 `mouseCursor` 數字，同時兼任
// 「游標長什麼樣」與「點下去做什麼」兩種語意，共 15 種動作（左緣離開、右緣翻頁、
// 頂列 Home、底列 End、`[`/`]`/`=` 同標題前後篇、重新整理…）。誤觸率高、無法測。
//
// 現在只剩三種動作，且「做什麼」與「長什麼樣」分開回報：
//   enter        列表／選單：把游標移到該列並 Enter（開文章／進看板）
//   exitArticle  文章內左側帶：送左方向鍵離開
//   none         什麼都不做（**必須真的什麼都不做**；舊 case 0 會送左方向鍵，
//                是「隨手一點就跳出文章」的來源）
//
// 座標一律是**格子空間**（clientToPos 的輸出）。注意 comment_parse.js 的
// realignListColumns 是**文字空間**的 DBCS 折疊補償，格子空間沒有位移，
// 絕對不可以套在這裡的 col 上。

import { LIST_TITLE_COL_START } from './comment_parse';

export const ACT_NONE = 'none';
export const ACT_ENTER = 'enter';
export const ACT_EXIT_ARTICLE = 'exitArticle';

export const CUR_AUTO = 'auto';
export const CUR_POINTER = 'pointer';
export const CUR_BACK = 'back';

// 文章內「點這裡離開」的左側帶寬度（格）。沿用 fork 以來的 7 欄：PTT 文章正文
// 一律從第 0 欄開始，但推文行的 `推 `／`→ ` 前綴與引言的 `: ` 都在左側，7 欄
// 落在標點與行首之間，實測不會壓到有意義的內容。
export const EXIT_COL_END = 7;

// 選單（pageState 1，含主功能表／分類看板／看板列表／我的最愛）的可點區起點。
// **刻意不套欄位限制**：pttbbs mbbsd/board.c#show_brdlist 每一列至少有四種版型
// （NBRD_LINE 分隔線、NBRD_FOLDER 目錄、IN_CLASSROOT() 的 10 空格前綴、一般看板
// 列），沒有一個共用的「標題欄起點」可用。依 CLAUDE.md「PTT 邏輯不准猜」，在沒有
// 對 source 校準出可靠欄位之前維持整列可點，只擋掉最左邊的序號區。
export const MENU_COL_START = 8;

const NONE = Object.freeze({
  action: ACT_NONE,
  row: -1,
  cursor: CUR_AUTO,
  highlightRow: -1
});

// 這一格的滑鼠語意。
//
// 輸入（全部格子空間）：
//   pageState  term_buf.pageState（0 NORMAL / 1 MENU / 2 LIST / 3 READING /
//              4 LIST 變體 / 5 PASS / 6 編輯器）
//   col, row   滑鼠所在格
//   rows       終端機列數（buf.rows，通常 24）
//   lineEmpty  該列是不是空列（呼叫端算好 buf.isLineEmpty(row) 傳進來，
//              純函式不碰 buf）
//
// 輸出：
//   action       ACT_*
//   row          action 的目標列（none 時 -1）
//   cursor       CUR_*（交給 cursorCss 轉成實際 CSS）
//   highlightRow 這一列要不要上游標底色（-1 = 不上）
//
// 底色與可點區**刻意不一致**：列表 hover 整列都上底色，但只有標題欄接受點擊。
// 與原生 term_buf.onMouse_move 的「整列 nowHighlight」一致，否則 col 0-29 完全
// 沒反應，看起來像壞掉。
export function resolveMouseRegion(input) {
  const o = input || {};
  const rows = o.rows == null ? 24 : o.rows;
  const row = o.row == null ? -1 : o.row;
  const col = o.col == null ? -1 : o.col;

  switch (o.pageState) {
    // 2 = 文章列表（setPageState 產生）；4 = LIST 變體（setPageState 不產生，
    // 只有舊 onMouse_move 用到，保留以免有呼叫端仍手動設定）。差別只在正文列範圍。
    case 2:
    case 4: {
      const top = o.pageState === 2 ? 2 : 1;
      const bottom = o.pageState === 2 ? rows - 1 : rows - 2;
      if (!(row > top && row < bottom)) return NONE;
      if (o.lineEmpty) return NONE;
      // 欄位對 pttbbs mbbsd/bbs.c#readdoent 校準（見 comment_parse.js 的欄位表）：
      // 序號 0-6 / 空格 7 / type 8 / 推文數 9-10 / 日期 11-16 / 作者 17-29 /
      // 標題區 30-。只有標題區可開文，點日期或作者欄不再誤觸。
      const clickable = col >= LIST_TITLE_COL_START;
      return {
        action: clickable ? ACT_ENTER : ACT_NONE,
        row: clickable ? row : -1,
        cursor: clickable ? CUR_POINTER : CUR_AUTO,
        highlightRow: row
      };
    }

    case 1: {
      if (!(row > 0 && row < rows - 1)) return NONE;
      const clickable = col >= MENU_COL_START;
      return {
        action: clickable ? ACT_ENTER : ACT_NONE,
        row: clickable ? row : -1,
        cursor: clickable ? CUR_POINTER : CUR_AUTO,
        highlightRow: row
      };
    }

    // 文章內：整個視窗高度的左側帶＝離開，其餘沒有動作。
    // 舊版在 row 0/1/2/23 另有 `[`/`]`/`=`/重新整理/End 等特例，全部移除 ——
    // 好讀模式是可捲動長頁，clientToPos 仍把 row clamp 進 0..rows-1，那些「頂列
    // 底列」指的是**視窗**頂底而非文章頂底，語意本來就對不上。
    case 3:
      if (col >= 0 && col < EXIT_COL_END) {
        return {
          action: ACT_EXIT_ARTICLE,
          row: -1,
          cursor: CUR_BACK,
          highlightRow: -1
        };
      }
      return NONE;

    default:
      return NONE;
  }
}

// pref → 各入口的生效與否。**總開關關掉就是全關**，包含中鍵與滾輪 —— 這正是
// 重新設計要修的東西：改版前 middleMouse_down 與 mouse_scroll 完全不看
// useMouseBrowsing，「關掉滑鼠瀏覽」只關得掉一半。
//
// 底色刻意**不在**這裡 gate：那條決策的唯一真相是 cursor_highlight.js 的
// resolveHighlightRow（滑鼠與鍵盤共用同一條管線），在這裡再算一次等於兩個真相源。
export function resolveMouseGates(prefs) {
  const p = prefs || {};
  const on = !!p.useMouseBrowsing;
  const left = on && !!p.mouseLeftClick;
  return {
    move: on,
    leftClick: left,
    // 自訂滑鼠指標圖示是「這裡點下去會做什麼」的提示 ⇒ 跟著左鍵開關走。
    cursorIcon: left,
    middleClick: on ? Number(p.mouseMiddleClick) || 0 : 0,
    wheel: on && !!p.mouseWheel
  };
}

// CUR_* → 實際的 CSS cursor 值。
//
// 歷史坑：舊的 mouseCursorMap（term_buf.js）每一筆都寫成 `url(${x} 0 6,auto`，
// **少一個右括號** —— 依 CSS Syntax，url( 之後出現空白且下一個字元不是 ) 會產生
// bad-url-token，整條 cursor declaration 直接被丟棄。也就是說那 11 顆自訂 PNG
// 指標從 React 改寫以來從未生效過（只有 'pointer'/'default'/'auto' 有作用），
// 「文章左側可以退出」因此一直沒有任何提示。tests/unit/mouse_regions.test.js
// 有一條括號平衡的回歸鎖，別再讓它壞掉。
export function cursorCss(kind, opts) {
  const o = opts || {};
  if (!o.iconsEnabled) return 'auto';
  if (kind === CUR_POINTER) return 'pointer';
  if (kind === CUR_BACK && o.backUrl) return 'url(' + o.backUrl + ') 0 6, auto';
  return 'auto';
}
