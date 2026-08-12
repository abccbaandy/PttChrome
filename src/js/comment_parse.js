// Pure logic for the Enhanced Add-on features (no DOM / no network → easy to test).
//
// Used to detect blacklisted authors/pushers and to number comment floors. Both
// render modes (native 24-row screen and the easy-reading accumulated long page)
// now draw through src/components/Screen.js#computeAnnotations — there is a single
// render path, so this logic is applied in exactly one place.
//
// Mirrors the DBCS handling in src/js/term_buf.js#getRowText and
// src/components/Row/ColorSegmentBuilder.js.

import { b2u, COMMENT_TIME_RE } from './string_util';

// Reconstruct the Unicode text of a row from its TermChar[] (one screen line).
// A DBCS character is stored as a lead byte followed by its second byte; combine
// them with b2u, exactly like TermBuf.getRowText.
export function rowToText(chars) {
  if (!chars) return '';
  let text = '';
  for (let i = 0; i < chars.length; ++i) {
    const c = chars[i];
    if (!c) continue;
    if (c.isLeadByte) {
      const next = chars[i + 1];
      const b5 = c.ch + (next ? next.ch : '');
      text += b5.length === 1 ? b5 : b2u(b5);
      i++; // skip the second byte
    } else {
      text += c.ch;
    }
  }
  return text;
}

// A PTT comment line looks like: "推 userid: text ...   MM/DD HH:MM"
// (噓 / → for boo / arrow). userid starts with a letter then alphanumerics, ≥2
// chars (mirrors official go-bbs `[a-zA-Z][a-zA-Z0-9]+` + the PTT account rule —
// see the cross-validation note below). The id field may be space-padded before
// ':' on some boards (Stock: "推 diefishfish : …"; C_Chat: "推 Haruna1998: …").
// Returns the pusher in lower case so blacklist matching is case-insensitive.
//
// The trailing " MM/DD HH:MM" timestamp (COMMENT_TIME_RE) is REQUIRED: it is what
// distinguishes a real comment from body text written in comment shape (no
// timestamp — e.g. an OP quoting "→ tony :" in the body) and from a "※ 編輯: …"
// line (leading ※, and a MM/DD/YYYY HH:MM:SS time). Without it those rows were
// wrongly numbered as floors. See docs/enhanced-addon.md.
//
// Body text CAN still fake the full shape including the timestamp (C_Chat
// #1g8zcjhj even copies the comment colors with ANSI codes — no per-row signal
// survives). Those fakes are handled by the FloorCounter meta-latch rule below
// (BePTT's algorithm), not by this regex.
//
// Official cross-validation (Ptt-official-app — CONFIRMED terminal byte/format spec
// this scrape逆-parses; sources are GPLv3 so we borrow the format knowledge, not code):
//   - Type prefix bytes — go-pttbbs/ptttype/comment_type.go CommentType.Bytes():
//       推 = ESC[1;37m \xb1\xc0   噓 = ESC[1;31m \xbcN   → = ESC[1;31m \xa1\xf7
//   - Row layout — go-pttbbs/ptt/comments.go FormatCommentString():
//       <typeBytes> <space> ESC[33m<id>ESC[m: <content><padding>ESC[m <IP?> MM/DD HH:MM
//     IP appears iff the board has BRD_IPLOGRECMD; the id is fixed-width iff
//     BRD_ALIGNEDCMT (explains why id alignment / the IP column differ per board).
//     We strip the ANSI upstream (rowToText), so the regex sees plain text; the IP,
//     when present, is absorbed by ".*" before the timestamp.
//   - Floor = record order — go-bbs/user_comment_record.go CommentOrder() (樓層即序號);
//     its id regex `[a-zA-Z][a-zA-Z0-9]+` is what we mirror above.
//   - Official also defines FORWARD/REPLY/EDIT/DELETED types, but on the terminal a
//     轉錄 ("※ id:轉錄至看板 X … MM/DD HH:MM") and 編輯 line lead with ※, so they stay
//     non-comment here and take no floor — matches BePTT's terminal numbering.
//   Regression: tests/unit/comment_parse.test.js "official cross-validation" + fixtures
//   IpComment_M.1621089154.txt / Forward_M.1644506392.txt.
//   - id 長度上限 — common/bbs/names.c#is_validuserid：長度 2..IDLEN、首字 isalpha、
//     其餘 isalnum；include/pttstruct.h `#define IDLEN 12`（fileheader_t.owner 也只有
//     IDLEN+1 bytes）。所以 id 恰是 [A-Za-z][0-9A-Za-z]{1,11}；沒有上限時，內文裡
//     更長的 "推 xxxxxxxxxxxxxx: …" 假冒行會被當成真推文而多吃一個樓層。
const COMMENT_RE = new RegExp(
  /^(推|噓|→)\s+([A-Za-z][0-9A-Za-z]{1,11})\s*:.*/.source + COMMENT_TIME_RE.source
);

// The user id starts at col 3: the 推/噓/→ marker is a 2-col DBCS char (cols 0-1)
// and col 2 is the single space before the id (same gap the floor badge uses).
// So the id occupies cols [COMMENT_USERID_COL, COMMENT_USERID_COL + userid.length).
export const COMMENT_USERID_COL = 3;

