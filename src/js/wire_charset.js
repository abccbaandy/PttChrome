// 線路編碼轉接層：連線用 UTF-8 時，在 telnet 層把線路位元組與「內部 Big5 位元組」互轉。
//
// 為什麼是轉接層而不是讓整個 app 改吃 Unicode：TermBuf 的格子模型是「一格＝一個 byte，
// 全形字＝lead／trail 兩格」，約 25 個解析器（aid_parse、comment_parse、footer_keys…）
// 都建在 isLeadByte＋b2u 上。在線路出入口轉一次，裡面一行都不用動。
//
// 收（UTF-8 → Big5 位元組）：
//   - 串流解碼（WebSocket 會在任意位元組切塊，一個字可能跨兩包）。
//   - Big5（UAO）轉得出的字 ⇒ 2 bytes ⇒ 佔 2 格，與 Big5 連線時完全相同。
//   - 轉不出的字依顯示寬度補佔位：全形 ⇒ `？`（2 格）、半形 ⇒ `?`（1 格）。
//     **寬度必須保住**：server 用它自己的寬度算游標位置，格數一錯整列錯位。
//     這也是 logind 編碼偵測能成立的原因：探針 `\xc4\xa1` 在 UTF-8 下是 U+0121
//     （不在 UAO 內、半形）⇒ `?` ⇒ 游標停在 col 2 ⇒ CPR 回 2 ⇒ server 切 UTF-8。
//   - 只轉 ≥ 0x80 的部分；ESC 序列、控制碼都是 ASCII，原樣通過。
//
// 送（Big5 位元組 → UTF-8）：
//   - 一個合法 lead＋trail ⇒ b2u ⇒ UTF-8。
//   - lead 與 trail 中間夾的 `\x00`／ESC（或 Ctrl-U）色碼序列原樣先送，字等 trail 到了
//     再送：這是 string_util.ansiHalfColorConv 的 raw-mode 一字雙色注入。UTF-8 下
//     server 不能把 ESC 塞進字中間，降級為「整個字用後半色」（同 SGR 66 被忽略時）。
//   - u2b 的轉不出標記 `\xFF\xFD` 與其他落單的高位元組 ⇒ `?`。UTF-8 不含 0xFF，
//     所以轉完後的資料流不會再有 IAC 需要加倍。
//
// 編碼由 pref `connectionEncoding`（'big5'｜'utf8'）決定；切換時機（CPR）見
// pttchrome.jsx#_attachConn、協定見 docs/pttbbs-screen-protocol.md §1.1 CPR。
import { u2b, b2u } from './string_util';

export const WIRE_BIG5 = 'big5';
export const WIRE_UTF8 = 'utf8';

export function normalizeWireCharset(v) {
  return v === WIRE_UTF8 ? WIRE_UTF8 : WIRE_BIG5;
}

const NARROW_PLACEHOLDER = '?';
// U+FF1F 全形問號；u2b 之後是 2 bytes。延遲到第一次用時才轉（u2b 需要已載入的表）。
let widePlaceholder = null;
function wideBytes() {
  if (widePlaceholder === null) widePlaceholder = u2b('？');
  return widePlaceholder;
}

// 只用在「Big5 轉不出」的字上（轉得出的一律 2 格）。範圍取 East Asian Wide／
// Fullwidth 的主幹＋emoji 平面；對齊 pttbbs common/sys/wcwidth.c 的大方向，未逐字對表。
export function isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function codePointToBig5(cp) {
  if (cp < 0x80) return String.fromCharCode(cp);
  if (cp <= 0xffff) {
    const b = u2b(String.fromCharCode(cp));
    if (b !== '\xff\xfd') return b;
  }
  return isWideCodePoint(cp) ? wideBytes() : NARROW_PLACEHOLDER;
}

