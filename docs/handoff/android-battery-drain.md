# Android APK 耗電分析（使用者體感掉電過快，懷疑是 APK）

狀態：**分析中**。第一階段（讀 code）＋模擬器量測已完成；實機已有一份 batterystats 快照（見「實機 batterystats 快照」）。CPU A/B（U5）還沒在實機上跑。**還沒有任何 code 改動。**
前置閱讀：`docs/android-app.md`（不變量 6、7 跟這裡直接相關）。

## 使用者情境（決定優先序）
- 系統「電池使用情形」：PttChrome **前景 1 小時、背景 2 分鐘**。⇒ 耗電主要發生在前景（螢幕開著讀 PTT）。
- 長時間離開時會**登出＋從最近使用清單滑掉**，通知列「連線中」不會殘留。
- 使用者的限制：不 root、不燒機、不做任何會過度耗電的測試。可以開開發者模式、接 USB 讓我們跑 adb。

## 已確定可優化（CONFIRMED）

### 1. 游標閃爍每秒整頁重算樣式＋重畫 ⇒ 前景閒置時的主要成本
- 位置：`pttchrome.jsx` `onConnect` 的 `timerEverySec`（每秒）→ `term_view.onBlink`（`blinkOn=true`＋`queueUpdate(true)`）
  → `term_buf.notify` 尾端 `document.body.classList.toggle('blink--active')`。
  `color.css` 有 24 條 `.blink--active .qq*` 子孫選擇器，`main.css` 有 `.blink--active #cursor {display:block}`。
- 量測（模擬器，WebView 133，正式版 GitHub Pages 頁面，停在登入畫面約 590 個 span，每組 60 秒）：

  | 情境 | App 程序 CPU | renderer CPU | 幀數／60 秒 |
  |---|---|---|---|
  | 前景閒置 | 660 ms | 350 ms | 60 |
  | 前景閒置，攔掉 `blink--active` toggle | 40 ms | 50 ms | 0 |
  | 前景，畫面複製 20 倍（約 1.2 萬 span，模擬好讀長文） | 1210 ms | 1970 ms | 166 |
  | 同上，攔掉 toggle | 20 ms | 40 ms | 0 |

  CDP `Performance.getMetrics`：每秒 1 次 RecalcStyle＋1 次 Layout（`#cursor` 的 display 在 none 和 block 之間切換會觸發 layout）。
  ⇒ 閒置 CPU 約 90% 以上來自閃爍，成本跟著畫面節點數變大。模擬器跑在 Apple Silicon 上，手機省電核心的絕對值會更高。
- 優化方向：閃爍只動 `#cursor`（CSS animation，或只切換游標元素自己的 class），**不要切換 `body` 的 class**；頁面隱藏時停掉。
  **注意畫面上真正的 blink 屬性文字**（SGR 5，`.qq*` 規則）也靠同一個 class 運作：要嘛改成只在畫面上有 blink 字元時才切換，
  要嘛另外用一個只作用在 blink 字元上的 class。改之前先讀 `term_view.js` 的 `_applyCursorVisibility`／`refreshCursorVisibility`
  （#cursor display 的唯一寫入點）以及 `cursor_shape.offline.spec.js`。
- 這屬於渲染鏈的改動 ⇒ 依 CLAUDE.md 的規定，要補測試，並跑 offline e2e＋adverse。

