// wheel 事件的水平／垂直判斷 —— 純函式（零 DOM、零 pref、零 App），只吃
// deltaX / deltaY / deltaMode。
//
// **這裡刻意沒有手勢辨識器**（2026-09 移除 SwipeXDetector）：觸控板的返回手勢
// 一律交給瀏覽器原生跑，我們只在導航真的發生時用 history sentinel 接住
// （見 history_back_guard.js 與 docs/mouse.md）。原因是 DOM 的 WheelEvent 不含
// macOS NSEvent 的 phase／momentumPhase ⇒ 頁面分不出「手指還在」「放開了」
// 「這是慣性尾巴」，「放手才退出」原理上做不到；原生的返回箭頭又是瀏覽器
// chrome 畫的，頁面畫不出來。**不要把 wheel 版的手勢辨識加回來。**
//
// 留下來的三個函式是**滾輪翻頁的守門**，與返回手勢無關：純水平的 wheel
// （deltaY === 0）會被 mouse_scroll 的 `up = deltaY < 0` 算成「往下」而偷送一個
// PageDown 給 PTT（見 isHorizontalWheel 的註解）。

// deltaMode 換算成 px。DOM_DELTA_LINE 用 16px（與瀏覽器慣例的一行高度同量級），
// DOM_DELTA_PAGE 用 800px（一個視窗寬的量級）—— 兩者都只有滑鼠的水平滾輪／
// 特殊裝置會送，精度不重要，重要的是「不要把一格當成 1px 而永遠達不到閾值」。
const LINE_PX = 16;
const PAGE_PX = 800;

// 水平主導的門檻：|deltaX| 要大於它的幾倍 |deltaY| 才算「這是水平手勢」。
const DEFAULT_DOMINANCE = 1.5;

export function wheelDeltaXPx(e) {
  const dx = Number(e && e.deltaX) || 0;
  const mode = Number(e && e.deltaMode) || 0;
  if (mode === 1) return dx * LINE_PX;
  if (mode === 2) return dx * PAGE_PX;
  return dx;
}

export function wheelDeltaYPx(e) {
  const dy = Number(e && e.deltaY) || 0;
  const mode = Number(e && e.deltaMode) || 0;
  if (mode === 1) return dy * LINE_PX;
  if (mode === 2) return dy * PAGE_PX;
  return dy;
}

// 「這一個 wheel 事件是水平主導的嗎」——呼叫端用它把水平事件擋在垂直翻頁分支
// 之外。App.mouse_scroll 的 `up` 只看 deltaY，純水平滑動（deltaY === 0）會被算成
// 「往下」⇒ 原生 24 列列表左滑會偷送一個 PageDown 給 PTT（2026-09 修）。
export function isHorizontalWheel(e, dominance) {
  const d = dominance == null ? DEFAULT_DOMINANCE : dominance;
  const dx = Math.abs(wheelDeltaXPx(e));
  const dy = Math.abs(wheelDeltaYPx(e));
  return dx > 0 && dx > d * dy;
}
