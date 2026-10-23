// 推文篩選（P29，docs/comment-filter.md）的共用常數與 DOM 判斷。
// 狀態在 term_view（setCommentFilter／clearCommentFilter／activeCommentFilter），判定在
// comment_parse（isFilteredOut）＋screen_annotations（applyCommentFilterSkips），
// 橫幅在 components/CommentFilterBar。
export const COMMENT_FILTER_BAR_ID = 'commentFilterBar';

// 點／捲橫幅不是點終端機（App._onUploadLayer）。
export function isCommentFilterBarTarget(el) {
  return !!(el && el.closest && el.closest('#' + COMMENT_FILTER_BAR_ID));
}
