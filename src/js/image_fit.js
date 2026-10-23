// 預覽圖載「剛好夠用」的尺寸（pref imageFitScreen，預設開）。
//
// 為什麼：X（twimg）的圖原本一律載原圖，手機拍的照片原圖常是 2000～4000 px、1～3 MB，
// 而好讀預覽的顯示框只有 39em×19em（手機是螢幕寬×19em）。改載剛好蓋住顯示框的具名
// 縮圖（image_proxy.js#TWIMG_FIT_SIZES），同一張圖 2.38 MB → 176 KB，肉眼一樣。
//
// **只做 twimg**：imgur 的縮圖（`<id>h.jpg`）會把比 1024 小的原圖**放大**到 1024（實測
// 923×906 → 1024×1006），透明 PNG 也會被轉成不透明；預覽的顯示尺寸取決於原圖大小
// （小圖照原尺寸顯示），換成縮圖會讓小圖變大、透明底變色 ⇒ 不是「肉眼一樣」，不做。
// imgur 已經改載 webp（約原圖 1/5），見 ImagePreviewer.jsx。
//
// 挑法保證「顯示出來跟原圖一樣」：縮圖框邊長 N ≥ 顯示框的寬與高（裝置像素）⇒ 縮圖在
// 任何長寬比下都不小於實際顯示尺寸（scale_thumb = min(N/w, N/h, 1) ≥ min(W/w, H/h, 1)）。
// 點圖放大（imagesEnlarged）或倍率 > 100% 時顯示框會變大 ⇒ 換回原圖（setFullResWanted，
// 由 render/screen.js#_syncImageSize 推），換的時候先在背景載好，畫面上不會閃。

// 對齊 main.css `.easyReadingImg { max-height: 19em; max-width: 39em }`
// （守護：tests/unit/image_fit.test.js 直接讀 CSS 比對）。
export const PREVIEW_MAX_WIDTH_EM = 39;
export const PREVIEW_MAX_HEIGHT_EM = 19;

// 顯示框（裝置像素）的長邊。reflow（手機好讀）時寬度上限是容器寬（`.mobileReflow
// .easyReadingImg { max-width: 100% }`），否則是 39em。img 身上有反向 scale 抵消 .main
// 的 transform（term_view.js#updateReverseScaleCss），所以版面 px 就是螢幕上的 CSS px。
export function previewNeededPx({ emPx, containerWidth, reflow, dpr }) {
  if (!(emPx > 0) || !(dpr > 0)) return Infinity;
  const w = reflow ? containerWidth : PREVIEW_MAX_WIDTH_EM * emPx;
  if (!(w > 0)) return Infinity;
  return Math.ceil(Math.max(w, PREVIEW_MAX_HEIGHT_EM * emPx) * dpr);
}

// sizes：[[name, box], ...] 由小到大。回傳框 ≥ needed 的最小一個；都不夠（或量不到）回 null
// ＝載原圖。
export function pickFitSize(neededPx, sizes) {
  if (!Number.isFinite(neededPx)) return null;
  for (const [name, box] of sizes) if (box >= neededPx) return name;
  return null;
}

// 從目前的 DOM 量顯示框。量不到（沒有 #mainContainer、字級為 0）回 Infinity ⇒ 原圖。
export function measurePreviewNeededPx(doc = document) {
  const container = doc && doc.getElementById("mainContainer");
  if (!container) return Infinity;
  const view = doc.defaultView;
  const emPx = parseFloat(view.getComputedStyle(container).fontSize);
  const main = container.closest(".main");
  return previewNeededPx({
    emPx,
    containerWidth: container.clientWidth,
    reflow: !!(main && main.classList.contains("mobileReflow")),
    dpr: view.devicePixelRatio || 1,
  });
}

// ---- 模組級 config（同 image_proxy.js：預設關是 fail-safe，真值由 App.onPrefChange 注入，
// 沒接上 pref 的路徑與 unit 測試一律維持原圖行為）。
let enabled = false;
export const setImageFitEnabled = (v) => {
  enabled = !!v;
};
export const isImageFitEnabled = () => enabled;

// ---- 「現在要原圖」：放大態或倍率 > 100%。單一 ScreenController 推、各張預覽訂閱。
let fullRes = false;
const listeners = new Set();
export const setFullResWanted = (v) => {
  const next = !!v;
  if (next === fullRes) return;
  fullRes = next;
  for (const fn of Array.from(listeners)) fn();
};
export const isFullResWanted = () => fullRes;
export const subscribeFullRes = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

// 測試用：還原模組狀態。
export const resetImageFitForTest = () => {
  enabled = false;
  fullRes = false;
  listeners.clear();
};
