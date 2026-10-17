// 內部格子編碼：TermBuf 的 TermChar.ch、u2b 的輸出、wire_charset 收方向的輸出，三者
// 同一種格式。**一格恆為一個 UTF-16 code unit**（欄位數學、URL 偵測、選取反查全建在
// 這上面），值域分三段：
//
//   0x00–0x7F   ASCII
//   0x80–0xFF   Big5 位元組，全形字＝lead／trail 兩格。Big5 線路只會有這兩段。
//   ≥ 0x100     Unicode 字元本身——只在 UTF-8 線路，且只給 Big5（UAO）收不下的字。
//               全形（ucs_width＝2）後面固定跟一格 WIDE_TRAIL；半形就一格。
//
// 為什麼 Big5 收得下的字仍然存 Big5 位元組：約 25 個解析器（aid_parse、comment_parse、
// footer_keys…）建在 isLeadByte＋b2u 上，UTF-8 線路收到的字 99.9% 都在 Big5 裡，
// 存成同一份位元組 ⇒ 兩種線路畫面逐格相同，這些解析器一行都不用分支。
// 收不下的字改存字元本身，b2u 原樣放行、isDBCSLead／isFullWidth 依 ucs_width 判寬，
// 所以 `b5.length === 1 ? b5 : b2u(b5)` 這種既有的收合寫法照樣拿到正確的字。
//
// 格寬（server 的 cursor 怎麼算，client 就要怎麼排，差一格整列錯位）：
//   - server 內部是 Big5（MB_IS_BIG5，pttbbs 預設、現行站台）：mbbsd/convert.c#
//     convert_write_utf8 把每個 Big5 雙位元組字轉成 UTF-8，cursor 照 Big5 位元組算
//     ⇒ **收得下的字恆 2 格**；收不到 Big5 以外的字（server 只送 b2u_table 的值或 '?'）。
//   - server 內部是 UTF-8（MB_IS_UTF8）：pfterm 用 ucs_width（ucs_width.js）。
//   兩者用同一張 UAO 表（common/sys/big5data.tar.bz2 與 src/conv/uao 逐位元組相同），
//   而這張表 b2u 的值域全部來回一致 ⇒ **收到一個來回不一致的字＝server 一定是 UTF-8
//   內部**（noteServerCodePoint 立閂），之後 Big5 收得下、但 ucs_width 是 1 的字
//   （À、ｱ、☺、✓…約 170 字）改存半形 Unicode 格。立閂前已畫的字不回頭改。
//   例外：0x80–0xFF 不能當 Unicode 格（與 Big5 位元組同值域），這段半形字（À 等）
//   在 UTF-8 內部的 server 上仍佔 2 格——已知限制。
//
// 守護：tests/unit/unicode_cells.test.js。協定依據見 docs/pttbbs-screen-protocol.md
// §1.1「Cursor Position Report」的 utf8 分支。
import { ucsWidth } from './ucs_width';

// 全形 Unicode 格的右半格。U+FFFF 是 noncharacter：pfterm 的 ftchar 把 ≥ 0xFFFE 的字
// 一律換成 U+FFFD／'?'（mbbsd/pfterm.c#out_mbchar），server 不可能送它。
export const WIDE_TRAIL = '￿';
const WIDE_TRAIL_CODE = 0xffff;

// logind 的編碼偵測探針 U+0121（daemon/logind/logind.c#login_ctx_activate 送的
// `\xc4\xa1`，原註解「not in UAO」）：Big5 內部的 server 也會送，不能拿來立閂。
const LOGIND_PROBE = 0x0121;

let enabled = false;
let serverNative = false;

// telnet.setWireCharset 呼叫：UTF-8 線路才會產生 ≥ 0x100 的格子。每條連線重算閂。
export function setUnicodeCells(on) {
  enabled = !!on;
  serverNative = false;
}

export function unicodeCellsEnabled() {
  return enabled;
}

// 已證實 server 內部是 UTF-8：它收得下、也畫得出 Big5 以外的字。
export function serverIsUnicodeNative() {
  return enabled && serverNative;
}

function tables() {
  return globalThis.lib;
}

