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

// row 0 的三段式標題文字（`【X】` 的 X，去頭尾空白）；不是這個形狀回 null。
// 只認 col 0 起的【】（理由同 rowHasTitle）。手機 App Bar 的標題來源
// （mobile_app_bar.js）；文章列表的 `【板主:xxx】` 也是這個形狀，呼叫端自己先判列表。
const HEADER_TITLE_RE = /^【\s*([^【】]*?)\s*】/;
export function parseHeaderTitle(rowText) {
  if (!rowText) return null;
  var m = rowText.match(HEADER_TITLE_RE);
  return m && m[1] ? m[1] : null;
}

// setPageState / classifyListScreen / boardListContextKind 共用的「選單畫面」
// 白名單。三份原本各自抄一遍字面值，這裡收成一處。
export const MENU_TITLES = [MAIN_MENU, CLASS_LIST, ARCHIVE_LIST];

// Board name from the row-0 title bar: 「…看板《C_Chat》…」. The reversed title
// is repainted on every board switch (protocol §4 TITLE_REDRAW), so this is the
// aliasing guard for accumulated article numbers across boards.
const BOARD_NAME_RE = /《([^《》]+)》/;
export function parseBoardName(row0Text) {
  if (!row0Text) return null;
  const m = row0Text.match(BOARD_NAME_RE);
  return m ? m[1] : null;
}

// 「看板《X》」不保證在：vtuikit.c#vs_draw_header 在 `szmid + szright > w` 時整段丟掉
// 右側（看板描述太長，例：LoL「[LoL] 世界大賽主題曲 Know My Name」）。標題列左段是
// bbs.c#readtitle → redraw_title(currBM, …)，currBM 只有「板主:xxx」（過長截成 `..`）
// 與「徵求中」兩種 ⇒ 用它認出「這是文章列表的標題列」。
const ARTICLE_LIST_TITLE_RE = /^\s*【(?:板主:[^】]*|徵求中)】/;

// 看板身分鍵（列表好讀的 _boardName／facts.boardName 存的就是它）：有《板名》用板名；
// 被 server 省略時退用整條標題列文字（板主＋描述，跨板不同；以「【」起頭，永遠不會
// 等於真的板名）。只拿來比「同一個板嗎」，要真板名（`s` 跳板、比對 deep link 目標）
// 用 boardNameFromKey。新信件提示會換掉描述 ⇒ 身分鍵變了 ⇒ 多一次 rebuild，安全。
export function parseBoardKey(row0Text) {
  const name = parseBoardName(row0Text);
  if (name != null) return name;
  if (!row0Text || !ARTICLE_LIST_TITLE_RE.test(row0Text)) return null;
  return row0Text.trim();
}

// 文章列表的標題列（有《板名》，或被省略但左段是 currBM）。
export function isArticleListTitleRow(row0Text) {
  return parseBoardKey(row0Text) != null;
}

export function boardNameFromKey(key) {
  return key != null && key.charAt(0) !== '【' ? key : null;
}
