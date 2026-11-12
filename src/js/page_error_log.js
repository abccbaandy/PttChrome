// 全域未捕捉的例外（window 'error'／'unhandledrejection'）只寫進本機 debug 錄製
// （架構 review A1 步驟 c，docs/feature-isolation.md）。
//   - 沒開錄製（recorderOf() 回 null）就什麼都不做：不攔、不吞、不上傳。
//   - 不 preventDefault：瀏覽器照樣印進 console、e2e 的 pageerror 照樣收得到。
//   - 錄製器是環狀緩衝（背景錄製只留最後三分鐘），這裡不另設上限。
const STACK_MAX = 1200;

function describe(err, fallbackMessage) {
  const message = err && err.message ? err.message : fallbackMessage != null ? fallbackMessage : err;
  return {
    message: String(message),
    stack: err && err.stack ? String(err.stack).slice(0, STACK_MAX) : null,
  };
}

export function installPageErrorLog(win, recorderOf) {
  if (!win || typeof win.addEventListener !== 'function') return () => {};
  const log = (tag, info) => {
    const r = recorderOf();
    if (r && typeof r.log === 'function') r.log(tag, info);
  };
  const onError = (e) => {
    const info = describe(e && e.error, e && e.message);
    if (e && e.lineno) info.line = e.lineno;
    log('pageError', info);
  };
  const onRejection = (e) => {
    log('pageRejection', describe(e && e.reason));
  };
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  return () => {
    win.removeEventListener('error', onError);
    win.removeEventListener('unhandledrejection', onRejection);
  };
}
