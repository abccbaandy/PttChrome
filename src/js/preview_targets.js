// 「這一下點在預覽媒體上」的判準 —— prod 與 e2e 共用，避免兩邊漂移。
//
// 為什麼需要它：內嵌預覽圖是**整寬區塊、起點在第 0 欄**，而文章模式的第 0-6 欄
// 現在是「點了就離開文章」的手勢。兩者直接衝突。而且 Screen.jsx#handleImageClick
// 是掛在 #mainContainer 上的 React onClick（事件委派），預覽圖**不是 <a> 的子孫**，
// 所以 mouse_click 開頭的 closest('a') 攔不到它 —— 必須另外擋一次。
//
// 涵蓋範圍（對 ImagePreviewer.jsx / LazyInlinePreview.jsx 現況核對）：
//   .inlinePreviewSlot   好讀模式的延遲載入插槽（真圖、替身盒、指示器都在裡面）
//   .previewLoading      「讀取中…」指示器（URL 解析中／媒體下載中共用）
//   .previewError        載入失敗提示（本身可點＝重試）
//   img.easyReadingImg   內嵌圖（含 .hyperLinkPreview 放大切換）
//   video.easyReadingVideo / iframe  自動開的影片
export const PREVIEW_CLICK_SELECTOR =
  '.inlinePreviewSlot, .previewLoading, .previewError, ' +
  'img.easyReadingImg, video.easyReadingVideo, iframe';

// e.target 是否落在預覽媒體上（含其後代）。
export function isPreviewTarget(el) {
  return !!(el && el.closest && el.closest(PREVIEW_CLICK_SELECTOR));
}
