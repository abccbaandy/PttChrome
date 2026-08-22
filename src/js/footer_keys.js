// PTT 畫面上「功能鍵提示列」的解析 —— 純函式，零 DOM、零狀態。
//
// 目的：把 `[←]離開 [→]閱讀 [Ctrl-P]發表文章 [d]刪除 …` 與
// ` 文章選讀  (y)回應(X)推文(^X)轉錄 …` 裡的每一組括號變成可點按鈕。
//
// pttbbs 原始碼校準（依 CLAUDE.md「PTT 邏輯不准猜」逐條查證，不是從畫面反推）：
//   mbbsd/bbs.c:663      readtitle()：showtitle() 佔 row 0，緊接 outs("[←]離開 …\n")
//                        ⇒ 看板文章列表的提示列固定在 **row 1**
//   mbbsd/board.c:1330   看板列表：outs("[←][q]回上層 [→][r]閱讀 [↑↓]選擇 …\n")
//                        ⇒ 同樣在 row 1
//   mbbsd/vtuikit.c:722  vs_footer()：一律 move(b_lines, 0) ⇒ 固定在**最後一列**；
//                        `(` / `)` 在該函式裡有獨立配色，是「一個按鍵」的視覺約定
//   mbbsd/pmore.c:2195   文章 footer part3 = "(h)按鍵說明 " + "←[q]離開 "
//                        （`←` 是裸的、沒有括號 ⇒ 依規則不可點；相鄰的 `[q]` 可點且同義）
//   mbbsd/pmore.c:2548   KEY_LEFT 與 'q' 同義（flExit = 1）
//
// **只認單一按鍵**。`(=[]<>)`（同標題前後篇）、`(/?a)`（搜尋）、`(v/V)`（已讀／未讀）、
// `(R/y)`、`[↑↓]` 這種多鍵組一律不產出候選：取第一個會送錯鍵（`v` 標已讀 vs `V` 標
// 未讀、`d` 刪一封 vs `D` 刪範圍，語意完全不同），違反「PTT 邏輯不准猜」。
//
// **一定要吃 TermChar[] 而不是 rowToText 的產物**：rowToText 把 DBCS 的 lead+trail
// 兩格折成一個字元 ⇒ 文字 index ≠ 格子 col，而 footer 一列有十幾個全形字，偏移是
// 累加的。且 `]` = 0x5D **落在 Big5 trail byte 範圍內**，對裸位元組跑 regex 會誤命中。
// 專案既有慣例是逐格走 chars、isLeadByte 就跳兩格（先例：mention_parse.js、
// bare_domain.js、aid_parse.js），這裡照做。

import { b2u, unescapeStr } from './string_util';
import { KeyMap } from './term_keyboard';

// 具名鍵 → 送出的 byte 序列。**一律轉接 KeyMap**（term_keyboard 的同一份表），
// 不另抄第三份，否則哪天改了跳脫序列這裡會靜默對不上。
const NAMED_KEYS = {
  '←': KeyMap['ArrowLeft'],
  '→': KeyMap['ArrowRight'],
  '↑': KeyMap['ArrowUp'],
  '↓': KeyMap['ArrowDown'],
  'PgUp': KeyMap['PageUp'],
  'PgDn': KeyMap['PageDown'],
  'Home': KeyMap['Home'],
  'End': KeyMap['End'],
  'Enter': KeyMap['Enter'],
  'Esc': KeyMap['Escape'],
  'Tab': KeyMap['Tab'],
  '空白鍵': ' '
};

// `Ctrl-P` / `Ctrl-p` / `CTRL-P` → `^P`（再交給 unescapeStr）。PTT 兩種寫法都出現過
// （bbs.c 用 `[Ctrl-P]`、pmore/編輯器用 `(^X)`）。
const CTRL_RE = /^Ctrl-([@-_?])$/i;

// 一列的 TermChar[] → { text, colOf }。
// text 的折疊規則與 comment_parse.rowToText **完全相同**（含 b2u）；
// colOf[k] = 第 k 個文字字元的**起始格號**，長度 = text.length + 1，
// 最後一項是列尾（＝chars.length），供 exclusive 邊界直接取用。
export function decodeRowWithCols(chars) {
  let text = '';
  const colOf = [];
  if (!chars) return { text, colOf: [0] };
  for (let i = 0; i < chars.length; ++i) {
    const c = chars[i];
    if (!c) continue;
    colOf.push(i);
    if (c.isLeadByte) {
      const next = chars[i + 1];
      const b5 = c.ch + (next ? next.ch : '');
      text += b5.length === 1 ? b5 : b2u(b5);
      i++; // 跳過 trail byte
    } else {
      text += c.ch;
    }
  }
  colOf.push(chars.length);
  return { text, colOf };
}

