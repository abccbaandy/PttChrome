// 游標底色（光棒）的決策層 —— 純函式，零 DOM、零狀態。
//
// 歷史：這個效果原本只綁在「滑鼠瀏覽」上，而且顏色設定 mouseBrowsingHighlightColor
// → view.highlightBG 是一條**死鏈**（全 repo 沒有讀取點），實際上色的是
// LinkSegmentBuilder / Row 硬寫的 `b2`（#008000）。fork 從 DOM 字串渲染改成 React
// 元件時斷掉，且沒有任何測試覆蓋 → 使用者選什麼顏色畫面都是綠的。
//
// 現在的合約：**誰要上色**（本檔 resolveHighlightRow）與**上什麼色**（highlightClass）
// 都在這裡決定，term_view.applyCursorHighlight 是唯一的套用入口，Screen 只負責把
// class 掛到那一列。滑鼠 hover 與鍵盤游標共用同一條管線與同一個顏色設定。

// color.css 的 .b2 = #008000，也就是 fork 以來的預設光棒綠。
export const DEFAULT_HIGHLIGHT_BG = 2;

// 底色 index → color.css 的背景 class。有效值 1..15（b0 是 transparent，等於沒上色，
// 設定頁的色票列也只給 1..15）；越界／非整數一律回預設，這樣壞掉的持久化值不會
// 讓光棒整個消失。
export function highlightClass(colorIndex) {
  const n = Number(colorIndex);
  if (!Number.isInteger(n) || n < 1 || n > 15) return "b" + DEFAULT_HIGHLIGHT_BG;
  return "b" + n;
}

// 原生畫面上「鍵盤游標列」只在這些 pageState 有意義：1=MENU、2/4=LIST。
// 文章閱讀頁與編輯器／輸入框的真實游標停在底部狀態列或打字處，整列上色只會干擾
// （這也是原生滑鼠光棒本來就只在 pageState 2/4 出現的理由，見 term_buf.onMouse_move）。
const KEYBOARD_HIGHLIGHT_PAGE_STATES = [1, 2, 4];

// 這一幀要把哪一列上色。回 -1 = 不上色。
//
// mode:
//   'listBuffer' 列表好讀（listRenderMode buffer/frozen）—— 座標是我們自己組的
//                24 列虛擬視窗，游標＝ListSession 的虛擬游標列。
//   'article'    好讀文章長頁（pageState 3）—— 一律不上色。
//   'native'     其餘（原生畫面、好讀模式停在列表／選單上）。
//
// 滑鼠優先於鍵盤：hover 時光棒跟手（維持既有直覺），滑鼠離開終端機區域
// （mouseRow < 0）才落回鍵盤游標列。
export function resolveHighlightRow(input) {
  const o = input || {};
  const mouseRow = o.mouseRow == null ? -1 : o.mouseRow;
  if (o.mode === "article") return -1;
  if (o.mouseEnabled && mouseRow >= 0) return mouseRow;
  if (!o.keyboardEnabled) return -1;
  if (o.mode === "listBuffer") {
    return o.listCursorRow == null || o.listCursorRow < 0 ? -1 : o.listCursorRow;
  }
  if (KEYBOARD_HIGHLIGHT_PAGE_STATES.indexOf(o.pageState) === -1) return -1;
  return o.cursorRow == null || o.cursorRow < 0 ? -1 : o.cursorRow;
}
