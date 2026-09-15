// 滑鼠區域決策層 —— 純函式，零 DOM、零狀態。
//
// 2026-08 整套滑鼠功能重新設計之前，這份決策散在 term_buf.onMouse_move 的
// `switch (pageState)` 裡，輸出是一個 0..14 的 `mouseCursor` 數字，同時兼任
// 「游標長什麼樣」與「點下去做什麼」兩種語意，共 15 種動作（左緣離開、右緣翻頁、
// 頂列 Home、底列 End、`[`/`]`/`=` 同標題前後篇、重新整理…）。誤觸率高、無法測。
//
// 現在是「做什麼」與「長什麼樣」分開回報，動作逐一列舉（漏改會變 undefined 而不是
// 靜默走錯 case）。前四種是重新設計後留下的，後四種是 2026-09 從原版找回來的邊緣區
// （吃 pref mouseEdgePaging，關掉時整張表逐格等同找回來之前）：
//   enter        列表／選單：把游標移到該列並 Enter（開文章／進看板）
//   exitArticle  文章內左側帶：送左方向鍵離開
//   exit         列表／選單的左側帶：同樣送左方向鍵回上一層（2026-08 重新加回，
//                當初移除是因為舊版 15 種動作沒有任何提示；提示帶＋back 指標補上
//                之後 affordance 問題已解決，見 docs/mouse.md）
//   none         什麼都不做（**必須真的什麼都不做**；舊 case 0 會送左方向鍵，
//                是「隨手一點就跳出文章」的來源）
//   home/end     頂列／底列：跳第一頁／最後一頁
//   pageUp/Down  右緣上下半（列表／看板列表）、整片上下半（文章）：翻頁
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

// 邊緣翻頁區（pref mouseEdgePaging）。2026-09 從 term.ptt.cc 原版找回來的四種動作：
// 頂列 Home、底列 End、右緣上／下半 PageUp／PageDown（文章內則是整片上／下半）。
//
// 當初（004c2c9）連同另外十種一起移除的理由是「誤觸率高又完全沒有提示」。提示這半
// 已經解決 —— 與左側退出帶同一套解法：自訂指標 ＋ hover 提示帶（#edgeHintBand），
// 而且整組吃一個可關掉的 pref。**送鍵一律走 App.sendNavKeyAsUser**（合成 keydown 走
// 既有分派鏈），三種 render 分支的語意各自已經寫好了，見 docs/mouse.md。
export const ACT_PAGE_UP = 'pageUp';
export const ACT_PAGE_DOWN = 'pageDown';
export const ACT_HOME = 'home';
export const ACT_END = 'end';

export const CUR_AUTO = 'auto';
export const CUR_POINTER = 'pointer';
export const CUR_BACK = 'back';
export const CUR_PAGE_UP = 'pageUp';
export const CUR_PAGE_DOWN = 'pageDown';
export const CUR_HOME = 'home';
export const CUR_END = 'end';

// 右緣翻頁帶的寬度（格）。沿用 fork 以來的 16 欄 ⇒ 80 欄畫面是第 64 欄起到行尾。
export const PAGE_BAND_WIDTH = 16;

export function pageBandColStart(cols) {
  return (cols == null ? 80 : cols) - PAGE_BAND_WIDTH;
}

// 上半／下半的分界列：`row <= split` ⇒ 上半（PageUp）。24 列時 ＝ 12，與改版前
// 硬寫的 `trow > 12` 逐格相同。
export function pageSplitRow(rows) {
  return Math.floor((rows == null ? 24 : rows) / 2);
}

// 邊緣區的動作 → 送給 term_view.sendKeyAsUser 的鍵名。**唯一真相源**：原生的
// action switch 與列表好讀的分支都查這一張表，不各寫一份對照。
export const EDGE_NAV_KEY = {
  [ACT_PAGE_UP]: 'PageUp',
  [ACT_PAGE_DOWN]: 'PageDown',
  [ACT_HOME]: 'Home',
  [ACT_END]: 'End'
};

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
  highlightColStart: 0,
  hintBand: null
});

