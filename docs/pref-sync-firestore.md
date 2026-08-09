# 偏好設定雲端同步（Firebase Firestore）

## 架構

| 層 | 檔案 | 職責 |
|---|---|---|
| 儲存層 | `src/js/pref_storage.js` | `DEFAULT_PREFS` / localStorage 讀寫（自 PrefModal 抽出） |
| 純邏輯 | `src/js/pref_sync_logic.js` | `sanitizeForCloud`（剝帳密）/ `mergeCloudPrefs`（cloud wins）/ `classifySnapshot`（snapshot 分類）— unit tested |
| 副作用 | `src/js/pref_sync.js` | SDK lazy-load（dynamic import 拆 chunk）、Google 登入、Firestore 讀寫 |
| config | `src/js/firebase_config.js` | web config + reCAPTCHA site key（皆非機密，安全靠 rules + authorized domains + App Check） |

- 同步策略：localStorage = 本地快取，啟動先套用（不阻塞 BBS 連線）；曾登入者背景 attach Firestore **onSnapshot realtime listener**，每個 snapshot merge 後二次套用（`main.jsx` → `registerOnCloudValues` + `startIfPreviouslySignedIn`）。儲存時雙寫（PrefModal `onCloseClick`/`onResetClick` → `prefSync.savePrefs`）。
- 資料模型：`users/{uid}` 單一 doc `{ prefs, updatedAt: serverTimestamp, schemaVersion: 1 }`。
- 衝突：cloud wins；首次登入雲端無 doc → push local up；登出只清旗標（`pttchrome.prefsync.enabled`），localStorage 保留。
- **`autoLoginPassword`、`autoLoginUser`、`autoLoginOtpSecret` 絕不上雲**：上傳前 `sanitizeForCloud` 剝除、下載 merge 強制取本地值；憑證走瀏覽器 PasswordCredential（見 `src/js/auto_login.js`，2FA 密鑰打包進 password 欄位）。帳號 local-only 的理由：裝置在瀏覽器存好憑證後會清空 local 帳密，若帳號同步，清空的 `""` 會上雲洗掉其他裝置（無 credential API 的 Firefox/Safari legacy 登入會壞）；密鑰同理。`savePrefs` 另以 `FieldValue.delete()` 自癒刪除舊 doc 殘留的 `prefs.autoLoginUser`——**`autoLoginOtpSecret` 刻意不加**，它從第一天就是 local-only，雲端文件不可能有殘留。

## Realtime listener（onSnapshot）

**為何不用一次性 `get()`**：分頁 B 開著時收不到裝置 A 的修改，B 下次存檔會把舊值蓋回雲端（last-write-wins 蓋掉 A）。`onSnapshot` 讓 A 的修改即時推到 B。

- 每個 snapshot 經 `classifySnapshot`（純函式，unit tested）分四類：
  - `skip-echo`：`metadata.hasPendingWrites` — 本機 `set()` 的 latency-compensation echo，跳過。
  - `skip-offline-missing`：cache 回報「無 doc」但 `metadata.fromCache` — **不可**誤判首次登入去 push local，否則連線恢復後 queue 的寫入會蓋掉雲端真資料；等 server snapshot。
  - `push-local`：server 證實無 doc/無 prefs → 首次登入，上傳本機。
  - `merge`：`mergeCloudPrefs` → `writeValues` → app callback（`onValuesPrefChange`）。