export function parseComment(text) {
  if (!text) return null;
  const m = text.match(COMMENT_RE);
  if (!m) return null;
  return { type: m[1], userid: m[2].toLowerCase() };
}

// Per-comment-row annotation used by the single render path (Screen#computeAnnotations,
// for both native and easy-reading modes). Returns null for non-comment rows. `floor`
// advances even for blacklisted rows (they still occupy a floor).
//
// Non-comment rows are NOT a no-op: they feed FloorCounter.nonComment (the BePTT
// reset/latch rule), so every article row must flow through here in order — the
// caller (computeAnnotations) walks the whole `lines` array in sequence.
//
// ctx = {
//   blacklist:      Set<lower id> | undefined
//   showFloorNumbers: bool
//   floorCounter:   FloorCounter   (mutated; caller owns its lifetime/reset)
//   highlightAuthor: bool
//   articleAuthor:  lower id | null   (原PO)
//   selectedPusher: lower id | null   (clicked pusher)
// }
// Result: { type, userid, floor?, hidden, pusher,
//           authorIdStart?, authorIdEnd?, pusherHighlight? }
export function annotateComment(text, ctx) {
  const c = parseComment(text);
  if (!c) {
    if (ctx.showFloorNumbers && ctx.floorCounter) {
      ctx.floorCounter.nonComment(text);
    }
    return null;
  }
  const floor =
    ctx.showFloorNumbers && ctx.floorCounter
      ? ctx.floorCounter.next(c.type)
      : undefined;
  const hidden = !!(ctx.blacklist && ctx.blacklist.has(c.userid));
  const result = { type: c.type, userid: c.userid, floor, hidden, pusher: c.userid };
  if (!hidden) {
    // 原PO comment → highlight only the user-id columns [start, end).
    if (ctx.highlightAuthor && ctx.articleAuthor && c.userid === ctx.articleAuthor) {
      result.authorIdStart = COMMENT_USERID_COL;
      result.authorIdEnd = COMMENT_USERID_COL + c.userid.length;
    }
    // Selected pusher → whole-row highlight.
    if (ctx.selectedPusher && c.userid === ctx.selectedPusher) {
      result.pusherHighlight = true;
    }
  }
  return result;
}

// Article header (first line of a post): "作者  userid (nickname) 看板 board".
// Returns the 原PO id in lower case (for same-author comment highlighting), or
// null when the line is not an author header (e.g. a later page of the article).
const ARTICLE_AUTHOR_RE = /^\s*作者\s+([0-9A-Za-z]+)/;

export function parseArticleAuthor(text) {
  if (!text) return null;
  const m = text.match(ARTICLE_AUTHOR_RE);
  if (!m) return null;
  return m[1].toLowerCase();
}

// Same header line also carries "看板 board"; the board name is what an AID
// link without an explicit board falls back to. Returned as-is (PTT board
// lookup is case-insensitive), or null when the line is not an author header.
const ARTICLE_BOARD_RE = /看板\s+([0-9A-Za-z_-]+)/;

export function parseArticleBoard(text) {
  if (!text) return null;
  const m = text.match(ARTICLE_BOARD_RE);
  return m ? m[1] : null;
}

// Both fields of the header line as ONE event, so callers can't keep a board
// from a PREVIOUS post. 站內信 headers carry 作者/標題/時間 but no 看板 (the field
// only exists in board post files), so a mail's header must CLEAR the tracked
// board — otherwise a suffix-less #AID inside a mail inherits the last board
// read and jumps somewhere unrelated. Returns null when the line is not a
// header at all (later pages of an article), which callers use to keep the
// current value across page-downs.
export function parseArticleHeader(text) {
  const author = parseArticleAuthor(text);
  if (!author) return null;
  return { author: author, board: parseArticleBoard(text) };
}

// Board list column map — 逐欄對 mbbsd/bbs.c#readdoent 的 printf 序列推出來的
// （pttbbs @ c1ff72df；先前是 live 校準值，現已與官方 source 對上）：
//
//   cols  來源                                              內容
//   0-6   prints("%7d", num)                                序號（置底文改印
//                                                           "  " ANSI "  ★ " ＝同寬 7 cells）
//   7     printf 字面 " "                                    空格
//   8     "%c" type                                         ' '/'+'/'~'/'*'/'#'/'m'/'M'/'='/'!'/'s'/'S'/'D'
//   9-10  ESC "[0;1;3%4.4s" 的後 2 字                        推文數（"爆"/"XX"/數字，前 2 字被吃進 ANSI）
//   11-16 prints("%-6.5s", ent->date)（或 IS_LISTING_MONEY   日期 " 6/05" / 金額
//         的 " ---- " / "%5d "）
//   17-29 prints("%-13.12s", ent->owner)                    作者（≤12 字 + ≥1 格 padding）
//   30-31 outs(mark)                                        □ / R: / 轉 / 鎖 / ˇ（2 cells）
//   32    outc(' ')
//   33-   title                                             標題（w = t_columns - 34）
//
// LIST_AUTHOR_COL_END(29) 是 **owner 內容**（%.12s）的 end-exclusive，用來切作者字串；
// 標題區起點是 LIST_TITLE_COL_START(30)，兩者差一格 padding —— 別混用。
// Fail-safe: if the extracted text is not a plain userid we
// return null and the row is NOT hidden, so we never hide a legitimate post by
// mistake. Pinned rows (★) — and, with the OLD cursor generation, the cursor row (●)
// — carry a leading full-width char that shifts the columns; realignListColumns below
// compensates for it. The current '>' cursor is half-width and shifts nothing.
export const LIST_AUTHOR_COL_START = 17;
export const LIST_AUTHOR_COL_END = 29;
export const LIST_TITLE_COL_START = 30;
const USERID_RE = /^[0-9A-Za-z]+$/;

