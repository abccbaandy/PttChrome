// PTT 官方「推文實況」（文章裡按 v）的畫面判讀與好讀累積的純邏輯。無 DOM、無網路。
//
// ---- PTT 端（CONFIRMED pttbbs mbbsd/more.c#live_run、pmore.c#pmore_cmd_live）----
// 文章裡按 v：pmore 先 mf_goBottom()+mf_display() 畫最後一頁、記下「畫了幾列」，以 RET_LIVE
// 退出 ⇒ more.c#live_run 接手整個畫面：
//   1. 在最後一頁的下一列印橫幅「實 況 開 始」（live_print_banner，1;33;41 滿寬）；
//   2. 補印開文之後新增的完整列（live_catchup，最多 16KB）；
//   3. 之後每則推文（IPC PubSub）照檔案裡的原樣一列一列往下印（live_print_text）。畫面滿了
//      ⇒ live_next_row 把整個畫面上捲一列（pfterm 送 `ESC[24;1H\n`），推文寫在 b_lines-1；
//   4. 每秒重畫狀態列 vs_footer(" 實況中 mm:ss [+N] ", " (X)留言 (B)鈴聲[關閉] (T/M/S)調時 (q)離開\t日期")。
//      N＝這次實況收到幾則（live_flush 每則 +1；catchup 不算）。844e8d0 版 part2 是
//      「(X)留言(B)鈴聲… (任意鍵)離開」。
//   5. q／Q 離開（844e8d0 版 X／B／T／M／S 以外任何鍵都離開）⇒ live_run 回 FULLUPDATE ⇒
//      read_post 返回 ⇒ **回到文章列表**（不是回 pmore）。
//   6. X／x／% 留言：scr_dump → hooks->comment（一般推文流程，畫在畫面上）→ scr_restore；
//      留言期間推文排隊，回來才一起印。
// 狀態列不是 pmore 狀態列（parseStatusRow 認不出）⇒ 本檔另外認。
//
// ---- 好讀這側 ----
// 好讀畫的是累積長頁（buf.pageLines）。實況畫面上是「文章最後一頁＋橫幅＋推文」，而且會上捲，
// 所以累積分兩步：
//   進實況那一幀（mergeLiveArticle）：橫幅以上＝文章最後一頁，跟累積頁的尾巴對齊（內容重疊，
//     findPageOverlap 同一套）⇒ 補上累積頁還沒有的尾巴，再接橫幅以下。對不上 ⇒ 不接管（原生鏡像）。
//   之後每一幀（mergeLiveWindow）：橫幅還在畫面上 ⇒ 橫幅以下就是整段實況；橫幅捲走了 ⇒ 畫面是
//     實況段的最後 R 列，找「上捲了幾列」對齊後只接新的。
// 認不出就不接管（docs/easy-reading.md「實況模式」）。

import { findPageOverlap } from './comment_parse';

export const LIVE_BANNER_TEXT = '實 況 開 始';

// 實況狀態列 part1：" 實況中 %02d:%02d [+%d] "（more.c#live_draw_status）。
const LIVE_STATUS_RE = /^ 實況中 (\d+):(\d\d) \[\+(\d+)\] /;

// 底列是不是實況狀態列。回 { elapsedSec, received, canComment, bell } 或 null。
//   canComment：part2 有沒有「(X)留言」（hooks->comment 不存在的 pager 不印）。
//   bell：鈴聲[打開] ⇒ true、[關閉] ⇒ false、看不到（被截）⇒ null。
export function parseLiveStatusRow(text) {
  const s = String(text || '');
  const m = LIVE_STATUS_RE.exec(s);
  if (!m) return null;
  let bell = null;
  if (s.indexOf('鈴聲[打開]') >= 0) bell = true;
  else if (s.indexOf('鈴聲[關閉]') >= 0) bell = false;
  return {
    elapsedSec: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
    received: parseInt(m[3], 10),
    canComment: s.indexOf('(X)留言') >= 0,
    bell
  };
}

export function isLiveStatusRow(text) {
  return parseLiveStatusRow(text) !== null;
}

const trimRight = (t) => String(t || '').replace(/\s+$/, '');
const isBlank = (t) => trimRight(t) === '';

// 橫幅列：整列只有「實 況 開 始」（兩側是同色空白）。
export function isLiveBannerRow(text) {
  return String(text || '').trim() === LIVE_BANNER_TEXT;
}

// 畫面（不含狀態列）上橫幅在哪一列；沒有 ⇒ -1。
export function findLiveBanner(screenTexts) {
  for (let i = screenTexts.length - 1; i >= 0; --i)
    if (isLiveBannerRow(screenTexts[i])) return i;
  return -1;
}

// 去掉尾端空白列之後的列數。
export function contentLength(texts, from, to) {
  let end = to;
  while (end > from && isBlank(texts[end - 1])) --end;
  return end - from;
}

