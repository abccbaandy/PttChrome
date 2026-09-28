// 診斷 log 的 module 級出口（debug 錄製專用）。
//
// DebugRecorder 的 log 原本只能從拿得到 app 的地方呼叫（app.debugRecorder?.log）。
// 純 JS 渲染鏈（render/screen.js、render/inline_preview_slot.js）與 app 之間隔著
// term_ui／buildRow／link_segment 好幾層，為了幾條 log 把回呼穿過去不划算 ⇒ 錄製期間
// 由 DebugRecorder 掛上 sink，沒在錄的時候 diag() 是一次 null 檢查、零成本。
//
// 呼叫端要自己決定「量不量」：會觸發 layout 的量測（offsetHeight 之類）只能在
// diagActive() 為真時才做，不可以為了 log 平白多一次 reflow。
let sink = null;

export function setDiagSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

export const diagActive = () => sink !== null;

export function diag(tag, info) {
  if (sink) sink(tag, info);
}
