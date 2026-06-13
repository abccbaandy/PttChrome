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
// (噓 / → for boo / arrow). userid is ASCII alphanumeric. The id field may be
// space-padded before ':' on some boards (Stock: "推 diefishfish : …"; C_Chat:
// "推 Haruna1998: …"). Returns the pusher in lower case so blacklist matching is
// case-insensitive.
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
const COMMENT_RE = new RegExp(
  /^(推|噓|→)\s+([0-9A-Za-z]+)\s*:.*/.source + COMMENT_TIME_RE.source
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
