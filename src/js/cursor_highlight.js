// 游標底色（光棒）的決策層 —— 純函式，零 DOM、零狀態。
//
// 歷史：這個效果原本只綁在「滑鼠瀏覽」上，而且顏色設定 mouseBrowsingHighlightColor
// → view.highlightBG 是一條**死鏈**（全 repo 沒有讀取點），實際上色的是
// LinkSegmentBuilder / Row 硬寫的 `b2`（#008000）。fork 從 DOM 字串渲染改成 React
// 元件時斷掉，且沒有任何測試覆蓋 → 使用者選什麼顏色畫面都是綠的。
//
// 現在的合約：**誰要上色**（本檔 resolveHighlightRow）與**上什麼色**
// （cursorHighlightClasses：整列提亮／整列底色，兩者可疊）都在這裡決定，
// term_view.applyCursorHighlight 是唯一的套用入口，Screen 只負責把
// class 掛到那一列。滑鼠 hover 與鍵盤游標共用同一條管線與同一個顏色設定，兩者誰贏
// 由 lastMover 仲裁（狀態在 term_view，規則見下方 resolveHighlightRow 與 docs/mouse.md）。

import { clickableColStart } from "./mouse_regions";

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

// 「整列提亮」的 class（css/color.css）。還原 pttbbs e18a7182 的
// grayout(row, row+1, GRAYOUT_COLORBOLD) ＝整列 FTATTR_BOLD / ESC[1m：前景色提亮
// 一階、**背景不變**。PTT 現行已無此選項（UF_MENU_LIGHTBAR 於 814adde3 移除，
// 官方詞彙裡的「光棒」專指有底色的 UF_CURSOR_STANDOUT），考證見
// docs/pttbbs-screen-protocol.md。
export const CURSOR_BRIGHTEN_CLASS = "cursorBrighten";

// 這一列要掛哪些 class。**樣式層**——「哪一列」由 resolveHighlightRow 決定，兩層正交：
// 兩種樣式可以同時開（底色 + 提亮），也可以都關（回 "" ＝這一列什麼都不畫，呼叫端
// 應直接當成「不上色」跳過整條 render/patch）。
//
// 順序固定（brighten 在前）：Screen.setCursorHighlight 是拿 cls **字串**比對前後幀，
// 順序飄動會讓沒變的幀被判成有變、白白重畫。
export function cursorHighlightClasses(input) {
  const o = input || {};
  const out = [];
  if (o.brighten) out.push(CURSOR_BRIGHTEN_CLASS);
  if (o.background) out.push(highlightClass(o.colorIndex));
  return out.join(" ");
}

// 原生畫面上「鍵盤游標列」只在這些 pageState 有意義：1=MENU、2/4=LIST。
// 文章閱讀頁與編輯器／輸入框的真實游標停在底部狀態列或打字處，整列上色只會干擾
// （這也是原生滑鼠光棒本來就只在 pageState 2/4 出現的理由，見 term_buf.onMouse_move）。
const KEYBOARD_HIGHLIGHT_PAGE_STATES = [1, 2, 4];

// 這一幀的「鍵盤游標列」，-1 = 這個畫面沒有可上色的鍵盤游標列。
function keyboardHighlightRow(o) {
  if (!o.keyboardEnabled) return -1;
  if (o.mode === "listBuffer") {
    return o.listCursorRow == null || o.listCursorRow < 0 ? -1 : o.listCursorRow;
  }
  if (KEYBOARD_HIGHLIGHT_PAGE_STATES.indexOf(o.pageState) === -1) return -1;
  return o.cursorRow == null || o.cursorRow < 0 ? -1 : o.cursorRow;
}

// 這一幀要把哪一列上色。回 -1 = 不上色。
//
// mode:
//   'listBuffer' 列表好讀（listRenderMode buffer/frozen）—— 座標是我們自己組的
//                24 列虛擬視窗，游標＝ListSession 的虛擬游標列。
//   'article'    好讀文章長頁（pageState 3）—— 一律不上色。
//   'native'     其餘（原生畫面、好讀模式停在列表／選單上）。
//
// 仲裁＝**誰最後動誰贏**（lastMover，由 term_view 維護）：
//   'mouse'（預設）  滑鼠列優先，滑鼠離開終端機區域（mouseRow < 0）才落回鍵盤游標列。
//   'keyboard'       鍵盤游標剛動過 ⇒ 鍵盤贏，**但**只有在該畫面真的有鍵盤游標列時；
//                    鍵盤底色關掉、或文章頁這種沒有游標列的畫面，hover 底色照舊生效。
// 歷史坑：改成仲裁之前是「滑鼠恆勝」，而滑鼠列是黏著狀態（列表好讀的 hover 列沒有
// 任何一處會在鍵盤操作時清掉）⇒ 滑鼠停過一次之後，底色就永遠釘在那一列，鍵盤怎麼
// 按都搶不回來。守護：tests/unit/cursor_highlight.test.js、cursor_highlight_arbitration.test.js。
export function resolveHighlightRow(input) {
  const o = input || {};
  // PTT 正開著輸入框（vgetstring 的反白輸入欄，呼叫端用 term_buf.isCursorOnInputField
  // 偵測）⇒ **整個畫面**都不上色，鍵盤游標列與滑鼠 hover 列一視同仁：畫面在等使用者
  // 打字，任何一條光棒都只是誤導（文章裡的推文輸入框本來就是這個樣子）。
  // 這是唯一決策點 —— 滑鼠端的可點區另由 mouse_regions.resolveMouseRegion 用同一個
  // 事實關掉，兩者一起動才守得住「底色區＝可點區」的合約。
  if (o.inputPrompt) return -1;
  const mouseRow = o.mouseRow == null ? -1 : o.mouseRow;
  if (o.mode === "article") return -1;
  const kbRow = keyboardHighlightRow(o);
  if (o.lastMover === "keyboard" && kbRow >= 0) return kbRow;
  if (o.mouseEnabled && mouseRow >= 0) return mouseRow;
  return kbRow;
}

// 底色從第幾欄畫起（0 = 整列）。**與可點區同一個真相源**（mouse_regions.
// clickableColStart），使用者 2026-08 定案「點擊區域＝底色區域」：防誤觸開啟時那條
// 底色本身就是「這裡點得下去」的提示，關掉就整列上色。
//
// 不分 lastMover —— 鍵盤游標與滑鼠 hover 共用同一個寬度（同上定案）：兩種來源畫出
// 不同寬度的光棒只會讓人以為畫面壞了。
// listBuffer（列表好讀的虛擬視窗）逐格對齊 server 的 readdoent 欄位（見
// list_session.buildListWindowLines），故直接套列表（pageState 2）的欄位表。
// article（好讀長頁）本來就不上色，一律回 0。
export function highlightColStart(input) {
  const o = input || {};
  if (o.mode === "article") return 0;
  if (o.mode === "listBuffer") return clickableColStart(2, o.misclickGuard);
  return clickableColStart(o.pageState, o.misclickGuard);
}