- handler 每次重讀 `readValuesWithDefault()`（local 會被 PrefModal/憑證清除移動，勿閉包舊值）。
- 變更比對用 `deepEqual`（key 順序無關，`pref_sync_logic.js`），**勿用 `JSON.stringify`**：Firestore 回傳 map 欄位 key 順序不保證（`termSize` 會 `{cols,rows}` ↔ `{rows,cols}` 假變更）。merge 後無實質變更 → 不 writeValues、不打 app callback（`onValuesPrefChange` 會觸發 resize 等實際動作）；PrefModal 關閉時表單與 storage `deepEqual` → 跳過寫入與上傳（避免空上傳 bump `updatedAt` 吵醒所有裝置）。
- 生命週期：attach 前先 unsub 舊 listener；`signOut` **先 unsub 再** `auth.signOut()`（否則 stream 噴 permission-denied）；`onAuthStateChanged` 收到 null（token 過期/撤銷）也 unsub；onSnapshot error callback 觸發後 listener 自停 → 清掉 handle。
- callback 走註冊制：`main.jsx` 啟動時無條件 `registerOnCloudValues(app.onValuesPrefChange)`（純 JS 不觸發 SDK 載入），PrefModal `signIn` 建立的 listener 也打得到 app；`signIn(onCloudValues)` 的參數 callback 只在首個 snapshot 處理完打一次（更新 modal 表單）。
- 啟動還原等 auth 用 `waitForFirstAuthState()`（`authStateKnown` 旗標 + waiter queue）。注意 `onAuthStateChanged` **同步立即**呼叫 cb → cb 內勿依賴尚未賦值的 `unsub`（TDZ）。
- 測試：`tests/integration/pref_sync.test.js`（`yarn test:integration`，官方 Firebase Emulator Suite——真 modular SDK + Auth/Firestore emulator + 真 `firestore.rules`，無 mock）重播啟動還原/他機推播/echo skip/offline 守門/signIn/signOut/憑證去敏全流程。細節見下方「測試」章節。

## SDK 載入：npm modular + dynamic import()

- npm modular SDK（firebase v12，版本歸 lockfile 管）。
- `init()` 用 `import("firebase/app"|"firebase/auth"|"firebase/firestore")` → Vite/Rolldown 自動 code-split 成獨立 lazy chunk（~500KB），只在「曾登入（localStorage 旗標）」或「按登入鈕」時下載 → 未登入者（含 e2e/guest）零下載、零 Firebase 請求（Playwright 兩個方向驗證過：無旗標零流量；有旗標 chunk 正常載入）。
- modular API 注意：`snap.exists` 是**方法** `snap.exists()`（非屬性）；`onAuthStateChanged` 通知在 sign-in promise resolve 後的 microtask 才到 → `signIn` attach listener 前要等模組層 `currentUser` 就緒（`waitForUser`）。
- emulator hookup（test-only）：`init()` 讀 `process.env.FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST` / `GCLOUD_PROJECT`（`firebase emulators:exec` 自動設給子行程）→ `connectAuthEmulator`/`connectFirestoreEmulator` + projectId 覆寫。`vite.config.mjs` `define` 把三鍵 pin 成 `undefined` → production bundle 整段被 minifier DCE（entry chunk grep 不到 `EMULATOR_HOST`）。

## 測試（官方 Firebase Emulator Suite）

`yarn test:integration` = `node scripts/run-integration.mjs`：在 **Docker** 跑 emulator（auth+firestore），vitest 在 host 連容器埠。真 modular SDK 連本機 emulator、`firestore.rules` 實際 enforce，**無 mock/假 firebase**；latency compensation（`hasPendingWrites`）、離線快取（`fromCache`）、permission-denied 都由真 SDK 產生。

