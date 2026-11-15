// @ts-check
// 手機好讀文章折行後的懸掛縮排（P86，pref mobileHangIndent → enhance.hangIndent）。
//
// 換行版面（`.main.mobileReflow`）把 80 欄的列自動折行，續行一律從最左邊開始；原文用
// 行首空白排好的段落（名單、條列第二行、全形空白開頭的段落）折行後就被切散。這裡只算
// 「行首有多少空白」，畫法交給 CSS：`padding-left` 推開續行、負的 `text-indent` 讓第一行
// 照舊從 0 起（行首空白本身佔住那段寬度），整列文字一個字都不動 ⇒ 複製出來不變。
//
// 寬度以格子算，跟畫面上的字同一套：半形空白＝`1ch`（等寬字型裡空白跟「0」一樣寬），
// 全形空白（U+3000）住在 `.wpadding` 裡，寬度＝字級＝`1em`（term_view.fixedResize）。
// 所以回傳半形、全形各幾個，由 CSS 自己乘，不在 JS 量 px。
//
// 不套的情況（照舊從最左邊折）：
//   - 行首沒有空白（一般段落）。
//   - 整列都是空白。
//   - 縮排超過 HANG_MAX_CELLS 格：置中的標題、ANSI 圖。手機一行大約 40～48 個半形格，
//     20 格約半個畫面；再寬續行只剩一小條，不如照舊。

/** 縮排上限（半形格），含。超過就不套。 */
export const HANG_MAX_CELLS = 20;

/**
 * @param {string} text 該列的文字（comment_parse.rowToText）
 * @returns {{ half: number, full: number } | null}
 */
export function hangIndentOf(text) {
  if (!text) return null;
  let half = 0;
  let full = 0;
  let i = 0;
  for (; i < text.length; ++i) {
    const c = text[i];
    if (c === " ") half++;
    else if (c === "　") full++;
    else break;
  }
  if (!half && !full) return null;
  if (!text.slice(i).trim()) return null;
  if (half + 2 * full > HANG_MAX_CELLS) return null;
  return { half, full };
}

/**
 * 把縮排寫到列節點上（`.hangIndent` ＋兩個 CSS 自訂屬性，見 main.css）。
 * @param {HTMLElement} node 列節點（span[type="bbsrow"]）
 * @param {{ half: number, full: number } | null} indent
 */
export function applyHangIndent(node, indent) {
  if (!node || !indent) return;
  node.classList.add("hangIndent");
  node.style.setProperty("--hangHalf", String(indent.half));
  node.style.setProperty("--hangFull", String(indent.full));
}
