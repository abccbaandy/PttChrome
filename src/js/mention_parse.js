// X(Twitter) @handle detection for the Enhanced Add-on auto-link feature. Pure
// logic (no DOM / no network → unit-testable). Finds the column ranges of @handle
// candidates in one screen row; whether a candidate becomes a link is decided
// later by src/js/x_handle_verify.js (existence check) — this only locates them.
//
// WHY walk the TermChar[] (columns) and NOT rowToText(string): a Big5 DBCS
// character's TRAIL byte can be 0x40 ('@'), so scanning the reconstructed string
// would match a phantom '@' inside Chinese text. We skip whole DBCS pairs
// (isLeadByte → advance 2) and only match single-byte ASCII, so the columns we
// return are real TermChar indices — the same indices LinkSegmentBuilder compares
// against in readChar(ch, i). Mirrors the lead-byte handling in
// src/js/comment_parse.js#rowToText.

// X usernames are 1–15 chars of [A-Za-z0-9_]. (X also disallows the substring
// "twitter" except in a few legacy handles; we don't enforce that — the existence
// check is the real filter.)
const MAX_HANDLE = 15;

function isHandleChar(c) {
  return (
    (c >= 'A' && c <= 'Z') ||
    (c >= 'a' && c <= 'z') ||
    (c >= '0' && c <= '9') ||
    c === '_'
  );
}

// Returns [{ startCol, endCol, handle }] where startCol is the '@' column and
// endCol is exclusive (first column past the handle) — matching the
// [authorIdStart, authorIdEnd) convention in comment_parse.js.
export function detectMentions(chars) {
  if (!chars) return [];
  const out = [];
  const n = chars.length;
  let i = 0;
  // The previous two single-byte chars, or null right after a DBCS pair / at line
  // start. '@' starts a mention when the previous char is NOT a word char or '@'
  // (so an email "a@b" and a stray "@@" are rejected; a Chinese char before it,
  // which leaves prevCh = null, is a legal prefix → "作者@jack" works) — OR when
  // the previous char is a STANDALONE 'X'/'x' (prevPrevCh not a word char/'@'),
  // the PTT idiom "X@kaotaro12" for an x.com account. "aX@b" stays an email.
  let prevCh = null;
  let prevPrevCh = null;
  while (i < n) {
    const cell = chars[i];
    if (!cell) {
      prevCh = null;
      prevPrevCh = null;
      i++;
      continue;
    }
    if (cell.isLeadByte) {
      // A DBCS (Big5) character occupies cols i and i+1; skip both. Its trail byte
      // may itself be 0x40 ('@') and must never be read as a mention start.
      i += 2;
      prevCh = null;
      prevPrevCh = null;
      continue;
    }
    const ch = cell.ch;
    const xPrefixOk =
      (prevCh === 'X' || prevCh === 'x') &&
      !(prevPrevCh && (isHandleChar(prevPrevCh) || prevPrevCh === '@'));
    const atOk =
      ch === '@' &&
      (!(prevCh && (isHandleChar(prevCh) || prevCh === '@')) || xPrefixOk);
    if (atOk) {
      let j = i + 1;
      let handle = '';
      // Read up to MAX_HANDLE+1 handle chars (the extra one detects an over-long
      // token, which is then rejected). Stops at a non-handle char, a DBCS lead
      // byte, or end of line.
      while (j < n && handle.length <= MAX_HANDLE) {
        const cj = chars[j];
        if (!cj || cj.isLeadByte || !isHandleChar(cj.ch)) break;
        handle += cj.ch;
        j++;
      }
      const nextIsHandle =
        j < n && chars[j] && !chars[j].isLeadByte && isHandleChar(chars[j].ch);
      if (
        handle.length >= 1 &&
        handle.length <= MAX_HANDLE &&
        !nextIsHandle && // would mean a 16+ char token → not a clean handle
        !/^[0-9]+$/.test(handle) // all-digits "@123" is almost never an X handle
      ) {
        out.push({ startCol: i, endCol: j, handle });
        prevPrevCh =
          handle.length >= 2 ? handle.charAt(handle.length - 2) : '@';
        prevCh = handle.charAt(handle.length - 1);
        i = j;
        continue;
      }
    }
    prevPrevCh = prevCh;
    prevCh = ch;
    i++;
  }
  return out;
}
