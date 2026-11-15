// 手機精華區卡片（P88，docs/mobile.md「精華區卡片」）的畫面判讀：純函式。
//
// 依據 mbbsd/announce.c（新版 announce_renderer／announce_coldefs／announce_caption，
// CONFIRMED @ 214868b3；舊版 a_showmenu，c20edf04^ 之前）：
//   - row 0：showtitle／redraw_title("精華文章", mtitle) ⇒ 【精華文章】＋中間 mtitle＋右邊《板名》。
//   - 欄位標題列：新版 VCOL「  編號   標  題 … 編  選 … 日  期」在第 2 列（第 1 列是 psb 按鍵說明），
//     舊版 `編號    標      題%56s` 的「編    選      日    期」在第 1 列 ⇒ 字距不同，只認字序。
//   - 每項：`%6d%c%c` 編號＋'.'（一般）／'X'（板主限定 FILE_BM）／')'（隱藏 FILE_HIDE）＋'c'（已標記），
//     標題（item->title 自帶 `◆ `目錄／`◇ `文章／`◎ `複製來的 前綴）、編選者（owner）、`[MM/DD/YY]`。
//     左邊 1 格給游標（`>`／`●`）。
//   - 底列 caption：新版「精華列表」（一般）／「精華管理」（板主）／「標記項目」（複製佇列）；
//     舊版 vs_footer「【功能鍵】」／「【板  主】」／「【已標記(複製) N 項】」。
// 卡片只接「一般瀏覽」那兩種（列表／管理）；標記中（複製佇列）照舊格線：c 標記要看得到。
// 三件（標題列、欄位標題列、底列 caption）任一失配 ⇒ 整個畫面照舊格線（認不出 ⇒ 原生）；
// 單列認不出（parseEssenceRow 回 null）⇒ 該列照舊畫格線。
import { rowHasTitle, ARCHIVE_LIST } from './screen_titles';

export const ESSENCE_HEADER_RE = /編\s*號\s+標\s*題\s+編\s*選\s+日\s*期/;
// 欄位標題列最多出現在第幾列（新版第 2 列，舊版第 1 列）。
const HEADER_MAX_ROW = 2;
export const ESSENCE_HEADER_SCAN_ROWS = HEADER_MAX_ROW + 1;

const NEW_CAPTION_RE = /^\s*(精華列表|精華管理)\s/;
const OLD_CAPTION_RE = /^\s*【\s*(功\s*能\s*鍵|板\s*主)\s*】/;

const ROW_RE = /^([>●])?\s*(\d+)([.X)])(c?)\s+(\S.*?)\s+(\S+)\s+\[(\d{2}\/\d{2}\/\d{2})\]\s*$/;
// ◎（複製來的，announce.c#a_pasteitem 的 copyowner 分支）可能是目錄也可能是文章 ⇒ 'other'（中性圖示）。
const KIND_OF = { '◆': 'dir', '◇': 'file', '◎': 'other' };

// 一列精華區項目 → { num, kind, title, editor, date, cursor, hidden, bmOnly }；不是項目列回 null。
// kind：'dir'（◆）｜'file'（◇）｜'other'（◎ 或沒有已知前綴）；title 已去掉前綴。
export function parseEssenceRow(text) {
  if (typeof text !== 'string') return null;
  const m = ROW_RE.exec(text);
  if (!m) return null;
  let title = m[5];
  let kind = 'other';
  const head = title.charAt(0);
  if (KIND_OF[head]) {
    kind = KIND_OF[head];
    title = title.slice(1).replace(/^\s+/, '');
  }
  if (!title) return null;
  return {
    num: Number(m[2]),
    kind: kind,
    title: title,
    editor: m[6],
    date: m[7],
    cursor: !!m[1],
    hidden: m[3] === ')',
    bmOnly: m[3] === 'X',
  };
}

// 點卡片前的游標檢查：游標列本身是項目列、而且畫著游標記號（`>`／`●`）。不是 ⇒ 不送
// （_sendRowEnter 用 cur_y 算 ↑↓ 次數，游標不在項目上就會開到別項）。
export function essenceCursorRowOk(cursorRowText) {
  const m = parseEssenceRow(typeof cursorRowText === 'string' ? cursorRowText.replace(/\s+$/, '') : null);
  return !!(m && m.cursor);
}

// 底列是不是精華區一般瀏覽的 caption（便宜的第一關）。
export function isEssenceListFooter(lastRowText) {
  return typeof lastRowText === 'string' && (NEW_CAPTION_RE.test(lastRowText) || OLD_CAPTION_RE.test(lastRowText));
}

// 欄位標題列是第幾列；不是精華區列表回 -1。rowTexts：每列文字（至少前幾列與底列）。
export function essenceHeaderRow(rowTexts) {
  if (!Array.isArray(rowTexts) || rowTexts.length < 4) return -1;
  if (!isEssenceListFooter(rowTexts[rowTexts.length - 1])) return -1;
  if (!rowHasTitle(rowTexts[0] || '', ARCHIVE_LIST)) return -1;
  for (let y = 1; y <= HEADER_MAX_ROW && y < rowTexts.length; ++y)
    if (ESSENCE_HEADER_RE.test(rowTexts[y])) return y;
  return -1;
}

// 這個畫面是不是精華區列表。
export function isEssenceListRows(rowTexts) {
  return essenceHeaderRow(rowTexts) >= 0;
}

// 標題列 → 卡片頂端那一列的「Gossip 精華區 › mtitle」：{ board, title }。
// board 取右邊《》，title 是中間那段（目前這一層的名稱）；跟板名一樣（最上層）就不重複。
export function essenceCrumb(row0Text) {
  const t = typeof row0Text === 'string' ? row0Text : '';
  const bm = /《([^》]+)》\s*$/.exec(t.replace(/\s+$/, '')) || /《([^》]+)》/.exec(t);
  const board = bm ? bm[1].trim() : '';
  let mid = t.replace(/^\s*【[^】]*】/, '');
  if (bm) mid = mid.slice(0, mid.lastIndexOf('《'));
  mid = mid.replace(/看板\s*$/, '').trim();
  return { board: board, title: mid && mid !== board ? mid : '' };
}
