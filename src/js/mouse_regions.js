// 滑鼠區域決策層 —— 純函式，零 DOM、零狀態。
//
// 2026-08 整套滑鼠功能重新設計之前，這份決策散在 term_buf.onMouse_move 的
// `switch (pageState)` 裡，輸出是一個 0..14 的 `mouseCursor` 數字，同時兼任
// 「游標長什麼樣」與「點下去做什麼」兩種語意，共 15 種動作（左緣離開、右緣翻頁、
// 頂列 Home、底列 End、`[`/`]`/`=` 同標題前後篇、重新整理…）。誤觸率高、無法測。
//
// 現在只剩四種動作，且「做什麼」與「長什麼樣」分開回報：
//   enter        列表／選單：把游標移到該列並 Enter（開文章／進看板）
//   exitArticle  文章內左側帶：送左方向鍵離開
//   exit         列表／選單的左側帶：同樣送左方向鍵回上一層（2026-08 重新加回，
//                當初移除是因為舊版 15 種動作沒有任何提示；提示帶＋back 指標補上
//                之後 affordance 問題已解決，見 docs/mouse.md）
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
// 列表／選單的左側退出帶。與 ACT_EXIT_ARTICLE **刻意分成兩個常數**：語意雖同
// （都送左方向鍵），但列表好讀底下必須走 ListSession 的封閉互動（_beginLeave 會
// 先 getkeep 同步真游標），文章則是直送。分開才逐處檢查得出來誰漏改。
export const ACT_EXIT = 'exit';

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

// 防誤觸模式（pref mouseMisclickGuard，預設開）：這一種畫面「從第幾欄起才算可點」。
// **唯一真相源** —— 可點區與底色區共用它，兩者不可能分岔（使用者 2026-08 定案：
// 點擊區域＝底色區域）。關掉就是 0＝整列可點、整列上底色（改版前的行為）。
//
// 文章（pageState 3）不走這裡：它的左側退出帶是固定的 EXIT_COL_END 手勢，
// 推文列的「內容區才可點」由該列自己的 contentCol 決定（comment_parse.annotateComment），
// 兩者都不是「整個畫面共用一個起始欄」。
export function clickableColStart(pageState, misclickGuard) {
  if (!misclickGuard) return 0;
  if (pageState === 2 || pageState === 4) return LIST_TITLE_COL_START;
  if (pageState === 1) return MENU_COL_START;
  return 0;
}

