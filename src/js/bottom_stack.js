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

/**
 * 底部堆疊的地板（px，視窗座標）：可見內容下緣，再讓開疊在視窗底的手機導覽列＋軟鍵盤＋safe-area
 * （`view.keyboardInset`）。手機的 `.main` 因列高取整會延伸到導覽列後面幾 px，只看內容下緣會壓到
 * 導覽列。推文列貼在地板上，下一篇卡片與導覽軸再讓開推文列——三者同一條規則。
 * 沒給 innerHeight（純幾何測試）⇒ 只看內容下緣。
 * @param {{ mainRect: { bottom: number }, footerTop?: number | null, innerHeight?: number, keyboardInset?: number }} facts
 * @returns {number}
 */
export function stackFloorOf({ mainRect, footerTop, innerHeight, keyboardInset }) {
  const bottom = contentBottomOf({ mainRect, footerTop });
  if (innerHeight == null) return bottom;
  return Math.min(bottom, innerHeight - (keyboardInset || 0));
}

// ── 貼視窗底的提示讓開推文列（A8 第三步）────────────────────────────────────
// 底部提示、讀取中、跳到未讀進度卡、上傳卡片、回到上次的地方這些「貼視窗底」的浮層原本只讓開
// `--term-bottom-inset`（手機底部導覽＋軟鍵盤），多留的 48px 剛好是手機推文列（40px）＋間距。
// 桌機推文列貼在好讀 footer 上緣（地板），上緣離視窗底遠超過 48px ⇒ 提示疊在推文列的輸入框上。
// 推文列畫著時把「它的上緣離視窗底多遠」寫進 STACK_CLEAR_VAR，提示取兩者較高者：
// 沒有推文列（0）⇒ 跟以前一樣；手機推文列上緣＝導覽上緣＋40 ⇒ 也跟以前一樣。
export const STACK_CLEAR_VAR = '--bottom-stack-clear';
// 提示與推文列上緣的間距。
export const STACK_GAP = 8;
// 舊的離底距離裡替推文列預留的那一格：px ≥ 48 的提示都含它，換算成「離推文列上緣多遠」時扣掉。
const BAR_SLOT = 40;

/**
 * 貼視窗底的浮層的 CSS `bottom`：讓開手機底部導覽＋軟鍵盤再 px，也讓開推文列（上緣再往上至少 STACK_GAP）。
 * px＝以前寫在 `--term-bottom-inset` 之上的距離；疊在一般提示上面的那層（88）照舊比提示高 40。
 * CSS 檔裡的同一條式子（#resumeLastPlace、.ImageUploadCard）由 bottom_stack.test.js 對照。
 * @param {number} px
 * @returns {string}
 */
export function aboveStackCss(px) {
  return (
    'max(calc(var(--term-bottom-inset, 0px) + ' + px + 'px), calc(var(' + STACK_CLEAR_VAR + ', 0px) + ' +
    Math.max(STACK_GAP, px - BAR_SLOT) + 'px))'
  );
}

/**
 * 推文列佔掉的底部高度（上緣離視窗底的距離，px）：沒畫＝0。
 * @param {{ visible?: boolean, bottom?: number } | null | undefined} state
 * @param {number} height 推文列實際高度（comment_bar.commentBarHeight）
 * @returns {number}
 */
export function stackClearOf(state, height) {
  if (!state || !state.visible || !(height > 0)) return 0;
  return Math.max(0, Math.round((state.bottom || 0) + height));
}

/**
 * 把推文列佔掉的底部高度寫到 `<html>` 的 STACK_CLEAR_VAR（提示的 CSS 讀它）。
 * @param {number} px
 * @param {Document | null} [doc]
 */
export function publishStackClear(px, doc = typeof document !== 'undefined' ? document : null) {
  const root = doc && doc.documentElement;
  if (!root || !root.style) return;
  root.style.setProperty(STACK_CLEAR_VAR, px + 'px');
}
