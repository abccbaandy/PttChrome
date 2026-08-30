// 內文跨行連結（無 DOM / 無網路，守護測試 tests/unit/body_wrap.test.js）。
//
// PTT 的文章內文一列放不下整條網址時會被切成兩列，兩層逐列偵測因此都失效：
//   08/30/2026 06:06:19 ※ 文章網址: https://www.ptt.cc/bbs/PttBug/M.1788041180.A.
//   404.html
// TermBuf.uriRegEx 只看到左邊的殘段（渲染成一條指向 404 的連結），右邊的
// `404.html` 沒有 scheme 根本不成立 ⇒ 右鍵選單的「複製文章代碼／複製文章 deep
// link」（articleTargetFromAnchor → parseArticleUrl）整組消失，hover/行內預覽也
// 因為 isImageLikeUrl 判不出圖而失效。
//
// 本模組把兩列的殘段接回去，**兩列都渲染成同一條 <a class="y">**（href 是接好的
// 完整網址）。與 url_fix / url_wrap 的「原文不動、下面補一行 ↳」不同——內文這裡
// 要的就是連結本身跨行成立。
//
// ---- 判別合約（對稱 src/js/url_wrap.js 的推文版）----
// 三個訊號缺一不可，外加一條反向守門：
//   1. 左列寫滿   URL 字元一路到 maxcol 為止，且 maxcol+1 不是 URL 字元
//   2. 右列續上   下一列的 col 0 就是 URL 字元（中間有空白就不是續行）
//   3. URL 形狀   併起來要有合法 host（TLDS）＋（scheme 或 path），見 url_join.js
//   反向守門      左片段自己就以媒體副檔名收尾 ⇒ 那是剛好寫滿的完整網址，不接
//
// 為什麼「寫滿 maxcol」這條單獨看很弱、合起來卻夠：pmore 是**逐字元**硬折行
// （不斷詞，pmore.c:1836-1900），所以「URL 字元一路跑到 maxcol、下一列 col 0 接
// 著仍是 URL 字元」在折行情形下**必然**是同一個 token 被切開。剩下的誤判只有
// 「某個檔案行剛好正好 78 欄且以網址收尾，而下一個檔案行以 URL 合法 ASCII 起頭、
// 併起來還是合法 TLD」。
//
// ---- 為什麼不在 term_buf 做 ----
// term_buf.updateCharAttr 的 line.uris / fullurl 是**逐列**語意（且已有既知的座標
// 脫勾問題，見該檔的 KNOWN 註解），而且它跑在活的 24 列 buffer 上；好讀模式的左
// 列可能來自更早、已經快照進 buf.pageLines 的那一頁。跨列資訊只有標註層
// （screen_annotations.computeAnnotations）手上齊全。
import { endsWithMediaExt } from './url_fix';
import { isUrlCell, validateJoined } from './url_join';

// pmore 的內文顯示寬度 → 最後一個可寫的欄號（pmore.c:1447-1456）：
//   headerw = MFDISP_DBCS_HEADERWIDTH(t_columns-1)   // 無條件捨去成偶數，不切半個中文字
//   dispw   = headerw - (t_columns - headerw < 2)
//   maxcol  = dispw - 1
// 80 欄 ⇒ 78 - 1 = 77。**不寫死 77**，與 comment_merge.js 不寫死 66/51 同一個約定。
export function pmoreMaxCol(cols) {
  const w = cols - 1;
  const headerw = w - (w % 2);
  const dispw = headerw - (cols - headerw < 2 ? 1 : 0);
  return dispw - 1;
}

// chars[from, to) 串成字串。
function textOf(chars, from, to) {
  let s = '';
  for (let i = from; i < to; ++i) s += chars[i].ch;
  return s;
}

// 這一列的 URL 字元是不是「一路寫到 maxcol 為止」。maxcol+1 那格若是 pmore 的折行
// 符號 `\`，因為反斜線不在 URL_CHAR_RE 內，這個條件自然成立（見 url_join.js）。
function endsAtMaxCol(chars, maxcol) {
  return isUrlCell(chars, maxcol) && !isUrlCell(chars, maxcol + 1);
}

