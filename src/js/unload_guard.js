// 「離開這個網站？」確認框（beforeunload）要不要跳。
//
// 網頁版：連線中、且已離開登入前畫面（pageState != 0）時，關分頁／重整要先確認，避免誤關斷線。
// APK（android/，docs/android-app.md）：一律不跳。殼裡沒有「關分頁」，返回鍵由 history_back_guard
// 轉成 PTT 左鍵、退到底只是 moveTaskToBack；唯一會觸發 beforeunload 的是點 target=_blank 連結
//（原生攔下改開外部瀏覽器，頁面根本不會離開），確認框只會擋在使用者與外部瀏覽器之間。
export function shouldWarnBeforeUnload({ connected, pageState, androidApp }) {
  if (androidApp) return false;
  return !!connected && pageState != 0;
}
