// 手機「分類看板」根目錄大按鈕（P99）的畫面判讀：純函式，零 DOM。
//
// 依據 mbbsd/board.c（CONFIRMED @ 647cd67a）：分類根＝IN_CLASSROOT()（class_bid == 1）。
//   - brdlist_header：redraw_title("分類看板", BBSNAME) ⇒ 第 0 列【分類看板】；第 1～6 列是寫死的
//     ANSI 圖（header_lines 7）。
//   - show_brdinfo 的 IN_CLASSROOT 分支：prints("          %s%s%*s %s", col_num, t_desc, …, t_bm)
//       col_num ＝ "%7d%c%s"（編號、隱藏記號 ' '／')'／'-'、"D "／"  "／未讀 "ˇ"）或
//                  "%7sX%s"（無權看）或 10 個空白（未讀模式下的群組）
//       t_desc  ＝ bh.desc（截到 40 欄；後面補空白到 40 欄）。分類群組的 desc 是「名稱＋多個空白＋
//                  說明」寫在同一欄（util/initbbs.c 的預設：「市民廣場     報告  站長  ㄜ！」）
//       t_bm    ＝ 板主欄，第 61 欄起，80 欄時只剩 12 欄寬（max_bm＝t_columns-68）
//     ⇒ 第 0～9 欄空白、10～19 欄＝編號區、20～59 欄＝desc（第一段 ≥2 個空白切成名稱／說明）、
//       61 欄起＝板主（desc 裡沒有說明時才拿來當說明）。
//   - brdlist_cursor：cursor_show(y, 10)（`>` 或 `●`，蓋在編號區開頭）。
//   - 底列：新版 vs_cmd_bar(VS_FOOTER, "分類看板", …)；舊版（03cdf5eb board.c:1285）三種看板列表
//     共用 caption「選擇看板」（docs/pttbbs-screen-protocol.md「底列 caption」）。另收 show_status()
//     的狀態列（menu_items.js 檔頭記的版本，string_util.parseListRow 新舊都吃）。標題列已經限定
//     【分類看板】，底列只是第二要素。
// 三件（標題、底列、至少一列群組）任一失配 ⇒ 整個畫面照舊格線（認不出 ⇒ 原生）；單列認不出
// ⇒ 該列照舊（收起）。
import { rowHasTitle, CLASS_LIST } from './screen_titles';
import { charCells, parseListRow } from './string_util';

// 群組列從第幾列起（header_lines 7）。
export const CLASS_ROOT_FIRST_ROW = 7;

const FOOTER_RE = /^\s*(?:分類看板|選擇看板)\s/;
const NUM_AREA_RE = /^([>●]?)\s*(\d*)\s*([)\-X]?)\s*(?:ˇ|D)?\s*$/;

function toCells(text) {
  const cells = [];
  for (const ch of text) {
    cells.push(ch);
    if (charCells(ch) === 2) cells.push('');
  }
  return cells;
}

// 一列 → { num, name, desc, cursor }；不是群組列回 null。num 可能是 null（未讀模式下的群組）。
export function parseClassRootRow(text) {
  if (typeof text !== 'string') return null;
  const cells = toCells(text.replace(/\s+$/, ''));
  if (cells.length <= 20) return null;
  for (let i = 0; i < 10; ++i) if (cells[i] !== ' ') return null;
  const area = NUM_AREA_RE.exec(cells.slice(10, 20).join(''));
  if (!area) return null;
  // desc 從第 20 欄開始（前一格是空白或未讀記號的右半）；板主欄在第 61 欄起。
  if (cells[20] === ' ' || cells[20] === '') return null;
  const field = cells.slice(20, 61).join('').trim();
  if (!field) return null;
  const cut = /\s{2,}/.exec(field);
  const name = cut ? field.slice(0, cut.index) : field;
  const bm = cells.slice(61).join('').trim();
  // 編號區整段空白時（未讀模式下的群組）只剩欄位位置可認：選單項「(X)desc」剛好也從第 20 欄起
  // （menu.c#menu_renderer），擋掉。
  if (!area[1] && !area[2] && /^\([0-9A-Za-z]\)/.test(name)) return null;
  const desc = cut ? field.slice(cut.index).trim() : bm;
  return {
    num: area[2] ? Number(area[2]) : null,
    name: name,
    desc: desc,
    cursor: !!area[1],
  };
}

// 底列是不是分類根的狀態列（新版 caption 或舊版 show_status）。
export function isClassRootFooter(lastRowText) {
  if (typeof lastRowText !== 'string') return false;
  return FOOTER_RE.test(lastRowText) || parseListRow(lastRowText);
}

// 整個畫面是不是分類根：標題、底列、至少一列群組。rowTexts：每列文字。
export function isClassRootRows(rowTexts) {
  if (!Array.isArray(rowTexts) || rowTexts.length < CLASS_ROOT_FIRST_ROW + 2) return false;
  if (!rowHasTitle(rowTexts[0] || '', CLASS_LIST)) return false;
  if (!/^【\s*分類看板\s*】/.test(rowTexts[0])) return false;
  if (!isClassRootFooter(rowTexts[rowTexts.length - 1])) return false;
  for (let y = CLASS_ROOT_FIRST_ROW; y < rowTexts.length - 1; ++y)
    if (parseClassRootRow(rowTexts[y])) return true;
  return false;
}

// 點卡片前的游標檢查：游標列本身是群組列、而且畫著游標記號（_sendRowEnter 用 cur_y 算
// ↑↓ 次數，游標不在群組列上就會進到別的群組）。
export function classRootCursorRowOk(cursorRowText) {
  const m = parseClassRootRow(cursorRowText);
  return !!(m && m.cursor);
}