- **為何 Docker**：`firebase-tools` 反覆把 transitive Dependabot alert（node-fetch/uuid/tough-cookie）拖進 committed lockfile。改用 pinned image `andreysenov/firebase-tools:15.22.3-node-22`（內含 firebase-tools + OpenJDK），firebase-tools 完全移出 `package.json`/`yarn.lock` → 整棵子樹的 alert 連同未來漏洞一次消失。prod 設定同步用的是 `firebase`（client SDK，`dependencies`），與 firebase-tools 無關，不受影響。
- 前置：**Docker**（本機跑 integration 必需；無 Docker 則只能靠 CI 驗）。emulator 設定檔（`firebase.json`/`firestore.rules`/`firestore.indexes.json`）以 read-only 掛進容器 `/home/node`；vitest 透過 `FIRESTORE_EMULATOR_HOST`/`FIREBASE_AUTH_EMULATOR_HOST` env 連線（`tests/integration/setup.js`）。orchestration 細節：`scripts/run-integration.mjs`（拉起容器 → `waitHttp`（HTTP 健康檢查，非 TCP） 輪詢就緒 → 跑 vitest → `finally` 拆容器）。
- port：firestore **8089**（預設 8080 與 dev server 衝突）、auth 9099（`firebase.json` emulators 段，已設 `host: 0.0.0.0` 供容器埠映射）。
- `demo-` 前綴 project id：保證純離線、不需 `firebase login`、不可能打到正式專案。
- 登入：auth emulator 接受**假 unsigned Google ID token**（官方功能）——`signInWithCredential(auth, GoogleAuthProvider.credential('{"sub":...,"email":...}'))`。`signInWithPopup` 需要真瀏覽器 UI，headless 不可行 → `prefSync.signIn(onCloudValues, authenticate)` 第二參數是測試注入縫；production 呼叫端不傳（走 popup），流程其餘部分（旗標、attach、merge、callback）全是真路徑。
- 隔離策略：**每個測試換新 uid**（token 換 `sub`）而非清庫——(1) REST 清庫清不掉主 client 的 in-memory cache，殘留 doc 會污染下個測試的 fromCache snapshot；(2) 刪 auth 帳號會讓另一個 client 的 token 失效。換 uid 兩個都繞開。
- 「另一台裝置」= 第二個 SDK app instance（`initializeApp(cfg, "seeder")`）以同 `sub` 登入（同 uid → 過 rules）讀寫 `users/{uid}`。
- vitest integration project 用 **node env 不用 jsdom**（`vitest.config.mjs`）：jsdom 下 Firestore 走 WebChannel/XHR（無真瀏覽器不穩）；node env 解析到 SDK 的 node build 走 gRPC。`window.localStorage` 用 Map shim（`tests/integration/setup.js`）。
- vitest 原生吃 ESM/`import()`，無需任何 transform plugin。
- 等待用確定性訊號：spy `console.info` 輪詢 `snapshot action=<x>` 日誌（= listener 已掛上且 snapshot 已分類），不瞎 sleep。
- 收尾：afterAll `terminate(db)` + `deleteApp(app)`（main + seeder 都要），否則 gRPC channel / auth token timer 讓 vitest 掛著不退。
- emulator 產物 `firestore-debug.log` / `firebase-debug.log` 已 gitignore。

## Firebase 專案設定（一次性，已完成）

project：`pttchrome-prefs-7k3m`（Firestore：asia-east1）。重建時：

```
firebase projects:create <project-id> --display-name "PttChrome Prefs"
firebase apps:create web pttchrome --project <project-id>
firebase apps:sdkconfig web --project <project-id>      # 貼進 src/js/firebase_config.js
firebase firestore:databases:create "(default)" --location=asia-east1 --project <project-id>
firebase deploy --only firestore:rules
```

> firebase-tools 已不在 repo deps（見上方「為何 Docker」）。這些一次性手動指令改用 `npx firebase-tools@15 <cmd>`（需 `firebase login`）或進 Docker image 跑。日常 integration 測試不需要這些（emulator 走 `demo-` 離線 project）。

踩坑：
- `firestore:databases:create` 首次會 403（Cloud Firestore API 未啟用）；啟用後要等 1–3 分鐘傳播再重試。無 gcloud 時可用 firebase CLI 的 OAuth token 呼叫 serviceusage REST 啟用。
- **Google Auth provider 無法用 CLI / REST 開**（標準 Firebase Auth 的初始化沒有公開 API；`identityPlatform:initializeAuth` 需付費 Identity Platform；REST 建 IdP config 需自備 OAuth client）→ 必須手動：Console → Authentication → Get started → Sign-in method → Google → Enable。`localhost` 預設已在 authorized domains。
- **部署網域（如 GitHub Pages 的 `<user>.github.io`）必須加進 Auth authorized domains**，否則線上登入報 `auth/unauthorized-domain`（只看網域不看 path）。Console 手動加，或 REST：`PATCH https://identitytoolkit.googleapis.com/admin/v2/projects/<project-id>/config?updateMask=authorizedDomains`（body 帶完整清單，會整組覆蓋）。
- rules / indexes 檔在 repo 根目錄（`firestore.rules`、`firestore.indexes.json`、`firebase.json`、`.firebaserc`），rules 只允許 `request.auth.uid == uid` 讀寫 `users/{uid}`。

## App Check（reCAPTCHA Enterprise，2026-06）

威脅模型：web config（apiKey 等）公開是設計使然 → 任何人可用 script 直打 Firestore/Auth REST 燒 Spark 免費額度（額度盡 → 服務停）。App Check enforce 後 Firestore 只收帶有效 token 的請求（= 在 key 允許網域上跑的真 client）。**defense-in-depth**：擋不了在允許網域上跑 headless browser，但擋掉最廉價的直打 API 濫用。

