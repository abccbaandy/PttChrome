// @ts-check
// 底部堆疊的共用量測（架構 review A8 第一步，docs/overlay-layout.md）。
//
// 疊在終端機下緣的浮層（底部推文列、下一篇卡片、文章導覽軸的下緣）都要先知道「終端機可見
// 內容的下緣在哪」：好讀 footer 顯示中＝它的上緣（footer 疊在格線最後一列上，不在 `.main`
// 最下緣，見 main.css #easyReadingLastRow），否則＝`.main` 的下緣。以前三個浮層各抄一份
// 「量 `.main`、看 footer 的 display、取上緣」，這裡收成一處；各浮層怎麼拿它組出自己的
// 位置照舊（行為不變），差異列在 docs/overlay-layout.md「各浮層怎麼讓位」。

/**
 * @typedef {{ top: number, bottom: number, left: number, right: number, width: number, height: number }} RectLike
 * @typedef {{ mainRect: RectLike, footerTop: number | null }} ContentEdge
 */

/**
 * 量終端機可見內容的下緣：`.main` 的框＋好讀 footer 的上緣（沒顯示＝null）。
 * 沒有版面（沒有 `.main`、不在瀏覽器）⇒ null。
 * @param {{ mainDisplay?: any, lastRowDiv?: any } | null | undefined} view
 * @param {Window | null} [win]
 * @returns {ContentEdge | null}
 */
export function measureContentEdge(view, win = typeof window !== 'undefined' ? window : null) {
  const main = view && view.mainDisplay;
  if (!main || typeof main.getBoundingClientRect !== 'function' || !win) return null;
  const footer = view.lastRowDiv;
  let footerTop = null;
  if (
    footer &&
    typeof footer.getBoundingClientRect === 'function' &&
    win.getComputedStyle(footer).display !== 'none'
  )
    footerTop = footer.getBoundingClientRect().top;
  return { mainRect: main.getBoundingClientRect(), footerTop };
}

/**
 * 可見內容的下緣（px，視窗座標）：footer 顯示中取它的上緣與 `.main` 下緣較小者。
 * @param {{ mainRect: { bottom: number }, footerTop?: number | null }} edge
 * @returns {number}
 */
export function contentBottomOf({ mainRect, footerTop }) {
  return footerTop != null ? Math.min(mainRect.bottom, footerTop) : mainRect.bottom;
}