// detectBodyWrappedUrls(lines, isSkipRow)
//   lines     : TermChar[][]（整篇；好讀模式下就是 buf.pageLines）
//   isSkipRow : (row) => boolean，推文列／被黑名單隱藏的列一律排除
// -> Array<{ href, host, parts: [{ row, startCol, endCol, preview }] }>
//    parts 依列序，長度 ≥ 2；preview 只有最後一段為 true（一條網址只開一張圖）。
// 絕大多數文章回 []。
export function detectBodyWrappedUrls(lines, isSkipRow) {
  if (!lines || lines.length < 2) return [];
  const cols = lines[0] ? lines[0].length : 0;
  if (cols < 4) return [];
  const maxcol = pmoreMaxCol(cols);
  const out = [];
  let row = 0;
  while (row < lines.length - 1) {
    const prev = lines[row];
    if (isSkipRow(row) || !prev || !endsAtMaxCol(prev, maxcol)) {
      ++row;
      continue;
    }
    // 左片段：緊貼 maxcol 往左取連續 URL 字元。
    let l = maxcol;
    while (isUrlCell(prev, l - 1)) --l;
    const left = textOf(prev, l, maxcol + 1);
    // 反向守門：左片段自己就是完整的媒體網址 ⇒ 只是剛好寫滿，不是殘段。
    if (endsWithMediaExt(left)) {
      ++row;
      continue;
    }
    // 續行鏈：一路往下吃，直到某一列沒有寫滿 maxcol（那就是最後一段）。
    const parts = [{ row, startCol: l, endCol: maxcol + 1, preview: false }];
    let joined = left;
    let r = row + 1;
    while (r < lines.length && !isSkipRow(r) && isUrlCell(lines[r], 0)) {
      const cur = lines[r];
      let e = 0;
      while (isUrlCell(cur, e + 1)) ++e;
      joined += textOf(cur, 0, e + 1);
      parts.push({ row: r, startCol: 0, endCol: e + 1, preview: false });
      if (e === maxcol && !isUrlCell(cur, maxcol + 1)) {
        ++r;
        continue; // 這一列也寫滿了 ⇒ 還沒到結尾
      }
      break;
    }
    if (parts.length < 2) {
      ++row;
      continue;
    }
    const v = validateJoined(joined);
    if (!v) {
      ++row;
      continue;
    }
    parts[parts.length - 1].preview = true;
    out.push({ href: v.fixed, host: v.host, parts });
    row = parts[parts.length - 1].row + 1;
  }
  return out;
}

// 把一段接好的範圍寫進某一列的標註，並把落在該範圍內的其他連結候選拿掉。
//
// 重疊排除是硬規則（docs/enhanced-addon.md「額外連結偵測器一律要排除已被 uriRegEx
// 標成 URL 的格子」）：左列殘段本來就被 uriRegEx 標了所以其他偵測器自己會避開，
// **右列的殘段沒有**（`404.html` 之類對 uriRegEx 完全不成立）⇒ 這條必須自己補，
// 否則同一段文字會同時被包成兩個 <a>。
export function applyWrapUrlRange(ann, range) {
  const out = Object.assign({}, ann || {});
  out.wrapUrls = (out.wrapUrls || []).concat(range);
  const overlaps = (c) => c.startCol < range.endCol && c.endCol > range.startCol;
  const keys = ['mentions', 'aids', 'giveaways', 'bareDomains'];
  for (let i = 0; i < keys.length; ++i) {
    const k = keys[i];
    if (!out[k]) continue;
    const kept = out[k].filter((c) => !overlaps(c));
    if (kept.length) out[k] = kept;
    else delete out[k];
  }
  // fixedUrls 是整列的「↳ 修復連結」（沒有欄座標）：同一條網址已經原位接好了，
  // 不需要下面再補一行一模一樣的。
  if (out.fixedUrls) {
    const kept = out.fixedUrls.filter((f) => f.fixed !== range.href);
    if (kept.length) out.fixedUrls = kept;
    else delete out.fixedUrls;
  }
  return out;
}
