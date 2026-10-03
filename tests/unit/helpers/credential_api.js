// 瀏覽器密碼管理員 API（PasswordCredential＋navigator.credentials）的測試替身。
//
// unit-browser 跑在真 Chromium：
//   - navigator.credentials 是 Navigator.prototype 上的唯讀 getter ⇒ 直接賦值會 throw，
//     `delete navigator.credentials` 也刪不掉（自有屬性本來就不存在）；
//   - 真 Chromium 本來就有 PasswordCredential ⇒「不支援的瀏覽器」要主動藏起來。
// 一律用自有屬性蓋過 prototype 的 getter。

export function setNavigatorCredentials(credentials) {
  Object.defineProperty(navigator, "credentials", {
    value: credentials,
    configurable: true,
    writable: true,
  });
}

// 模擬 Firefox／Safari／Android WebView：兩個都沒有。
export function hideCredentialApi() {
  delete window.PasswordCredential;
  setNavigatorCredentials(undefined);
}
