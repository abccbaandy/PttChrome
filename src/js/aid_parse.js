// PTT article-code (AID) detection for the easy-reading auto-link feature.
// Pure logic (no DOM / no network → unit-testable). Finds "#XXXXXXXX" tokens
// in one screen row plus an optional board suffix "(Board)" / "@Board"; the
// click-to-navigate behaviour lives in src/js/aid_navigation.js.
//
// Format (verified against pttbbs @ c1ff72df, mbbsd/aids.c + mbbsd/stuff.c):
// aidu2aidc() 以 aidu2aidc_table = "0123456789A-Za-z-_"（64 字）逐位取模，寫進
// buf[0..7] ⇒ 產出的 AIDc **恆為 8 字**，字元集就是本檔 isAidChar 的那組。
// 反向的 aidc2aidu() 反而不限長度（讀到 '\0' 或空白為止），但畫面上出現的一律
// 是產生端的 8 字形式，所以這裡用「恰 8 字」當判準是對的（第 9 字仍是 AID 字元
// ⇒ 那是別的識別碼，不是 AIDc）。
// 官方 footer（bbs.c，AID_DISPLAYNAME/AID_HOSTNAME）：
//   文章代碼(AID): #1gIeu-3A (Android) [ptt.cc]
// and cross-board references are conventionally "#AID (Board)" or "#AID@Board".
//
// Like mention_parse.js we walk the TermChar[] columns and skip DBCS pairs
// (isLeadByte → advance 2) so Big5 trail bytes can never fake a '#' or an AID
// char, and the returned columns are real TermChar indices for
// LinkSegmentBuilder.readChar(ch, i).

import { rangeInTermUrl } from './term_url_flag';
import { parseArticleUrl } from './aid_codec';

export const AID_LEN = 8;

// 合併推文塊的「兩則之間」cell（comment_merge.buildMergedCommentChars 造的 '\n'）。
export const NEWLINE = "\n";

export function isAidChar(c) {
  return (
    (c >= "A" && c <= "Z") ||
    (c >= "a" && c <= "z") ||
    (c >= "0" && c <= "9") ||
    c === "-" ||
    c === "_"
  );
}

// Board names on PTT are [0-9A-Za-z_-]{2,}; single chars are never boards.
function readBoardToken(chars, j) {
  let board = "";
  while (j < chars.length) {
    const cj = chars[j];
    if (!cj || cj.isLeadByte || !isAidChar(cj.ch)) break;
    board += cj.ch;
    j++;
  }
  return { board, next: j };
}

function isPlainCell(chars, j, ch) {
  return !!chars[j] && !chars[j].isLeadByte && chars[j].ch === ch;
}

// Optional suffix right after the AID (or after one space): "(Board)" or
// "@Board". Returns the board name or null; never affects the link columns.
//
// 分隔段允許 [空白?] [換行?] [空白?]：'\n' cell 只在「連續同作者推文合併」重組出來的
// chars 裡出現（comment_merge.buildMergedCommentChars），代表兩則推文的邊界。使用者
// 實際寫法就是把 AID 打在一則的結尾、看板打在下一則的開頭：
//   推 someone: ...有興趣可到  #1gU3wwNZ      08/26 22:17
//   →  someone: (Browsers) 體驗(懷舊?)        08/26 22:17
// 少了這一步 board 就是 null → 退回「目前文章所在看板」→ 跳轉必失敗（實錄見
// docs/enhanced-addon.md「跨行 AID 接合」）。
// 這裡刻意**不**比照 url_wrap 要求 leftFull／同分鐘：看板 token 本來就要 2 字以上的
// [0-9A-Za-z_-] ＋閉合 ')'，誤判成本只是「跳到不存在的看板」（PTT 自己會擋）；而真實
// 現場的左側那則收尾還剩 6 格空白，要求「寫滿內容欄」反而會漏掉它。
export function parseBoardSuffix(chars, j) {
  const n = chars.length;
  if (j < n && isPlainCell(chars, j, " ")) j++;
  if (j < n && isPlainCell(chars, j, NEWLINE)) {
    j++;
    if (j < n && isPlainCell(chars, j, " ")) j++;
  }
  if (j >= n || !chars[j] || chars[j].isLeadByte) return null;
  const ch = chars[j].ch;
  if (ch === "(") {
    const { board, next } = readBoardToken(chars, j + 1);
    const closed =
      next < n && chars[next] && !chars[next].isLeadByte && chars[next].ch === ")";
    return closed && board.length >= 2 ? board : null;
  }
  if (ch === "@") {
    const { board } = readBoardToken(chars, j + 1);
    return board.length >= 2 ? board : null;
  }
  return null;
}

