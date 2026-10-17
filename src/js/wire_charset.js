// 線路編碼轉接層：連線用 UTF-8 時，在 telnet 層把線路位元組與「內部格子編碼」互轉。
// 格子編碼的定義（Big5 位元組＋Big5 收不下的字存 Unicode 本身）與格寬規則在
// unicode_cells.js 檔頭；這支只負責線路兩端。
//
// 收（UTF-8 → 格子編碼）：
//   - 串流解碼（WebSocket 會在任意位元組切塊，一個字可能跨兩包）。自己解而不用
//     TextDecoder：要分得出「線路壞掉」（→ 半形 `?`，同 server convert_read_utf8）與
//     「server 真的送了 U+FFFD」（pfterm 對 ≥ 0xFFFE 的字送它，全形 2 格）。
//   - 每個字照 server 的寬度落格（unicode_cells.encodeCodePoint）：Big5 收得下 ⇒ 2 bytes
//     （與 Big5 連線逐位元組相同）；收不下 ⇒ Unicode 格，寬度＝ucs_width。
//     **寬度必須保住**：server 用它自己的寬度算游標位置，格數一錯整列錯位。
//     這也是 logind 編碼偵測能成立的原因：探針 `\xc4\xa1` 在 UTF-8 下是 U+0121
//     （不在 UAO、半形）⇒ 一格 ⇒ 游標停在 col 2 ⇒ CPR 回 2 ⇒ server 切 UTF-8。
//   - 寬 0 的字（組合字元、C1 控制碼）丟掉：pfterm 本來就不輸出它們（out_mbchar 的
//     `if (w <= 0) return;`）。BMP 以外的字照 pfterm 的 16-bit ftchar 換成 U+FFFD／`?`。
//   - 只轉 ≥ 0x80 的部分；ESC 序列、控制碼都是 ASCII，原樣通過。
//
// 送（格子編碼 → UTF-8）：
//   - 一個合法 lead＋trail ⇒ b2u ⇒ UTF-8；Unicode 格 ⇒ 直接 UTF-8（WIDE_TRAIL 丟掉）；
//     u2b 放行的 emoji（surrogate pair）與組合字元一樣直接 UTF-8。
//   - lead 與 trail 中間夾的 `\x00`／ESC（或 Ctrl-U）色碼序列原樣先送，字等 trail 到了
//     再送：這是 string_util.ansiHalfColorConv 的 raw-mode 一字雙色注入。UTF-8 下
//     server 不能把 ESC 塞進字中間，降級為「整個字用後半色」（同 SGR 66 被忽略時）。
//   - u2b 的轉不出標記 `\xFF\xFD` 與其他落單的高位元組 ⇒ `?`。UTF-8 不含 0xFF，
//     所以轉完後的資料流不會再有 IAC 需要加倍。
//
// 編碼由 pref `connectionEncoding`（'big5'｜'utf8'）決定；切換時機（CPR）見
// pttchrome.jsx#_attachConn、協定見 docs/pttbbs-screen-protocol.md §1.1 CPR。
import { b2u } from './string_util';
import {
  WIDE_TRAIL,
  encodeCodePoint,
  isWideCellCode,
  noteServerCodePoint,
} from './unicode_cells';
import { ucsWidth } from './ucs_width';

export const WIRE_BIG5 = 'big5';
export const WIRE_UTF8 = 'utf8';

export function normalizeWireCharset(v) {
  return v === WIRE_UTF8 ? WIRE_UTF8 : WIRE_BIG5;
}

const NARROW_PLACEHOLDER = '?';

// server 送來的一個字 → 格子編碼。
function serverCodePointToCells(cp) {
  noteServerCodePoint(cp);
  const w = ucsWidth(cp);
  if (w === 0) return '';
  if (cp >= 0xfffe) return w === 2 ? '�' + WIDE_TRAIL : NARROW_PLACEHOLDER;
  return encodeCodePoint(cp);
}

// 收方向：每條連線一個（解碼器帶跨包狀態）。
export function createUtf8Inbound() {
  let need = 0; // 這個字還缺幾個 continuation byte
  let len = 0; // 這個字總共幾個 byte（擋 overlong）
  let cp = 0;
  return {
    // bytes：一字元一 byte 的字串（websocket.js 的格式）。回傳格子編碼。
    decode(bytes) {
      // 純 ASCII 且沒有懸著的半個字 ⇒ 原樣（絕大多數的游標移動／色碼封包）。
      if (!need && !/[\x80-\xff]/.test(bytes)) return bytes;
      let out = '';
      for (let i = 0; i < bytes.length; ++i) {
        const b = bytes.charCodeAt(i);
        if (need) {
          if ((b & 0xc0) === 0x80) {
            cp = (cp << 6) | (b & 0x3f);
            if (--need) continue;
            const overlong = (len === 3 && cp < 0x800) || (len === 4 && cp < 0x10000);
            const bad = overlong || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff;
            out += bad ? NARROW_PLACEHOLDER : serverCodePointToCells(cp);
            continue;
          }
          // 字還沒完就換別的 byte：半個字結算成一個 `?`，這個 byte 重新處理。
          need = 0;
          out += NARROW_PLACEHOLDER;
        }
        if (b < 0x80) {
          out += bytes.charAt(i);
          continue;
        }
        len = b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
        if (!len) {
          out += NARROW_PLACEHOLDER; // 不可能是開頭的 byte（落單的 continuation、0xC0/0xC1/0xF5+）
          continue;
        }
        need = len - 1;
        cp = b & (0xff >> (len + 1));
      }
      return out;
    },
  };
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
  if (!/[^\x00-\x7f]/.test(bytes)) return bytes;

  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const c = bytes.charCodeAt(i);
    if (c < 0x80) {
      out += bytes.charAt(i);
      ++i;
      continue;
    }
    if (c > 0xff) {
      if (bytes.charAt(i) === WIDE_TRAIL) {
        ++i;
        continue;
      }
      const next = bytes.charCodeAt(i + 1);
      if (c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        out += utf8Bytes(bytes.substr(i, 2));
        i += 2;
        continue;
      }
      if (c >= 0xd800 && c <= 0xdfff) {
        out += NARROW_PLACEHOLDER;
        ++i;
        continue;
      }
      // 全形 Unicode 格同樣可能被 raw-mode 一字雙色夾住：字等右半格到了再送。
      if (isWideCellCode(c)) {
        let j = i + 1;
        let between = '';
        let end;
        while (j < bytes.length && (end = interleavedSeqEnd(bytes, j)) > 0) {
          between += bytes.substring(j, end);
          j = end;
        }
        if (bytes.charAt(j) === WIDE_TRAIL) {
          out += between + utf8Bytes(bytes.charAt(i));
          i = j + 1;
          continue;
        }
      }
      out += utf8Bytes(bytes.charAt(i));
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
