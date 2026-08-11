// 好讀「自動開圖」的延遲載入／遠離卸載決策（純邏輯，無 DOM；unit 守護：
// tests/unit/lazy_inline_preview.test.jsx）。
//
// ---- 為什麼需要 ----
// 好讀文章模式把整篇累積成一長頁，並對**每一個**連結掛 inline 預覽。實錄的
// EZsoft 長文（ptt-debug-20260809）有 287 個圖片連結：舊行為是文章一累積到就全部
// 解析＋下載＋解碼，而且到離開文章前永不釋放 —— 已解碼的點陣圖是分頁記憶體的最大
// 宗（「記憶體吃滿」）。無副檔名的 imgur 連結還會各自再發兩個 HEAD 探測請求。
//
// 所以延後的不只是 <img> 的下載，而是**整個 <ImagePreviewer> 的掛載**：
// requestPreview() 一被呼叫就開始解析網址（含 imgur 探測），單靠 <img loading=lazy>
// 攔不到它。另外現行 <img> 在載入完成前是 display:none，而瀏覽器對 display:none 的
// 元素根本不會觸發 lazy 載入 —— 那條路本來就走不通，故一律由這裡的 wrapper 負責。

// 進入視野前多遠就開始載入。約一個視窗高：捲動時圖片通常已經備好，
// 又不會把整篇的圖一次拉下來。
export const LAZY_MOUNT_MARGIN_PX = 1500;

// 離開視野多遠才卸載釋放記憶體。刻意比 mount 邊界大很多（遲滯區），
// 否則在邊界附近來回捲動會反覆卸載／重載（閃爍＋重複下載）。
export const LAZY_UNMOUNT_MARGIN_PX = 6000;

// mounted：目前是否已掛上真正的預覽元件
// near   ：與「視野 + LAZY_MOUNT_MARGIN_PX」相交
// far    ：與「視野 + LAZY_UNMOUNT_MARGIN_PX」**不**相交
export function nextLazyState({ mounted, near, far }) {
  if (!mounted && near) return "mount";
  if (mounted && far) return "unmount";
  return "keep";
}

// 佔位盒內「真的載到媒體」的判準（LazyInlinePreview 卸載前用它查 slot）。
// 刻意**不含** .previewLoading／.previewError —— 見 nextSlotHeight。
export const LAZY_MEDIA_SELECTOR =
  "img.easyReadingImg, video.easyReadingVideo, img.hyperLinkPreview, iframe";

// 卸載時要把當下高度釘進佔位盒，否則內容總高會塌陷、捲動容器的 scrollTop 被夾住
// → 使用者的閱讀位置整個位移（與點圖放大／影片全螢幕同一類問題，見
// src/js/scroll_anchor.js 開頭）。0／負值不採信（尚未載入完成就被捲過去）。
//
// hasMedia=false 一律不釘（2026-08 使用者回報「推文區前面多一塊空白」）：塌陷補償
// 的前提是「卸載後會少掉一塊真內容」。若 slot 當下只有「讀取中…」指示器
// （.previewLoading，URL 解析中／媒體下載中共用）、「載入失敗」提示，或這個網址
// 根本不是媒體（ImagePreviewer render 出 null），那量到的高度就不是內容高度，
// 釘進 min-height 只會變成**永久假空白**——而且非媒體連結永遠不會再長出內容來填它。
// 實例：每篇文章的「※ 文章網址: https://www.ptt.cc/bbs/…html」都掛預覽 slot，
// 捲過去顯示讀取中→判定非媒體→內容消失，卸載卻把指示器的 65px 釘住 ⇒ 每篇文章的
// 推文區都被往下推兩行（ptt-debug-20260812-010606 實測，offline 重放已複現）。
export function nextSlotHeight(prev, measured, hasMedia) {
  if (!hasMedia) return prev;
  return measured > 0 ? measured : prev;
}
