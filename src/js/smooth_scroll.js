// 平滑捲動的動畫核心（純邏輯 + 可注入的排程器，零 DOM）。
//
// 為什麼需要它：列表好讀的畫面是自己組的字元格線，最小單位是「一列」（chh≈26px）。
// 滾輪直接換算成整數列 ⇒ 每個事件都是一次 26px 的瞬移，與瀏覽器原生捲動（把同樣的
// 100px 分散成十幾幀、還帶緩動）體感差很多，觸控板尤其明顯（它一次只送幾個像素，
// 全被取整吃掉或變成突兀的整列跳動）。
//
// 兩件事一起做才會像網頁：
//   1. **次列位移**：畫面要能停在半列的位置（render 端用 body 視口的 scrollTop 表達）。
//   2. **時間緩動**：一次滾輪的距離分散到數幀，逐幀遞減（指數趨近，ease-out）。
// 這支只負責 (2) 與純數學，位移怎麼畫由呼叫端決定。

// 每幀吃掉剩餘距離的比例。0.28 在 60fps 下約 120ms 收斂到 1px 內，與 Chrome 的
// 滾輪動畫同量級；調大＝更跟手但更接近瞬移，調小＝更綿但會有「滑不停」的拖尾。
export const SMOOTH_FACTOR = 0.28;
// 指數趨近的尾巴會無限接近 0，給一個最小步長讓它有限步收斂。
export const SMOOTH_MIN_STEP = 1;

// 這一幀要吃掉多少（帶正負；|step| ≤ |pending|）。
export function smoothStep(pending, factor, minStep) {
  const f = factor === undefined ? SMOOTH_FACTOR : factor;
  const m = minStep === undefined ? SMOOTH_MIN_STEP : minStep;
  if (!pending || !isFinite(pending)) return 0;
  const mag = Math.abs(pending);
  let step = mag * f;
  if (step < m) step = m;
  if (step > mag) step = mag;
  return pending > 0 ? step : -step;
}

// 有狀態的動畫驅動器。排程器注入（unit 測試餵假的 rAF）。
//   add(px)   累加待捲距離（帶正負），需要時自動起跑
//   stop()    立刻停止並丟掉剩餘距離
//   pending() 還沒吃完的距離
// onStep(step) 回 false ⇒ 立刻停止（撞到邊界／模式已切走）。
export function createSmoothScroller(opts) {
  const raf = opts.raf;
  const cancel = opts.cancel;
  const onStep = opts.onStep;
  const factor = opts.factor;
  const minStep = opts.minStep;
  let pending = 0;
  let handle = null;

  const frame = function () {
    handle = null;
    const step = smoothStep(pending, factor, minStep);
    if (!step) {
      pending = 0;
      return;
    }
    pending -= step;
    // 浮點殘渣：低於最小步長就當作到齊了。
    if (Math.abs(pending) < 0.5) pending = 0;
    if (onStep(step) === false) {
      pending = 0;
      return;
    }
    if (pending) handle = raf(frame);
  };

  return {
    add: function (px) {
      if (!px || !isFinite(px)) return;
      pending += px;
      if (handle == null) handle = raf(frame);
    },
    stop: function () {
      pending = 0;
      if (handle != null && cancel) cancel(handle);
      handle = null;
    },
    pending: function () {
      return pending;
    }
  };
}
