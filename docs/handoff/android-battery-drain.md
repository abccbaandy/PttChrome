# Android APK 耗電分析（使用者體感掉電過快，懷疑是 APK）

狀態：**分析中**。已實作：游標閃爍省電（`term_view.js#toggleBlinkPhase`，守護 `tests/unit/blink_phase.test.js`、`blink_cursor.offline.spec.js`）；實機省電幅度未驗（U5）。
前置閱讀：`docs/android-app.md`（不變量 6、7 跟這裡直接相關）。

## 使用者情境（決定優先序）
- 系統「電池使用情形」：PttChrome **前景 1 小時、背景 2 分鐘**。⇒ 耗電主要發生在前景（螢幕開著讀 PTT）。
- 長時間離開時會**登出＋從最近使用清單滑掉**，通知列「連線中」不會殘留。
- 限制：不 root、不燒機、不做會過度耗電的測試。可開開發者模式、無線 adb。

## 實機 batterystats（兩份，PttChrome 部分）
| 快照 | top 時間 | PttChrome mAh（screen／cpu） | CPU 時間／top | 對照 PTT App CPU／top |
|---|---|---|---|---|
| 10-02，未 reset，20h47m（閃爍修正前） | 1h10m45s | 311（211／85.7） | 57% 核心 | 29% |
| 10-03，reset 後 15h39m（閃爍修正已上 Pages） | 25m14s | 102（75.0／26.4） | 63% 核心 | 29% |
| 10-04 減 10-03 的增量（PttChrome 程式無耗電相關改動） | 30m30s | 108 | 64% 核心 | — |
- 10-04 增量的使用時段在 `957e278`（延遲載入 observer root 改 `.main`，卸載遲滯邊界之前失效）部署**之前** ⇒ 下一份快照可順便驗 U3。
- 三份 bg／fgs／cached 都 <5 mAh ⇒ **背景與服務排除（CONFIRMED，實機）**。
- 閃爍修正後 CPU 比例沒降 ⇒ 實際使用時的主成本不在閒置閃爍（見 U5）。
- 10-02 流量：Wi-Fi 收 193 MB、行動收 22.7 MB（70 分鐘），來源未驗（U7）。
- 螢幕鎖 165Hz（`min_refresh_rate=peak_refresh_rate=165`，使用者不改）⇒ 面板不降頻；捲動／動畫時 WebView 以 165fps 出幀。
- 整機待機／「系統應用程式」／GMS 耗電與 APK 無關（CONFIRMED：系統項主因是硬體待機底噪、165Hz 合成、休眠被打斷），
  另案追蹤於 `docs/local/phone-standby-drain.md`（gitignored，含個人裝置資訊）。

## 已確定可排除（CONFIRMED，模擬器）
- 背景 JS／渲染：`document.hidden=true` 後 60 秒 App 30 ms＋renderer 80 ms，出幀 0。不變量 7＋`RENDERER_PRIORITY_IMPORTANT`＋`offscreenPreRaster` 背景不耗電。
- 滑掉後無殘留 `ConnectionService`（返回鍵是 `moveTaskToBack`，服務會留，見 U6）。
- 推文自動更新預設關、無重連迴圈、無 WakeLock。

## 尚未確認（依優先序）
| # | 項目 | 怎麼驗 |
|---|---|---|
| U5 | 實機前景 CPU 絕對值＋閃爍修改前後差。2026-10-03 實機（閃爍修正已上 Pages）：CPU／top ≈ 63% 核心，沒有比修正前的 57% 低 ⇒ 實際使用時的主成本**不是閒置閃爍**（guess：捲動／預覽在 165Hz 下出幀） | 實機 `/proc/<pid>/stat` 第 14＋15 欄差值（不需 root），分「閒置停在文章」／「連續翻頁」兩組量；確認 WebView 載入的是新版（排除快取） |
| U7 | 前景 70 分鐘 216 MB 流量來源（預覽圖、tenor 動圖、`video`） | CDP `Network` 或 `performance.getEntriesByType('resource')` 量一篇文章的位元組數 |
| U3 | tenor 動圖（`ImagePreviewer.jsx` `InlineVideo`，`video autoplay loop`）持續解碼；165Hz 下權重上調 | 實機開含動圖文章量 renderer CPU，確認捲出可視範圍會卸載（`inline_preview_slot.js` `LAZY_UNMOUNT_MARGIN_PX`） |
| U4 | OkHttp 20 秒 ping 的行動網路成本（`LocalWebSocketProxy.kt`） | 只在 mobile radio 異常高時追；拉長間隔前先讀不變量 6（NAT 逾時） |
| U6 | 返回鍵離開後服務一直留著 | 非使用者習慣；可考慮背景閒置自動斷線 |

## 量測方法（可重現，免登入）
- 建置：`android/local.properties` 寫 `sdk.dir=<Android SDK>`（gitignored，用完刪），`cd android && ./gradlew assembleDebug`。debug 版才開 WebView devtools。
- 模擬器：既有 AVD（API 36 gplay，arm64），`emulator -avd <name> -no-snapshot-save`，`adb install -r app-debug.apk`，
  `adb shell am start -n io.github.abccbaandy.pttchrome/.MainActivity`。停在登入畫面，不要登入。
- CDP：`adb forward tcp:9333 localabstract:$(adb shell cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1)`，
  連 `http://127.0.0.1:9333/json` 裡 url 含 PttChrome 的 page（Node 22 內建 `WebSocket`）：
  `Performance.getMetrics` 隔 N 秒取 `RecalcStyleCount`／`LayoutCount`／`TaskDuration` 差值。正式版頁面沒有 `window.__app`。
- 程序 CPU：`adb shell ps -A -o PID,PPID,USER,NAME` 找 App 程序與它的 renderer（`sandboxed_process0`，可能多個，用啟動時間或 uid 對應）。
  前後讀 `/proc/<pid>/stat` 第 14＋15 欄（1 jiffy＝10 ms）。幀數用 `dumpsys gfxinfo io.github.abccbaandy.pttchrome` 的 `Total frames rendered` 差值。
- 收尾：`adb forward --remove-all`、`adb emu kill`，刪 `local.properties`。
