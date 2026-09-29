# Android App（`android/`）

動 `android/**`、`src/js/android_bridge.js`、`src/js/credential_store.js`、`src/js/boot_site.js` 前先讀。

## 為什麼要有 APK
- 手機 Chrome 開網頁版，切到別的 App 幾秒後 WebSocket 被系統凍結／切斷。網頁端無解（瀏覽器分頁沒有前景服務）。
- APK ＝ WebView 殼載入**線上** GitHub Pages（`AppConfig.PAGE_URL`，網頁更新不必重裝）＋前景服務持有 PTT 連線。
- 附帶解掉 Origin 白名單：上游由原生 OkHttp 連，Origin 直接寫 `https://term.ptt.cc`（`docs/pttchrome-research.md`）。
- 原型來源：第三方 demo（loopback proxy＋前景服務，模擬器驗過背景 30 秒不斷線）。正式版修掉 demo 的兩個缺陷，見下方「不變量」1、2。

## 架構
```
WebView  https://abccbaandy.github.io/PttChrome/
  ├─ window.__PTT_ANDROID__ = { version, site }     document-start script（只注入 PAGE_ORIGIN）
  ├─ window.PttAndroid                              WebMessageListener（只注入 PAGE_ORIGIN）
  └─ ws://127.0.0.1:<系統挑的 port>/bbs/<token>
        └─ ConnectionService（前景服務 specialUse）
             └─ LocalWebSocketProxy ── OkHttp wss://ws.ptt.cc/bbs（Origin: https://term.ptt.cc，ping 20s）
```
| 檔案 | 職責 |
|---|---|
| `android/app/src/main/java/.../MainActivity.kt` | WebView 設定、注入、返回鍵、檔案選擇、renderer 被回收時重建 |
| `.../ConnectionService.kt` | 前景服務＋通知（「中斷連線並關閉」） |
| `.../LocalWebSocketProxy.kt` | loopback 中繼（session 生命週期） |
| `.../WsProtocol.kt` | RFC 6455 握手／frame 純邏輯（JVM test 守護） |
| `.../CredentialBridge.kt` | Credential Manager get/create password |
| `src/js/android_bridge.js` | 網頁端偵測＋request/reply（訊息合約在檔頭） |
| `src/js/credential_store.js` | 密碼管理員單一入口：`PasswordCredential` 或 bridge |
| `src/js/boot_site.js` | connect 優先序：`?site` > android > prefs proxy > default |

## 不變量（改之前先想清楚）
1. **連線位址只在讀取端覆寫，絕不寫進 prefs**：prefs 經 `pref_sync` 同步到桌機，寫進去桌機會連 127.0.0.1。demo 就是用 seed localStorage 的做法。守護 `tests/unit/boot_site.test.js`。
2. **Android WebView 沒有 `PasswordCredential`**：密碼管理員必須走原生 Credential Manager＋bridge。demo 在 APK 內「自動登入失效」就是這個原因。守護 `tests/unit/credential_store.test.js`、`auto_login_credentials.test.js`（Android 那組）。
3. **密碼字串原樣傳遞**：2FA 密鑰打包在網頁 `credential_pack.js`；原生不解析。Chrome 與 APK 共用同一筆 GPM 紀錄、格式相同。
4. **bridge 與 proxy 都鎖 origin**：`addDocumentStartJavaScript`／`addWebMessageListener` 的 allowedOriginRules 只放 `PAGE_ORIGIN`；不用 `addJavascriptInterface`（不分 origin）。
5. **proxy 路徑帶每次啟動的隨機 token**：127.0.0.1 本機任何 App 都連得到，沒有 token 就能拿它當 Origin 改寫跳板。token 必須完整經過 `siteToWsUrl`（多段路徑）——守護在 `boot_site.test.js`。
6. **不注入 telnet 指令保活**（demo 的 `IAC DO TIMING-MARK` 已拿掉：PTT 的回應會流進網頁 telnet parser）。保活靠 OkHttp ping。實機若驗出 NAT 逾時再議。
7. **背景不暫停 WebView**：不呼叫 `onPause()`／`pauseTimers()`；`setRendererPriorityPolicy(IMPORTANT, false)`。
8. **軟鍵盤不縮 WebView**：insets 只讓系統列／瀏海，IME 高度以 `pttandroid:ime` 事件交給網頁（`mobile_layout.keyboardInset` 的 `hostInset`）。縮 WebView＝layout resize ⇒ 改列數、重送 NAWS（`docs/mobile.md`）。
9. FGS 型別 `specialUse`（`dataSync` 在 Android 15 起每 24h 限 6h）。不上 Play，無 specialUse 審核問題。

