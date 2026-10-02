# Android 模擬器 e2e（真 Android Chrome）

守**我們對 Android 的假設**（桌機 offline e2e 只能用替身測的那層）。第一個 case：選取模式的長按／拖把手
（`docs/mobile.md`「長按選單與選取模式」）。

## 檔案

| 路徑 | 職責 |
|---|---|
| `tests/e2e/android/android_env.js` | 純函式：選模擬器、CSS px→device px、adb 輸出解析、SDK 工具定位 |
| `tests/e2e/android/fixtures.js` | worker：選機→OS 斷網→清 Chrome→IPv4 轉送＋adb reverse；test：`launchBrowser` 覆寫 `page`；失敗存整個螢幕 |
| `tests/e2e/android/*.android.spec.js` | spec（project `android`，`playwright.config.js`） |
| `scripts/run-android-e2e.mjs` | `yarn test:e2e:android`：找／建 AVD、開機、跑、分類 exit 0/1/2、自己開的自己關 |
| `scripts/android-e2e-needed.mjs` | `--if-changed[=base]` 的檔案名單（預設 base `origin/dev`） |
| `.github/workflows/android-e2e-spike.yml` | CI 抖動量測（20 次平行） |
| 守護 | `tests/unit/android_e2e.test.js`、`tests/unit/e2e_offline_no_network.test.js`「android e2e：OS 層斷網」 |

## 跑法

- `yarn test:e2e:android`：手動或有改動才跑。`--if-changed` 沒命中名單⇒印「略過」exit 0。
  `--keep-emulator` 留著模擬器（下一輪省開機）；`--no-boot` 只用已在跑的（CI）。其餘參數透傳 playwright。
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
| 測試卡在 setting up "context" 直到 timeout | Chrome 起不來時 `launchBrowser` 不會自己逾時 ⇒ 被算成真失敗 | 自帶 60s 逾時，丟 `[android-env]` |
| 實機也在 adb 上 | 開發機常連著無線 adb 的手機 | `pickEmulatorSerial` 只收 `emulator-N`；多台要 `ANDROID_SERIAL` |

- 螢幕用原生 Pixel 6（1080x2400，412 CSS px、DPR 2.625）。spec 用一般終端機畫面（不開好讀），所以
  不需要「一屏 24 列」；曾用 `-skin 1080x1366` 湊 24 列，比例失真，已棄用。
- 預設 `screenshot` 只拍網頁；系統／Chrome UI 看 `device-screen.png`（失敗時自動存）。

## CI spike（未完成）

狀態：workflow 已寫、**未跑**（交接：`docs/handoff/android-emulator-e2e.md`）。判準：斷言紅（`test-fail`）一次都不接受；`env`／`boot-fail` 是基礎設施，
可在 job 內重試**開機**（不重試測試）。降不下來 ⇒ `test-e2e-android` 先 non-required，判讀寫進
`docs/ci-troubleshooting.md`。結果填回本節後，再決定是否把 job 加進 `test.yml`／required checks。
