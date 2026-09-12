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

// 「這一下右鍵壓在真的圖片上」的判準 —— 成立就**整個放行**瀏覽器原生選單
// （另存圖片／複製圖片／以 Google 智慧鏡頭搜尋）。
//
// 與 PREVIEW_CLICK_SELECTOR **刻意分開**，不是共用一條：
//   * 那條含 .inlinePreviewSlot／.previewLoading／.previewError ——
//     整寬區塊、含圖片左右兩側的留白，用它放行等於「圖片那一列整列都沒有我們的
//     選單」，代價遠超需求。
//   * 原生選單只在指標真的落在圖片像素上時才有意義（沒有圖片就沒有「另存圖片」）。
//   * 影片／iframe 不納入：<video> 自己有原生控制項選單，iframe 是第三方頁面，
//     兩者都不是這次動線（以圖找圖）的對象。
//
// 依據 CLAUDE.md「系統／瀏覽器的原生行為不准模擬，一律接入使用」：智慧鏡頭沒有
// 任何網頁可呼叫的 API，唯一入口就是原生選單 ⇒ 只能拆掉自己擋原生的那道牆
// （ContextMenu/index.jsx 開頭那個無條件的 preventDefault）。
export const NATIVE_MENU_SELECTOR = 'img.easyReadingImg';

// e.target 是否落在內嵌預覽圖上（含其後代——<img> 沒有後代，但寫法保持一致）。
export function isNativeMenuTarget(el) {
  return !!(el && el.closest && el.closest(NATIVE_MENU_SELECTOR));
}
