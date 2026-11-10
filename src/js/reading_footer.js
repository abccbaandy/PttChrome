// 好讀文章底列顯示「你讀到哪」（P65，pref easyReadingFooterProgress，預設開）。
//
// 好讀的底列（#easyReadingLastRow）是 PTT 真狀態列的鏡像（term_view._mirrorStatusRowToFooter）。
// 好讀會自動把整篇翻完接起來 ⇒ PTT 那邊早就停在最後一頁，人還在文章開頭，底列卻寫
// 「瀏覽 第 2/2 頁 (100%)  目前顯示: 第 05~27 行」，捲動也不變。這裡把狀態列**左半**
// （頁數、百分比、目前顯示第幾行）換成讀者自己的位置，**右半的功能鍵照舊鏡像**（一樣可點）。
//
// 只改顯示、一個 byte 都不送。認不出 ⇒ 原生：
//   - 只接 STATUS_ROW_RE 那一種（有「目前顯示: 第 a~b 行」）：實況狀態列、沒有行號的變體
//     （此頁內容會依閱讀者不同、系統連線服務異常）、水平捲動的「顯示範圍」一律照原樣鏡像；
//   - 量不到位置、或換上去的字放不進原本左半的寬度 ⇒ 照原樣鏡像。
import { big5Of, unicodeCellsEnabled, encodeCodePoint, WIDE_TRAIL } from './unicode_cells';

// 左半的範圍：從列首到「… 行」之後那一格空白（PTT 的 part2 之後接一格空白再接功能鍵）。
const LEFT_RE = /^  瀏覽 第 \d+(?:\/\d+)? 頁 *\( *\d+%\)  目前顯示: 第 0*\d+~0*\d+ 行/;

// 狀態列文字（getRowText，一個全形字算一個字元）→ 左半在格子裡的欄數與「目前顯示」起始欄；
// 不是可替換的那一種回 null。cellsOf(text) ＝這段文字佔幾格。
export function footerLeftSpan(statusText, cellsOf) {
  const m = LEFT_RE.exec(statusText || '');
  if (!m) return null;
  const at = m[0].indexOf(' 目前顯示');
  return { end: cellsOf(m[0]), secondStart: cellsOf(m[0].slice(0, at)) };
}

// 讀者位置 → 兩段文字。progress：{ first, last, total, complete, percent }（列號 1 起算）。
// complete ＝整篇都接起來了（好讀反向讀取補完）：才有「共 N 列」與百分比；還在接 ⇒「已載入 N 列」。
export function footerProgressTexts(progress) {
  const p = progress || {};
  if (!(p.first >= 1) || !(p.last >= p.first) || !(p.total >= 1)) return null;
  const range = p.first === p.last ? `第 ${p.first} 列` : `第 ${p.first}~${p.last} 列`;
  if (p.complete && p.percent >= 0) {
    return { head: `  讀到 ${p.percent}% `, tail: ` ${range}／共 ${p.total} 列` };
  }
  return { head: '  讀到 ', tail: ` ${range}／已載入 ${p.total} 列` };
}

// 捲動量 → 百分比（視窗下緣讀到全文的幾成；整篇放得下＝100）。trailing ＝文末標題卡這類
// 不屬於文章的捲動高度（reading_record.trailingPx）。
export function scrollPercent({ scrollTop, clientHeight, scrollHeight, trailing }) {
  const content = (scrollHeight || 0) - (trailing || 0);
  if (!(content > 0)) return null;
  const seen = Math.min(content, (scrollTop || 0) + (clientHeight || 0));
  return Math.max(0, Math.min(100, Math.floor((seen / content) * 100)));
}

// 一段文字 → 格子字元（Big5 線路：全形字＝兩個 Big5 位元組；UTF-8 線路收不下 Big5 的字＝
// Unicode 本身＋WIDE_TRAIL，與 term_buf 存法一致，見 unicode_cells.js 檔頭）。
function textToCellChars(text) {
  const out = [];
  for (const s of text) {
    const cp = s.codePointAt(0);
    if (cp < 0x80) {
      out.push(s);
      continue;
    }
    const b5 = big5Of(cp);
    const enc = b5 || (unicodeCellsEnabled() ? encodeCodePoint(cp) : null);
    if (!enc) return null;
    if (enc.length === 2 && enc[1] === WIDE_TRAIL) out.push(enc[0], WIDE_TRAIL);
    else for (const c of enc) out.push(c);
  }
  return out;
}

// 狀態列的格子（TermChar 陣列）→ 左半換成讀者位置的新陣列（原陣列不動）；換不了回 null。
// head 用第 0 格的顏色（PTT 的「瀏覽」段），tail 用「目前顯示」那段的顏色，補空白到原寬。
export function footerProgressCells(chars, span, texts) {
  if (!chars || !span || !texts) return null;
  const head = textToCellChars(texts.head);
  const tail = textToCellChars(texts.tail);
  if (!head || !tail || head.length + tail.length > span.end || span.end > chars.length) return null;
  const clone = (src, ch) => {
    const c = Object.assign(Object.create(Object.getPrototypeOf(src)), src);
    c.ch = ch;
    c.isLeadByte = false;
    c.startOfURL = c.endOfURL = c.partOfURL = c.partOfKeyWord = false;
    c.fullurl = '';
    c.hyperlink = '';
    return c;
  };
  const headSrc = chars[0];
  const tailSrc = chars[Math.min(span.secondStart + 1, span.end - 1)];
  const left = head.map((ch) => clone(headSrc, ch));
  for (const ch of tail) left.push(clone(tailSrc, ch));
  while (left.length < span.end) left.push(clone(tailSrc, ' '));
  // Big5 lead byte 標記（渲染端看位元組值配對；這裡只讓 isLeadByte 與 term_buf 的語意一致）。
  for (let i = 0; i + 1 < left.length; ++i) {
    const code = left[i].ch.charCodeAt(0);
    if (code >= 0x81 && code <= 0xfe && !left[i - 1]?.isLeadByte) left[i].isLeadByte = true;
  }
  return left.concat(chars.slice(span.end));
}
