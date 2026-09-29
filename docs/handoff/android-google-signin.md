# Android APK：雲端同步的 Google 登入

先讀 `docs/android-app.md`、`docs/pref-sync-firestore.md`。

## 現況
- APK 內 `PrefModal` 備份分頁不顯示登入鈕（`isAndroidApp()` → `options_syncAndroidUnsupported`）。
- 原因：`pref_sync.js` 走 `signInWithPopup`，Google 禁止在 WebView 內做 OAuth（`disallowed_useragent`）。
- `startIfPreviouslySignedIn` 在 APK 內沒有登入狀態 ⇒ 不會載 Firebase，無副作用。

## 做法（guess，未驗）
- 原生：Credential Manager `GetGoogleIdOption`／`GetSignInWithGoogleOption`（`androidx.credentials:credentials-play-services-auth` 已在依賴裡，另需 `com.google.android.libraries.identity.googleid:googleid`），`serverClientId` ＝ Firebase 專案的 **Web** OAuth client id。
- bridge 新 op `googleSignIn` → 回 `{ ok, idToken }`（合約補在 `src/js/android_bridge.js` 檔頭）。
- 網頁：`pref_sync.js` 的 `authenticate` 注入縫（原本給 emulator test 用）改走 `signInWithCredential(auth, GoogleAuthProvider.credential(idToken))`。
- Google Cloud 需新增 **Android** OAuth client（package `io.github.abccbaandy.pttchrome`＋release 簽章 SHA-1），否則 Credential Manager 回 developer error。
- App Check（reCAPTCHA Enterprise）在 WebView 能否過：`unknown`，先實測。
- 登出：`signOut` 照舊，另呼叫 `CredentialManager.clearCredentialState`。

## 完成條件
- APK 登入後偏好從雲端還原；桌機改設定 APK 即時收到。
- 補 unit：`isAndroidApp()` 時 `signIn` 走 bridge 路徑；integration 用 emulator 驗 `signInWithCredential` 分支。
- 刪本檔，並把 `docs/android-app.md`「APK 內刻意關掉的網頁功能」那條拿掉。