## APK 內刻意關掉的網頁功能
- 設定「連線 → BBS proxy」：不生效，改顯示說明（`options_androidProxyNote`）。
- 雲端同步 Google 登入：Google 禁止 WebView 內 OAuth（`disallowed_useragent`），改顯示暫不支援。後續：`docs/handoff/android-google-signin.md`。
- 連線失敗提示不做 Origin／proxy 診斷（`pttchrome.jsx` onClose：`isAndroidApp()` 時不給 `diagnose`）。
- 已知不支援（未處理）：`a[download]` blob 下載（設定備份匯出）、Web Notification。

## 密碼共用（Digital Asset Links）
- APK manifest `asset_statements` → include `https://abccbaandy.github.io/.well-known/assetlinks.json`。
- assetlinks 必須在**網域根**：repo `abccbaandy.github.io`（user site），不能放在 `/PttChrome/` 底下。需 `.nojekyll`，否則 Jekyll 不輸出 `.well-known`。
- 內容（`<SHA256>` ＝ release 簽章憑證指紋，`keytool -list -v -keystore release.jks` 取得）：
```json
[
  {
    "relation": ["delegate_permission/common.get_login_creds", "delegate_permission/common.handle_all_urls"],
    "target": { "namespace": "web", "site": "https://abccbaandy.github.io" }
  },
  {
    "relation": ["delegate_permission/common.get_login_creds", "delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "io.github.abccbaandy.pttchrome",
      "sha256_cert_fingerprints": ["<SHA256>"]
    }
  }
]
```
- 未上線前 APK 仍可用 GPM，只是存的是 App 專屬的一筆（跟 Chrome 那筆分開）。
- applicationId `io.github.abccbaandy.pttchrome` 與簽章一旦發佈就不可改（assetlinks 綁它、使用者覆蓋安裝也要同簽章）。

## 建置
- 本機：需 JDK 17+（**完整 JDK**，只有 JRE 會 `No Java compiler found`）＋ Android SDK（platform 37、build-tools 37）。
  `android/local.properties` 寫 `sdk.dir=`（gitignored）。新版 cmdline-tools 的 `sdkmanager` 已改為 `android sdk install platforms/android-37.0 build-tools/37.0.0`。
- `cd android && ./gradlew test assembleDebug` → `app/build/outputs/apk/debug/app-debug.apk`。
- JVM test：`WsProtocolTest`（握手／frame）、`LocalWebSocketProxyTest`（MockWebServer 當假 PTT：Origin 改寫、雙向轉送、token／Origin 拒絕）。
- CI：`.github/workflows/android.yml`（`android/**` 變動才跑）。沒有簽章 secrets 時上傳 debug APK。
- Windows 上新增 `gradlew` 要 `git update-index --chmod=+x android/gradlew`，否則 CI `Permission denied`。

## 發佈
1. 使用者本機產 keystore（**不入 repo**）：`keytool -genkeypair -v -keystore release.jks -alias pttchrome -keyalg RSA -keysize 4096 -validity 36500`
2. GitHub secrets：`ANDROID_KEYSTORE_B64`（`base64 -w0 release.jks`）、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。
3. push tag `android-v<版本>` → CI 建 Release 附 `pttchrome.apk`。versionCode ＝ `github.run_number`。
4. 首次發佈後用該 keystore 的 SHA-256 產 assetlinks.json（上一節）。

## 狀態
| 項目 | 狀態 |
|---|---|
| JVM test（WsProtocol／proxy） | CONFIRMED |
| 真機：背景長時間不斷線 | `unknown`（demo 只在模擬器驗 30 秒） |
| 真機：https 頁連 `ws://127.0.0.1`（`MIXED_CONTENT_ALWAYS_ALLOW`） | `guess`（demo 同設定可連） |
| 真機：GPM 底部選單＋與 Chrome 共用 | `unknown`（需 assetlinks 上線） |
| renderer 被系統回收 | 已處理成「重建 WebView 重新連線」；網頁狀態會丟。未來可做「上游保留＋重接後 Ctrl+L」 |