## 實機 batterystats 快照（2026-10-02，未 reset，since last charge 約 20h47m）
來源：`dumpsys batterystats`（全文），沒有跑 bugreport。原始檔沒有進 repo。
- 整機：總放電 3290 mAh。螢幕開著 1970 mAh（亮屏 3h36m），螢幕關著 1320 mAh（17h，平均約 77 mA；deep doze 830 mAh／14.5h，約 57 mA）。
- PttChrome（uid u0a359）：**311 mAh，整機第 2 名**（第 1 名是遊戲，44 分鐘 351 mAh）。在 top 的時間 1h10m45s。
  - screen 211、cpu 85.7（其中 fg 82.2）、mobile_radio 13.1、wifi 1.5。bg／fgs／cached 合計約 4.5 ⇒ **背景與服務可以排除（CONFIRMED，實機）**。
  - CPU 時間 40m35s，約等於 top 時間的 57% 個核心。renderer（`sandboxed_process0`）20m22s，App 程序 17m20s（WebView 的 compositor／GPU 執行緒算在 App 程序）。
  - 流量：Wi-Fi 收 193 MB、行動網路收 22.7 MB（70 分鐘）。推測是圖片／動圖預覽，**未驗**。Wi-Fi 的耗電只算 1.5 mAh，行動網路 13 mAh。
- 對照另一個 PTT App（uid u0a248）：top 37m25s，CPU 10m48s（約 29% 個核心），cpu 9.8 mAh，mobile_radio 12.0。
  ⇒ 每分鐘前景的 CPU 時間，PttChrome 大約是它的 **2 倍**；換算成 cpu mAh 大約 **4.4 倍**（PttChrome 比較多時間跑在大核的高頻）。
- 螢幕更新率：`min_refresh_rate=peak_refresh_rate=165`（使用者把更新率鎖在 165Hz），`mActiveRenderFrameRate=165`。
  ⇒ **U2 在這台實機上不成立**（面板本來就不會降頻）。但捲動或動畫時，WebView 會以 165fps 出幀，CPU／GPU 的成本也會跟著放大。
- 螢幕關閉時的整機耗電與 APK 無關（CONFIRMED）：PttChrome 的 bg＋fgs＋cached 合計約 4.5 mAh。
  **使用者手機本身的待機耗電**（kernel 休眠被打斷、其他 App 掃藍牙等）另案追蹤，**不屬於本 handoff**。
  筆記在 `docs/local/phone-standby-drain.md`（gitignored，只存在使用者的本機。內容含個人裝置與已安裝 App，依隱私規範不進 repo）。

### 下一步建議（依實機數據重排優先序）
1. CONFIRMED #1（閃爍）仍然是第一優先：前景 CPU 是 PttChrome 唯一大於螢幕以外的成本。
2. 新增 U7：前景 70 分鐘 216 MB 流量的來源（預覽圖、tenor 動圖、`<video>`）。用 CDP `Network` 或 `performance.getEntriesByType('resource')` 量一篇文章的位元組數。
3. U3（動圖持續解碼）的權重上調：在 165Hz 下，`<video autoplay loop>` 的合成成本更高。

## 已確定可排除（CONFIRMED，模擬器）
- **背景 JS／渲染**：按 HOME 鍵後 `document.hidden=true`，60 秒內 App 30 ms＋renderer 80 ms，出幀 0，RecalcStyle 0。
  不變量 7（不暫停 WebView）＋`RENDERER_PRIORITY_IMPORTANT`＋`offscreenPreRaster` 在背景都不會造成持續耗電。
- **滑掉後殘留**：從最近使用清單滑掉後，`dumpsys activity services` 裡沒有 `ConnectionService`，程序也結束了。
  （按返回鍵是 `moveTaskToBack`，服務**會**留著，但使用者的習慣不是這樣。）
- **推文自動更新**：`maxPushthreadAutoUpdateCount` 預設 -1（關閉）。
- **斷線後重連迴圈**、**WakeLock**：code 裡都沒有。

