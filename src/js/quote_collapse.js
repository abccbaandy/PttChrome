// @ts-check
// 好讀文章把長引言收起來（P106，L 11/18 同意）：標註層。接線在 screen_annotations.computeAnnotations
// （PAGE_READING＋好讀＋pref enableQuoteCollapse，反向讀取接合中不收），畫法在 render/screen.js：
// 收起的列**還在 DOM**、包在 hidden="until-found" 裡（瀏覽器的找字命中會自己打開，beforematch 時
// 我們把整段記成展開；複製由 screen_chunk.readSelectionText 暫時打開再讀），所以收起的列**不**標
// `hidden`（那是「整列移除」的語意，黑名單／推文篩選在用），只標 `quoteHidden`。
//
// 引言的形狀照 pttbbs mbbsd/edit.c 回文引用：先一行「※ 引述《作者》之銘言：」，原文每一行前面加
// 「: 」（色碼拔掉）、讀到簽名檔分隔「--」就停；多層引言就是引文本身已經以「: 」開頭（「: : 」）。
// 使用者可以在編輯器裡手改引言，所以判準只有一條：**連續**以「: 」開頭的行（原文的空行引用後是
// 「: 」，畫面上去掉行尾空白剩「:」，也算）。「:)」「:D」這種表情不是引言。
// 已知限制：引言行太長、被 pmore 折到下一列時，續行沒有「: 」⇒ 那一段在這裡斷開（該收的可能沒收，
// 不會收錯）。接線時若要處理，用 body_wrap 的折行邊界判斷續行。

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
 * 段落的展開 key：段首文字＋「這段首文字在這篇裡第幾次當段首」（同一篇兩段都以「: 同意」或「:」
 * 開頭時，各自展開）。不用列號：反向讀取會往中間插列。
 * @param {ReadonlyArray<string>} texts
 * @param {Array<{ start: number, end: number }>} runs
 */
export function quoteRunKeys(texts, runs) {
  const seen = new Map();
  return runs.map(({ start }) => {
    const head = texts[start];
    const k = seen.get(head) || 0;
    seen.set(head, k + 1);
    return head + '\u0000' + k;
  });
}

/**
 * 把長引言段標進標註（只寫 result[row]，同 applyCommentFilterSkips 的規則）。
 *   - 收起：第 QUOTE_KEEP 行之後 `quoteHidden: true, quoteKey`（render 包進 until-found）；最後一個
 *     露出來的行標 `quoteSkip: N`（收起幾行）、`quoteKey`（quoteRunKeys）。別的功能已經藏起來
 *     （hidden）的列不動（不掛 quoteHidden）。
 *   - 展開（expanded 含這段的 key）：都不收，同一行改標 `quoteExpanded: N`。
 * 標註內容沒變就不換物件（前沿快路徑沿用的前綴要保持同一批物件）。
 * **不清舊標註**：引言段變短／消失時殘留的 quoteHidden／quoteSkip 要靠呼叫端每次給新的 result
 * （computeAnnotations 每幀都是新陣列；前沿快路徑沿用的前綴不會再變）。
 * @param {Array<any>} result computeAnnotations 的逐列標註（可有空洞）
 * @param {ReadonlyArray<string> | null | undefined} expanded 這篇展開過的段落 key
 * @param {ReadonlyArray<string>} texts
 */
export function applyQuoteCollapse(result, expanded, texts) {
  const runs = findQuoteRuns(texts);
  const keys = quoteRunKeys(texts, runs);
  runs.forEach(({ start, end }, i) => {
    const key = keys[i];
    const open = !!(expanded && expanded.includes(key));
    const count = end - start - QUOTE_KEEP;
    const head = start + QUOTE_KEEP - 1;
    for (let r = head + 1; r < end; ++r) {
      const a = result[r] || {};
      if (open) {
        if (a.quoteHidden) {
          const next = { ...a };
          delete next.quoteHidden;
          delete next.quoteKey;
          result[r] = next;
        }
      } else if (!a.hidden && (!a.quoteHidden || a.quoteKey !== key)) {
        result[r] = { ...a, quoteHidden: true, quoteKey: key };
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
  });
}