// The board-list keyboard cursor, TWO generations (pttbbs include/common.h):
//
//   舊 STR_CURSOR2 "●"  全形，佔 cells [0,1]：蓋掉 %7d 序號的前導空格 ＋ 最高位
//                       數字。rowToText 折疊 2 cells → 1 char ⇒ 後面每欄左移一格。
//   新 STR_CURSOR  ">"  半形，只佔 cell [0]：蓋掉前導空格，6 位序號完整可見，
//                       欄位不位移。
//
// 切換點＝pttbbs `b9a5029f` "cleanup(cursor): Always do CURSOR_ASCII"（2026-08-11）：
// 廢除 UF_CURSOR_ASCII 使用者旗標，全站強制 ASCII 游標（`mbbsd/stuff.c#cursor_show`
// 一律 `outs(STR_CURSOR)`，看板列表的 `mbbsd/psb.c#psb_default_cursor` 同步）。
//
// **兩代都必須認得**：`tests/e2e/cassettes/*.json` 是舊 server 錄的 raw bytes，
// offline e2e 是 CI gate。只換不加＝ offline 全紅。認得的地方共四處，改一處就要想到
// 另外三處：`parseListArticleNum`（strict）、`parseListArticleNumLoose`（strip 集合）、
// `term_view.js#serverCursorWidth`（還原被蓋的 cell 數，以 `isLeadByte` 判寬）、
// 以及下方的 `hasServerCursorMark`（閃爍底線抑制）。
//
// 反向：**我們自己畫**的假游標（列表好讀視窗）一律 `>`，見 `list_window.js#labelListCursor`。

const OLD_CURSOR_GLYPH = '●'; // ● (STR_CURSOR2，舊 server)

// 終端機游標所在的那一格，是不是 PTT 自己畫的鍵盤游標記號？
//
// 不變量（pttbbs `mbbsd/stuff.c#cursor_show`）：
//     move(row, column); outs(STR_CURSOR); move(row, column);
// 印完游標記號後**把終端機游標移回同一格**，看板列表的 `mbbsd/psb.c#psb_default_cursor`
// 用 `outs(STR_CURSOR "\b")` 達成同樣效果。所以「這一格就是游標記號」＝「PTT 已經自己畫了
// 游標」，此時我們的閃爍底線是重複資訊（term_view.js#refreshCursorVisibility）。
// 反之輸入框／編輯器不走 cursor_show，該格是內容或空白 → 底線照舊顯示。
//
// 半形 '>' 佔一格；舊的全形 ● 是 DBCS pair（cell 存單一 Big5 byte，故走 rowToText 還原）。
export function hasServerCursorMark(line, x) {
  if (!line || x == null || x < 0 || x >= line.length) return false;
  const c = line[x];
  if (!c) return false;
  if (!c.isLeadByte) return c.ch === '>';
  return rowToText(line.slice(x, x + 2)) === OLD_CURSOR_GLYPH;
}

// Pinned rows carry a full-width ★, and the OLD cursor a full-width ●. rowToText
// collapses each 2-cell DBCS glyph to ONE Unicode char, so such a leading wide
// marker shifts every later column LEFT by one — col 17-28 then yields a truncated
// author (e.g. "jhengkunlin" → "hengkunlin"), so the blacklist match (and thus the
// hidden state) silently drops on whichever row the cursor is sitting on. Re-pad one
// space per leading wide char (codepoint > 0x7F within the ASCII prefix region) to
// restore the fixed-column alignment before slicing. Normal rows — and rows under
// the NEW half-width '>' cursor — have an all-ASCII prefix → no padding needed,
// which is exactly right: '>' occupies one cell and shifts nothing.
function realignListColumns(text) {
  let pad = 0;
  for (let i = 0; i < text.length && i < LIST_AUTHOR_COL_START; ++i) {
    if (text.charCodeAt(i) > 0x7f) pad++;
  }
  return pad ? ' '.repeat(pad) + text : text;
}

export function parseListAuthor(text) {
  if (!text || text.length < LIST_AUTHOR_COL_START) return null;
  const row = realignListColumns(text);
  const author = row.substring(LIST_AUTHOR_COL_START, LIST_AUTHOR_COL_END).trim();
  if (!author || !USERID_RE.test(author)) return null;
  return author.toLowerCase();
}

