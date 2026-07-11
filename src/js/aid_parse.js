// PTT article-code (AID) detection for the easy-reading auto-link feature.
// Pure logic (no DOM / no network → unit-testable). Finds "#XXXXXXXX" tokens
// in one screen row plus an optional board suffix "(Board)" / "@Board"; the
// click-to-navigate behaviour lives in src/js/aid_navigation.js.
//
// Format (verified against pttbbs source, mbbsd/stuff.c aidu2aidc / aids.c):
// an AIDc is EXACTLY 8 chars from the base64 variant alphabet
// "0-9 A-Z a-z - _". The official footer line looks like
//   文章代碼(AID): #1gIeu-3A (Android) [ptt.cc]
// and cross-board references are conventionally "#AID (Board)" or "#AID@Board".
//
// Like mention_parse.js we walk the TermChar[] columns and skip DBCS pairs
// (isLeadByte → advance 2) so Big5 trail bytes can never fake a '#' or an AID
// char, and the returned columns are real TermChar indices for
// LinkSegmentBuilder.readChar(ch, i).

const AID_LEN = 8;

function isAidChar(c) {
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

// Optional suffix right after the AID (or after one space): "(Board)" or
// "@Board". Returns the board name or null; never affects the link columns.
function parseBoardSuffix(chars, j) {
  const n = chars.length;
  if (j < n && chars[j] && !chars[j].isLeadByte && chars[j].ch === " ") j++;
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
        out.push({
          startCol: i,
          endCol: j,
          aid,
          board: parseBoardSuffix(chars, j)
        });
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
