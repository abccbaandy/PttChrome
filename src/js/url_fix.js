// Pure logic for the "auto-fix broken URL" feature (no DOM / no network → easy to
// test in node env, same convention as src/js/comment_parse.js).
//
// PTT article authors sometimes break a URL — on purpose or by accident — by
// injecting spaces, dropping the scheme, or splitting a file extension:
//   https://www . google .com/      → https://www.google.com/
//   www.example.com/someimage. png  → https://www.example.com/someimage.png
//   example.com /badpath.jpg        → https://example.com/badpath.jpg
//   google .tw/page                 → https://google.tw/page
// A broken URL is INVISIBLE to the real URL detector (TermBuf.uriRegEx requires a
// scheme and tolerates no whitespace), so it neither links nor auto-opens. This
// module detects such candidates per row and reconstructs a fixed URL. The caller
// renders the fixed URL on an extra line BELOW the original text — the original is
// never rewritten.
//
// Design: conservative TLD-anchored scan, not a single greedy regex (which would
// false-positive all over Chinese prose). The key false-positive guards are:
//   - the final host label MUST be in a closed TLD allowlist;
//   - host/path char classes are ASCII-only, so CJK chars terminate a match
//     naturally (full-width 。，、 never look like an ASCII dot/label);
//   - only a SINGLE injected space is tolerated between URL pieces (a double space
//     is treated as a real word gap and stops the match).
// Tradeoff: we miss exotic/un-listed TLDs and URLs broken across two screen rows
// (detection is per-row) in exchange for near-zero false positives.

// Closed TLD allowlist. Longer ones first so e.g. ".com" is preferred over ".co"
// (the trailing \b also prevents matching "co" inside "com").
const TLDS = [
  'community', 'online', 'store', 'tech', 'live', 'news', 'blog', 'wiki', 'site',
  'club', 'shop', 'app', 'dev', 'info', 'biz', 'moe',
  'com', 'net', 'org', 'edu', 'gov', 'xyz',
  'io', 'tw', 'jp', 'cn', 'co', 'tv', 'me', 'cc', 'gg', 'fm', 'us', 'uk', 'de',
  'fr', 'hk', 'kr', 'ru', 'it', 'es', 'nl', 'se', 'ca', 'au', 'in', 'to', 'ly',
  'gl', 'be', 'la', 'pw', 'ws'
].sort((a, b) => b.length - a.length);

// Path char class, mirrors TermBuf.uriRegEx's host/path class (ASCII-only, no space).
const PATH = "[A-Za-z0-9_#!:.?+=&%@\\-/$^,;|*~'()]";
const LABEL = '[A-Za-z0-9-]+';
const TLD_ALT = TLDS.join('|');
// Media file extensions, kept in sync with RE_IMAGE_EXT / RE_VIDEO_EXT in
// src/components/ImagePreviewer.js. Used ONLY to repair a space-split extension
// ("someimage. png" → "someimage.png"); a generic "space + word" in the path is
// NOT merged (that is real prose, e.g. ".../b here").
const EXT = 'jpe?g|png|gif|webp|apng|avif|jfif|pjpeg|svg|bmp|ico|mp4|webm|ogg';

// optional scheme (tolerating "https : //"), host with optional spaces around dots
// ending in an allowlisted TLD, optional :port, optional path. The path body itself
// contains NO spaces; a single broken file extension ("name. png" / "name .png") is
// the one space the path tolerates. Removing every ASCII space from the whole match
// then reconstructs the URL (real URLs cannot contain raw spaces).
const CANDIDATE_RE = new RegExp(
  '(?:(?:https?|ftp|telnet)\\s*:\\s*/\\s*/)?' + // optional scheme
    LABEL +
    '(?:\\s*\\.\\s*' + LABEL + ')*' + // sub-labels
    '\\s*\\.\\s*(?:' + TLD_ALT + ')\\b' + // final dot + TLD
    '(?::\\d+)?' + // optional port
    '(?:[ ]?/(?:' + PATH + ')*(?:[ ]+\\.?[ ]*(?:' + EXT + ')\\b)?)?', // path + opt. broken ext
  'ig'
);

// Same shape as TermBuf.uriRegEx (src/js/term_buf.js#298): used only to drop
// candidates that are ALREADY a valid URL verbatim, so we never duplicate a link
// the real pipeline already renders (e.g. a clean "https://yahoo.com").
const VALID_URI_RE = /((ftp|http|https|telnet):\/\/([A-Za-z0-9_]+:{0,1}[A-Za-z0-9_]*@)?([A-Za-z0-9_#!:.?+=&%@!\-\/\$\^,;|*~'()]+)(:[0-9]+)?(\/|\/([A-Za-z0-9_#!:.?+=&%@!\-\/]))?)|(pid:\/\/(\d{1,10}))/ig;

const HAS_SCHEME_RE = /^(?:https?|ftp|telnet):\/\//i;

const MAX_PER_ROW = 3;

// detectFixableUrls(text) -> Array<{ original, fixed }>
// `fixed` always carries a scheme and contains no spaces. Returns [] for the
// common case (almost every row).
export function detectFixableUrls(text) {
  if (!text) return [];

  // Verbatim valid-URL spans → used to skip already-good URLs.
  const validTexts = new Set();
  VALID_URI_RE.lastIndex = 0;
  let v;
  while ((v = VALID_URI_RE.exec(text)) !== null) {
    validTexts.add(v[0]);
    if (VALID_URI_RE.lastIndex === v.index) VALID_URI_RE.lastIndex++; // guard zero-width
  }

  const out = [];
  const seenFixed = new Set();
  CANDIDATE_RE.lastIndex = 0;
  let m;
  while ((m = CANDIDATE_RE.exec(text)) !== null) {
    if (CANDIDATE_RE.lastIndex === m.index) CANDIDATE_RE.lastIndex++;
    const original = m[0];
    // Already a clean, valid URL → the real pipeline handles it; don't duplicate.
    if (validTexts.has(original)) continue;
    let fixed = original.replace(/\s+/g, '');
    if (!HAS_SCHEME_RE.test(fixed)) fixed = 'https://' + fixed;
    if (fixed === original) continue; // nothing was actually repaired
    // Skip bare-domain MENTIONS: a candidate with neither an injected space NOR a
    // path is just a domain mentioned in prose — e.g. "批踢踢實業坊(ptt.cc)" in the
    // 發信站 line — and must NOT be linkified by merely prepending a scheme. Qualify
    // only when it is genuinely broken (a removed space) OR is a real deep link with
    // a path/file (e.g. "i.imgur.com/ajHklmb.jpeg", worth a clickable + auto-open).
    const hasSpace = /\s/.test(original);
    const hasPath = /\/.+/.test(fixed.replace(HAS_SCHEME_RE, ''));
    if (!hasSpace && !hasPath) continue;
    if (seenFixed.has(fixed)) continue;
    seenFixed.add(fixed);
    out.push({ original, fixed });
    if (out.length >= MAX_PER_ROW) break;
  }
  return out;
}