// Board list title column. Same calibration as parseListAuthor: the author field
// ends at LIST_AUTHOR_COL_END (col 29) and the title region (incl. the "R:" reply
// marker / "□"/"轉" state glyph) follows to end of line, e.g.:
//   " 350024 + 2 6/14 a0930307148  R: [閒聊] 烙印勇士384 …"
//   "                              ^29(title region)"
// Returns the title lower-cased for case-insensitive keyword matching, or '' when
// the row is too short. Unlike the author we do NOT validate the shape — any text
// in this region is a candidate for substring keyword matching, and a non-matching
// row is simply never hidden (fail-safe).
export function parseListTitle(text) {
  if (!text || text.length <= LIST_AUTHOR_COL_END) return '';
  // realign so the cursor/pinned row's leading wide marker doesn't shift the title
  // region (keyword matching is substring-tolerant, but keep it consistent).
  return realignListColumns(text)
    .substring(LIST_AUTHOR_COL_END)
    .trim()
    .toLowerCase();
}

// Raw-case variant of parseListTitle, for the quick-add-title-blacklist modal
// prefill: the user edits the REAL title, so casing must be preserved (matching
// itself is case-insensitive — parseTitleBlacklist lower-cases the keywords).
export function parseListTitleRaw(text) {
  if (!text || text.length <= LIST_AUTHOR_COL_END) return '';
  return realignListColumns(text).substring(LIST_AUTHOR_COL_END).trim();
}

// Which quick-blacklist region a screen column falls in on a board-list row.
// Columns are fixed screen cells (欄位表見上方 readdoent 對照)：作者欄 %-13.12s
// 佔 [17, 30)、標題區（mark 起）從 30。col 29 是作者欄自己的 padding 格，屬
// author —— 舊版用 LIST_AUTHOR_COL_END(29) 當標題起點，點在該格會誤判成 title。
// Anything left of the author field (seq/push/date) is neither.
export function listColRegion(col) {
  if (col >= LIST_TITLE_COL_START) return 'title';
  if (col >= LIST_AUTHOR_COL_START) return 'author';
  return null;
}

// Append one entry to a newline-separated blacklist pref string (works for both
// `blacklist` and `titleBlacklist`). Dedup is case-insensitive on trimmed lines;
// returns the new string, or null when nothing needs writing (already present /
// empty entry) so callers can skip the whole persist+sync+redraw pipeline.
export function appendBlacklistEntry(existing, entry) {
  const trimmed = (entry || '').trim();
  if (!trimmed) return null;
  const lines = (existing || '').split('\n');
  const lower = trimmed.toLowerCase();
  for (let i = 0; i < lines.length; ++i) {
    if (lines[i].trim().toLowerCase() === lower) return null;
  }
  const base = (existing || '').replace(/\n+$/, '');
  return base ? base + '\n' + trimmed : trimmed;
}