// 這個字的 Big5（UAO）兩位元組，且 b2u 轉回來是同一個字；否則 null。
export function big5Of(cp) {
  if (cp < 0x80 || cp > 0xffff) return null;
  const t = tables();
  const hi = t.u2bArray[2 * cp];
  const lo = t.u2bArray[2 * cp + 1];
  if ((!hi && !lo) || (hi === 0xff && lo === 0xfd)) return null;
  const p = 2 * ((hi << 8) | lo);
  if (((t.b2uArray[p] << 8) | t.b2uArray[p + 1]) !== cp) return null;
  return String.fromCharCode(hi, lo);
}

// 0x80–0xFF 不能存成 Unicode 格，只能借 Big5 的近似字（¢ → ￠），沒有就 '?'。
function latin1Big5(cp) {
  const t = tables();
  const hi = t.u2bArray[2 * cp];
  const lo = t.u2bArray[2 * cp + 1];
  if ((!hi && !lo) || (hi === 0xff && lo === 0xfd)) return '?';
  return String.fromCharCode(hi, lo);
}

// 一個 code point 存成哪幾格（只在 enabled 時用）。寬 0 的字回 ''：pfterm 不輸出它們，
// 收方向本來就不會有；送方向（使用者打的組合字元、emoji 的 VS16）由呼叫端另外處理。
export function encodeCodePoint(cp) {
  if (cp < 0x80) return String.fromCharCode(cp);
  if (cp < 0x100) return latin1Big5(cp);
  if ((cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfffe || cp === WIDE_TRAIL_CODE) return '?';
  const w = ucsWidth(cp);
  const b5 = big5Of(cp);
  if (b5 && !(serverNative && w === 1)) return b5;
  if (w === 0) return '';
  if (cp > 0xffff) return '?';
  return w === 2 ? String.fromCharCode(cp) + WIDE_TRAIL : String.fromCharCode(cp);
}

// 這個字在畫面上佔幾格——與 encodeCodePoint 存的格數一致（寬 0 的字是 0）。
// Big5 線路一律 2：那邊的格子全是 Big5 位元組，與既有的「> 0x7F 算兩格」相同。
export function codePointCells(cp) {
  if (cp < 0x80) return 1;
  if (!enabled || cp < 0x100) return 2;
  if (cp === WIDE_TRAIL_CODE) return 0;
  // 熱路徑（每列文字的欄號換算）：Big5 收得下的字先查表就結束，不必算 ucs_width。
  if (!serverNative && big5Of(cp)) return 2;
  const w = ucsWidth(cp);
  if (serverNative && w !== 1 && big5Of(cp)) return 2;
  return w;
}

// 收方向每個 code point 都過一次：見檔頭「格寬」。
export function noteServerCodePoint(cp) {
  if (serverNative || cp < 0xa0 || cp === 0xfffd || cp === LOGIND_PROBE) return;
  if (cp > 0xffff || !big5Of(cp)) serverNative = true;
}

// 格子裡的 ≥ 0x100 字元是不是全形字的左半（右半是 WIDE_TRAIL）。
export function isWideCellCode(code) {
  return code >= 0x100 && code !== WIDE_TRAIL_CODE && ucsWidth(code) === 2;
}

// 不是任何字右半的一格（非 lead 的格子）讀成文字：孤兒 WIDE_TRAIL（左半被 server 蓋掉）
// 讀成 '?'——與畫面（color_segment）一致，也不讓 U+FFFF 漏進複製、解析器的文字。
export function cellText(ch) {
  return ch === WIDE_TRAIL ? '?' : ch;
}

// 渲染端的配對：isDBCSLead 成立的左半格（leadCh）要不要吃掉下一格（nextCh）。
// Big5 lead 一律吃（trail 的值域無從驗證，維持既有行為）；全形 Unicode 格只吃
// WIDE_TRAIL——右半被 server 蓋掉的孤兒左半、或呼叫端自己造的「一格一個中文字」
// 都不配對，左半照原樣畫、下一格重新讀。
export function cellPairs(leadCh, nextCh) {
  return leadCh.charCodeAt(0) <= 0xff || nextCh === WIDE_TRAIL;
}
