# 偏好設定雲端同步（Firebase Firestore）

## 架構

| 層 | 檔案 | 職責 |
|---|---|---|
| 儲存層 | `src/js/pref_storage.js` | `DEFAULT_PREFS` / localStorage 讀寫（自 PrefModal 抽出） |
| 純邏輯 | `src/js/pref_sync_logic.js` | `sanitizeForCloud`（剝密碼）/ `mergeCloudPrefs`（cloud wins）— unit tested |
| 副作用 | `src/js/pref_sync.js` | SDK lazy-load、Google 登入、Firestore 讀寫 |
| config | `src/js/firebase_config.js` | web config（非機密，安全靠 rules + authorized domains） |

- 同步策略：localStorage = 本地快取，啟動先套用（不阻塞 BBS 連線）；曾登入者背景從 Firestore 拉取後二次套用（`main.js` → `startIfPreviouslySignedIn`）。儲存時雙寫（PrefModal `onCloseClick`/`onResetClick` → `prefSync.savePrefs`）。
- 資料模型：`users/{uid}` 單一 doc `{ prefs, updatedAt: serverTimestamp, schemaVersion: 1 }`。
- 衝突：cloud wins；首次登入雲端無 doc → push local up；登出只清旗標（`pttchrome.prefsync.enabled`），localStorage 保留。
- **`autoLoginPassword` 絕不上雲**：上傳前 `sanitizeForCloud` 剝除、下載 merge 強制取本地值；密碼仍走瀏覽器 PasswordCredential（見 `src/js/auto_login.js`）。

## 為什麼用 compat CDN lazy-load 而不是 npm（踩坑）

- webpack 4 的 acorn parser 不認 ES2020（`?.` / `??`），且 babel-loader 只轉譯 `src/`；firebase v9+ npm 發行檔含這些語法 → **`yarn add firebase` 直接炸 build**。
- 解法：`pref_sync.js` 在 runtime 動態注入 gstatic compat scripts（`firebase-{app,auth,firestore}-compat.js`，pin `10.14.1`），全域 `window.firebase`，完全不經 webpack。
- Lazy：只在「曾登入（localStorage 旗標）」或「使用者按登入鈕」時載入 → 未登入者（含 e2e/guest）零額外下載、零 Firebase 網路請求。
- 升級路徑：webpack ≥5 後改 modular SDK，見 `docs/handoff/upgrade-webpack5-build-toolchain.md`。

## Firebase 專案設定（一次性，已完成）

project：`pttchrome-prefs-7k3m`（Firestore：asia-east1）。重建時：

```
firebase projects:create <project-id> --display-name "PttChrome Prefs"
firebase apps:create web pttchrome --project <project-id>
firebase apps:sdkconfig web --project <project-id>      # 貼進 src/js/firebase_config.js
firebase firestore:databases:create "(default)" --location=asia-east1 --project <project-id>
firebase deploy --only firestore:rules
```

踩坑：
- `firestore:databases:create` 首次會 403（Cloud Firestore API 未啟用）；啟用後要等 1–3 分鐘傳播再重試。無 gcloud 時可用 firebase CLI 的 OAuth token 呼叫 serviceusage REST 啟用。
- **Google Auth provider 無法用 CLI / REST 開**（標準 Firebase Auth 的初始化沒有公開 API；`identityPlatform:initializeAuth` 需付費 Identity Platform；REST 建 IdP config 需自備 OAuth client）→ 必須手動：Console → Authentication → Get started → Sign-in method → Google → Enable。`localhost` 預設已在 authorized domains。
- rules / indexes 檔在 repo 根目錄（`firestore.rules`、`firestore.indexes.json`、`firebase.json`、`.firebaserc`），rules 只允許 `request.auth.uid == uid` 讀寫 `users/{uid}`。

## 已知限制

- `signInWithPopup` 在嚴格擋第三方 storage 的瀏覽器（Safari/Brave）可能失敗；fallback 可改 `signInWithRedirect`（未實作）。
- 多分頁不做即時同步（無 onSnapshot），last-write-wins。
- 清瀏覽器資料只清掉同步旗標與快取；偏好仍在雲端，重新登入即拉回。
