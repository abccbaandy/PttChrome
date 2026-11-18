// @ts-check
// 好讀文章把長引言收起來（P106，L 11/18 同意）：**純邏輯層**，還沒接上渲染。
// 實作筆記（共享資料夾 research/plans/p106-quote-collapse.md）：接線照抄推文篩選細線
// （screen_annotations.js#applyCommentFilterSkips）的 hidden＋串首標記＋展開 key 那一套。
//
// 引言的形狀照 pttbbs mbbsd/edit.c 回文引用：先一行「※ 引述《作者》之銘言：」，原文每一行前面加
// 「: 」（色碼拔掉）、讀到簽名檔分隔「--」就停；多層引言就是引文本身已經以「: 」開頭（「: : 」）。
// 使用者可以在編輯器裡手改引言，所以判準只有一條：**連續**以「: 」開頭的行（原文的空行引用後是
// 「: 」，畫面上去掉行尾空白剩「:」，也算）。「:)」「:D」這種表情不是引言。

/** 連續幾行以上才收。 */
export const QUOTE_COLLAPSE_MIN = 5;
/** 收起時留幾行在外面。 */
export const QUOTE_KEEP = 2;

/**
 * 這一行是不是引言行（畫面文字，行尾空白可有可無）。
 * @param {string | null | undefined} text
 */
export function isQuoteLine(text) {
  const t = text == null ? '' : String(text);
  return t.charAt(0) === ':' && (t.length === 1 || t.charAt(1) === ' ');
}

/**
 * 找出所有夠長的連續引言段。
 * @param {ReadonlyArray<string>} texts 每一列的文字
 * @param {number} [min]
 * @returns {Array<{ start: number, end: number }>} end 不含
 */
export function findQuoteRuns(texts, min = QUOTE_COLLAPSE_MIN) {
  const out = [];
  const n = texts ? texts.length : 0;
  let row = 0;
  while (row < n) {
    if (!isQuoteLine(texts[row])) {
      ++row;
      continue;
    }
    const start = row;
    while (row < n && isQuoteLine(texts[row])) ++row;
    if (row - start >= min) out.push({ start, end: row });
  }
  return out;
}

/**
 * 把長引言段標進標註（只寫 result[row]，同 applyCommentFilterSkips 的規則）。
 *   - 收起：第 QUOTE_KEEP 行之後 `hidden: true, quoteHidden: true`；最後一個露出來的行標
 *     `quoteSkip: N`（收起幾行）、`quoteKey`（這段第一行的文字：不用列號，反向讀取會往中間插列）。
 *   - 展開（expanded 含這段的 key）：都不藏，同一行改標 `quoteExpanded: N`（render 畫「收起引言」）。
 * 標註內容沒變就不換物件（前沿快路徑沿用的前綴要保持同一批物件）。
 * @param {Array<any>} result computeAnnotations 的逐列標註（可有空洞）
 * @param {ReadonlyArray<string> | null | undefined} expanded 這篇展開過的段落 key
 * @param {ReadonlyArray<string>} texts
 */
export function applyQuoteCollapse(result, expanded, texts) {
  for (const { start, end } of findQuoteRuns(texts)) {
    const key = texts[start];
    const open = !!(expanded && expanded.includes(key));
    const count = end - start - QUOTE_KEEP;
    const head = start + QUOTE_KEEP - 1;
    for (let r = head + 1; r < end; ++r) {
      const a = result[r] || {};
      if (open) {
        if (a.quoteHidden) {
          const next = { ...a };
          delete next.quoteHidden;
          delete next.hidden;
          result[r] = next;
        }
      } else if (!a.quoteHidden || !a.hidden) {
        result[r] = { ...a, hidden: true, quoteHidden: true };
      }
    }
    const a = result[head] || {};
    const skip = open ? undefined : count;
    const exp = open ? count : undefined;
    if (a.quoteSkip !== skip || a.quoteExpanded !== exp || a.quoteKey !== key) {
      const next = { ...a, quoteKey: key };
      if (open) {
        delete next.quoteSkip;
        next.quoteExpanded = count;
      } else {
        delete next.quoteExpanded;
        next.quoteSkip = count;
      }
      result[head] = next;
    }
  }
}
