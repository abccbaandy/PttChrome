# 偏好設定雲端同步（Firebase Firestore）

## 架構

| 層 | 檔案 | 職責 |
|---|---|---|
| 儲存層 | `src/js/pref_storage.js` | `DEFAULT_PREFS` / localStorage 讀寫（自 PrefModal 抽出） |
| 純邏輯 | `src/js/pref_sync_logic.js` | `sanitizeForCloud`（剝帳密）/ `mergeCloudPrefs`（cloud wins）/ `classifySnapshot`（snapshot 分類）— unit tested |
| 副作用 | `src/js/pref_sync.js` | SDK lazy-load、Google 登入、Firestore 讀寫 |
| config | `src/js/firebase_config.js` | web config（非機密，安全靠 rules + authorized domains） |

- 同步策略：localStorage = 本地快取，啟動先套用（不阻塞 BBS 連線）；曾登入者背景 attach Firestore **onSnapshot realtime listener**，每個 snapshot merge 後二次套用（`main.js` → `registerOnCloudValues` + `startIfPreviouslySignedIn`）。儲存時雙寫（PrefModal `onCloseClick`/`onResetClick` → `prefSync.savePrefs`）。
- 資料模型：`users/{uid}` 單一 doc `{ prefs, updatedAt: serverTimestamp, schemaVersion: 1 }`。
- 衝突：cloud wins；首次登入雲端無 doc → push local up；登出只清旗標（`pttchrome.prefsync.enabled`），localStorage 保留。
- **`autoLoginPassword`、`autoLoginUser` 絕不上雲**：上傳前 `sanitizeForCloud` 剝除、下載 merge 強制取本地值；憑證走瀏覽器 PasswordCredential（見 `src/js/auto_login.js`）。帳號 local-only 的理由：裝置在瀏覽器存好憑證後會清空 local 帳密，若帳號同步，清空的 `""` 會上雲洗掉其他裝置（無 credential API 的 Firefox/Safari legacy 登入會壞）。`savePrefs` 另以 `FieldValue.delete()` 自癒刪除舊 doc 殘留的 `prefs.autoLoginUser`。

## Realtime listener（onSnapshot，2026-06 改版）

一次性 `get()` 的問題：分頁 B 開著時收不到裝置 A 的修改，B 下次存檔把舊值蓋回雲端（last-write-wins 蓋掉 A）。改 `onSnapshot` 後 A 的修改即時推到 B。

- 每個 snapshot 經 `classifySnapshot`（純函式，unit tested）分四類：
  - `skip-echo`：`metadata.hasPendingWrites` — 本機 `set()` 的 latency-compensation echo，跳過。
  - `skip-offline-missing`：cache 回報「無 doc」但 `metadata.fromCache` — **不可**誤判首次登入去 push local，否則連線恢復後 queue 的寫入會蓋掉雲端真資料；等 server snapshot。
  - `push-local`：server 證實無 doc/無 prefs → 首次登入，上傳本機。
  - `merge`：`mergeCloudPrefs` → `writeValues` → app callback（`onValuesPrefChange`）。
- handler 每次重讀 `readValuesWithDefault()`（local 會被 PrefModal/憑證清除移動，勿閉包舊值）。
- 生命週期：attach 前先 unsub 舊 listener；`signOut` **先 unsub 再** `auth.signOut()`（否則 stream 噴 permission-denied）；`onAuthStateChanged` 收到 null（token 過期/撤銷）也 unsub；onSnapshot error callback 觸發後 listener 自停 → 清掉 handle。
- callback 走註冊制：`main.js` 啟動時無條件 `registerOnCloudValues(app.onValuesPrefChange)`（純 JS 不觸發 SDK 載入），PrefModal `signIn` 建立的 listener 也打得到 app；`signIn(onCloudValues)` 的參數 callback 只在首個 snapshot 處理完打一次（更新 modal 表單）。

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
- **部署網域（如 GitHub Pages 的 `<user>.github.io`）必須加進 Auth authorized domains**，否則線上登入報 `auth/unauthorized-domain`（只看網域不看 path）。Console 手動加，或 REST：`PATCH https://identitytoolkit.googleapis.com/admin/v2/projects/<project-id>/config?updateMask=authorizedDomains`（body 帶完整清單，會整組覆蓋）。
- rules / indexes 檔在 repo 根目錄（`firestore.rules`、`firestore.indexes.json`、`firebase.json`、`.firebaserc`），rules 只允許 `request.auth.uid == uid` 讀寫 `users/{uid}`。

## 已知限制

- `signInWithPopup` 在嚴格擋第三方 storage 的瀏覽器（Safari/Brave）可能失敗；fallback 可改 `signInWithRedirect`（未實作）。
- PrefModal 表單 state 每次**開啟**時重讀 localStorage，但開啟期間不吃 snapshot；兩端**同時**編輯仍 last-write-wins，realtime 只縮小不消滅此窗口。
- 踩坑（2026-06）：PrefModal 由 ContextMenu mount **一次**、靠 `show` prop 切換，`withStateHandlers` 的初始 `values: readValuesWithDefault()` 只在 app 啟動時跑一次 → 表單 state 永遠是啟動瞬間的舊值，關閉時 `writeValues`+`savePrefs` 會把舊值寫回，**復原憑證清除、蓋掉雲端新偏好**（realtime listener 寫進 localStorage 也救不了）。修法：`componentDidUpdate` 偵測 `show` false→true 時 `setValues(readValuesWithDefault())`。debug 線索：About 分頁與 console 啟動行有 build commit id（webpack DefinePlugin `GIT_COMMIT`/`BUILD_TIME`），可排除舊 bundle。
- 帳號改 local-only 後，新裝置（尤其無 credential API 的 Firefox/Safari）不再從雲端拿到 `autoLoginUser`，需手動重填帳密一次。
- 清瀏覽器資料只清掉同步旗標與快取；偏好仍在雲端，重新登入即拉回。
