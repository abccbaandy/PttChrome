// 手機長按推文的選單：常用的幾項收成最上面一排圖示鈕（P37），其餘照舊列在下面，少捲一次。
// 純資料：哪些項目算常用、排序、最多幾顆、什麼時候才收（ContextSheet.jsx 畫）。
// 項目本身（出現條件、handler、反灰）仍只來自 context_menu_entries.js —— 這裡只重新分組。

// 優先序（前面的先上）。只看這個人／只看原 PO／顯示全部推文是互斥出現的（篩選生效與否）。
export const QUICK_ACTION_KEYS = [
  "replyComment",
  "copyComment",
  "filterCommentUser",
  "filterCommentOp",
  "clearCommentFilter",
  "addAuthorFollow",
  "addAuthorBlacklist",
];

// 推文才有的項目：至少要有一個，才算「長按推文」（列表卡片長按也有黑名單／關注，那邊不收）。
const COMMENT_KEYS = new Set([
  "replyComment",
  "copyComment",
  "copyCommentAll",
  "filterCommentUser",
  "filterCommentOp",
  "filterCommentPush",
  "filterCommentBoo",
  "clearCommentFilter",
]);

export const QUICK_ACTION_MAX = 5;
// 少於這個數就不收（一兩顆圖示反而比文字難懂）。
const QUICK_ACTION_MIN = 3;

// 圖示鈕下面的短字（完整的字放 aria-label／title）。
export const QUICK_ACTION_LABEL_KEYS = {
  replyComment: "cmenuShort_replyComment",
  copyComment: "cmenuShort_copyComment",
  filterCommentUser: "cmenuShort_filterCommentUser",
  filterCommentOp: "cmenuShort_filterCommentOp",
  clearCommentFilter: "cmenuShort_clearCommentFilter",
  addAuthorFollow: "cmenuShort_addAuthorFollow",
  addAuthorBlacklist: "cmenuShort_addAuthorBlacklist",
};

// entries（buildContextMenuEntries 的結果）→ { quick, rest }。不收時 quick 是空的、rest 原封不動。
// rest 拿掉收走的項目後，開頭、結尾與連續的分隔線只留必要的。
export function splitQuickActions(entries) {
  const items = entries.filter((e) => e.type === "item");
  if (!items.some((e) => COMMENT_KEYS.has(e.key)))
    return { quick: [], rest: entries };
  const quick = QUICK_ACTION_KEYS.map((k) => items.find((e) => e.key === k))
    .filter(Boolean)
    .slice(0, QUICK_ACTION_MAX);
  if (quick.length < QUICK_ACTION_MIN) return { quick: [], rest: entries };
  const taken = new Set(quick);
  const rest = [];
  for (const e of entries) {
    if (taken.has(e)) continue;
    if (e.type === "divider") {
      const last = rest[rest.length - 1];
      if (!last || last.type === "divider") continue;
    }
    rest.push(e);
  }
  while (rest.length && rest[rest.length - 1].type === "divider") rest.pop();
  return { quick, rest };
}
