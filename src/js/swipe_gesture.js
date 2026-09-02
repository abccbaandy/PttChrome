// 觸控板兩指水平滑動的手勢辨識 —— 純函式（零 DOM、零 pref、零 App），只吃
// wheel 事件的四個欄位（deltaX / deltaY / deltaMode / timeStamp）。
//
// 為什麼是 wheel：網頁收不到「手勢」這種東西，macOS/Windows 的觸控板兩指水平
// 滑動一律以 wheel 的 deltaX 呈現（捏合縮放是 wheel + ctrlKey，另一回事）。
// 瀏覽器自己的「返回手勢」則是 overscroll 的產物，用 CSS overscroll-behavior-x
// 擋掉即可，擋掉之後 wheel 事件照常派發（見 docs/mouse.md「手勢與瀏覽器返回」）。
//
// deltaX 的符號：Chromium 的 overscroll 導航是「東向 overscroll ＝ 上一頁」，
// 東向＝內容被往右拉＝**deltaX 為負**。也就是說「會觸發瀏覽器上一頁的那個方向」
// 累積出來的 deltaX < 0 ⇒ 'back'。若在真機上量到相反（量法見下），只要把
// BACK_SIGN 翻過來，其餘邏輯不動：
//   addEventListener('wheel', e => console.log(e.deltaX, e.deltaY, e.deltaMode), {capture:true});
const BACK_SIGN = -1;

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

export class SwipeXDetector {
  constructor(opts) {
    const o = opts || {};
    this.thresholdPx = o.thresholdPx == null ? 100 : o.thresholdPx;
    // macOS 的慣性滾動（momentum）在手指離開後還會送幾十個事件，中間沒有空檔 ⇒
    // 「觸發過就鎖住，直到靜止 idleMs 才解鎖」是不連送好幾個方向鍵的唯一辦法。
    this.idleMs = o.idleMs == null ? 200 : o.idleMs;
    this.dominance = o.dominance == null ? DEFAULT_DOMINANCE : o.dominance;
    this.reset();
    // null＝還沒收過任何事件。**不可以用 0 當哨兵**：wheel 的 timeStamp 是頁面
    // 開啟後的毫秒數，第一個事件真的可能是 0（測試更是天天如此）。
    this._last = null;
  }

  reset() {
    this._acc = 0;
    this._locked = false;
  }

  // 回 null（還不成手勢）／'back'／'forward'。
  feed(e) {
    const t = Number(e && e.timeStamp);
    const now = Number.isFinite(t) ? t : Date.now();
    const idle = this._last === null || now - this._last > this.idleMs;
    this._last = now;
    // 靜止夠久 ⇒ 這是全新的一次手勢（慣性尾巴到此結束）。
    if (idle) this.reset();

    const dx = wheelDeltaXPx(e);
    const dy = wheelDeltaYPx(e);
    // 水平主導才算數：對角線滑動不可以既翻頁又退出。
    if (!(Math.abs(dx) > 0 && Math.abs(dx) > this.dominance * Math.abs(dy))) {
      this.reset();
      return null;
    }
    if (this._locked) return null;
    // 方向翻轉 ⇒ 從這一個事件重新算（不然來回滑會互相抵消到永遠不觸發）。
    if (this._acc !== 0 && Math.sign(dx) !== Math.sign(this._acc)) this._acc = 0;
    this._acc += dx;
    if (Math.abs(this._acc) < this.thresholdPx) return null;
    this._locked = true;
    return Math.sign(this._acc) === BACK_SIGN ? 'back' : 'forward';
  }
}
