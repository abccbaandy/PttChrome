// 手機長按選單放哪裡：像原生的浮動選單一樣，貼著長按的那一列浮出來，手指只要移動
// 很短的距離就點得到；同時不蓋住那一列。
//
// 理念：
//   1. 選單不可擋住它要作用的對象：長按畫面下半部的文章時若蓋住那一列，「選中文章
//      外框」（menu_target_highlight.js）等於沒畫，使用者看不到自己要對哪一篇做「前已讀
//      後未讀」。
//   2. 選單要長在手指旁邊：舊版是貼底／貼頂的 bottom sheet，長按最下方那一列時 sheet
//      改貼頂，離手指一整個畫面遠。
//
// 規則（純函式，unit 守 tests/unit/sheet_placement.test.js）：
//   - 量不到對象（anchor 缺）或視窗量不到 ⇒ null（呼叫端退回貼底 sheet）；
//   - 對象下方空間 ≥ 上方 ⇒ 浮在對象下緣之下（留 GAP），否則浮在對象上緣之上；
//     最高到視窗邊（留 MARGIN），內容更長就在選單內捲動（.mobileSheetScroll）；
//   - 水平：左緣對齊觸點，靠右放不下就往左推，永遠留在視窗內（留 MARGIN）。
// anchor 與 viewport 都是 client 座標（layout viewport，同 position:fixed 的 Drawer）。

export const SHEET_ANCHOR_GAP_PX = 8;
// 選單與視窗邊緣的最小距離。
export const FLOAT_MENU_MARGIN_PX = 8;
// 選單寬度上限（窄螢幕取視窗寬扣兩側 MARGIN）。
export const FLOAT_MENU_WIDTH_PX = 280;

// 長按點不在任何一列上（空白處）時，以觸點上下這麼多 px 當作對象。
export const SHEET_POINT_ANCHOR_PX = 16;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function floatMenuPlacement({
  anchor,
  viewportWidth,
  viewportHeight,
} = {}) {
  const vw = Number(viewportWidth);
  const vh = Number(viewportHeight);
  if (
    !anchor ||
    !Number.isFinite(anchor.top) ||
    !Number.isFinite(anchor.bottom) ||
    !(vw > 0) ||
    !(vh > 0)
  ) {
    return null;
  }
  const M = FLOAT_MENU_MARGIN_PX;
  const width = Math.max(0, Math.min(FLOAT_MENU_WIDTH_PX, vw - 2 * M));
  const x = Number.isFinite(anchor.x) ? anchor.x : M;
  const left = Math.round(clamp(x, M, Math.max(M, vw - M - width)));

  const top = clamp(anchor.top, 0, vh);
  const bottom = clamp(anchor.bottom, top, vh);
  const below = vh - bottom - SHEET_ANCHOR_GAP_PX - M;
  const above = top - SHEET_ANCHOR_GAP_PX - M;
  if (below >= above) {
    return {
      side: "below",
      top: Math.round(bottom + SHEET_ANCHOR_GAP_PX),
      bottom: null,
      left,
      width,
      maxHeight: Math.max(0, Math.floor(below)),
    };
  }
  return {
    side: "above",
    top: null,
    // 以視窗下緣起算（CSS bottom）：選單下緣貼在對象上緣之上，往上長。
    bottom: Math.round(vh - top + SHEET_ANCHOR_GAP_PX),
    left,
    width,
    maxHeight: Math.max(0, Math.floor(above)),
  };
}

// 由長按的 event.target 找出「對象」的矩形：文章列／列表卡片（span[type=bbsrow]）、
// 主選單大按鈕（[data-menu-row]）；都不是 ⇒ 觸點上下 SHEET_POINT_ANCHOR_PX。
// x ＝ 觸點的水平位置（選單左緣對齊它）；量不到就不帶。
export function menuAnchorRect(target, clientY, clientX) {
  const x = Number(clientX);
  const withX = (r) => (Number.isFinite(x) ? { ...r, x } : r);
  const el =
    target && typeof target.closest === "function"
      ? target.closest('span[type="bbsrow"], [data-menu-row]')
      : null;
  if (el && typeof el.getBoundingClientRect === "function") {
    const r = el.getBoundingClientRect();
    if (r.height > 0) return withX({ top: r.top, bottom: r.bottom });
  }
  const y = Number(clientY);
  if (!Number.isFinite(y)) return null;
  return withX({
    top: y - SHEET_POINT_ANCHOR_PX,
    bottom: y + SHEET_POINT_ANCHOR_PX,
  });
}
