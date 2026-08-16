// 「這一格已經被 TermBuf.uriRegEx 認定成 URL 的一部分了嗎？」——所有**額外**的
// 自動連結偵測器（bare_domain / aid_parse / mention_parse）共用的重疊守則。
//
// 為什麼每個偵測器都需要它：主偵測器（src/js/term_buf.js#updateCharAttr）逐列跑
// uriRegEx，命中範圍內每一格都設 partOfURL。額外偵測器是**在同一批 cell 上**再掃
// 一次找主偵測器看不見的形狀（無 scheme 的裸網域、#AIDc、@handle），一旦它們在
// 已經是 URL 的字元裡命中，LinkSegmentBuilder 會在那個 col 切開 segment ⇒ 一條好好
// 的網址被拆成好幾個 <a>，中段甚至變成別的 href。實例（使用者 2026-08 回報）：
//   https://abccbaandy.github.io/PttChrome/#Browsers/1gU3wwNZ
// 的 "#Browsers" 恰好是合法 AIDc 形狀（'#' + 8 個 AID 字元 + 非 AID 字元），
// 被 aid_parse 認走 ⇒ 底線只畫到 #Browsers、尾段 /1gU3wwNZ 連 <a> 都不是。
//
// 方法存在性要用 typeof 守：unit test 的假 cell 只有 { ch, isLeadByte }，沒有這個
// 方法 ⇒ 回 false ⇒ 等同「沒有 URL 資訊」，偵測照原本的規則走。
export function isTermUrlCell(cell) {
  return !!(cell && typeof cell.isPartOfURL === "function" && cell.isPartOfURL());
}

// [from, to) 內任一格已屬 URL。範圍型候選（AIDc、@handle、裸網域 run）用這個判，
// 不只看起始格——邊界剛好壓在 URL 頭尾時單看一格會漏。
export function rangeInTermUrl(chars, from, to) {
  for (let i = from; i < to; ++i) {
    if (isTermUrlCell(chars[i])) return true;
  }
  return false;
}

export default isTermUrlCell;
