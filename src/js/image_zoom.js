// 好讀自動開圖的「整頁圖片倍率」（純邏輯，無 DOM；unit 守護 tests/unit/image_zoom.test.js）。
//
// 與「點圖一鍵放大」（imagesEnlarged，滿版 width:100%）並存：倍率作用在**小圖模式**
// 的顯示寬度上（顯示寬 ＝ 小圖寬 × 倍率，上限容器寬，CSS 在 main.css 的
// `#mainContainer.imagesZoomed`）。放大態優先，縮回來時回到原倍率。
//
// sizeMode 是佔位盒分模式記高度的**字串鍵**（lazy_media.recordSlotHeight）：
// "normal" | "enlarged" | "zoom@<倍率>"。每個倍率各記一格，換倍率不會拿別格的高度頂。

export const IMAGE_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];

const ZOOM_PREFIX = "zoom@";

// 最近的一格（非階梯值吸附；同距離取較小者）。
function nearestIndex(z) {
  let best = 0;
  for (let i = 1; i < IMAGE_ZOOM_STEPS.length; ++i) {
    if (Math.abs(IMAGE_ZOOM_STEPS[i] - z) < Math.abs(IMAGE_ZOOM_STEPS[best] - z))
      best = i;
  }
  return best;
}

// dir：+1 放大一格、-1 縮小一格、0 回 100%。到底就停在端點。
export function stepImageZoom(z, dir) {
  if (!dir) return 1;
  const cur = Number.isFinite(z) ? nearestIndex(z) : IMAGE_ZOOM_STEPS.indexOf(1);
  const next = Math.min(
    IMAGE_ZOOM_STEPS.length - 1,
    Math.max(0, cur + (dir > 0 ? 1 : -1)),
  );
  return IMAGE_ZOOM_STEPS[next];
}

export const isMinImageZoom = (z) => z <= IMAGE_ZOOM_STEPS[0];
export const isMaxImageZoom = (z) =>
  z >= IMAGE_ZOOM_STEPS[IMAGE_ZOOM_STEPS.length - 1];

export function imageSizeMode(enlarged, zoom) {
  if (enlarged) return "enlarged";
  if (!zoom || zoom === 1) return "normal";
  return ZOOM_PREFIX + zoom;
}

// 反推 sizeMode 的倍率。放大態沒有意義（倍率列在那時是藏起來的），回 null。
export function zoomFromSizeMode(mode) {
  if (mode === "enlarged") return null;
  if (typeof mode === "string" && mode.startsWith(ZOOM_PREFIX)) {
    const z = parseFloat(mode.slice(ZOOM_PREFIX.length));
    return z > 0 ? z : 1;
  }
  return 1;
}

export const formatZoomLabel = (z) => `${Math.round(z * 100)}%`;