## 尚未確認
| # | 項目 | 為什麼沒驗 | 怎麼驗 |
|---|---|---|---|
| U1 | **App 是不是真的耗電元兇**（相對於螢幕本身） | 模擬器的耗電模型是假的 | 實機 `dumpsys batterystats --reset`，照常使用半天後跑 `dumpsys batterystats --charged io.github.abccbaandy.pttchrome`，跟同時段其他螢幕開著的 App 比 CPU 時間和估計 mAh。先請使用者提供系統電池頁上的 % 數。 |
| U2 | 每秒 1 幀會不會讓變動更新率螢幕降不下來 | 推測，模擬器沒有這種螢幕 | 實機開發者選項的「顯示更新頻率」，看閒置在 PTT 畫面時的數字，再跟關掉閃爍的版本比。 |
| U3 | tenor 動圖（`ImagePreviewer.jsx` `InlineVideo` gif 模式，`<video autoplay loop>`）持續解碼的成本 | 要登入才開得到含動圖的文章（登入預算） | 實機開一篇有 tenor 動圖的文章，量 renderer CPU，以及捲到可視範圍外時有沒有停（`inline_preview_slot.js` 的卸載距離 `LAZY_UNMOUNT_MARGIN_PX`）。 |
| U4 | OkHttp 每 20 秒 ping 的行動網路成本（`LocalWebSocketProxy.kt` 的 `pingInterval(20s)`） | 模擬器沒有真的行動網路；使用者離開就登出，影響應該很小 | 只有在 U1 顯示行動網路工作時間異常高時才追：`adb bugreport` 丟進 Battery Historian 看 mobile radio 的時間軸。若要拉長間隔，先讀不變量 6（NAT 逾時）。 |
| U5 | 實機 CPU 的絕對值 | 模擬器 CPU 跟手機不同 | 實機跑下面的 cpu.sh，同一套對照（不需要 root，用 `/proc/<pid>/stat` 就能讀）。 |
| U6 | 按返回鍵離開後服務一直留著 | 不是使用者的習慣，所以排除在本次之外 | 如果要保護其他使用者：背景閒置太久就自動斷線，或在通知顯示已連線多久。 |

## 量測方法（可重現，免登入）
- 建置：`android/local.properties` 寫 `sdk.dir=<Android SDK>`（gitignored，用完刪掉），`cd android && ./gradlew assembleDebug`。
  debug 版才會開 WebView devtools（`setWebContentsDebuggingEnabled(BuildConfig.DEBUG)`）。
- 模擬器：用既有的 AVD（API 36 gplay，arm64）就可以。`emulator -avd <name> -no-snapshot-save`，`adb install -r app-debug.apk`，
  `adb shell am start -n io.github.abccbaandy.pttchrome/.MainActivity`。App 會連真的 PTT，停在登入畫面，不要登入。
- CDP：`adb forward tcp:9333 localabstract:$(adb shell cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1)`，
  然後連 `http://127.0.0.1:9333/json` 裡 url 含 PttChrome 的 page，用 Node 22 內建的 `WebSocket`：
  - `Performance.enable` 之後隔 N 秒呼叫兩次 `Performance.getMetrics`，取 `RecalcStyleCount`／`LayoutCount`／`TaskDuration` 的差值。
  - A/B 不改 code：用 `Runtime.evaluate` 把 `DOMTokenList.prototype.toggle` 包一層，遇到 `'blink--active'` 就直接 return。
    正式版頁面**沒有** `window.__app` 這個探針（只有 DEVELOPER_MODE 才掛）。
  - 模擬長文：把 `#mainContainer` 的 children `cloneNode` 20 倍，放進一個兄弟節點（只在模擬器上做，量完 reload）。
- 程序 CPU：`adb shell ps -A -o PID,PPID,USER,NAME`，找 App 程序（`io.github.abccbaandy.pttchrome`）和**它的** renderer
  （`sandboxed_process0`，PPID＝webview_zygote；可能有不只一個，用啟動時間或 uid 對應，例如 `u0_i90xx`）。
  前後各讀一次 `/proc/<pid>/stat` 的第 14＋15 欄（jiffies，1 jiffy＝10 ms）相減。
  幀數用 `dumpsys gfxinfo io.github.abccbaandy.pttchrome` 的 `Total frames rendered` 前後相減。
- 收尾：`adb forward --remove-all`、`adb emu kill`，刪掉 `local.properties`。
