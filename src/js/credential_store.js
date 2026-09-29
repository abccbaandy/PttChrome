// 密碼管理員的單一入口：瀏覽器的 Credential Management API（PasswordCredential，
// Chrome → Google 密碼管理員），或 Android APK 殼的原生 Credential Manager（經
// android_bridge）。Android WebView **沒有** PasswordCredential，所以 APK 裡必須走
// bridge，否則自動登入永遠拿不到密碼。
//
// 兩個後端存的是同一種東西：id ＝ PTT 帳號，password ＝ credential_pack 打包後的字串
// （可能夾帶 2FA 密鑰）。打包／解包留在呼叫端，所以 Chrome 與 APK 讀到的是同一筆。
//
//   available()        → boolean
//   get()              → Promise<{ id, password } | null>（使用者取消／沒有 ⇒ null）
//   store({ id, password }) → Promise<void>（失敗吞掉：呼叫端的本機副本就是後援）

import { androidBridgeAvailable, requestAndroid } from './android_bridge';

const browserApiAvailable = () =>
  typeof window !== 'undefined' && !!window.PasswordCredential &&
  !!(navigator.credentials && navigator.credentials.get &&
     navigator.credentials.store);

export function credentialStoreAvailable() {
  return androidBridgeAvailable() || browserApiAvailable();
}

export async function getStoredCredential() {
  if (androidBridgeAvailable()) {
    const r = await requestAndroid('getPassword');
    if (r && r.ok && r.user && r.password) {
      return { id: r.user, password: r.password };
    }
    return null;
  }
  if (!browserApiAvailable()) return null;
  const cred = await navigator.credentials.get({
    password: true,
    mediation: 'optional'
  });
  if (cred && cred.password) return { id: cred.id, password: cred.password };
  return null;
}

export async function storeCredential({ id, password }) {
  if (androidBridgeAvailable()) {
    try {
      await requestAndroid('storePassword', { user: id, password });
    } catch (e) {}
    return;
  }
  if (!browserApiAvailable()) return;
  try {
    await navigator.credentials.store(
      new window.PasswordCredential({ id, password, name: 'PTT' })
    );
  } catch (e) {}
}
