// 「把被切成兩段的網址接回去」的共用原語（無 DOM / 無網路）。
//
// 兩個消費端，形狀完全一樣、訊號來源不同：
//   - src/js/url_wrap.js   推文被輸入欄切成兩則（換行邊界來自 comment_merge）
//   - src/js/body_wrap.js  內文被切成兩列（換行邊界＝ pmore 的顯示寬度 maxcol）
// 這裡只放兩邊都要用的東西；判別合約各自寫在自己的檔頭。
//
// 2026-08 從 url_wrap.js 原地搬出，行為零改變 —— tests/unit/url_wrap.test.js 不改
// 而維持全綠就是搬移正確的證明。
import { TLDS } from './url_fix';
import { isDbcsCell } from './comment_break';

// URL 字元類：與 url_fix.js 的 PATH / TermBuf.uriRegEx 的 host+path 類一致（純
// ASCII、不含空白），加上 scheme 會用到的字元。
// 注意**不含反斜線** —— pmore 的折行符號 `\`（MFDISP_WRAP_INDICATOR）正好落在
// maxcol+1，body_wrap 靠這一點自然把它排除在 URL 片段之外。
export const URL_CHAR_RE = /[A-Za-z0-9_#!:.?+=&%@\-/$^,;|*~'()]/;
export const SCHEME_RE = /^(?:https?|ftp|telnet):\/\//i;
// host：label(.label)* + '.' + 允許清單 TLD。TLDS 已依長度排序（長的優先），\b 擋掉
// 「TLD 只是更長 label 的前綴」（i.imgur.comfoo 不成立）。
const HOST_RE = new RegExp(
  '^([A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.(?:' + TLDS.join('|') + '))\\b',
  'i'
);

// chars[i] 是不是「可以當 URL 一部分」的格子。DBCS 守門不可省：Big5 的 trail byte
// 有可能剛好是 0x40 = '@' 這種 URL 合法字元。
export function isUrlCell(chars, i) {
  const c = chars[i];
  return !!c && !isDbcsCell(chars, i) && URL_CHAR_RE.test(c.ch);
}

// 併起來的字串是不是一個值得連的網址 → { fixed, host }，否則 null。
export function validateJoined(joined) {
  const hasScheme = SCHEME_RE.test(joined);
  const rest = joined.replace(SCHEME_RE, '');
  const m = HOST_RE.exec(rest);
  if (!m) return null;
  const after = rest.slice(m[0].length).replace(/^:\d+/, '');
  // host 之後只能是空的或路徑；其他形狀（如 host 後面直接接字母）不認。
  if (after && after[0] !== '/') return null;
  const hasPath = after.length > 1 && after[0] === '/';
  // 無 scheme 又無路徑 ⇒ url_fix 的 gray 那一類（產物只是首頁連結、證據薄弱），
  // 這裡直接排除——接合本來就該是「網址被切斷」而不是「兩個字剛好像網域」。
  if (!hasScheme && !hasPath) return null;
  return {
    fixed: hasScheme ? joined : 'https://' + joined,
    host: m[1].toLowerCase(),
  };
}
