// 看板列表列的「終端機欄位」解析（live e2e 用，純函式，unit 守護在
// tests/unit/e2e_list_row_columns.test.js）。
//
// 為什麼不能直接 substring：畫面字串（buf.getRowText / DOM textContent）裡一個全形字
// 是 1 個 JS char，卻佔 2 個終端機欄位（PTT 是 Big5：byte > 0x7f 的字一律雙寬，同
// term_buf.isFullWidth）。推文數欄的「爆」、置底的 ★、舊游標 ● 都會讓後面的欄位在
// JS 索引上左移一格 ⇒ 作者被砍頭（實例："350570 +爆 9/28 laptic" 切出 "aptic"）。
//
// 欄位依據（0-indexed，end-exclusive）：cols 0-6 序號、17-29 作者
// （= src/js/comment_parse.js 的 LIST_AUTHOR_COL_START/END）。

const LIST_NUM_COLS = [0, 7];
const LIST_AUTHOR_COLS = [17, 29];
const USERID_RE = /^[0-9A-Za-z]+$/;

const cellWidth = (ch) => (ch.charCodeAt(0) > 0x7f ? 2 : 1);

// 取出落在終端機欄位 [start, end) 內的字。雙寬字只要有一半在區間外就不收
// （不會切出半個字）。
function sliceColumns(text, start, end) {
  let col = 0;
  let out = '';
  for (const ch of text || '') {
    const w = cellWidth(ch);
    if (col >= start && col + w <= end) out += ch;
    col += w;
    if (col >= end) break;
  }
  return out;
}

// 列表索引列的作者（保留原大小寫）；不是合法帳號形狀回 ''。
function listRowAuthor(text) {
  const a = sliceColumns(text, LIST_AUTHOR_COLS[0], LIST_AUTHOR_COLS[1]).trim();
  return USERID_RE.test(a) ? a : '';
}

// 一般文章索引列：序號欄（可帶游標標記 '>' 或舊的全形 '●'）是數字，且作者欄合法。
// 置底列序號欄是 ★ 沒有數字 → 不算。
function isListIndexRow(text) {
  const num = sliceColumns(text, LIST_NUM_COLS[0], LIST_NUM_COLS[1]);
  return /^[\s>●]*\d+$/.test(num) && listRowAuthor(text) !== '';
}

module.exports = { sliceColumns, listRowAuthor, isListIndexRow };