// 進實況那一幀：橫幅以上（文章最後一頁）怎麼接到累積頁後面。
//   accTexts    累積頁每一列的文字
//   screenTexts 這一幀畫面（不含狀態列）每一列的文字
// 回 null ＝不接管（看不到橫幅，或文章段對不上累積頁——中間有一段沒讀到，接上去會靜默缺字）。
// 否則回：
//   keep        累積頁保留前幾列（去掉尾端空白列：單頁短文的累積頁是整個畫面、含空白填充列）
//   articleFrom 畫面上第幾列起是累積頁還沒有的文章尾巴（到 articleTo 為止）
//   articleTo   文章段（去尾端空白列）的結尾
//   liveFrom    實況段從哪一列開始（＝橫幅那一列）
//   liveTo      實況段的結尾（去尾端空白列；畫面還沒滿時下面是空的）
export function mergeLiveArticle({ accTexts, screenTexts }) {
  const banner = findLiveBanner(screenTexts);
  if (banner < 0) return null;
  const keep = contentLength(accTexts, 0, accTexts.length);
  const articleTo = contentLength(screenTexts, 0, banner);
  const liveTo = banner + contentLength(screenTexts, banner, screenTexts.length);
  let articleFrom = 0;
  if (articleTo > 0) {
    if (keep === 0) return null;
    // 累積頁的尾巴 == 文章最後一頁的開頭（讀完整篇時＝整頁都重疊）。
    const k = findPageOverlap(accTexts.slice(0, keep), screenTexts.slice(0, articleTo));
    // 只對上一兩列（"--"、空白附近的常見列）不算數：除非整段都對上，否則要求至少 3 列。
    if (k === 0 || (k < articleTo && k < 3)) return null;
    articleFrom = k;
  }
  return { keep, articleFrom, articleTo, liveFrom: banner, liveTo };
}

// 之後每一幀：實況段（liveTexts，第 0 列是橫幅）要怎麼更新。
//   screenTexts   這一幀畫面（不含狀態列）
//   receivedDelta 狀態列 [+N] 比上一幀多了幾則（多列推文、catchup 不算 ⇒ 只是下界提示）
// 回：
//   { action: 'none' }                       沒有新東西
//   { action: 'append', from, to }           接上畫面第 from..to 列
//   { action: 'replace', from, to }          實況段整段換成畫面第 from..to 列（橫幅還在、但對不上舊的）
//   { action: 'resync', from, to }           橫幅捲走而且找不到對齊點：整個畫面當新列接上（一次湧進超過一個畫面）
export function mergeLiveWindow({ liveTexts, screenTexts, receivedDelta }) {
  const n = liveTexts.length;
  const R = screenTexts.length;
  const banner = findLiveBanner(screenTexts);
  if (banner >= 0) {
    const to = banner + contentLength(screenTexts, banner, R);
    const m = to - banner;
    let same = m >= n;
    for (let i = 0; same && i < n; ++i)
      if (trimRight(liveTexts[i]) !== trimRight(screenTexts[banner + i])) same = false;
    if (!same) return { action: 'replace', from: banner, to };
    if (m === n) return { action: 'none' };
    return { action: 'append', from: banner + n, to };
  }
  // 橫幅捲走了 ⇒ 畫面已滿，整個畫面都是實況段最後 R 列。上捲 d 列 ⇔
  // screen[0 .. R-d) == live[n-(R-d) .. n)。
  const matches = (d) => {
    const keepRows = R - d;
    if (keepRows > n) return false;
    for (let i = 0; i < keepRows; ++i)
      if (trimRight(screenTexts[i]) !== trimRight(liveTexts[n - keepRows + i])) return false;
    return true;
  };
  const want = Math.max(0, receivedDelta | 0);
  let first = -1;
  let chosen = -1;
  for (let d = 0; d < R; ++d) {
    if (!matches(d)) continue;
    if (first < 0) first = d;
    // 同樣的推文連刷好幾列時，好幾個 d 都對得上；[+N] 的增量是下界，取第一個不小於它的。
    if (d >= want) { chosen = d; break; }
  }
  if (chosen < 0) chosen = first;
  if (chosen < 0) return { action: 'resync', from: 0, to: R };
  if (chosen === 0) return { action: 'none' };
  return { action: 'append', from: R - chosen, to: R };
}

// 好讀實況中按下的單字元鍵要不要先切原生鏡像（_enterFunctionMode）。
// X／x／% 留言會畫推文流程的 prompt、q／Q 離開回列表 ⇒ 要鏡像；B／T／M／S 這類只改狀態列的鍵
// 與其他被 live_run 忽略的鍵直接送，畫面照樣是好讀（狀態列由底部 footer 鏡像）。
export function liveKeyMirrors(key) {
  return key === 'X' || key === 'x' || key === '%' || key === 'q' || key === 'Q';
}