// 收方向：每條連線一個（解碼器帶跨包狀態）。
export function createUtf8Inbound() {
  const decoder = new TextDecoder('utf-8');
  return {
    // bytes：一字元一 byte 的字串（websocket.js 的格式）。回傳同格式的 Big5 位元組。
    decode(bytes) {
      let ascii = true;
      for (let i = 0; i < bytes.length; ++i) {
        if (bytes.charCodeAt(i) >= 0x80) {
          ascii = false;
          break;
        }
      }
      // 純 ASCII 且解碼器沒有懸著的半個字 ⇒ 原樣（絕大多數的游標移動／色碼封包）。
      // 有懸著的字時仍要過解碼器，才會把它結算成 U+FFFD。
      if (ascii && !this._pending) return bytes;
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; ++i) arr[i] = bytes.charCodeAt(i);
      const text = decoder.decode(arr, { stream: true });
      this._pending = endsMidSequence(arr);
      let out = '';
      for (const ch of text) out += codePointToBig5(ch.codePointAt(0));
      return out;
    },
    _pending: false
  };
}

// 這一包是不是停在一個多位元組字的中間（只看結尾最多 3 bytes）。
function endsMidSequence(arr) {
  const n = arr.length;
  for (let back = 1; back <= 3 && back <= n; ++back) {
    const b = arr[n - back];
    if (b < 0x80) return false;
    if (b >= 0xc0) {
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      return back < need;
    }
  }
  return false;
}

function isLead(c) {
  return c >= 0x81 && c <= 0xfe;
}
function isTrail(c) {
  return (c >= 0x40 && c <= 0x7e) || (c >= 0xa1 && c <= 0xfe);
}

// ansiHalfColorConv 夾在 lead／trail 之間的東西：`\x00`、或 ESC／Ctrl-U 開頭到 'm' 的色碼。
// 回傳這段的結束 index（不含），不是則回 -1。
function interleavedSeqEnd(s, i) {
  const c = s.charCodeAt(i);
  if (c === 0x00) return i + 1;
  if ((c === 0x1b || c === 0x15) && s.charAt(i + 1) === '[') {
    let j = i + 2;
    while (j < s.length && /[0-9;]/.test(s.charAt(j))) ++j;
    if (s.charAt(j) === 'm') return j + 1;
  }
  return -1;
}

const encoder = new TextEncoder();
function utf8Bytes(text) {
  return String.fromCharCode(...encoder.encode(text));
}

// 送方向：無狀態（一次送出的字串一定是完整的字；見 telnet.js#_sendEscaped）。
export function big5ToUtf8Wire(bytes) {
  let ascii = true;
  for (let i = 0; i < bytes.length; ++i) {
    if (bytes.charCodeAt(i) >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return bytes;

  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const c = bytes.charCodeAt(i);
    if (c < 0x80) {
      out += bytes.charAt(i);
      ++i;
      continue;
    }
    // u2b 的轉不出標記是一整個字：吃兩個 byte。不先攔，0xFD 會被當成 lead 把後面的
    // ASCII 誤吃成 trail。
    if (c === 0xff && bytes.charCodeAt(i + 1) === 0xfd) {
      out += NARROW_PLACEHOLDER;
      i += 2;
      continue;
    }
    if (isLead(c)) {
      // 先收掉夾在中間的色碼序列，再找 trail。
      let j = i + 1;
      let between = '';
      let end;
      while (j < bytes.length && (end = interleavedSeqEnd(bytes, j)) > 0) {
        between += bytes.substring(j, end);
        j = end;
      }
      if (j < bytes.length && isTrail(bytes.charCodeAt(j))) {
        const u = b2u(bytes.charAt(i) + bytes.charAt(j));
        // b2u 轉不出時原樣回傳 2 個字元（長度 2）
        out += between + (u.length === 1 ? utf8Bytes(u) : NARROW_PLACEHOLDER);
        i = j + 1;
        continue;
      }
    }
    out += NARROW_PLACEHOLDER;
    ++i;
  }
  return out;
}

// Cursor Position Report 的回覆（1-based）。
export function cursorPositionReport(row, col) {
  return '\x1b[' + row + ';' + col + 'R';
}
