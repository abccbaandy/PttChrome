// 手機長按選單（bottom sheet）放哪一邊，才不會蓋住使用者長按的那一列。
//
// 理念：選單不可擋住它要作用的對象。固定貼底時，長按畫面下半部的文章，sheet 一升起
// 就把那一列蓋掉 ⇒「選中文章外框」（menu_target_highlight.js）等於沒畫，使用者看不到
// 自己要對哪一篇做「前已讀後未讀」。
//
// 規則（純函式，unit 守 tests/unit/sheet_placement.test.js）：
//   - 量不到對象（anchor 缺）⇒ 照舊貼底、高度不限；
//   - 對象下方空間 ≥ 上方 ⇒ 貼底，最高到對象下緣（留 GAP）；
//   - 否則改貼頂，最高到對象上緣（留 GAP）。
// 內容比可用高度長就在 sheet 內捲動（.mobileSheetScroll），不壓到對象。
// anchor 與 viewportHeight 都是 client 座標（layout viewport，同 position:fixed 的 Drawer）。

export const SHEET_ANCHOR_GAP_PX = 8;

// 長按點不在任何一列上（空白處）時，以觸點上下這麼多 px 當作對象。
export const SHEET_POINT_ANCHOR_PX = 16;

export function sheetPlacement({ anchor, viewportHeight } = {}) {
  const vh = Number(viewportHeight);
  if (
    !anchor ||
    !Number.isFinite(anchor.top) ||
    !Number.isFinite(anchor.bottom) ||
    !(vh > 0)
  ) {
    return { position: "bottom", maxHeight: null };
  }
  const top = Math.max(0, Math.min(vh, anchor.top));
  const bottom = Math.max(top, Math.min(vh, anchor.bottom));
  const below = vh - bottom - SHEET_ANCHOR_GAP_PX;
  const above = top - SHEET_ANCHOR_GAP_PX;
  if (below >= above) {
    return { position: "bottom", maxHeight: Math.max(0, Math.floor(below)) };
  }
  return { position: "top", maxHeight: Math.max(0, Math.floor(above)) };
}

// 由長按的 event.target 找出「對象」的矩形：文章列／列表卡片（span[type=bbsrow]）、
// 主選單大按鈕（[data-menu-row]）；都不是 ⇒ 觸點上下 SHEET_POINT_ANCHOR_PX。
export function menuAnchorRect(target, clientY) {
  const el =
    target && typeof target.closest === "function"
      ? target.closest('span[type="bbsrow"], [data-menu-row]')
      : null;
  if (el && typeof el.getBoundingClientRect === "function") {
    const r = el.getBoundingClientRect();
    if (r.height > 0) return { top: r.top, bottom: r.bottom };
  }
  const y = Number(clientY);
  if (!Number.isFinite(y)) return null;
  return { top: y - SHEET_POINT_ANCHOR_PX, bottom: y + SHEET_POINT_ANCHOR_PX };
}
