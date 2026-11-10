// 存到本機（P64）的快照格式：把好讀累積頁（buf.pageLines，TermChar[][]）壓成可以放進
// IndexedDB 的純資料，再還原成同形的 TermChar[][] 交給現有渲染鏈。設計見
// docs/saved-articles.md —— 改這支之前先讀它。
//
// 規則：
//   1. **欄位清單只有一份**：term_char_intern.INTERN_FIELDS（TermChar 新增欄位時那邊必須同步，
//      已有守護）。這裡存 ch 以外、needUpdate 以外的全部欄位 ⇒ 還原出來的格子跟存的時候
//      畫出來一模一樣（顏色、全形配對、網址範圍、OSC 8 連結），不必重跑網址偵測。
//   2. 格子屬性高度重複 ⇒ 屬性組合放一張表（attrs），每列存「字串＋(屬性索引, 連續格數) 的
//      run」。一格恆為一個 code unit（docs：unicode_cells.js 檔頭），所以每列的字就是一個字串；
//      萬一某格不是單一 code unit（不該發生），那一列改存字元陣列，不靜默弄錯欄位。
//   3. **讀回來的資料不可信**（IndexedDB 可能是舊版、被別的程式改過、半寫入）：decode 任何一處
//      對不上就回 null，呼叫端當作「這篇壞了」處理，不畫半份。
import { INTERN_FIELDS, internChar } from './term_char_intern';
import { parseArticleLines } from './agent_parse';

export const SAVED_ARTICLE_VERSION = 1;

// 屬性欄位（順序即 attrs 表每一筆的欄位順序；變更要升 SAVED_ARTICLE_VERSION）。
export const ATTR_FIELDS = Object.freeze(
  INTERN_FIELDS.filter((f) => f !== 'ch' && f !== 'needUpdate')
);

function attrKey(cell) {
  let k = '';
  for (let i = 0; i < ATTR_FIELDS.length; ++i) k += String(cell[ATTR_FIELDS[i]]) + '\u0001';
  return k;
}

// rows：TermChar[][]（pageLines）。回傳 { attrs, rows }，全部是 JSON／structured clone 安全的值。
export function encodeRows(rows) {
  const attrs = [];
  const index = new Map();
  const out = new Array(rows.length);
  for (let r = 0; r < rows.length; ++r) {
    const row = rows[r] || [];
    const runs = [];
    let text = '';
    let single = true;
    const chars = new Array(row.length);
    let prev = -1;
    for (let c = 0; c < row.length; ++c) {
      const cell = row[c];
      const ch = cell && typeof cell.ch === 'string' ? cell.ch : ' ';
      if (ch.length !== 1) single = false;
      chars[c] = ch;
      text += ch;
      const key = attrKey(cell || {});
      let ai = index.get(key);
      if (ai === undefined) {
        ai = attrs.length;
        index.set(key, ai);
        attrs.push(ATTR_FIELDS.map((f) => (cell ? cell[f] : undefined)));
      }
      if (ai === prev) runs[runs.length - 1]++;
      else {
        runs.push(ai, 1);
        prev = ai;
      }
    }
    out[r] = single ? { t: text, a: runs } : { c: chars, a: runs };
  }
  return { attrs, rows: out };
}

function validAttr(a) {
  return Array.isArray(a) && a.length === ATTR_FIELDS.length;
}

// enc：encodeRows 的輸出；proto：TermChar.prototype（呼叫端用 Object.getPrototypeOf(buf.attr)
// 拿，這支不 import term_buf）。回傳 TermChar[][]，格子經 internChar 共用（與累積頁同一套）。
export function decodeRows(enc, proto) {
  if (!enc || !Array.isArray(enc.attrs) || !Array.isArray(enc.rows) || !proto) return null;
  if (!enc.attrs.every(validAttr)) return null;
  const out = new Array(enc.rows.length);
  for (let r = 0; r < enc.rows.length; ++r) {
    const row = enc.rows[r];
    if (!row || !Array.isArray(row.a)) return null;
    const chars =
      typeof row.t === 'string' ? row.t : Array.isArray(row.c) ? row.c : null;
    if (chars == null) return null;
    const cells = [];
    let col = 0;
    for (let i = 0; i + 1 < row.a.length; i += 2) {
      const ai = row.a[i];
      const n = row.a[i + 1];
      const attr = enc.attrs[ai];
      if (!attr || !Number.isInteger(n) || n <= 0) return null;
      for (let k = 0; k < n; ++k, ++col) {
        const ch = chars[col];
        if (typeof ch !== 'string') return null;
        const cell = Object.create(proto);
        cell.ch = ch;
        for (let f = 0; f < ATTR_FIELDS.length; ++f) cell[ATTR_FIELDS[f]] = attr[f];
        cell.needUpdate = false;
        cells.push(internChar(cell));
      }
    }
    if (row.a.length % 2 !== 0 || col !== chars.length) return null;
    out[r] = cells;
  }
  return out;
}

export function savedArticleKey(board, aid) {
  return board && aid ? String(board).toLowerCase() + '/' + aid : null;
}

// 一篇存檔的完整紀錄。rows＝pageLines，rowTexts＝同一份的每列文字（buf.getRowText）。
// 身分（board＋aid＋url）由呼叫端取自文末網址列（aid_navigation.findLocalPostAid），
// 讀不到就不存（跟「最近讀過」同一條規則）。
export function buildSavedArticle({ rows, rowTexts, board, aid, url, cols, savedAt }) {
  const key = savedArticleKey(board, aid);
  if (!key || !Array.isArray(rows) || !rows.length) return null;
  const parsed = parseArticleLines(rowTexts || []);
  return {
    v: SAVED_ARTICLE_VERSION,
    key,
    board: String(board),
    aid: String(aid),
    url: url || '',
    title: parsed.title || '',
    author: parsed.author || '',
    time: parsed.time || '',
    cols: cols | 0,
    lineCount: rows.length,
    comments: (parsed.comments || []).length,
    savedAt: savedAt || Date.now(),
    body: encodeRows(rows),
  };
}

// 清單用的摘要（不含內文）。存檔紀錄缺欄位或版本不對 ⇒ null。
export function savedArticleMeta(rec) {
  if (!rec || rec.v !== SAVED_ARTICLE_VERSION || typeof rec.key !== 'string') return null;
  return {
    v: SAVED_ARTICLE_VERSION,
    key: rec.key,
    board: String(rec.board || ''),
    aid: String(rec.aid || ''),
    url: String(rec.url || ''),
    title: String(rec.title || ''),
    author: String(rec.author || ''),
    time: String(rec.time || ''),
    lineCount: rec.lineCount | 0,
    comments: rec.comments | 0,
    savedAt: typeof rec.savedAt === 'number' ? rec.savedAt : 0,
  };
}
