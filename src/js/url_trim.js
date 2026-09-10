// URL 結尾的 prose 修剪（無 DOM / 無網路 ⇒ 純 node 可測）。
//
// 為什麼需要這支：本專案所有 URL 偵測器的 path 字元類都含 `(`、`)`、`,`、`;`、`.`
// （`TermBuf.uriRegEx`、`url_fix.PATH`、`url_cjk.PATH_ASCII`、`url_join.URL_CHAR_RE`
// ——同一組字元類被複製在 5 處），而那些字元在 URL path 裡確實合法（維基百科的
// `戈黛娃夫人_(歌手)` 就靠它）。所以**不可以靠縮字元類解決**「句子的標點被吃進
// 連結」這件事，只能在算出結尾之後再修剪一次。
//
// 回報現場（2026-09-10）：
//     ，(https://vt100.net/emu/ctrlseq_dec.html)，本站
//     (https://docs.frankentui.com/render/synchronized-output)
// 兩行的連結都把結尾的 `)` 吃進去 ⇒ 連結 404，而且同一個 `<a href>` 的下游
// （行內圖片預覽、hover 預覽、右鍵複製文章連結）全部跟著失配：`RE_IMAGE_EXT`
// 的 `(?:$|[?#])` 錨定對 `....png)` 不成立，預覽是**靜默**不出現。
//
// 規則（反覆套用到收斂）：
//   1. 不成對的 `)` `]` `}` ⇒ 砍。「成對」指的是剩餘字串裡該右括號的數量不超過
//      對應左括號 —— 所以 `(https://a/b)` 的 `)` 砍掉（左括號在 URL 之外），
//      `https://a/b_(c)` 的 `)` 保留。
//   2. 結尾的 `.` `,` `;` `:` `!` `?` ⇒ 砍（句尾標點，URL 幾乎不會以它們結尾）。
//   3. 絕不砍進 scheme：`<scheme>://` ＋至少一個字元永遠保留（`https://)` 這種
//      退化輸入不得被砍成 `https://`）。
//
// 引號 `'` `"` 刻意**不納入**：path 裡出現引號比句尾引號常見（`url_fix.PATH` /
// `URL_CHAR_RE` 都含 `'`），砍它的期望值是負的。
// 全形標點也不必處理：Big5 分支在 TermBuf 會把非 ASCII 成對換成 placeholder，
// `uriRegEx` 天生吃不到全形括號；CJK 延伸那一段由 `url_cjk.js` 的 STOP 集合終止。

// 結尾可砍的句尾標點。
const TAIL_PUNCT = '.,;:!?';

// 右括號 → 對應左括號。
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

// `text` 前 `end` 個字元裡 `ch` 出現幾次。
function countChar(text, ch, end) {
  let n = 0;
  for (let i = 0; i < end; ++i) if (text.charAt(i) === ch) ++n;
  return n;
}

// 永不砍進去的下界：`<scheme>://` ＋ 1 個字元；沒有 scheme 的候選（url_fix 的裸
// 網域那一類）至少保留 1 個字元。
function floorOf(url) {
  const i = url.indexOf('://');
  return i >= 0 ? i + 4 : 1;
}

// 尾端有幾個字元其實屬於句子而不是 URL。
export function trimUrlTailLength(url) {
  if (typeof url !== 'string' || !url) return 0;
  const floor = floorOf(url);
  let end = url.length;
  while (end > floor) {
    const ch = url.charAt(end - 1);
    if (TAIL_PUNCT.indexOf(ch) >= 0) {
      --end;
      continue;
    }
    const open = CLOSERS[ch];
    if (open && countChar(url, ch, end) > countChar(url, open, end)) {
      --end;
      continue;
    }
    break;
  }
  return url.length - end;
}

// 修剪後的 URL。
export function trimUrlTail(url) {
  const n = trimUrlTailLength(url);
  return n ? url.slice(0, url.length - n) : url;
}