// Board list article sequence number (the leading numeric column, e.g.
// " 352960 + 4 6/05 author title" → 352960). It is monotonic across the board, so
// list easy reading uses it as the stable de-dup key when accumulating pages and as
// the jump target when opening an article (type the number → cursor jumps there).
// Returns the int, or null for rows where it is not readable: the ★pinned rows
// (公告/置底) which PTT shows as "★" instead of a number, separators, the bottom
// status row, AND — with the OLD full-width cursor only — the keyboard-cursor row.
//
// Cursor handling differs per generation (see the LIST_CURSOR_* block above):
//   舊 ●  overwrites the first 2 cells (leading space + the number's top digit), so
//         the number is genuinely obscured (" 350039" → "●50039") → null. That is
//         deliberate: list easy reading recovers that one row's number from the same
//         article on an adjacent (cursor-free) page (term_view accumulateListLines);
//         a wrong number would corrupt de-dup and jump-to-open.
//   新 >  covers only the leading padding space, so the number is fully readable —
//         the leading '>' is stripped and the row parses like any other. Getting this
//         wrong made facts.cursorRowNum permanently null, so every jump transaction's
//         expect (`facts.cursorRowNum === num`) starved → open/End/Home/prefetch all
//         timed out（使用者實測「文章列表好讀讀取卡住」）.
// A 7-digit board number would fill col 0 and thus be covered by '>' too; the
// neighbour-recovery path still handles it (parseListArticleNumLoose).
export function parseListArticleNum(text) {
  if (!text) return null;
  const m = realignListColumns(text).match(/^[>\s]*(\d+)\s/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

// A deleted-article row: pttbbs paints "-" in the author column for both
// self-deleted 「(本文已被刪除) [author]」 and mod-deleted 「(已被xxx刪除)
// <author>」 rows. parseListAuthor deliberately rejects it (USERID_RE), so slice
// the same realigned column here. These rows cannot be opened (Enter never
// yields an article → the serialized open would time out), so list hiding
// treats them exactly like blacklisted rows.
export function isDeletedListRow(text) {
  if (!text || text.length < LIST_AUTHOR_COL_START) return false;
  const row = realignListColumns(text);
  return row.substring(LIST_AUTHOR_COL_START, LIST_AUTHOR_COL_END).trim() === '-';
}

// Native-mode blacklisted list row → a deleted-article-style notice line, structured
// to match the way pttbbs paints a deleted row so it lines up in the grid:
//   "  62349 + 6 7/09 -            □ （本文已被黑名單） someone"
// The author column is blanked to '-' (12-wide field), then a space + □ state glyph
// at the title column, then the FULL-WIDTH-parenthesised 「（本文已被黑名單）」 (half-
// width ASCII parens break the 2-cell CJK rhythm and skew every following glyph — the
// 「排版歪掉」 bug) and the original author (kept in its original case).
//
// The PREFIX is the RAW (un-realigned) text: under the OLD full-width ● cursor the
// glyph covers cells [0,1] and rowToText collapses it to one char, so a realigned
// prefix would insert a padding space and shift the whole line right (the
// cursor-moves-and-layout-jumps bug). Keeping the raw prefix preserves the cursor
// mark exactly where the server drew it — and the NEW half-width '>' needs no
// compensation at all (one cell, one char). Only the AUTHOR is read from the
// realigned text (the wide cursor shifts that column, so realign is needed to slice
// it). rawPrefixLen = author column minus the count of leading wide glyphs realign
// would have padded.
// Optional `label` overrides the trailing token: author-blacklist hits omit it
// (show the author, the reason IS the author); title-keyword hits pass the
// matched keyword so the notice tells the user WHICH keyword fired.
export function blacklistNoticeText(text, label) {
  const raw = text || '';
  let wide = 0;
  for (let i = 0; i < raw.length && i < LIST_AUTHOR_COL_START; ++i)
    if (raw.charCodeAt(i) > 0x7f) wide++;
  const prefix = raw.substring(0, LIST_AUTHOR_COL_START - wide); // seq + date (+● if cursor)
  const author = realignListColumns(raw)
    .substring(LIST_AUTHOR_COL_START, LIST_AUTHOR_COL_END)
    .trim();
  // '-' at the author column, then pad to the title column (the □ sits one cell past
  // the 12-wide author field, exactly like a deleted row).
  const gap = ' '.repeat(LIST_AUTHOR_COL_END - LIST_AUTHOR_COL_START);
  return prefix + '-' + gap + '□ （本文已被黑名單） ' + (label || author);
}

// A board-list ★pinned (置底/公告) row: it carries normal article columns (a valid
// author, hence a real article) but PTT prints a ★ instead of a sequence number. List
// easy reading accumulates these as ordinary rows keyed by their title (no number to key
// on) instead of dropping them — they live at the very bottom of the board (below the
// newest article), so they naturally end up as the last rows of the ascending buffer.
//
// Distinguishes pinned rows from: status / separator / blank rows (no valid author →
// false) and normal/cursor article rows (a number is present). IMPORTANT: only call this
// on rows whose RECOVERED number (pageArticleNums) is null — under the OLD full-width ●
// cursor the row has no readable number from text alone (the ● covers it) but
// pageArticleNums recovers it from a neighbour, so the caller classifies it as numbered
// before reaching here. Under the NEW '>' cursor the number reads directly, so a
// cursor-on-article row is rejected here on the number alone.
export function isPinnedListRow(text) {
  if (!text) return false;
  if (parseListArticleNum(text) != null) return false;
  return parseListAuthor(text) != null;
}

// Loose variant: the VISIBLE leading digits on a cursor row. With the OLD full-width
// ● the top digit is covered (e.g. "●49886" → 49886, missing the top "3"); with the
// NEW half-width '>' nothing is covered and this agrees with the strict parse.
// Strips a leading cursor-mark/space run, then reads the digit run. Returns null
// when no digits follow (header / a pinned ★ row / status row). Only meaningful
// when paired with recoverCursorArticleNum to restore the covered high-order digit
// from a neighbour. Exported ALSO as the pinned-map guard in accumulateListLines:
// a row with visible digits after stripping the cursor mark is a covered NUMBERED
// row (a mid-response frame can paint the cursor on a row that is not buf.cur_y — no
// neighbour recovery), never a pinned row. `classifyListScreen`'s board-tail
// short-page rule also depends on it (a tail page may hold ONE numbered row).
//
// MUST NOT strip ★: unlike the cursor marks, ★ marks a genuine pinned row and NEVER covers an
// article number (pinned rows have none — PTT prints ★ where the number would go).
// The column right after ★ is the push-count (推文數), which is often a bare integer
// (e.g. "★    4 …", "★   35 …" — announcements without an m/M/=/+ mark). Stripping
// ★ exposed that push count → the guard misread the pinned row as a numbered one and
// dropped it, so those announcements vanished from the buffer (user-reported「部分置底
// 文固定消失」). Leaving ★ in place shields the push count: `^(\d+)` never matches a
// row that still starts with ★ — that holds for BOTH cursor generations (a pinned row
// under the new cursor reads ">   ★ …", the ★ still blocks).
export function parseListArticleNumLoose(text) {
  if (!text) return null;
  const m = text
    .replace(/^[\s●>]+/, '')
    .match(/^(\d+)\b/);
  return m ? parseInt(m[1], 10) : null;
}

// Recover a cursor row's full article number from its visible suffix and a clean
// neighbour's number. The cursor ● covers only the high-order digit(s); board numbers
// are monotonic and neighbours are numerically close, so the covered high part equals
// the neighbour's value rounded to the suffix's magnitude. P = 10^(suffix digit count):
//   recover = round((neighbour - suffix) / P) * P + suffix
// e.g. suffix 49886 (5 digits, P=100000), neighbour 349887 → round(3.00001)*100000+49886
// = 349886. Correct across a high-digit boundary too (suffix 49999, neighbour 350000 →
// 349999). The user's insight: the obscured leading digits match the neighbour's.
export function recoverCursorArticleNum(suffix, neighbor) {
  if (suffix == null || neighbor == null) return null;
  const P = Math.pow(10, String(suffix).length);
  return Math.round((neighbor - suffix) / P) * P + suffix;
}

// Per-row article numbers for one painted board-list page. `rowTexts` are the rows'
// getRowText output (DBCS collapsed), `cursorY` the buf.cur_y of the ●cursor row.
// Returns an array parallel to rowTexts: the article number for real article rows
// (the cursor row recovered from its nearest numbered neighbour), or null for
// header / pinned-★ / status / blank rows. Pure; regression-tested against captured
// live rows in tests/unit. Used by accumulateListLines for monotonic-number de-dup.
export function pageArticleNums(rowTexts, cursorY) {
  const nums = rowTexts.map(parseListArticleNum);
  if (
    cursorY != null && cursorY >= 0 && cursorY < rowTexts.length &&
    nums[cursorY] == null
  ) {
    const suffix = parseListArticleNumLoose(rowTexts[cursorY]);
    if (suffix != null) {
      let neighbor = null;
      for (let d = 1; d < rowTexts.length && neighbor == null; ++d) {
        if (nums[cursorY + d] != null) neighbor = nums[cursorY + d];
        else if (nums[cursorY - d] != null) neighbor = nums[cursorY - d];
      }
      if (neighbor != null) nums[cursorY] = recoverCursorArticleNum(suffix, neighbor);
    }
  }
  // Monotonicity repair: a board list ascends top→bottom, so a numbered row can never be
  // SMALLER than a confirmed earlier one. When PTT leaves the leading digit cell of a row
  // blank (a partial-redraw artifact after the keyboard cursor moves off it — e.g. the
  // newest article 351903 painted as "  51903"), parseListArticleNum reads the truncated
  // value, which is NOT the cursor row so the recovery above misses it. Recover any such
  // drop from the previous confirmed number; recoverCursorArticleNum is a no-op when the
  // value isn't actually truncated (fewer digits → smaller P → real fix; same digits → 0).
  let prev = null;
  for (let i = 0; i < nums.length; ++i) {
    if (nums[i] == null) continue;
    if (prev != null && nums[i] < prev) {
      const fixed = recoverCursorArticleNum(nums[i], prev);
      if (fixed > nums[i]) nums[i] = fixed;
    }
    prev = nums[i];
  }
  return nums;
}

// PTT appends these lines between the article body (incl. signature) and the
// real comments. BePTT latches on them — see FloorCounter.nonComment.
const META_LATCH_RE = /※ (發信站|文章網址): /;

// Running floor counter for an article. seq = overall floor number; sub = ordinal
// within the same type (推/噓/→). Reset per article (new post entered).
//
// Implements BePTT's floor algorithm (decompiled 7.0.9, login-mode telnet parser —
// the behavior the user verified; see docs/enhanced-addon.md):
//   - comment rows take the next floor (next), fake ones in the body included;
//   - until the article's "※ 發信站:"/"※ 文章網址:" line is seen, every
//     non-comment row (blank ones too) zeroes the counters (nonComment);
//   - that meta line is a one-way latch (cleared per article by reset): after it,
//     non-comment rows like "※ 編輯:" never interrupt the numbering.
// Net effect: body/signature fake comments get transient numbers but the meta
// lines always sit between them and the real comments, so real floors start at 1.
// Known BePTT-identical limits: a quoted "※ 發信站" inside a 轉錄 body latches
// early; in articles with no meta lines, a blank row between comments re-counts.
export class FloorCounter {
  constructor() {
    this.reset();
  }

  reset() {
    this.seq = 0;
    this.push = 0;
    this.shu = 0;
    this.arrow = 0;
    this.metaSeen = false;
  }

  // Called (via annotateComment) for every article row that is NOT a comment.
  nonComment(text) {
    if (!this.metaSeen) {
      this.seq = 0;
      this.push = 0;
      this.shu = 0;
      this.arrow = 0;
    }
    if (text && META_LATCH_RE.test(text)) {
      this.metaSeen = true;
    }
  }

  next(type) {
    this.seq++;
    let sub;
    if (type === '推') sub = ++this.push;
    else if (type === '噓') sub = ++this.shu;
    else sub = ++this.arrow;
    return { seq: this.seq, sub, type };
  }
}

// Cross-page de-duplication for easy reading. When PTT pages down, the top of the
// new screen re-displays the bottom rows of the previous screen (the overlap);
// genuinely new content follows. Returns how many top rows of `newText` are that
// re-display (= rows to skip before appending).
//
// PURE CONTENT COMPARISON — deliberately does NOT use PTT's status-line row numbers
// ("目前顯示: 第 N~M 行"). The old arithmetic (rowIndexStart vs a self-counted
// actualRowIndex, plus the首頁 `i==4` hack) mis-counted by 1 and dropped the first
// comment. BePTT (same ws.ptt.cc/bbs telnet client) likewise carries no status-line
// parsing — content overlap is the robust signal. See docs/enhanced-addon.md.
//
// Both inputs are arrays of row text (caller maps TermChar[] via rowToText). Trailing
// whitespace is normalised so padding differences don't break a match.
export function findPageOverlap(accText, newText) {
  const maxK = Math.min(accText.length, newText.length);
  // Largest plausible overlap first: PTT only re-shows the overlap region, so rows
  // above it are absent from the new screen — a k larger than the true overlap would
  // need coincidentally-repeated content across the boundary (rare).
  for (let k = maxK; k >= 1; --k) {
    let ok = true;
    let hasContent = false;
    for (let i = 0; i < k; ++i) {
      const a = accText[accText.length - k + i].replace(/\s+$/, '');
      const b = newText[i].replace(/\s+$/, '');
      if (a !== b) {
        ok = false;
        break;
      }
      if (b.trim() !== '') hasContent = true;
    }
    // Require ≥1 non-blank row in the matched block: a purely-blank "overlap" is
    // ambiguous, so fall through to 0 (append all) rather than risk eating content.
    if (ok && hasContent) return k;
  }
  return 0; // no overlap → append the whole screen
}

// Resolve how many top rows of the new screen to skip when accumulating an easy-reading
// page, using PTT's status-line row numbers ("目前顯示: 第 S~E 行") as the PRIMARY signal
// and findPageOverlap's content result (kContent) as cross-check / fallback.
//
// Why status-primary: content comparison returns the LARGEST text-matching run, so on a
// half-painted intermediate frame (a row in the true overlap not yet settled) it locks
// onto a SMALLER k → the caller re-appends already-accumulated rows → a duplicate block
// on screen (hard to reproduce, not article-specific — it's a render/timing race). The
// status numbers are PTT's absolute article-line numbers: as long as parseStatusRow
// matched, they are exact regardless of paint state, so they recover the true overlap.
//
// The status numbers had historically been mis-used (off-by-1 floor counting, 首頁 i==4
// hack — see findPageOverlap comment). Here we only use them for overlap sizing, bounded
// to [0, maxK], with a drift guard against a wrong (discontinuous) accEndRow.
//
// accEndRow  = article-line number of the last accumulated row (prev screen's rowIndexEnd)
// statusStart = new screen's rowIndexStart. maxK = min(accTail.length, newTexts.length).
// accTail/newTexts (optional) = the row texts findPageOverlap compared, for the guard.
export function resolvePageOverlap({ accEndRow, statusStart, kContent, maxK, accTail, newTexts }) {
  if (accEndRow == null || statusStart == null) return kContent; // no tracking → content
  // A NEGATIVE raw overlap means statusStart ran past accEndRow — pmore invariant P1
  // says that cannot happen on a PageDown, so it is a LOST PAGE, not an overlap of 0.
  // classifyPageTransition catches it upstream ('gap' branch) and the caller self-heals;
  // if one still reaches here, fall back to the content-proven overlap instead of
  // pretending the pages are adjacent.
  const kStatus = Math.max(0, Math.min(maxK, accEndRow - statusStart + 1));

  // kContent is the LARGEST text-matching run, i.e. a proven lower bound of the overlap:
  // those rows genuinely re-appear and MUST be skipped, so never go below it (going below
  // re-appends real duplicates — long article "行" can wrap across display rows, making the
  // arithmetic kStatus smaller than the true display-row overlap). Status only helps in the
  // OTHER direction: a half-painted frame left a row in the overlap unsettled so content
  // under-counted — then kStatus > kContent recovers the rows content missed.
  if (kStatus <= kContent) return kContent;

  // kStatus > kContent. Trust status UNLESS accEndRow drifted (tracking lost continuity),
  // which would make kStatus point at rows that share ~nothing with the accumulated tail →
  // trusting it could eat genuinely-new content. Distinguish a paint glitch (a few overlap
  // rows differ, most still match) from drift (almost none match).
  if (accTail && newTexts) {
    let nonBlank = 0;
    let matched = 0;
    for (let i = 0; i < kStatus; ++i) {
      const b = (newTexts[i] || '').replace(/\s+$/, '');
      if (b.trim() === '') continue;
      ++nonBlank;
      const a = (accTail[accTail.length - kStatus + i] || '').replace(/\s+$/, '');
      if (a === b) ++matched;
    }
    // ratio < 0.5 → the status-implied region barely matches → treat as drift, fall back.
    if (nonBlank > 0 && matched / nonBlank < 0.5) return kContent;
  }
  return kStatus;
}

// Classify how the newly painted article page relates to what we have accumulated,
// using PTT's absolute file-line numbers from the status row. This is the CLIENT-SIDE
// expression of pmore invariant P1 (docs/pttbbs-screen-protocol.md §13):
//
//   PageDown == mf_forward(mf.dispedlines - 1)   (pmore.c#PMORE_UINAV_FORWARDPAGE)
//
// i.e. the next screen's FIRST file line is exactly the current screen's LAST file
// line (`S' == E`), because pmore advances by one less than what it displayed. Near
// the end of the article mf_forward is clamped by mf.maxdisps so the new screen can
// start EARLIER (`S' < E`, a bigger overlap) — but it can NEVER start later.
//
// ⇒ `S' > E + 1` is impossible for a single PageDown. Observing it proves at least
//   one whole screen was never received — the typeahead-skip failure mode (P4:
//   pfterm.c#refresh returns without drawing while client keys are still queued), i.e.
//   permanently lost article text. The old code hid this: resolvePageOverlap clamped
//   the negative overlap to 0 and appended anyway, leaving a silent hole.
//
// `S' == E + 1` (zero overlap) is tolerated as a continuation: pmore's `if (i < 1) i = 1`
// guard makes it reachable when a screen displays a single file line.
//
// Returns null when there is no status row to judge from (transient half-painted
// frame) — the caller falls back to its own transient handling.
export function classifyPageTransition({ accEndRow, statusStart, statusEnd }) {
  if (statusStart == null) return null;
  if (statusStart === 1 || accEndRow == null) return 'restart';
  if (statusStart > accEndRow + 1) return 'gap';
  if (statusEnd != null && statusEnd < accEndRow) return 'backward';
  return 'continuation';
}

// Branch decision for term_view.accumulatePageLines — 'rebuild' (restart pageLines
// as this screen) | 'append' (continuation de-dup) | 'skip' (transient/incomplete
// frame) | 'gap' (P1 violated: a page was lost, caller must self-heal).
//
// Fixes the [ ] same-title-jump pile-up: leaveCurrentPost's one-shot prevPageState=0
// gets consumed by a stale old-article frame (redraw rewrites prevPageState=pageState
// every frame), so the NEW article's first page took the continuation branch and got
// concatenated under the old one — permanently, since accEndRow then tracks the new
// pages. Two independent defences:
//   sticky   — pendingReset (buf.easyReadingPendingReset) is only consumed on a
//              CONFIRMED first article page (statusStart===1), so stale frames
//              can't eat it;
//   self-heal — first page (statusStart===1) with ZERO content overlap AND a
//              CHANGED first row (the article header/author line) cannot be
//              "the next page of the same article" → force rebuild even if some
//              unknown path lost the flag. headerChanged is required: a
//              half-painted repaint of the SAME article's first page also shows
//              statusStart===1 with kContent 0 (rows not settled yet) — without
//              the header check it would wrongly restart accumulation
//              (stock-end offline regression). The caller compares row 0 texts
//              (both non-blank and different).
// statusStart==null (no status row = transient/half-painted frame): keep the current
// behaviour — skip while continuing (prevPageState 3), rebuild otherwise.
//
// `complete` (pmore invariant P6) is the THIRD defence and the one that removes the
// root cause of the two above: pfterm parks the cursor at (rows-1, cols-1) only at the
// very END of a server response, and the footer is a per-cell patch — so a half-painted
// frame still carries the PREVIOUS page's line numbers. Accumulating off such a frame
// makes _accEndRow drift, which is what forced resolvePageOverlap to grow its
// match-ratio drift guard. Only an explicit `false` gates (callers pass a real boolean;
// the older call sites that omit it are testing the branch logic itself).
//
// `transition` comes from classifyPageTransition: 'gap' means pmore invariant P1 was
// violated (a whole screen was lost) — the caller must self-heal rather than append a
// hole. Checked after the first-page rebuild so a genuine restart still wins.
// `healInFlight` (buf.easyReadingHealInFlight) — easy reading is seeking back to a
// swallowed page with pmore's goto-line (`:N\r`, see EasyReading._healAtLine). While
// the 「跳至第幾行:」 prompt occupies the bottom row there is no status row, so that
// frame can classify as a non-article pageState — and term_view.redraw writes
// buf.prevPageState on EVERY rendered frame, so the landing frame would then take the
// `prevPageState !== 3 → rebuild` route and restart pageLines from the MIDDLE of the
// article, silently discarding everything above it. Both rebuild routes are therefore
// suppressed for the duration; 'gap' and the P6 'skip' deliberately still apply, so
// neither the escalation path nor the half-frame guard is weakened.
export function decideAccumulateBranch({
  complete,
  prevPageState,
  pendingReset,
  statusStart,
  kContent,
  hasAcc, // eslint-disable-line no-unused-vars -- kept for call-site readability
  headerChanged,
  transition,
  healInFlight
}) {
  if (complete === false) return 'skip';
  if (!healInFlight && prevPageState !== 3) return 'rebuild';
  if (statusStart == null) return 'skip';
  if (!healInFlight && statusStart === 1 && (pendingReset || (kContent === 0 && headerChanged)))
    return 'rebuild';
  if (transition === 'gap') return 'gap';
  return 'append';
}

// Build a lower-cased Set from the newline-separated blacklist textarea value.
export function parseBlacklist(str) {
  const set = new Set();
  if (!str) return set;
  str
    .split(/\r?\n/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .forEach(id => set.add(id));
  return set;
}

// Build a lower-cased keyword list from the newline-separated title-blacklist
// textarea value. Unlike parseBlacklist (exact userid match) these are substring
// keywords matched against the post title, so order/duplicates don't matter — a
// plain array is enough.
export function parseTitleBlacklist(str) {
  if (!str) return [];
  return str
    .split(/\r?\n/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

// Returns the FIRST keyword the (already lower-cased) title contains, or null.
// Truthy iff blacklisted, so boolean call sites (list_session hide check) keep
// working; the keyword itself feeds the notice line (「命中的關鍵字」 display).
export function matchTitleBlacklist(title, keywords) {
  if (!title || !keywords || !keywords.length) return null;
  return keywords.find(k => title.includes(k)) ?? null;
}
