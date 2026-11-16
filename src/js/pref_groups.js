// @ts-check
// 設定頁「一般」分區裡的小標（P94）。純資料＋純函式，無 DOM。
//
// 「一般」那一區有將近 50 項，照設定頁上的順序切成六段。**每段只記第一項的 key**：
// 段的範圍＝從這一項起，到下一段第一項之前。這樣新增設定只要放對位置就自動落進
// 那一段，不必再維護一份逐項名單。
//
// 兩個消費端共用這一份：
//   - PrefModal.jsx：在每段第一項前面畫小標（data-pref-group），區塊頂端畫跳轉列；
//   - pref_search.js：搜尋結果的副標寫「一般 · 首頁與收藏」。
// 守護：tests/unit/pref_groups.test.jsx（畫面上每個小標緊接著它的 first 項；
// 索引裡 first 的順序與這裡一致）。

/** @typedef {{ id: string, titleKey: string, first: string }} PrefGroup */

/** @type {PrefGroup[]} */
export const GENERAL_GROUPS = [
  { id: "basic", titleKey: "options_groupBasic", first: "nativeSafeMode" },
  {
    id: "easyReading",
    titleKey: "options_groupEasyReading",
    first: "enableEasyReading",
  },
  { id: "home", titleKey: "options_groupHome", first: "enableHomeDashboard" },
  { id: "article", titleKey: "options_groupArticle", first: "enableBoardTabs" },
  {
    id: "hotkeys",
    titleKey: "options_groupHotkeys",
    first: "easyReadingEndSwitchKey",
  },
  { id: "misc", titleKey: "options_groupMisc", first: "refreshKeyIntercept" },
];

/**
 * 依設定頁順序排好的 key 清單 → 每個 key 屬於哪一段（titleKey）。
 * 第一段的 first 之前的項目（不該有）不在結果裡。
 * @param {string[]} orderedKeys
 * @returns {Map<string, string>}
 */
export function groupTitleByKey(orderedKeys) {
  const firsts = new Map(GENERAL_GROUPS.map((g) => [g.first, g.titleKey]));
  /** @type {Map<string, string>} */
  const out = new Map();
  /** @type {string|null} */
  let current = null;
  for (const key of orderedKeys) {
    const start = firsts.get(key);
    if (start) current = start;
    if (current) out.set(key, current);
  }
  return out;
}
