# Android APK：雲端同步 Google 登入（剩實機驗證）

程式已完成（網頁 `google_sign_in.js`＋bridge `googleSignIn`／`googleSignOut`＋`CredentialBridge.kt`），設計見 `docs/android-app.md`「雲端同步 Google 登入」。

## 剩下
- 實機：APK 登入 → 偏好從雲端還原；桌機改設定 APK 即時收到；取消選單回 idle；登出後再登入會重新讓人選帳號。
- App Check 在 WebView 能否拿到 token（`docs/android-app.md` 狀態表 `unknown`）。拿不到再議（Play Integrity provider 需要原生 SDK＋改架構）。
- 完成後把 `docs/android-app.md` 狀態表兩列改 CONFIRMED，刪本檔。