// pttbbs cross-post header puts the board BEFORE the AID:
//   ※ [本文轉錄自 C_Chat 看板 #1gIx63RL ]
// The Chinese words can't be matched on TermChar cells (they hold raw Big5
// lead/trail bytes), so this takes the decoded row TEXT (rowToText/getRowText)
// and only extracts the board name — no column mapping needed.
const CROSS_POST_PREFIX_RE = /本文轉錄自\s+([0-9A-Za-z_-]{2,})\s+看板/;

export function parseCrossPostBoardPrefix(rowText) {
  if (!rowText) return null;
  const m = CROSS_POST_PREFIX_RE.exec(rowText);
  return m ? m[1] : null;
}

// The Q post-info box (mbbsd/bbs.c#view_postinfo:3691-3705) — the ONLY way to
// learn the AID of the article you are currently on, which is what makes the
// AID-jump back anchor immune to article numbers shifting (a `/` search puts
// the list in MODE_SELECT, whose numbering is a SEPARATE space — see
// docs/pttbbs-screen-protocol.md §8):
//   │ 文章代碼(AID): #1gIeu-3A (movie) [ptt.cc] [好雷] 電影心得
// Takes the DECODED row text (same as parseCrossPostBoardPrefix): the label is
// Chinese, so it cannot be matched on raw Big5 TermChar cells.
// The label is mandatory — a bare "#XXXXXXXX" in article TEXT must never be
// mistaken for "this is the article I am on". board is null when pttbbs printed
// a non-board name there (「不明」 when currboard is empty); the caller falls
// back to its own board knowledge rather than guessing.
const POST_INFO_AID_RE =
  /文章代碼\(AID\)\s*[:：]\s*#([0-9A-Za-z_-]{8})(?![0-9A-Za-z_-])(?:\s*\(([0-9A-Za-z_-]{2,})\))?/;

export function parsePostInfoAid(rowText) {
  if (!rowText) return null;
  const m = POST_INFO_AID_RE.exec(rowText);
  if (!m) return null;
  return { aid: m[1], board: m[2] || null };
}

// 「本篇是哪一篇」的第二條路，而且是**免費**的：文章本文末尾那行
//   ※ 文章網址: https://www.ptt.cc/bbs/<Board>/M.<v1>.A.<v2>.html
// 已經把檔名寫在畫面上了，aid_codec 直接換算得到 AID，不必按 Q（按 Q 會被
// FULLUPDATE 抛回文章列表，得再花兩個指令回來，畫面看得出來在閃）。
//
// 兩個非顯而易見的約束：
//   1. **必須錨在列首**。回文的引言區塊會原樣帶著原文那行，長成 `: ※ 文章網址: …`；
//      不錨列首就會把「別人那篇」當成本篇。
//   2. 命中之後呼叫端**還要比對看板**（見 aid_navigation.findLocalPostAid）。轉錄文
//      會原樣複製原文內容、連原文的這行一起帶進來（pttbbs mbbsd/bbs.c:2162-2179），
//      而 pttbbs 擋掉同板轉錄（bbs.c:2097 "同板不需轉錄。"）⇒ 看板不符就是轉錄來的原文。
//
// 這行是 ptt.cc 私有 patch，不在開源 pttbbs 快照裡：一律當 best-effort，取不到就退回按 Q。
const ARTICLE_URL_LINE_RE = /^\s*※\s*文章網址\s*[:：]\s*(\S+)/;

