// 滾輪 delta → 捲動像素（純函式，零 DOM / 零 app 狀態）。
//
// 文章列表好讀模式的畫面是自己組出來的字元格線，`.main` 沒有任何可捲距離
// （內容高＝容器高，見 docs/easy-reading-list.md「視窗模型」），所以「像網頁一樣
// 捲動」沒有瀏覽器原生捲動可用 —— 必須自己把 wheel event 換算成距離，再交給
// ListSession 的平滑捲動（js/smooth_scroll.js）分幀吃掉。
//
// 這裡唯一的工作是認 **deltaMode**：0＝像素（Chrome/Edge/Safari，以及各家的
// 觸控板）、1＝列（Firefox 的滑鼠滾輪，deltaY 本身就是列數）、2＝頁。只看 deltaY
// 不看 deltaMode 的話，Firefox 滑鼠滾輪一格只會捲 3 個「像素」＝幾乎不動。
//
// 小數不必在這裡累積：次列偏移本來就是 ListSession 的狀態（_scrollFrac），
// 觸控板送來的幾個像素會原封不動地累進畫面位置。

// 換算不出列高時的保底值（px）。只有在 view.chh 還沒量出來的極早期會用到。
export const WHEEL_FALLBACK_LINE_PX = 20;

// 單一 wheel event 的位移量，單位＝**與 lineHeight 同一個座標系的像素**（正＝往下）。
export function wheelDeltaToPx(ev, geom) {
  const g = geom || {};
  let lineHeight = Number(g.lineHeight);
  if (!isFinite(lineHeight) || lineHeight <= 0) lineHeight = WHEEL_FALLBACK_LINE_PX;
  let pageLines = Number(g.pageLines);
  if (!isFinite(pageLines) || pageLines <= 0) pageLines = 1;

  let dy = Number(ev && ev.deltaY);
  let mode = Number(ev && ev.deltaMode);
  if (!isFinite(dy)) {
    // 舊式 mousewheel 事件（沒有 deltaY）：wheelDelta 的正負與 deltaY 相反，
    // 一格 120。App 仍會在沒有 onwheel 的環境掛這種事件，順手支援。
    const wd = Number(ev && ev.wheelDelta);
    if (!isFinite(wd)) return 0;
    dy = -wd;
    mode = 0;
  }
  if (!dy) return 0;
  if (mode === 1) return dy * lineHeight; // 列
  if (mode === 2) return dy * lineHeight * pageLines; // 頁
  return dy; // 像素
}
