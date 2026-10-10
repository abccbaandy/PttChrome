# Android 模擬器 e2e（真 Android Chrome）

守**我們對 Android 的假設**（桌機 offline e2e 只能用替身測的那層）。涵蓋：
- `select_mode`：選取模式的長按／拖把手（`docs/mobile.md`「長按選單與選取模式」）；
- `mobile_input`：真 tap 工具列不彈鍵盤、⌨ 叫出軟鍵盤後工具列／終端機底列在鍵盤上方、鍵盤開著按返回只收鍵盤、
  系統返回鍵 → sentinel 接住並交給送鍵出口、補回 sentinel（連按三次、每次隔開超過 `DOUBLE_BACK_MS`
  以免觸發「送不出 ← 時連按兩次離站」的逃生門，不離站）。
- `list_card_blacklist`：真長按文章列表卡片的序號・日期／作者／標題三段，都要同時給作者與標題黑名單
  （整張卡片＝同一組，`docs/mobile.md`）。列表 cassette 是 24 列 ⇒ 測試內 `wm size 1080x1400` 縮螢幕高，
  讓手機版面 rows 夾到下限 24（觸控座標仍 1:1，不像 setDeviceMetricsOverride 會偏），`finally` 裡 `wm size reset`。
- 試過但沒收：「下拉不觸發 Chrome 重新整理」——拿掉 overscroll-behavior 的對照組在模擬器上也拉不出重整
  （body `overflow:hidden`），否定斷言證明不了什麼。
- `apk`：debug APK（WebView 殼）——返回鍵退到底只丟背景不斷線、疊了 sentinel 交給網頁 guard；文章網址交給
  外部瀏覽器、BBS 畫面留著；軟鍵盤疊在 WebView 上不縮、原生 `pttandroid:ime` 回報高度、工具列浮在鍵盤上、
  返回只收鍵盤。APK 以 dev server 模式載 host 的 dev server（fixture 用 `run-as` 寫 `shared_prefs`），
  PTT 連線一樣離線重放（stub 也攔 APK 本機 proxy 的 `/bbs/<token>`）。執行器每輪開機前先
  `gradlew assembleDebug`（增量，沒改動幾秒；編不過＝exit 2）⇒ 不會拿 build 目錄裡的舊 APK 測新 code。
  `ANDROID_E2E_APK` 已設（CI）或 `--no-build` 時不建；沒有 APK 就略過，CI 缺 APK＝exit 2。
- 未涵蓋：密碼管理員／Google 登入 bridge（模擬器上沒有 Google 帳號與已存密碼）、檔案選擇器。

## 檔案

| 路徑 | 職責 |
|---|---|
| `tests/e2e/android/android_env.js` | 純函式：選模擬器、CSS px→device px、adb 輸出解析、SDK 工具定位 |
| `tests/e2e/android/fixtures.js` | worker：選機→OS 斷網→清 Chrome→IPv4 轉送＋adb reverse、裝 debug APK；test：`launchBrowser` 覆寫 `page`、`apk`（清 App→dev server 模式→連 WebView）；失敗存整個螢幕 |
| `tests/e2e/android/screen.js` | spec 共用：強制手機版面開畫面（`openScreen`／列表卡片 `openListCards`）、OS 層真 tap（含落點自檢）／keyevent、收送出的 bytes、軟鍵盤蓋住的高度 |
| `tests/e2e/android/*.android.spec.js` | spec（project `android`，`playwright.config.js`） |
| `scripts/run-android-e2e.mjs` | `yarn test:e2e:android`：找／建 AVD、開機、跑、分類 exit 0/1/2、自己開的自己關 |
| `scripts/android-e2e-needed.mjs` | `--if-changed[=base]` 的檔案名單（預設 base `origin/dev`） |
| `.github/workflows/test.yml` job `test-e2e-android` | CI：每次都跑，emulator-runner 開機＋`--no-boot` |
| 守護 | `tests/unit/android_e2e.test.js`、`tests/unit/e2e_offline_no_network.test.js`「android e2e：OS 層斷網」 |

## 跑法

- `yarn test:e2e:android`：手動或有改動才跑。`--if-changed` 沒命中名單⇒印「略過」exit 0。
  `--keep-emulator` 留著模擬器（下一輪省開機）；`--no-boot` 只用已在跑的（CI）；`--no-build` 跳過建 APK。其餘參數透傳 playwright。
