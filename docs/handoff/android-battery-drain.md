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
| 11-12，自動 reset 後 18h50m（`957e278` 已部署一個多月） | 55m39s | 265（181／72.7） | 79% 核心（扣掉 cached 段約 64%） | — |
- 10-04 增量的使用時段在 `957e278`（延遲載入 observer root 改 `.main`，卸載遲滯邊界之前失效）部署**之前**。
- 11-12 快照：前景 CPU／top 仍約 64% 核心 ⇒ **`957e278` 沒有降低前景 CPU（CONFIRMED，實機）**，主成本不在延遲載入卸載失效。
  - CPU 時間拆程序：renderer（`sandboxed_process0`）24m18s、App 主程序 19m22s（其中 kernel 7m09s）。主程序佔 44%，
    它裝的是 WebView 的 GPU／合成執行緒與 `LocalWebSocketProxy` ⇒ 支持「165Hz 出幀」假說（guess），U5 分組量時兩個程序分開記。
  - 流量 55 分鐘只有 27.7 MB（行動 25.7＋Wi-Fi 2.0），CPU 比例卻沒變 ⇒ CPU 成本跟下載量無關，U7 降優先。
  - cached 段 12.8 mAh（cpu 10.8，10h20m）、fgs 3.44 mAh（5 分鐘）：比前三份的「<5 mAh」高，仍是小項；來源未驗（unknown）。
  - 區間內 APK 由 1.4.0 換成 1.5.0（網頁內容走 Pages，兩版載入的是同一份）。
- 三份 bg／fgs／cached 都 <5 mAh ⇒ **背景與服務排除（CONFIRMED，實機）**。
- 閃爍修正後 CPU 比例沒降 ⇒ 實際使用時的主成本不在閒置閃爍（見 U5）。
- 10-02 流量：Wi-Fi 收 193 MB、行動收 22.7 MB（70 分鐘），來源未驗（U7）。
- 螢幕鎖 165Hz（`min_refresh_rate=peak_refresh_rate=165`，使用者不改）⇒ 面板不降頻；捲動／動畫時 WebView 以 165fps 出幀。
- 整機待機／「系統應用程式」／GMS 耗電與 APK 無關（CONFIRMED：系統項主因是硬體待機底噪、165Hz 合成、休眠被打斷），
  另案追蹤於 `docs/local/phone-standby-drain.md`（gitignored，含個人裝置資訊）。

## 實機分組 CPU（11-12，APK 1.5.0，165Hz，好讀文章；`/proc/<pid>/stat` 每 10 秒取樣）
| 組 | 時長 | App 主程序 | renderer | 合計 | 出幀 |
|---|---|---|---|---|---|
| 停在文章不碰 | 51s | 2.2% 核心 | 6.9% | 9% | 0 幀 |
| 連續手指捲動 | 112s | 47.5% | 81.3% | 129% | 102 fps（11461 幀） |
- **主成本＝捲動（CONFIRMED，實機）**：閒置 0 幀、9% 核心（含取樣自身的 `dumpsys gfxinfo`）⇒ 閒置／閃爍排除，U5 結案。
  全日平均 64% ≈ 前景時間約 45% 在捲動。
- 捲動時每幀 CPU：renderer 約 8.0 ms、主程序約 4.7 ms；165Hz 每幀預算 6.06 ms ⇒ renderer 跟不上，只出到 102 fps。
  renderer 81% 表示捲動不是純合成器捲動，每幀有主執行緒／raster 工作（來源 unknown，見 U8）。
- 閒置時 renderer 仍有 6.9%、0 幀（來源 unknown，小項）。