// 邊緣區的回傳值。`hintBand` 是**格子空間**的半開矩形
// `{colStart, colEnd, rowStart, rowEnd}`，由 mouse_geometry.edgeBandRect 換成像素，
// 交給 #edgeHintBand 畫出來 —— 「帶子亮＝點得下去」的合約靠兩邊同一份矩形成立。
// 邊緣區一律**不上底色**（highlightRow -1），與左側退出帶同處理：那一格的意思是
// 「翻頁」而不是「開這一列」。
function edgeBand(action, cursor, rect) {
  return {
    action: action,
    row: -1,
    cursor: cursor,
    highlightRow: -1,
    highlightColStart: 0,
    hintBand: rect
  };
}

// 列表（pageState 2/4）與看板列表（pageState 1）的邊緣區。回 null ＝這一格不是邊緣
// 區，交回原本的決策。bodyTop／bodyBottom 是該畫面「內文列」的開區間邊界。
//
// 主功能表（pageState 1 但不是看板列表）**不走這裡**：mbbsd/menu.c:508,517 的
// KEY_HOME／KEY_PGUP 是「下一項」、KEY_END／KEY_PGDN 是「上一項」，做出來的事與
// 使用者點「跳第一頁」的預期相反。呼叫端用 `boardList` 把它擋掉。
function listEdgeRegion(row, col, rows, cols, bodyTop, bodyBottom) {
  if (!(row >= 0 && row < rows)) return null;
  if (row === 0)
    return edgeBand(ACT_HOME, CUR_HOME, {
      colStart: 0, colEnd: cols, rowStart: 0, rowEnd: 1
    });
  if (row === rows - 1)
    return edgeBand(ACT_END, CUR_END, {
      colStart: 0, colEnd: cols, rowStart: rows - 1, rowEnd: rows
    });
  // 內文列以外、又不是頂／底列的那幾列（pageState 2 的 row 1-2、4 的 row 1 與
  // rows-2）＝整列上一頁，與改版前相同。帶子涵蓋**整段連續**的那幾列。
  if (!(row > bodyTop && row < bodyBottom))
    return edgeBand(ACT_PAGE_UP, CUR_PAGE_UP, {
      colStart: 0,
      colEnd: cols,
      rowStart: row <= bodyTop ? 1 : bodyBottom,
      rowEnd: row <= bodyTop ? bodyTop + 1 : rows - 1
    });
  // 內文列的右緣帶。**排在左側退出帶之後**（呼叫端的順序），兩條帶子不重疊。
  const bandStart = pageBandColStart(cols);
  if (col >= bandStart) {
    const split = pageSplitRow(rows);
    const up = row <= split;
    return edgeBand(up ? ACT_PAGE_UP : ACT_PAGE_DOWN, up ? CUR_PAGE_UP : CUR_PAGE_DOWN, {
      colStart: bandStart,
      colEnd: cols,
      rowStart: up ? bodyTop + 1 : split + 1,
      rowEnd: up ? split + 1 : bodyBottom
    });
  }
  return null;
}

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
//   cols           終端機欄數（buf.cols，通常 80；右緣翻頁帶從 cols-16 起）
//   edgePaging     邊緣翻頁區（pref mouseEdgePaging，同樣已 and 過總開關）。
//                  **不傳＝關**，整張表逐格等同 2026-09 找回這些區域之前。
//   boardList      這一幀是不是看板列表（term_buf.isBoardListScreen）。只有
//                  pageState 1 會看它 —— 主功能表的 Home/End 語意相反，見
//                  listEdgeRegion。
//   inputPrompt    PTT 開著 vgetstring 輸入框（buf.isCursorOnInputField()）
//   dismiss        這一幀有沒有滑鼠關得掉的框（screen_dismiss.resolveDismiss 的
//                  結果，null ＝沒有）。**優先於 inputPrompt**，見下方。
//
// 輸出：
//   action           ACT_*
//   row              action 的目標列（none 時 -1）
//   cursor           CUR_*（交給 cursorCss 轉成實際 CSS）
//   highlightRow     這一列要不要上游標底色（-1 = 不上）
//   highlightColStart 底色從第幾欄起（0 = 整列）
//   hintBand         邊緣翻頁區的提示帶矩形（格子空間的半開矩形，null ＝這一格不是
//                    邊緣區）。**非 null ⟺ 邊緣區**，消費端拿它當判別式就不必逐一
//                    列舉 action（term_view.listEdgeRegion 就是這樣用的）。
//
// 底色範圍與可點區**一律相同**（clickableColStart 是兩者的唯一真相源）：防誤觸開
// ⇒ 只有標題／選項欄上底色，那條底色本身就是「這裡點得下去」的提示；關 ⇒ 整列。
// 2026-08 之前是「整列上底色、只有標題欄可點」，兩者刻意不一致，代價是使用者無從
// 得知邊界在哪。
export function resolveMouseRegion(input) {
  const o = input || {};
  // 滑鼠已經交給 PTT server（見 resolveMouseGates 的 serverReport）⇒ 這一格什麼
  // 都不是。**必須排在最前面**，連 dismiss 都要讓開：關框那一下也該由 server 收。
  //
  // 一條早退同時關掉四件事，所以不必去改四個消費端：
  //   - action 恆 ACT_NONE      ⇒ App.onMouse_click 什麼都不做
  //   - cursor 恆 CUR_AUTO      ⇒ 自訂指標消失、_applyMousePointer 不畫退出提示帶
  //   - highlightRow 恆 -1      ⇒ setHighlight 不宣告滑鼠優先權，hover 底色自動
  //                                消失、鍵盤游標列照常（cursor_highlight.js 不用改）
  if (o.serverMouse) return NONE;
  // 框開著（pressanykey／vmsg 橫幅／vgetstring 輸入欄，呼叫端用
  // screen_dismiss.resolveDismiss 判）⇒ 整個畫面都是「點空白處關框」的目標，
  // **只換指標、不上底色**：框在時下方整片是殘影，上底色會讓人以為那裡可以點。
  // action 刻意維持 ACT_NONE —— 關框**不走 buf.mouseAction**（term_buf.notify 的
  // 每個 changed 幀都 clearHighlight() 把它清成 none，而框正是「畫面剛變出來」
  // 的東西 ⇒ 使用者不動滑鼠直接點時必定讀到 none）。送鍵那一半在
  // App.mouse_click 於點擊當下現算，見 docs/mouse.md「點空白處關框」。
  //
  // **必須排在 inputPrompt 早退之前**：輸入欄那一種框正好被它擋掉。
  if (o.dismiss) {
    return {
      action: ACT_NONE,
      row: -1,
      cursor: CUR_POINTER,
      highlightRow: -1,
      highlightColStart: 0,
      hintBand: null
    };
  }
  // PTT 正開著輸入框（vgetstring 的反白輸入欄，呼叫端用 term_buf.isCursorOnInputField
  // 偵測）⇒ 這一幀什麼都不做。prompt 只重畫最上面一兩列，下方的列表／選單整片殘留
  // 在畫面上，看起來還是可以點 —— 但那一點會送 Enter 給輸入框（等於替使用者把搜尋
  // 送出／進錯看板），左側退出帶送的左方向鍵也只會被 vgetstring 吃掉。
  // 底色同時由 cursor_highlight.resolveHighlightRow 用同一個事實關掉（可點區＝底色區）。
  if (o.inputPrompt) return NONE;
  const rows = o.rows == null ? 24 : o.rows;
  const cols = o.cols == null ? 80 : o.cols;
  const row = o.row == null ? -1 : o.row;
  const col = o.col == null ? -1 : o.col;
  const colStart = clickableColStart(o.pageState, o.misclickGuard);
  // 邊緣翻頁區（pref mouseEdgePaging，呼叫端已與總開關 and 過）。**預設不啟用**：
  // 沒傳這個欄位時整張表逐格等同 2026-09 之前的行為，既有的區域測試就是那半邊的
  // 回歸鎖。pageState 1 另外要求 `boardList`（理由見 listEdgeRegion）。
  const edgeOn =
    !!o.edgePaging && (o.pageState !== 1 || !!o.boardList);

  switch (o.pageState) {
    // 2 = 文章列表（setPageState 產生）；4 = LIST 變體（setPageState 不產生，
    // 只有舊 onMouse_move 用到，保留以免有呼叫端仍手動設定）。差別只在正文列範圍。
    case 2:
    case 4: {
      const top = o.pageState === 2 ? 2 : 1;
      const bottom = o.pageState === 2 ? rows - 1 : rows - 2;
      // 內文列以外（頂列 Home／底列 End／整列上一頁）：排在 lineEmpty 之前 ——
      // 那個判斷只對內文列有意義，而邊緣區與該列畫了什麼無關。
      if (!(row > top && row < bottom))
        return (edgeOn && listEdgeRegion(row, col, rows, cols, top, bottom)) || NONE;
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
          highlightColStart: 0,
          hintBand: null
        };
      }
      // 右緣翻頁帶。**排在左側退出帶之後**：兩條帶子不重疊，而左側是先來的手勢。
      if (edgeOn) {
        const edge = listEdgeRegion(row, col, rows, cols, top, bottom);
        if (edge) return edge;
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
        highlightColStart: colStart,
        hintBand: null
      };
    }

    case 1: {
      if (!(row > 0 && row < rows - 1))
        return (edgeOn && listEdgeRegion(row, col, rows, cols, 0, rows - 1)) || NONE;
      // 同 case 2/4：左 7 欄恆為退出，不看 misclickGuard。
      if (col >= 0 && col < EXIT_COL_END) {
        return {
          action: ACT_EXIT,
          row: -1,
          cursor: CUR_BACK,
          highlightRow: -1,
          highlightColStart: 0,
          hintBand: null
        };
      }
      if (edgeOn) {
        const edge = listEdgeRegion(row, col, rows, cols, 0, rows - 1);
        if (edge) return edge;
      }
      const clickable = col >= colStart;
      return {
        action: clickable ? ACT_ENTER : ACT_NONE,
        row: clickable ? row : -1,
        cursor: clickable ? CUR_POINTER : CUR_AUTO,
        highlightRow: row,
        highlightColStart: colStart,
        hintBand: null
      };
    }

    // 文章內：整個視窗高度的左側帶＝離開，其餘沒有動作。
    // 舊版在 row 0/1/2/23 另有 `[`/`]`/`=`/重新整理/End 等特例，全部移除 ——
    // 好讀模式是可捲動長頁，clientToPos 仍把 row clamp 進 0..rows-1，那些「頂列
    // 底列」指的是**視窗**頂底而非文章頂底，語意本來就對不上。
    case 3: {
      // **左側退出帶優先於底列 End**（與改版前的 row 23 特例不同，刻意的）：
      // #exitHintBand 是整片高度的一條帶子，讓 End 吃掉它最底下那一格的話，帶子會
      // 在那裡亮著卻送出別的鍵 —— affordance 說謊正是當初這些區域被移除的原因。
      if (col >= 0 && col < EXIT_COL_END) {
        return {
          action: ACT_EXIT_ARTICLE,
          row: -1,
          cursor: CUR_BACK,
          highlightRow: -1,
          highlightColStart: 0,
          hintBand: null
        };
      }
      if (!edgeOn || !(row >= 0 && row < rows)) return NONE;
      // 文章沒有右緣帶：整片內容區上半＝上一頁、下半＝下一頁（改版前相同），
      // 最後一列＝End。好讀模式是一整條長頁，clientToPos 仍把 row clamp 進
      // 0..rows-1 ⇒ 這裡的「上半／下半／底列」指的是**視窗**，而送出去的鍵在
      // easy_reading 是捲動語意（_scrollBy / _scrollBottom），正好對得上。
      if (row === rows - 1)
        return edgeBand(ACT_END, CUR_END, {
          colStart: EXIT_COL_END, colEnd: cols, rowStart: rows - 1, rowEnd: rows
        });
      const split = pageSplitRow(rows);
      const up = row <= split;
      return edgeBand(up ? ACT_PAGE_UP : ACT_PAGE_DOWN, up ? CUR_PAGE_UP : CUR_PAGE_DOWN, {
        colStart: EXIT_COL_END,
        colEnd: cols,
        rowStart: up ? 0 : split + 1,
        rowEnd: up ? split + 1 : rows - 1
      });
    }

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
  // PTT server 自己開了滑鼠 tracking，而且使用者也允許回報 ⇒ 滑鼠交給 PTT。
  // 兩個條件缺一不可：`serverMouse` 是主機宣告的事實（buf.mouseReport.isActive()，
  // 內含「主機開了 1000/1002/1003 且開了 1006」），`mouseServerReport` 是使用者
  // 偏好。跟著總開關走（`on &&`），維持「總開關關掉就是全關」這條不變量。
  const serverReport = on && !!p.mouseServerReport && !!p.serverMouse;
  // 讓位規則：**我們自己發明的滑鼠語意**整組關掉（左鍵開文／退出帶／自訂指標／
  // 防誤觸／滾輪翻頁），但**真的是另一個東西**的仍然保留 —— 中鍵貼上是瀏覽器語意、
  // backNav 是瀏覽器導航，兩者都不是「終端機格子上的滑鼠」，不該送給 PTT。
  // `move` 也保持 on：座標快取還要繼續更新（term_buf.onMouse_move）。
  const left = on && !!p.mouseLeftClick && !serverReport;
  return {
    move: on,
    serverReport: serverReport,
    leftClick: left,
    // 自訂滑鼠指標圖示是「這裡點下去會做什麼」的提示 ⇒ 跟著左鍵開關走。
    cursorIcon: left,
    // 防誤觸也**跟著總開關走**：總開關關掉時左鍵、指標、左側提示帶全滅，沒有任何
    // 誤觸要防（推文列的 pusher 高亮此時退回整列可點＝改版前的行為）。設定頁那顆
    // checkbox 因此能與其他子項一樣 disabled={!useMouseBrowsing}。
    misclickGuard: on && !!p.mouseMisclickGuard && !serverReport,
    // 邊緣翻頁區（頂列 Home／底列 End／右緣與文章上下半翻頁）。跟著總開關走，
    // serverReport 時整組讓位 —— 它與「點標題開文」同類，都是我們自己發明的
    // 滑鼠語意，不是瀏覽器語意。
    edgePaging: on && !!p.mouseEdgePaging && !serverReport,
    middleClick: on ? Number(p.mouseMiddleClick) || 0 : 0,
    wheel: on && !!p.mouseWheel && !serverReport,
    // 平滑捲動是滾輪的子行為 ⇒ 必須先過滾輪本身這一關（列表好讀模式才有作用）。
    wheelSmoothScroll:
      on && !!p.mouseWheel && !!p.mouseWheelSmoothScroll && !serverReport,
    // 瀏覽器的「返回」→ 左方向鍵：觸控板左滑手勢、滑鼠側鍵、Alt+←／⌘[、
    // 工具列上一頁**全都是同一個來源**（一律走 history sentinel，見
    // history_back_guard.js）⇒ 只有一個 pref，不可能單獨開關其中一種。
    // **刻意不掛在 mouseWheel 底下**：mouseWheel 的語意是「垂直滾輪＝上下頁」，
    // 綁進去會讓「我不要滾輪翻頁」的人連退出手勢一起失去。
    backNav: on ? Number(p.mouseBackNav) || 0 : 0
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
// 邊緣區指標的 hotspot：箭頭圖自己的尖端在上緣中央，沿用 ptt-term 的 `6 0`
// （back 是左指箭頭，維持 `0 6`）。
const EDGE_CURSOR_KEYS = [CUR_PAGE_UP, CUR_PAGE_DOWN, CUR_HOME, CUR_END];

// 這個指標是不是邊緣翻頁區的。消費端用它決定「要不要顯示自訂圖示」：邊緣區的圖示
// 跟著 mouseEdgePaging 走（區域本身已經由那顆 pref gate 過），**不跟 mouseLeftClick**
// —— 否則關掉「點標題開文」會得到一個點得下去卻沒有任何提示的翻頁區。
export function isEdgeCursor(kind) {
  return EDGE_CURSOR_KEYS.indexOf(kind) >= 0;
}

export function cursorCss(kind, opts) {
  const o = opts || {};
  if (!o.iconsEnabled) return 'auto';
  if (kind === CUR_POINTER) return 'pointer';
  const urls = o.urls || {};
  const backUrl = o.backUrl || urls[CUR_BACK];
  if (kind === CUR_BACK && backUrl) return 'url(' + backUrl + ') 0 6, auto';
  if (EDGE_CURSOR_KEYS.indexOf(kind) >= 0 && urls[kind])
    return 'url(' + urls[kind] + ') 6 0, auto';
  return 'auto';
}
