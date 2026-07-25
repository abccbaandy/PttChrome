// 捲動錨定（scroll anchoring）純函式（無網路，unit test 守護）。
//
// 用途：好讀模式點圖切換「整頁圖片放大／縮小」時，整份內容高度驟變，但捲動容器
// （.main）的 scrollTop 不變 → 視窗相對文章的位置整個位移，被點的那張圖跑出視野。
// 這裡把「維持某個元素在視窗中的相對位置」的算式抽成純函式。
//
// 座標系規則（務必遵守，混用會算錯）：
//   scrollTop 是 **layout 座標**，而好讀模式的 .main 整體被 transform scale 縮放、
//   img.hyperLinkPreview 另被套反向 scale（見 term_view.js setTermFontSize /
//   updateReverseScaleCss）→ getBoundingClientRect() 含 transform，尺規與 scrollTop
//   不同。故錨定的量測一律走 offsetTop / offsetHeight（不含 transform）。

// 保持 anchor 元素相對視窗的位置不變，換算高度變化後的新 scrollTop。
//
// d = 視窗頂端相對 anchor 頂端的距離（scrollBefore - topBefore）：
//   d <= 0（anchor 頂端仍在視窗內）→ 維持該固定間距，位移最小、最自然。
//   d > 0 （anchor 頂端已捲出視窗上方，看大圖時的常態）→ 改以「視窗頂端落在 anchor
//          內部的同一比例處」錨定；縮小後 d 依 heightAfter/heightBefore 一起變小，
//          視窗頂端必然仍落在該圖範圍內 → 圖一定看得到。
export function computeAnchoredScrollTop({
  topBefore,
  heightBefore,
  scrollBefore,
  topAfter,
  heightAfter,
  maxScroll,
}) {
  const d = scrollBefore - topBefore;
  // heightBefore 為 0（圖尚未載入 / 已卸下）時比例無意義，退回維持固定間距。
  const ratio = heightBefore > 0 ? heightAfter / heightBefore : 1;
  const next = topAfter + (d > 0 ? d * ratio : d);
  const limit = maxScroll > 0 ? maxScroll : 0;
  return Math.max(0, Math.min(next, limit));
}

// el 相對 ancestor 的 layout 頂端距離。
// 兩端各自沿 offsetParent 鏈累加到頂後相減——相減法不要求 ancestor 落在 el 的
// offsetParent 鏈上（#mainContainer 未設 position，鏈會直接跳過它到 body，單邊
// 累加會多算 #mainContainer 自身的位置）。
export function offsetTopWithin(el, ancestor) {
  return absOffsetTop(el) - absOffsetTop(ancestor);
}

function absOffsetTop(node) {
  let top = 0;
  for (let e = node; e; e = e.offsetParent) top += e.offsetTop;
  return top;
}