## 實機捲動 trace（11-12，debug APK＋CDP `Tracing`＋`Profiler`，25 秒連續捲動）
文章：好讀累積頁 19552 列、40 個 `screenChunk`、DOM 11.6 萬節點、`scrollHeight` 113477、圖 10 張。WebView Chrome 156。
renderer 主執行緒 556 ms/s（其餘 thread：Compositor 65、VizWebView 59、InProcGpu 51、raster worker 34、App UI thread 43）。
| 主執行緒項目（ms/s，含子事件） | 值 | 來源 |
|---|---|---|
| Paint | 209 | 每幀約 4 次；`#document` 109＋`.main` 96（clip 高 12453 裝置 px）。**每幀重畫的原因 unknown**（guess：導覽軸滑塊每幀改 style 使整層失效） |
| `ArticleNav._measure`（rAF） | 111 | `article_nav.js#_watch` 的 scroll listener 每幀排一次，逐一量每個標記的 `offsetTop` 鏈（CONFIRMED：JS profile self time 前兩名＝`offsetTopWithin`、`nodeTopWithin`） |
| 「滑到底開下一篇」的 scroll listener 讀 `scrollTop` | 49 | 其中 45 是被它逼出來的 style＋layout（每幀 1 次，dirty 2 個物件）；前一幀有人在 lifecycle 之後改 DOM |
| IntersectionObserver `computeIntersections` | 40 | 188 次/s |
| React scheduler task | 37 | guess：導覽軸滑塊位置走 React state，每個 scroll 事件 re-render 一次 |
| Layerize＋Commit＋PrePaint | 85 | 跟著每幀失效走 |
- style recalc 88 次/s，每次 `elementCount` 中位數 1 ⇒ 每幀只有一個元素在變（`.articleNavThumb`，A/B 後 CONFIRMED）。

### A/B：關掉 `enableArticleNav`，同一篇（重載後 20102 列）再錄 25 秒
| | 導覽軸開 | 導覽軸關 |
|---|---|---|
| 主執行緒 ms/s | 556 | 409（−26%） |
| 主執行緒幀數/s（`BeginMainThreadFrame`） | 93 | 117 |
| 每個主執行緒幀 ms | 5.97 | 3.48（−42%） |
| Paint ms/s | 209 | 218（**沒變**） |
| FunctionCall ms/s | 238 | 85 |
| style recalc 次/s／Layout 次/s | 88／88 | 18／17 |
| rAF（`FireAnimationFrame`）ms/s | 127 | 8 |
- **導覽軸＝每幀約 2.5 ms（CONFIRMED，實機 A/B）**：`_measure` 掛在 scroll 上＋滑塊每個 scroll 事件經 React 改 style
  （lifecycle 之後弄髒 ⇒ 下一幀第一個讀 `scrollTop` 的 listener 被迫 style＋layout）。
  修法方向：`_measure` 不掛 scroll（版面變化已有 `ResizeObserver`）；滑塊不經 React、只動 `transform`。
- **每幀 Paint 與導覽軸無關（CONFIRMED，原 guess 推翻）**：關掉後照舊。`.main` 的 Paint 巢狀在 `#document` 的裡面，
  實際 Paint self ≈ 113 ms/s（上表「含子事件」欄把兩層重複加了），佔導覽軸關閉後主執行緒的 28%。成因見下節。
  其餘：IntersectionObserver 39、Layerize＋Commit＋PrePaint 81、style recalc 剩 18 次/s 但每次 2.8 ms（guess：`screenChunk` 進出）。

### 每幀 Paint 的成因：`.main` 的自訂捲軸（CONFIRMED，實機 A/B）
方法：CDP `Input.synthesizeScrollGesture`（touch，±5000 CSS px，2500 px/s，約 4.6 秒）＋臨時注入一條 CSS，其餘不變；導覽軸關。
| 變因 | 主執行緒幀 | ms／幀 | `.main` Paint 次數 | Layerize ms |
|---|---|---|---|---|
| 現況（4 次：440～467 幀） | 440 | 4.33 | 355 | 147 |
| `.main::-webkit-scrollbar{display:none}` | 688 | **2.18** | **21** | 27 |
| `scrollbar-width:thin`＋`scrollbar-color` | 456 | 4.12 | 367 | 150 |
| 隱藏 `#floatTools`／上下工具列／`#cursor`／圖片、`.main{will-change:transform}` | — | 3.3～4.3 | 不變 | 不變 |
- `LayerTree`：`.main` 本身是合成捲動（內容層 1052×267518），但旁邊有一層 26×1953（＝10 CSS px 的捲軸）帶
  `RepaintsOnScroll` ⇒ `::-webkit-scrollbar` 自訂捲軸由主執行緒畫，每次捲動位移都要重畫；它屬於 `.main` 的 PaintLayer
  ⇒ 整層連同內容（cull rect 12453 裝置 px）每幀重建 display list（約 1.5 ms）＋Layerize。