// 括號內那一串 → 要送出的 bytes（不是單一按鍵則回 null）。
export function keyBytesFor(inner) {
  if (!inner) return null;
  if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, inner)) {
    return NAMED_KEYS[inner];
  }
  const ctrl = CTRL_RE.exec(inner);
  if (ctrl) {
    // unescapeStr 只認大寫的 ^@..^_（與 ^?），先正規化。
    return unescapeStr('^' + ctrl[1].toUpperCase());
  }
  if (inner.length === 2 && inner.charAt(0) === '^') {
    const out = unescapeStr(inner);
    // 不是合法的 caret notation 時 unescapeStr 會原樣吐回（長度仍是 2）。
    return out.length === 1 ? out : null;
  }
  if (inner.length === 1) {
    const code = inner.charCodeAt(0);
    // ASCII 可見字元才算按鍵。空白與 DEL 以上一律不認。
    if (code > 0x20 && code < 0x7f) return inner;
  }
  return null;
}

// 純字串層的 token 掃描（好寫 unit）。回傳的 start/end 是**文字空間**的 index，
// end 為 exclusive，**範圍包含括號本身**。
//
// 為什麼連括號一起：邊界因此必落在 ASCII 的 `(` `[` `)` `]` 上，絕不會切在 DBCS
// 的 trail cell 中間（與 docs/mouse.md 的邊界原則一致），順帶讓點擊區大一點。
export function findFunctionKeyTokens(text) {
  const out = [];
  if (!text) return out;
  for (let i = 0; i < text.length; ++i) {
    const open = text.charAt(i);
    const close = open === '[' ? ']' : open === '(' ? ')' : null;
    if (!close) continue;
    const end = text.indexOf(close, i + 1);
    if (end < 0) continue;
    const inner = text.slice(i + 1, end);
    // 巢狀／跨組保護：內層不得再出現任何括號（`(=[]<>)` 因此在這裡就被擋掉，
    // 不必等 keyBytesFor）。
    if (/[[\]()]/.test(inner)) {
      continue;
    }
    const keyBytes = keyBytesFor(inner);
    if (keyBytes == null) continue;
    out.push({ start: i, end: end + 1, inner, label: open + inner + close });
    i = end; // 同一組括號不重複掃
  }
  return out;
}

// TermChar[] → 格子空間的可點功能鍵。
// endCol 為 **exclusive**，與 aids / mentions 同語意（LinkSegmentBuilder.readChar 的 i）。
export function parseFunctionKeys(chars) {
  if (!chars || !chars.length) return null;
  const { text, colOf } = decodeRowWithCols(chars);
  const tokens = findFunctionKeyTokens(text);
  if (!tokens.length) return null;
  const out = [];
  for (const t of tokens) {
    const startCol = colOf[t.start];
    const endCol = colOf[t.end];
    if (startCol == null || endCol == null || endCol <= startCol) continue;
    out.push({
      startCol,
      endCol,
      keyBytes: keyBytesFor(t.inner),
      label: t.label
    });
  }
  return out.length ? out : null;
}

// 這個畫面要掃哪幾列。
//
// **由 term_view 算好交給 computeAnnotations**，不在標註層自行推導：好讀累積長頁的
// lines 是 buf.pageLines（數千列），`lines.length - 1` 是**內文最後一行**而不是狀態
// 列，推導必錯。回 null ＝這個畫面沒有功能鍵列。
export function functionKeyRows(pageState, rows) {
  if (!rows || rows < 2) return null;
  switch (pageState) {
    // 1 MENU（主功能表／看板列表）、2 LIST（文章列表）、4 LIST 變體：
    // 提示列在 row 1（bbs.c:663 / board.c:1330），vs_footer 在最後一列。
    case 1:
    case 2:
    case 4:
      return [1, rows - 1];
    // 3 READING：pmore 只有底部 footer。
    case 3:
      return [rows - 1];
    default:
      return null;
  }
}
