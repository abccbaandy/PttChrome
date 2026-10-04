// 雲端同步的 Google 登入：依執行環境選路（pref_sync.signIn 的預設 authenticate）。
//
// - 瀏覽器：Firebase `signInWithPopup`。
// - Android APK：Google 禁止在 WebView 裡做 OAuth（disallowed_useragent），popup 必失敗。
//   改由原生 Credential Manager 取 Google ID token（bridge op `googleSignIn`，合約見
//   android_bridge.js 檔頭），再 `signInWithCredential` 交給 Firebase。之後的 Firestore
//   同步、App Check 都在網頁端照常跑，原生只負責「拿到 token」這一步。
//
// `f` ＝ pref_sync 的 SDK handle（{ auth, authM }），由呼叫端傳入 ⇒ 本檔不觸發 SDK 載入。

import { isAndroidApp, androidBridgeAvailable, requestAndroid } from './android_bridge';
import { GOOGLE_WEB_CLIENT_ID } from './firebase_config';

// 使用者自己關掉登入視窗／選單：不是錯誤，UI 回到未登入狀態即可。
const CANCEL_CODES = new Set([
  'cancelled', // Android bridge
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
  'auth/user-cancelled'
]);

export function isSignInCancelled(e) {
  return !!(e && CANCEL_CODES.has(e.code));
}

function bridgeError(reply) {
  const code = (reply && reply.error) || 'failed';
  const e = new Error('android googleSignIn: ' + code);
  e.code = code;
  return e;
}

export async function authenticateGoogle(f) {
  if (!isAndroidApp()) {
    return f.authM.signInWithPopup(f.auth, new f.authM.GoogleAuthProvider());
  }
  // serverClientId 由網頁傳給原生（而非寫死在 APK）：換 Firebase 專案只需更新網頁。
  // 必須是 Firebase Google provider 的 **Web** client，ID token 的 aud 才會被 Firebase 接受。
  const reply = await requestAndroid('googleSignIn', {
    serverClientId: GOOGLE_WEB_CLIENT_ID
  });
  if (!reply.ok || typeof reply.idToken !== 'string' || !reply.idToken) {
    throw bridgeError(reply);
  }
  return f.authM.signInWithCredential(
    f.auth,
    f.authM.GoogleAuthProvider.credential(reply.idToken)
  );
}

// 登出時清掉 Credential Manager 的登入狀態，否則下次登入選單會直接沿用同一個帳號、
// 不讓使用者換。非 APK 環境不做事；失敗只影響「下次是否自動選帳號」，吞掉。
export function clearGoogleSignInState() {
  if (!androidBridgeAvailable()) return Promise.resolve();
  return requestAndroid('googleSignOut').then(
    () => {},
    () => {}
  );
}
