// 選單畫面（mbbsd/menu.c#domenu：主功能表與它底下的個人設定區、私人信件區、
// 休閒聊天區、系統資訊區…）的判定 —— 純函式，零 DOM。
//
// 所有選單都由同一個 domenu 畫：上半是 adbanner 的動畫／心情點播（ANSI 圖），下半才是
// 選單項；兩者同在「內文列」範圍裡，只看列號分不出來（header_lines 是 12 或 13，見
// menu.c#decide_menu_row）⇒ 以**列文字的形狀**判斷。依據（現行 master 與
// origin/piaip.newui 兩版相同）：
//   menu.c#menu_renderer  prints("%*s  (" ANSI_COLOR(1;36) "%c" ANSI_RESET ")%s",
//                                menu_column, "", s[0], s + 1)
//                         ⇒ menu_column 個空白 + 2 空白 + `(X)` + 其餘描述
//                         （快捷鍵是 desc 的第一個字元，可以是數字，如 `0Admin`）
//   menu.c#decide_menu_column  ≥80 欄恆 20（較窄才置中）
//   stuff.c#cursor_show   在 menu_column 寫 STR_CURSOR `>`（UF_CURSOR_LEGACY 時寫
//                         STR_CURSOR2 `●`，兩欄寬，正好蓋掉那兩個空白）
//
// 「這一幀是不是選單」：主功能表靠標題；子選單的標題是各自的 title（個人設定、電子郵件…，
// 巢狀選單還會從 desc 推導，見 menu.c#extract_menu_title），列舉不完 ⇒ 改認**狀態列**
// （menu.c#show_status_bar）。狀態列指紋沿用 string_util.parseListRow —— setPageState
// 判子選單為 pageState 1 用的就是它，新舊兩種格式都吃（細節與出處見該函式與
// docs/pttbbs-screen-protocol.md §11.9），**不要另寫一份**。
// 同一個狀態列也出現在**分類看板根目錄**（board.c#brdlist_footer 的 IN_CLASSROOT ⇒
// show_status()），那是看板列表不是選單 ⇒ 以標題（board.c#brdlist_header 的
// 「分類看板」／「看板列表」）排除。
// 消費端：mouse_regions（ANSI 圖區不可點、不上底色）、手機的選單大按鈕（render/menu_card.js）。
import {
  MAIN_MENU,
  BOARD_LIST,
  CLASS_LIST,
  rowHasTitle,
  rowHasAnyTitle,
} from './screen_titles';
import { parseListRow } from './string_util';

// `(X)` 之後不要求非空白：desc 第二個字元是什麼由各選單表決定（`2FA`、`My Files`…）。
const MENU_ITEM_RE = /^ *(?:>|●)? *\(([0-9A-Za-z])\)/;
const BOARD_LIST_TITLES = [BOARD_LIST, CLASS_LIST];

// 這一列是不是選單項。回 `{ key }`（快捷鍵字元）或 null。
export function parseMenuItemRow(text) {
  if (typeof text !== 'string') return null;
  var m = MENU_ITEM_RE.exec(text);
  return m ? { key: m[1] } : null;
}

// 這一幀是不是選單畫面（主功能表或任一子選單）。pageState 1 底下另一種是看板列表
// （含分類看板根目錄，它的狀態列與選單相同，以標題排除）。
export function isMenuScreen(pageState, row0Text, lastRowText) {
  if (pageState !== 1) return false;
  var row0 = row0Text || '';
  if (rowHasAnyTitle(row0, BOARD_LIST_TITLES)) return false;
  return rowHasTitle(row0, MAIN_MENU) || parseListRow(lastRowText);
}