- 導覽軸開著時原生捲軸只是**隱形、寬度照留**（`main.css` `.main.articleNavOn::-webkit-scrollbar-*`）⇒ 看不到也照樣每幀重畫。
- 換成標準 `scrollbar-width`／`scrollbar-color` 沒有用（上表第三列；有無被 `::-webkit-scrollbar` 規則蓋過 unknown）。
- 修法方向：好讀文章的 `.main` 不要有自訂捲軸（`display:none`），原本靠捲軸佔住的 10px 改用 `padding-right` 之類補回
  （拿掉寬度內容會變寬，見 `main.css` 該段註解）；桌機是否同樣每幀重畫未量（unknown）。
- 兩項都修的預估：每幀 5.97 → 約 2.2 ms（導覽軸 −2.5、捲軸 −1.3～2.1），renderer 主執行緒可跟上 165Hz。

## 提案（第 1、2 項已實作，待新的 batterystats 驗收；第 3、4 項使用者決定先不做）
結論：前景耗電的主成本＝好讀文章**捲動**時 renderer 主執行緒每幀 5.97 ms（165Hz 預算 6.06 ms），其中兩項是白做的：
導覽軸每幀 2.5 ms（U8）、自訂捲軸逼出的每幀 Paint 1.3～2.1 ms（U9）。閒置、背景、下載量都已排除。
| # | 改什麼 | 位置指示怎麼辦 | 狀態 |
|---|---|---|---|
| 1 | 導覽軸：`_measure` 不掛 scroll（只留 `ResizeObserver`＋settle，另加閉塊 class 的 `MutationObserver`）；滑塊位置不經 React state，直接寫 `transform` | 不變（滑塊照舊） | 已實作（`article_nav_scroll_cost.test.jsx`） |
| 2 | 導覽軸**開**時：`.main` 的原生捲軸改 `display:none`（原本是隱形但照畫），10px 寬度用 `padding-right`＋`border-box` 補回 | 不變：這時原生捲軸本來就看不到，位置與長度由導覽軸滑塊顯示 | 已實作（`article_nav_scrollbar.offline.spec.js` 守內容寬度不變） |
| 3 | 導覽軸**關**時的捲軸（先不做） | 選項 a：維持現況（看得到捲軸，付每幀 Paint）。選項 b：手機拿掉 `::-webkit-scrollbar` 自訂規則，改用系統的浮動捲軸（捲動時浮現、不佔寬） | b 是否免重畫 **unknown**：實驗只測過「隱藏」與「`scrollbar-color`」，沒測過「完全不自訂」；要先用 CSSOM 移除規則再跑同一套實驗 |
| 4 | 桌機（先不做） | — | 是否同樣每幀 Paint unknown，先量再決定要不要比照 |
- 順序建議：1＋2 一起（導覽軸預設開，涵蓋多數使用者），修完用同一套實驗確認每幀約 2.2 ms；3、4 各自先量。
- 驗收：`synthesizeScrollGesture` 實驗 `.main` Paint 掉到個位數／秒、主執行緒幀數接近 165；再抓一份 batterystats 看 CPU／top 是否低於 64% 核心。

## 已確定可排除（CONFIRMED，模擬器）
- 背景 JS／渲染：`document.hidden=true` 後 60 秒 App 30 ms＋renderer 80 ms，出幀 0。不變量 7＋`RENDERER_PRIORITY_IMPORTANT`＋`offscreenPreRaster` 背景不耗電。
- 滑掉後無殘留 `ConnectionService`（返回鍵是 `moveTaskToBack`，服務會留，見 U6）。
- 推文自動更新預設關、無重連迴圈、無 WakeLock。

## 尚未確認（依優先序）
| # | 項目 | 怎麼驗 |
|---|---|---|
| U8 | 導覽軸每幀 2.5 ms（成因 CONFIRMED，見「實機捲動 trace」） | 已修（提案第 1 項），待實機驗收 |
| U9 | `.main` 自訂捲軸使每幀 Paint（成因 CONFIRMED，見「每幀 Paint 的成因」） | 導覽軸開時已修（提案第 2 項），待用同一套 `synthesizeScrollGesture` 實驗確認 Paint 次數掉到個位數／秒；導覽軸關時照舊（第 3 項） |
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