- client：`pref_sync.js` `init()` 第 4 個 `import("firebase/app-check")`（同批 lazy chunk，未登入照樣零下載）→ `!emuProject` 才 `initializeAppCheck`（emulator/node 跳過：無 DOM、emulator 不驗 token）→ `ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY)` + `isTokenAutoRefreshEnabled: true`，包 try/catch（ad-blocker 擋 recaptcha script 時 app 不死，僅同步失效）。
- key：reCAPTCHA Enterprise **score-based** key（GCP 同專案），allowedDomains 只有正式部署網域（GitHub Pages），**不含 localhost**（加了等於任何人可在本機鑄 token）。site key = `firebase_config.js` `RECAPTCHA_SITE_KEY`（公開無妨，域名限制在 key 上）。
- App Check 註冊：provider config `tokenTtl: 86400s`（預設；每活躍裝置每天 ~1 次 assessment，Enterprise 免費額 10k/月）、`minValidScore: 0.5`（預設）。
- **dev（localhost）走 debug token**：`DEVELOPER_MODE` 時 `self.FIREBASE_APPCHECK_DEBUG_TOKEN = process.env.APPCHECK_DEBUG_TOKEN || true`。`APPCHECK_DEBUG_TOKEN` 來自**開發機環境變數**（`vite.config.mjs` `define` 注入）——已註冊的 debug token 可繞過 reCAPTCHA，**絕不可進 repo**。沒設環境變數時 SDK 每瀏覽器 profile 自產一組印在 console，需逐一註冊（Console → App Check → Apps → Manage debug tokens，或 REST `POST /v1/projects/{p}/apps/{appId}/debugTokens`）。
- enforcement：`firestore.googleapis.com` 的 `enforcementMode`（UNENFORCED ↔ ENFORCED）。**enforce 當下未帶 token 的舊 client 立即被拒** → 順序必須：部署新 client → 驗證 → 再 enforce。Auth（`identitytoolkit.googleapis.com`）enforce 需升級 Identity Platform，未做（Google 登入非計量資源，濫用主戰場是 Firestore）。
- 無 gcloud 的 REST 管理做法（同上方 serviceusage 踩坑）：firebase CLI 的 refresh token（`~/.config/configstore/firebase-tools.json`，含 `cloud-platform` scope）＋ firebase-tools 內嵌公開 OAuth client id/secret（`node_modules/firebase-tools/lib/api.js`）→ `POST oauth2.googleapis.com/token` 換 access token。重建時依序：
  1. serviceusage `services:batchEnable`：`recaptchaenterprise.googleapis.com` + `firebaseappcheck.googleapis.com`
  2. `POST recaptchaenterprise.googleapis.com/v1/projects/{p}/keys`（webSettings: SCORE + allowedDomains）→ site key 貼進 `firebase_config.js`
  3. `PATCH firebaseappcheck.googleapis.com/v1/projects/{p}/apps/{appId}/recaptchaEnterpriseConfig?updateMask=siteKey,tokenTtl`
  4. 註冊 debug token（上述）＋ 開發機 `setx APPCHECK_DEBUG_TOKEN <token>`
  5. 部署驗證後 `PATCH .../v1/projects/{p}/services/firestore.googleapis.com`（`enforcementMode: ENFORCED`）
- 驗證 pointer：dev 下 console 應見 `App Check debug token: ...`、`exchangeDebugToken` 回 200（未註冊 → 403）；正式站 network 應見 `exchangeRecaptchaEnterpriseToken` 200。

## 已知限制

- `signInWithPopup` 在嚴格擋第三方 storage 的瀏覽器（Safari/Brave）可能失敗；fallback 可改 `signInWithRedirect`（未實作）。
- PrefModal 由 ContextMenu mount 一次、靠 `show` prop 切換；表單 state 在每次**開啟**時 `componentDidUpdate` 重讀 localStorage（見 `PrefModal.jsx` 該處註解），但開啟期間不吃 snapshot → 兩端**同時**編輯仍 last-write-wins，realtime 只縮小不消滅此窗口。
- 帳號改 local-only 後，新裝置（尤其無 credential API 的 Firefox/Safari）不再從雲端拿到 `autoLoginUser`，需手動重填帳密一次。
- 清瀏覽器資料只清掉同步旗標與快取；偏好仍在雲端，重新登入即拉回。
- ad-blocker 擋 `google.com/recaptcha` 時 App Check 拿不到 token：enforce 後該瀏覽器同步全掛（permission-denied），BBS 其餘功能正常（`initializeAppCheck` 有 try/catch）。
