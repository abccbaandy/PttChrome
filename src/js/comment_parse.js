// Pure logic for the Enhanced Add-on features (no DOM / no network → easy to test).
//
// Used by both render paths to detect blacklisted authors/pushers and to number
// comment floors:
//   - native grid  : src/components/Screen.js
//   - easy reading : src/js/term_view.js (appendRows)
//
// Mirrors the DBCS handling in src/js/term_buf.js#getRowText and
// src/components/Row/ColorSegmentBuilder.js.

import { b2u } from './string_util';

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
// (噓 / → for boo / arrow). userid is ASCII alphanumeric. Returns the pusher in
// lower case so blacklist matching is case-insensitive.
const COMMENT_RE = /^(推|噓|→)\s+([0-9A-Za-z]+)\s*:/;

export function parseComment(text) {
  if (!text) return null;
  const m = text.match(COMMENT_RE);
  if (!m) return null;
  return { type: m[1], userid: m[2].toLowerCase() };
}

// Board list author column. Calibrated against live PTT (C_Chat, 2026-06), e.g.:
//   " 352960 + 4 6/05 HarunoYukino R: ..."
//   "  ^0          ^12 ^17(author, 12 wide)"
// The id column starts at 17 (after "index pushcount M/DD ") and the author field
// is 12 chars wide. Fail-safe: if the extracted text is not a plain userid we
// return null and the row is NOT hidden, so we never hide a legitimate post by
// mistake. Pinned/marked rows ("★") contain a full-width char before the author,
// which shifts the position — those are announcements, rarely blacklist targets,
// and simply fall through to the fail-safe.
const LIST_AUTHOR_COL_START = 17;
const LIST_AUTHOR_COL_END = 29;
const USERID_RE = /^[0-9A-Za-z]+$/;

export function parseListAuthor(text) {
  if (!text || text.length < LIST_AUTHOR_COL_START) return null;
  const author = text.substring(LIST_AUTHOR_COL_START, LIST_AUTHOR_COL_END).trim();
  if (!author || !USERID_RE.test(author)) return null;
  return author.toLowerCase();
}

// Running floor counter for an article. seq = overall floor number; sub = ordinal
// within the same type (推/噓/→). Reset per article (new post entered).
export class FloorCounter {
  constructor() {
    this.reset();
  }

  reset() {
    this.seq = 0;
    this.push = 0;
    this.shu = 0;
    this.arrow = 0;
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
