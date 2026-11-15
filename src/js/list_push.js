// P90 列表按推文改出推文列：純邏輯（無 DOM／無網路）。
//
// 使用者在**文章列表**上按 X，PTT 在底列畫推文類型選單（bbs.c#recommend 的 vkey），選單之上
// 仍是列表、游標列還在原篇。這時底部改出跟好讀文章同一條推文列（comment_bar.js 的 list 模式），
// 按送出才由長推文狀態機替使用者按「類型鍵 → 內容 → y」（long_push_session.startFromList）。
//
// 這裡只回答兩件事，任一要素認不出就回 null ＝ 不接手、選單照原生（認不出 ⇒ 原生）：
//   1. 底列是不是**整句**推文類型選單（含禁噓板少了「2.給它噓聲」的版本）；
//   2. 選單之上是不是文章列表、游標列是哪一篇（作者＋主題＋日期）——第二則起是在列表上重按 X，
//      要拿它確認還在同一篇（long_push_anchor.checkCursorAnchor 的 date 欄）。
//
// 為什麼不放寬：這條路會替使用者把字寫進公開看板。push_screen.classifyPushScreen 只看
// 「您覺得這篇文章 」開頭就夠用（那邊是在自己按過 X 之後判讀），這裡是**別人按的 X**、
// 我們要接手送鍵，所以要整句對上 upstream 的字串。
import { parseBoardKey } from './screen_titles';
import { listRowIdentity } from './long_push_anchor';
import { parseListDate, pageArticleNums } from './comment_parse';

// CONFIRMED（pttbbs mbbsd/bbs.c#recommend）：
//   outs("您覺得這篇文章 ");
//   for i in RECTYPE_SIZE: (BRD_NO_DOWNVOTE 跳過 RECTYPE_BAD) prints("%d.", i+1); outs(ctype_long[i]); outc(' ');
//   prints("[%d]? ", RECTYPE_DEFAULT+1);
// ctype_long ＝ 值得推薦／給它噓聲／只加→註解，RECTYPE_DEFAULT＝0。
const MENU_RE = /^您覺得這篇文章 1\.值得推薦 (2\.給它噓聲 )?3\.只加→註解 \[1\]\? *$/;

export function parseListPushMenu(lastRowText) {
  const m = MENU_RE.exec(String(lastRowText || ''));
  if (!m) return null;
  return { booAllowed: !!m[1] };
}

// 列表上 PTT 自己畫的游標記號：新版半形 '>'、舊版全形 '●'（comment_parse.js 的 cursor 兩代）。
// 型別選單一出現，終端機游標就移到底列 ⇒ 找游標列只能看記號。entry 區 [3, rows-2] 裡**剛好一列**
// 有記號才算；零列或兩列以上（殘影、別的畫面）一律認不出。
function cursorMarkRow(rowTexts, rows) {
  let found = null;
  for (let i = 3; i <= rows - 2; ++i) {
    const t = rowTexts[i] || '';
    const c = t.charAt(0);
    if (c !== '>' && c !== '●') continue;
    if (found != null) return null;
    found = i;
  }
  return found;
}

// 推文類型選單一幀 → 要推的那一篇。facts 形狀同 list_session._collectFacts（rowTexts／rows／
// row0Reversed／row2Reversed）。
export function listPushTarget(facts) {
  if (!facts || !facts.rowTexts) return null;
  const rowTexts = facts.rowTexts;
  const rows = facts.rows || rowTexts.length;
  const menu = parseListPushMenu(rowTexts[rows - 1]);
  if (!menu) return null;
  // 列表的頭兩件：row 0 看板標題（反白＋板名）、row 2 欄位表頭（反白＋「編號」）。
  if (!facts.row0Reversed || parseBoardKey(rowTexts[0]) == null) return null;
  if (!facts.row2Reversed || (rowTexts[2] || '').indexOf('編號') < 0) return null;
  const row = cursorMarkRow(rowTexts, rows);
  if (row == null) return null;
  const id = listRowIdentity(rowTexts[row]);
  const date = parseListDate(rowTexts[row]);
  if (!id || !date) return null;
  const nums = pageArticleNums(rowTexts, row);
  return {
    author: id.author,
    subject: id.subject,
    date: date,
    num: nums[row] == null ? null : nums[row],
    row: row,
    board: parseBoardKey(rowTexts[0]),
    booAllowed: menu.booAllowed
  };
}

// 兩次讀到的是不是同一篇（送出那一刻重讀畫面，跟推文列出現時讀到的比）。
export function sameListPushTarget(a, b) {
  return !!(a && b &&
    a.author === b.author &&
    a.subject === b.subject &&
    a.date === b.date &&
    a.row === b.row &&
    a.board === b.board);
}

// TermBuf → listPushTarget 要的 facts（讀 buf 不讀 DOM：DOM 慢一幀）。
export function listPushFactsOf(buf) {
  if (!buf || typeof buf.getRowText !== 'function') return null;
  const rowTexts = [];
  for (let r = 0; r < buf.rows; ++r) rowTexts.push(buf.getRowText(r, 0, buf.cols));
  return {
    rowTexts: rowTexts,
    rows: buf.rows,
    row0Reversed: typeof buf.isUnicolor === 'function' ? buf.isUnicolor(0, 0, 29) : false,
    row2Reversed: typeof buf.isUnicolor === 'function' ? buf.isUnicolor(2, 0, buf.cols - 10) : false
  };
}
