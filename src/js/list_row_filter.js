// 文章列表「使用者看不到哪幾列」的唯一判準。所有會從文章列表挑文章、列文章給人或 agent
// 看的功能一律經這支，不准各自重寫作者／標題黑名單比對（漏一個就是「列表上藏起來的文章，
// 某個功能又把它端出來」）。消費端對照與規則見 docs/list-row-filter.md。
//
// 兩層：
//   blacklistHit      使用者的黑名單（作者 id 精確比對、標題關鍵字子字串比對）命中與否＋原因
//   isHiddenListText  列表好讀會藏起來的列：上面那層＋刪除文＋鎖文（開不了，read_post → READ_SKIP）
// 輸入一律是一列的純文字（rowToText／getRowText），黑名單一律是 view.blacklist（parseBlacklist）／
// view.titleBlacklist（parseTitleBlacklist），兩者都已轉小寫。純函式、無 DOM。

import {
  isListShapedRow,
  isUnopenableListRow,
  isLockedListRow,
  isDeletedListRow,
  parseListAuthor,
  parseListTitle,
  matchTitleBlacklist
} from './comment_parse';

// view → 黑名單（呼叫當下的值：使用者隨時可能改，快照裡不存）。
export function listFilterOf(view) {
  return {
    blacklist: (view && view.blacklist) || null,
    titleKeywords: (view && view.titleBlacklist) || null
  };
}

// 黑名單命中：{ by: 'author' } | { by: 'title', keyword } | null。作者先比（命中就不看標題）。
// 不看刪除／鎖文，也不看列的形狀（呼叫端各自決定）。
export function blacklistHit(text, blacklistSet, titleKeywords) {
  if (!text) return null;
  if (blacklistSet && blacklistSet.size > 0) {
    const author = parseListAuthor(text);
    if (author && blacklistSet.has(author)) return { by: 'author' };
  }
  if (titleKeywords && titleKeywords.length > 0) {
    const keyword = matchTitleBlacklist(parseListTitle(text), titleKeywords);
    if (keyword) return { by: 'title', keyword: keyword };
  }
  return null;
}

// 關注名單（P33，pref followList／followTitleList）：判準跟黑名單同一套（作者 id 精確、標題
// 關鍵字子字串，都已轉小寫），回傳同形狀。**黑名單優先**：呼叫端只對沒被擋的列問這個。
// 只改顯示（列表整列標色、推文 id 上色），不影響任何送鍵或挑文章的功能。
export function followHit(text, followSet, titleKeywords) {
  return blacklistHit(text, followSet, titleKeywords);
}

// 列表好讀會藏起來的列（list_session#visibleListIndices、screen_annotations 的
// listEasyReading 分支、next_article 的下一篇都吃這一份）。不是列表形的列一律可見。
export function isHiddenListText(text, blacklistSet, titleKeywords) {
  if (!isListShapedRow(text)) return false;
  if (isUnopenableListRow(text)) return true;
  return !!blacklistHit(text, blacklistSet, titleKeywords);
}

// 為什麼被藏（錄製檔 log 用）：'deleted' | 'locked' | 'author' | 'title' | null。
export function hiddenReason(text, blacklistSet, titleKeywords) {
  if (!isListShapedRow(text)) return null;
  if (isDeletedListRow(text)) return 'deleted';
  if (isLockedListRow(text)) return 'locked';
  const hit = blacklistHit(text, blacklistSet, titleKeywords);
  return hit ? hit.by : null;
}

// 錄製檔記黑名單設定用的摘要（debug_recorder）。id 原樣記：錄製檔本來就含整個列表畫面的
// 作者 id；要分辨「是不是黑名單擋的」得看得到名單本身。
export function filterSummary(view) {
  const f = listFilterOf(view);
  return {
    authors: f.blacklist ? Array.from(f.blacklist) : [],
    titleKeywords: f.titleKeywords ? f.titleKeywords.slice() : []
  };
}