- exit：0 綠／1 真失敗／2 環境（沒 adb、沒 AVD、開機逾時、失敗全帶 `[android-env]`）。**2 不可當綠**；
  環境錯混到任何一條真斷言紅 ⇒ 1。
- 已有在跑的模擬器就用它；沒有就用 AVD `pttchrome_e2e`（`pixel_6`＋`system-images;android-34;google_apis;x86_64`），沒 AVD 就建。

## 本機環境（一次性）

- Android SDK：`platform-tools`、`emulator`、`cmdline-tools;latest`、上面那個系統映像（約 3–5 GB）。
  `sdkmanager --package_file=<檔>` 避開 Windows `.bat` 把 `;` 當分隔。
- Windows：需要 WHPX（`Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform`，系統管理員）＋
  `bcdedit /set hypervisorlaunchtype auto`＋重開機。驗證：`emulator -accel-check` 印 `WHPX ... is installed and usable`。
  只開 feature 不設 launchtype ⇒ `HypervisorPresent=False`、accel-check 報 AEHD 未安裝。
- driver：`playwright install android`（執行器每次都跑，已裝則 no-op）。

## CONFIRMED 事實（Android 14 模擬器、Chrome 113，2026-10）

- 拖完選取把手放手，Chrome 補發 contextmenu：`pointerType:'mouse'`、`pointerId:1`、`firesTouchEvents:false`、
  與 `docs/mobile.md` 一致；我們放行後 `android:id/floating_toolbar_menu_item_text`「Copy」出現。
  長按本身：`pointerType:'touch'`、`pointerId:2`、`firesTouchEvents:true`。
- 把修法改回「觸控＋選取模式才放行」⇒ 主 spec 紅在補發那次 `defaultPrevented`（反向驗證過）。
- `launchBrowser` 會自己略過 Chrome FRE；`addInitScript`、`context.route`、`baseURL`、`args` 都可用。
- 映像內建 Chrome **113**（固定版本，無 Play Store 不會升級）。app 照常 boot。
- 慣性甩動中 JS 寫入捲動容器的 scrollTop 會被 compositor 蓋回去（寫法全試過，見
  `docs/easy-reading-list.md`「純位移不寫 scrollTop」）。量法：`adb shell input swipe … 60` 連甩，
  頁面掛 scroll listener＋包 `setListScrollTop` 記寫入前後值。
- `Emulation.setDeviceMetricsOverride` 在 Android Chrome 可用來湊手機版面列數（列數＝視窗高 / 16，
  要對上 cassette 的 rows）；寬度給 `screen.width` 觸控 x 才 1:1，**y 仍會偏**（壓到 24 列時實測偏 ~5%），
  而且壓過之後系統返回鍵**不再產生 popstate**（實測）⇒ 返回鍵測試不壓高度，在原生 49 列（pageState 0）
  上斷言 guard 有接住並交給 `sendNavKeyAsUser`；送不送得出 ← 由 offline `swipe_back` 守。
- 系統返回鍵（`input keyevent KEYCODE_BACK`）在 Chrome 113 會變成 popstate、sentinel 接得住；第一層 sentinel
  在觸控 `pointerdown` 疊（規範上觸控要到 pointerup 才算 activation）**沒有**被 History Manipulation
  Intervention 跳過（實測：返回照樣收到 popstate、仍在站內）。
- 鍵盤開著時按返回：IME 吃掉、只收鍵盤，頁面收不到 popstate。

### 為什麼是 API 34（Chrome 113）而不是更新的映像

API 35 google_apis（Chrome 124，GPU 不當）試過、**棄用**：
- 模擬器內 adbd 反覆 `timeout expired while flushing socket` 後整條 transport 斷（`host-N: offline`），
  Playwright driver 跟著斷 ⇒ `browserContext.close: Target ... closed`、下一輪找不到模擬器。API 34 連跑十幾輪沒發生。
- 全新 AVD 第一次開機完成後約 1 分鐘會自己 `reboot,factory_reset` 一次（`persist.sys.boot.reason.history`）。
換映像前先在本機用 `--no-boot` 連跑 ≥5 輪確認以上兩點。

## 踩坑（症狀→原因→處置，已在 code 裡處理）