// Q 資訊框的網址列（mbbsd/bbs.c:3713，QUERY_ARTICLE_URL）：
//   │ 文章網址: https://www.ptt.cc/bbs/<Board>/M.<v1>.A.<v2>.html
// 價值在於補 board：currboard 為空時上面那列的看板會印「未知」（bbs.c:3701），
// 但網址裡的看板一直是對的。看板不提供網頁版時 pttbbs 改印
// 「本看板目前不提供文章網址」/「本文章不提供文章網址」——那兩行沒有 URL，
// parseArticleUrl 自然回 null。
const POST_INFO_URL_RE = /^\s*│\s*文章網址\s*[:：]\s*(\S+)/;

function urlLine(re, rowText) {
  if (!rowText) return null;
  const m = re.exec(rowText);
  return m ? parseArticleUrl(m[1]) : null;
}

// → { board, aid } | null（board 來自網址路徑，一定有值）
export function parseArticleUrlLine(rowText) {
  return urlLine(ARTICLE_URL_LINE_RE, rowText);
}

export function parsePostInfoUrl(rowText) {
  return urlLine(POST_INFO_URL_RE, rowText);
}

// Returns [{ startCol, endCol, aid, board }] where startCol is the '#' column
// and endCol is exclusive (first column past the 8 AID chars). board is null
// when no suffix parsed — the caller falls back to the current article board.
// Optional rowText (decoded Unicode of the same row) enables the cross-post
// header prefix: a suffix-less AID on a 「本文轉錄自 X 看板」 line gets that
// board (suffix still wins when both are present).
export function detectAids(chars, rowText) {
  if (!chars) return [];
  const out = [];
  const n = chars.length;
  let i = 0;
  // Previous single-byte char, or null right after a DBCS pair / line start.
  // '#' starts an AID only when the previous char is NOT an AID char or '#'
  // (rejects "a#1gIeu-3A" and "##..."); Chinese/space/line-start are legal.
  let prevCh = null;
  while (i < n) {
    const cellI = chars[i];
    if (!cellI) {
      prevCh = null;
      i++;
      continue;
    }
    if (cellI.isLeadByte) {
      i += 2;
      prevCh = null;
      continue;
    }
    const ch = cellI.ch;
    if (ch === "#" && !(prevCh && (isAidChar(prevCh) || prevCh === "#"))) {
      let j = i + 1;
      let aid = "";
      while (j < n && aid.length <= AID_LEN) {
        const cj = chars[j];
        if (!cj || cj.isLeadByte || !isAidChar(cj.ch)) break;
        aid += cj.ch;
        j++;
      }
      // Exactly 8 chars, and the 9th column must not be another AID char
      // (an over-long token is some other identifier, not an AIDc).
      if (aid.length === AID_LEN) {
        // 但一個網址的 fragment 與 AIDc 同形（'#' 前是 '/'、8 個 AID 字元、第 9 格
        // 又是 '/'）——https://…/PttChrome/#Browsers/1gU3wwNZ 的 "#Browsers" 正是
        // 如此。uriRegEx 早就把整段標成 URL 了；在裡面認出 AID 只會讓
        // LinkSegmentBuilder 把那條網址的 <a> 從中切斷（見 term_url_flag.js）。
        // 仍然要往後跳過這幾格：這裡不是 AID，也不該被當成別的候選的前綴。
        if (!rangeInTermUrl(chars, i, j)) {
          out.push({
            startCol: i,
            endCol: j,
            aid,
            board: parseBoardSuffix(chars, j)
          });
        }
        prevCh = aid.charAt(aid.length - 1);
        i = j;
        continue;
      }
    }
    prevCh = ch;
    i++;
  }
  if (out.length && rowText) {
    const prefixBoard = parseCrossPostBoardPrefix(rowText);
    if (prefixBoard) {
      for (let k = 0; k < out.length; ++k) {
        if (out[k].board === null) out[k].board = prefixBoard;
      }
    }
  }
  return out;
}
