// unit-browser 每個測試檔開跑前清空 localStorage／sessionStorage（tests/unit/setup.js 呼叫）。
//
// Vitest Browser Mode 在同一個 worker 分頁裡**依序**跑好幾個測試檔，storage 是那個分頁
// origin 的、跨檔留著 ⇒ 前一個檔沒收乾淨的 prefs（例如 nativeSafeMode: true）會讓下一個檔
// 讀到被關掉的功能，整檔莫名其妙紅；單獨重跑又綠，紅不紅看排程把哪些檔排在同一個分頁。
// （同時在跑的檔在不同的 browser context，storage 不共用，不用管。）
// 用真的 Storage 清，不換成假的：有測試靠 vi.spyOn(Storage.prototype, …) 模擬寫入失敗。
export function resetBrowserStorage(win = globalThis) {
  for (const name of ["localStorage", "sessionStorage"]) {
    try {
      win[name].clear();
    } catch (e) {}
  }
}
