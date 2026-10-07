// Android APK 殼（android/，見 docs/android-app.md）與網頁之間的 bridge。
//
// 兩個由原生注入的全域（只注入給當前頁面來源的 origin：正式版 https://abccbaandy.github.io，
// 或 APK「App 設定」開了 dev server 模式時的 http://localhost:8080 之類；別的 origin 看不到）：
//   window.__PTT_ANDROID__  document-start script 設的設定：{ version, site }
//                           site ＝本機前景服務的 WebSocket proxy（wstelnet://127.0.0.1:<port>/bbs/<token>）
//   window.PttAndroid       androidx.webkit WebMessageListener 物件：postMessage(string)／onmessage
//
// 訊息合約（JSON 字串）：
//   → { id, op: 'getPassword' }                          ← { id, ok, user, password }
//   → { id, op: 'storePassword', user, password }        ← { id, ok }
//   → { id, op: 'googleSignIn', serverClientId }         ← { id, ok, idToken } | { id, ok:false, error }
//   → { id, op: 'googleSignOut' }                        ← { id, ok }
//   → { id, op: 'openAppSettings' }                      ← { id, ok }   開原生「App 設定」頁
//   → { id, op: 'saveFile', filename, mime, text }       ← { id, ok } | { id, ok:false, error }
//     WebView 不支援 a[download]／blob: 下載（util.js#downloadAsFile 的 APK 分支）。原生跳系統
//     「儲存檔案」對話框（SAF CreateDocument），使用者選位置後寫入 UTF-8。error：'cancelled'／'busy'
//    （上一個還沒選完）／'failed'。舊版 APK 回 'unknown op'。
// ok:false ＝使用者取消／沒有存任何密碼／原生出錯，一律當「沒有」處理。
// googleSignIn（雲端同步登入，google_sign_in.js）：原生 Credential Manager
//   GetSignInWithGoogleOption 取 Google ID token；serverClientId ＝ Firebase Google provider
//   的 Web OAuth client（firebase_config.js#GOOGLE_WEB_CLIENT_ID），原生只接受
//   `<數字>-<英數>.apps.googleusercontent.com` 形狀。error：'cancelled'（使用者關掉）／
//   'badClientId'／'failed'（其餘，含 Google Cloud 沒註冊 Android OAuth client 的 developer error）。
// googleSignOut：CredentialManager.clearCredentialState，下次登入才會重新讓使用者選帳號。
//
// 原生 → 網頁的單向通知（window 上的 CustomEvent，由原生 evaluateJavascript 發出）：
//   'pttandroid:ime'  detail: { inset }  軟鍵盤蓋住 WebView 底部的高度（CSS px）。
//   APK 刻意不讓鍵盤把 WebView 縮小（那是 layout resize ⇒ 改列數、重送 NAWS，
//   docs/mobile.md「軟鍵盤蓋住底列」），所以 visualViewport 量不到鍵盤，改由原生告知。
//
// 連線位址只在讀取端覆寫（main.jsx 的 connect 優先序），**絕不寫進 prefs**：
// prefs 經 pref_sync 同步到桌機，寫進去桌機就會去連 127.0.0.1。

const REQUEST_TIMEOUT_MS = 120000; // 密碼選單等使用者點選，給寬一點

let nextId = 1;
const pending = new Map();
let listeningOn = null; // 原生重建 WebView 時物件會換，綁在哪個上要記著

function config() {
  return (typeof window !== 'undefined' && window.__PTT_ANDROID__) || null;
}

export function isAndroidApp() {
  return !!config();
}

export function androidSite() {
  const c = config();
  return (c && typeof c.site === 'string' && c.site) || '';
}

function channel() {
  return (typeof window !== 'undefined' && window.PttAndroid) || null;
}

export function androidBridgeAvailable() {
  const ch = channel();
  return !!(isAndroidApp() && ch && typeof ch.postMessage === 'function');
}

function onMessage(event) {
  let msg;
  try {
    msg = JSON.parse(typeof event === 'string' ? event : event && event.data);
  } catch (e) {
    return;
  }
  if (!msg || !pending.has(msg.id)) return;
  const { resolve, timer } = pending.get(msg.id);
  pending.delete(msg.id);
  clearTimeout(timer);
  resolve(msg);
}

function ensureListening(ch) {
  if (listeningOn === ch) return;
  listeningOn = ch;
  if (typeof ch.addEventListener === 'function') {
    ch.addEventListener('message', onMessage);
  } else {
    ch.onmessage = onMessage;
  }
}

// 回傳原生的回覆物件；bridge 不存在／逾時 → reject。
export function requestAndroid(op, payload = {}) {
  const ch = channel();
  if (!androidBridgeAvailable()) {
    return Promise.reject(new Error('android bridge unavailable'));
  }
  ensureListening(ch);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('android bridge timeout: ' + op));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    try {
      ch.postMessage(JSON.stringify({ ...payload, id, op }));
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

// 原生「App 設定」頁（dev server 模式等 APK 自己的設定）。失敗（舊版 APK 不認得這個 op 不會回覆）
// 不影響網頁，呼叫端不必處理。
export function openAppSettings() {
  return requestAndroid('openAppSettings').catch(() => null);
}

export const IME_EVENT = 'pttandroid:ime';
let imeInset = 0;

export function androidImeInset() {
  return imeInset;
}

// 訂閱原生回報的鍵盤高度；回傳取消訂閱。非 APK 環境永遠不會觸發。
export function onAndroidIme(fn) {
  const handler = e => {
    const v = Number(e && e.detail && e.detail.inset);
    imeInset = v > 0 ? v : 0;
    fn(imeInset);
  };
  window.addEventListener(IME_EVENT, handler);
  return () => window.removeEventListener(IME_EVENT, handler);
}

export const _REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
