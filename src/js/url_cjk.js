// Pure logic for extending an auto-detected URL into a CJK path segment
// (no DOM / no network → node-testable, same convention as comment_parse.js).
//
// TermBuf.uriRegEx is ASCII-only, so "https://zh.wikipedia.org/wiki/戈黛娃夫人"
// stops right before the first Chinese char. This module decides whether the
// text following the ASCII match is really part of the URL.
//
// False-positive guards (per docs discussion: prose right after a URL is common
// on PTT — "來源https://x.com/abc真的好看" must NOT absorb "真的好看"):
//   - the CJK run may start ONLY when the char immediately before it is '/' or
//     '=' (a path segment or query value boundary, e.g. /wiki/中文, ?q=中文);
//     a URL whose ASCII part ends in a letter/digit gets no extension;
//   - full-width punctuation (。，、！？…「」etc.) and any whitespace terminate
//     the extension — they never appear raw in a URL but always end a sentence;
//   - after at least one CJK char, ASCII path chars may continue (mixed titles
//     like 戈黛娃夫人_(歌手)), but an ASCII space still terminates.
// Residual risk: CJK prose butted directly against a trailing '/' with no
// punctuation ("看https://foo.com/超好笑") is indistinguishable from a CJK path
// and will be absorbed until the next punctuation/space. Accepted tradeoff.

// Full-width punctuation / whitespace that ends a sentence, never a URL.
const STOP = new Set(
  '　。，、；：！？…‥—－～‧·「」『』（）《》〈〉【】〔〕｛｝＂＇．'.split('')
);

// Mirrors the path char class of TermBuf.uriRegEx (src/js/term_buf.js).
const PATH_ASCII = /[A-Za-z0-9_#!:.?+=&%@\-/$^,;|*~'()]/;

// cjkUrlExtension(prevChar, tail) -> string
//   prevChar: last char of the ASCII URL match ('/' or '=' required).
//   tail: decoded Unicode text that follows the match on the same row.
// Returns the accepted extension ('' if none). Must start with a CJK char.
export function cjkUrlExtension(prevChar, tail) {
  if (prevChar !== '/' && prevChar !== '=') return '';
  let out = '';
  let sawCjk = false;
  for (const ch of tail) {
    if (ch.charCodeAt(0) > 0x7f) {
      if (STOP.has(ch)) break;
      out += ch;
      sawCjk = true;
    } else if (sawCjk && PATH_ASCII.test(ch)) {
      out += ch;
    } else {
      break;
    }
  }
  if (!sawCjk) return '';
  // A trailing ASCII sentence-punctuation run belongs to the prose, not the URL.
  return out.replace(/[.,;:!?]+$/, '');
}