const NONE = Object.freeze({
  action: ACT_NONE,
  row: -1,
  cursor: CUR_AUTO,
  highlightRow: -1,
  highlightColStart: 0
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
//   misclickGuard  防誤觸模式（pref mouseMisclickGuard，已由呼叫端與總開關 and 過）
//
// 輸出：
//   action           ACT_*
//   row              action 的目標列（none 時 -1）
//   cursor           CUR_*（交給 cursorCss 轉成實際 CSS）
//   highlightRow     這一列要不要上游標底色（-1 = 不上）
//   highlightColStart 底色從第幾欄起（0 = 整列）
//
// 底色範圍與可點區**一律相同**（clickableColStart 是兩者的唯一真相源）：防誤觸開
// ⇒ 只有標題／選項欄上底色，那條底色本身就是「這裡點得下去」的提示；關 ⇒ 整列。
// 2026-08 之前是「整列上底色、只有標題欄可點」，兩者刻意不一致，代價是使用者無從
// 得知邊界在哪。
export function resolveMouseRegion(input) {
  const o = input || {};
  // PTT 正開著輸入框（vgetstring 的反白輸入欄，呼叫端用 term_buf.isCursorOnInputField
  // 偵測）⇒ 這一幀什麼都不做。prompt 只重畫最上面一兩列，下方的列表／選單整片殘留
  // 在畫面上，看起來還是可以點 —— 但那一點會送 Enter 給輸入框（等於替使用者把搜尋
  // 送出／進錯看板），左側退出帶送的左方向鍵也只會被 vgetstring 吃掉。
  // 底色同時由 cursor_highlight.resolveHighlightRow 用同一個事實關掉（可點區＝底色區）。
  if (o.inputPrompt) return NONE;
  const rows = o.rows == null ? 24 : o.rows;
  const row = o.row == null ? -1 : o.row;
  const col = o.col == null ? -1 : o.col;
  const colStart = clickableColStart(o.pageState, o.misclickGuard);

  switch (o.pageState) {
    // 2 = 文章列表（setPageState 產生）；4 = LIST 變體（setPageState 不產生，
    // 只有舊 onMouse_move 用到，保留以免有呼叫端仍手動設定）。差別只在正文列範圍。
    case 2:
    case 4: {
      const top = o.pageState === 2 ? 2 : 1;
      const bottom = o.pageState === 2 ? rows - 1 : rows - 2;
      if (!(row > top && row < bottom)) return NONE;
      if (o.lineEmpty) return NONE;
      // 左側退出帶（與文章的 EXIT_COL_END 同一個手勢與同一組提示）。
      // **不看 misclickGuard**（使用者 2026-08 定案）：這是一個固定手勢，不是
      // 「哪一欄算內容」的問題，與文章一致。
      // 放在**列範圍與 lineEmpty 檢查之後**是刻意的：header／footer 那幾列現在有
      // 功能鍵按鈕，不該同時是退出區，這樣「提示帶亮＝點得下去」的合約才成立。
      if (col >= 0 && col < EXIT_COL_END) {
        return {
          action: ACT_EXIT,
          row: -1,
          cursor: CUR_BACK,
          highlightRow: -1,
          highlightColStart: 0
        };
      }
      // 欄位對 pttbbs mbbsd/bbs.c#readdoent 校準（見 comment_parse.js 的欄位表）：
      // 序號 0-6 / 空格 7 / type 8 / 推文數 9-10 / 日期 11-16 / 作者 17-29 /
      // 標題區 30-。防誤觸開啟時只有標題區可開文，點日期或作者欄不再誤觸。
      const clickable = col >= colStart;
      return {
        action: clickable ? ACT_ENTER : ACT_NONE,
        row: clickable ? row : -1,
        cursor: clickable ? CUR_POINTER : CUR_AUTO,
        highlightRow: row,
        highlightColStart: colStart
      };
    }

    case 1: {
      if (!(row > 0 && row < rows - 1)) return NONE;
      // 同 case 2/4：左 7 欄恆為退出，不看 misclickGuard。
      if (col >= 0 && col < EXIT_COL_END) {
        return {
          action: ACT_EXIT,
          row: -1,
          cursor: CUR_BACK,
          highlightRow: -1,
          highlightColStart: 0
        };
      }
      const clickable = col >= colStart;
      return {
        action: clickable ? ACT_ENTER : ACT_NONE,
        row: clickable ? row : -1,
        cursor: clickable ? CUR_POINTER : CUR_AUTO,
        highlightRow: row,
        highlightColStart: colStart
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
          highlightRow: -1,
          highlightColStart: 0
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
    // 防誤觸也**跟著總開關走**：總開關關掉時左鍵、指標、左側提示帶全滅，沒有任何
    // 誤觸要防（推文列的 pusher 高亮此時退回整列可點＝改版前的行為）。設定頁那顆
    // checkbox 因此能與其他子項一樣 disabled={!useMouseBrowsing}。
    misclickGuard: on && !!p.mouseMisclickGuard,
    middleClick: on ? Number(p.mouseMiddleClick) || 0 : 0,
    wheel: on && !!p.mouseWheel,
    // 平滑捲動是滾輪的子行為 ⇒ 必須先過滾輪本身這一關（列表好讀模式才有作用）。
    wheelSmoothScroll: on && !!p.mouseWheel && !!p.mouseWheelSmoothScroll
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