| 症狀 | 原因 | 處置 |
|---|---|---|
| `ERR_EMPTY_RESPONSE` | adb reverse 連 host 的 127.0.0.1；Windows vite 只綁 `[::1]` | fixture 內 TCP 轉送 127.0.0.1:<隨機>→localhost:8080 |
| app 沒進手機版面 | 模擬器觸控螢幕 source 帶 STYLUS ⇒ `pointer: fine`；CDP `setEmulatedMedia` 蓋不掉 | 產品的逃生門 pref `mobileLayout:'on'`（觸控本身仍真） |
| 觸控落點偏 55px | 斷網後 SystemUI 在狀態列下插「No internet connection」，幾秒後才出現 | 每次注入前重讀 WebView bounds（連兩次相同才用）；pointerdown 落點自檢，偏差>4px ⇒ `[android-env]` |
| UIAutomator 什麼都找不到（NPE） | `pm clear` 後 Chrome 跳 Android 13+ 通知權限推廣對話框，蓋住全畫面 | `pm grant ... POST_NOTIFICATIONS` |
| 分頁一路累積 | `launchBrowser` 每次開新分頁、`context.close()` 不關 | worker 開頭 `pm clear` |
| `device.info` 拋 `NullPointerException` | driver 對「找不到節點」的回應方式 | 視同找不到 |
| `device.wait` 逾時但截圖裡目標就在畫面上 | wait 等的是 UI 變化；目標在 wait 前就出現、之後不再變 ⇒ 永遠等不到 | 一律 `expect.poll(device.info)`（守護禁用 `device.wait`） |
| 偶發「Chrome keeps stopping」蓋住畫面 | 映像的 Chrome 113 GPU 程序在模擬器軟體 GPU 上初始化即 SIGSEGV（`pc 0`），每次啟動 ~6 次後退回軟體繪圖；`--disable-features=EnableDrDc`／`--use-angle=swiftshader`／`-gpu swangle_indirect`、`guest` 皆無效 | `settings put global hide_error_dialogs 1`；當機只限 `privileged_process*`（GPU），頁面與觸控照常，失敗時附 `logcat-crash` |
| 「Pixel Launcher isn't responding」蓋住畫面（CI 冷開機） | launcher 在 fixture 設 `hide_error_dialogs` **之前**就 ANR；該設定即時生效（ATMS `SettingObserver`）但只擋之後的對話框，已顯示的不收 | 設定後再 `am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS`（`BaseErrorDialog` 收到即關；shell 有 `BROADCAST_CLOSE_SYSTEM_DIALOGS`）。AOSP android14-release 原始碼 CONFIRMED |
| 測試卡在 setting up "context" 直到 timeout | Chrome 起不來時 `launchBrowser` 不會自己逾時 ⇒ 被算成真失敗 | 自帶 60s 逾時，丟 `[android-env]` |
| 實機也在 adb 上 | 開發機常連著無線 adb 的手機 | `pickEmulatorSerial` 只收 `emulator-N`；多台要 `ANDROID_SERIAL` |

- 螢幕用原生 Pixel 6（1080x2400，412 CSS px、DPR 2.625）。spec 用一般終端機畫面（不開好讀），所以
  不需要「一屏 24 列」；曾用 `-skin 1080x1366` 湊 24 列，比例失真，已棄用。
- 預設 `screenshot` 只拍網頁；系統／Chrome UI 看 `device-screen.png`（失敗時自動存）。

## CI（`test.yml` job `test-e2e-android`）

ubuntu-latest＋KVM、`ReactiveCircus/android-emulator-runner`（API 34 google_apis x86_64、`pixel_6`、`-gpu swiftshader_indirect`）。
開機前先 `./gradlew assembleDebug`（setup-java 21＋setup-gradle 快取），路徑經 env `ANDROID_E2E_APK` 交給 fixture。
不重試；exit 1／2 都是紅，判讀見 `docs/ci-troubleshooting.md`。

spike 實測（20 次平行 ×2 輪，2026-10）：
- 第 1 輪：pass 17／env 3／test-fail 0／boot-fail 0。env 3 次同一原因：Launcher ANR 對話框（見踩坑表）。
- 修法後第 2 輪：pass 20/20。
- 開機秒數（runner 起算到 script 開始）：81–128s，中位數約 95s；整個 job 140–196s。
- 版本：執行器開跑前印一行 `裝置：<serial>｜<fingerprint>｜映像 … r<rev>｜Chrome <ver>`（本機與 CI 皆有），
  與「CONFIRMED 事實」節的 Chrome 113／r14 不同時，GPU 當機與選取把手的結論要重驗。
  CONFIRMED（2026-10）：CI 為 r14、Chrome 113.0.5672.136、fingerprint `…emu64xa:14/UE1A.230829.050/12077443…`，與本機同版。
