# Playwright Firefox `_maybeDontRestoreTabs` teardown 錯誤：獨立重現

目標錯誤（`context.close()` 丟出）：

```
browserContext.close: Protocol error (Browser.removeBrowserContext): can't access property
"_maybeDontRestoreTabs", this[#windows][aWindow.__SSi] is undefined
```

## 環境（Linux cloud）

| 項目 | 值 |
|---|---|
| OS | Linux 6.18（x86_64 container） |
| 核心數 | 4 |
| Node | v24 |
| Playwright | 1.64.0（`playwright` 套件，非 test runner） |
| Firefox | `firefox-1555`（Playwright 內建，157.0） |

## 結論先講

1. **機制已確定性重現（Linux）**：`prove-mechanism.mjs` 只在 Firefox 自己的
   `BrowserGlue._beforeUIStartup` 裡、`SessionStore.init()` 之前插一段「轉 event loop N 毫秒」，
   其餘全是 Playwright 正常流程（launch → newContext → newPage → setContent → context.close），
   就會穩定命中同一句錯誤。對照組「同樣長時間卡住主執行緒但**不**轉 event loop」不命中。
2. **原生（未 patch）Firefox 在 Linux 上 7569 次中命中 0 次**（4 種變體，含 CPU 加壓），
   見下方「原生長跑」表。Linux 沒有自然觸發窗口；上游 issue 建議以 `prove-mechanism.mjs` 為主、
   Windows 自然命中（約 2/2250）為佐證。

## 機制（讀 firefox-1555 的 omni.ja 原始碼）

- Playwright 以 `-silent -juggler-pipe` 啟動 Firefox，沒有初始視窗；第一個視窗是
  `Browser.newPage` 時由 Juggler `TargetRegistry._newPageInternal` 用 `Services.ww.openWindow` 開的。
- Juggler（`chrome/juggler/content/components/Juggler.js`）與 BrowserGlue
  （`browser/modules/BrowserGlue.sys.mjs`）**都監聽 `final-ui-startup`**。Juggler 的 observer
  在 `command-line-startup` 才註冊，比 BrowserGlue 晚 ⇒ observer service 先通知它（LIFO），
  它在這裡就把 remote-debugging pipe 開好、可以收 `Browser.newPage`。
- 接著 BrowserGlue `_beforeUIStartup` 才跑，並在**最後**才呼叫
  `callModulesFromCategory("browser-before-ui-startup")` ⇒ `SessionStore.init()`，
  這一步才 `addObserver("browser-window-before-show")`。
- 如果 Juggler 開 pipe 之後、`SessionStore.init()` 之前有任何東西轉了 nested event loop，
  pipe 上的 `newContext`／`newPage` 就會被處理，第一個視窗的 `gBrowserInit.onLoad()` 跑完、
  發出 `browser-window-before-show` 時 **SessionStore 還沒在聽** ⇒ 該視窗永遠沒有 `__SSi`、
  `#windows` 空的（與 Windows 實測的現場狀態完全一致：`__SSi=undefined`、`#windows` 空、
  `isQuitting=false`、`#onBeforeBrowserWindowShown` 從未對該視窗執行）。
  Juggler 的 `waitForWindowReady`（等 `delayedStartupPromise`）照樣會過，所以 newPage 成功。
- 之後 `context.close()` → `BrowserContext.destroy` → `PageTarget.close` → `gBrowser.removeTab`
  → 最後一個分頁 → `closeWindow(true, …, "close-last-tab")`（`globalOverlay.js`）
  → `SessionStore.maybeDontRestoreTabs(window)` → `this.#windows[aWindow.__SSi]._maybeDontRestoreTabs = true`
  沒判空 ⇒ TypeError，成為 `Browser.removeBrowserContext` 的 protocol error。
- 只有「新瀏覽器的第一個頁面視窗」可能中：之後的視窗開啟時 SessionStore 早已 init。
  這與 Windows 上兩次命中都在「剛重啟的 worker」相符。

真實環境中是誰轉了 event loop **尚未定位**（BrowserGlue `_beforeUIStartup` 本身沒有
`spinEventLoopUntil`；可能是同一個 `final-ui-startup` 通知裡排在 Juggler 之後、BrowserGlue 之前的
其他 observer，或 Windows 專屬的同步 OS 呼叫路徑）。這不影響上游判斷：時序窗口本身由
「Juggler 在 `final-ui-startup` 就收指令」與「`maybeDontRestoreTabs` 不判空」構成。

## 確定性證明：`prove-mechanism.mjs`

複製 Playwright 的 Firefox 到 `os.tmpdir()/pw-firefox-ssi-patched`，用 fflate 改
`browser/omni.ja` 裡的 `modules/BrowserGlue.sys.mjs`（在 `browser-before-ui-startup` 呼叫前插入），
用 env 控制：

- `REPRO_DELAY_SESSIONSTORE_INIT=ms` → `Services.tm.spinEventLoopUntil` ms（nested event loop）
- `REPRO_BLOCK_SESSIONSTORE_INIT=ms` → busy-wait ms（對照：一樣慢，但不轉 event loop）

`node prove-mechanism.mjs --n=5 --ms=4000`（Linux，同時背景有 8 路原生長跑在吃 CPU）：

| 模式 | 命中 |
|---|---|
| 無注入 | 0/5 |
| busy-wait 4000ms（不轉 event loop） | 0/5 |
| spinEventLoop 4000ms | **4/5** |

另以 scratchpad 的 probe 掃延遲門檻（各 3 次）：100／300／600／1000ms → 0/3；1500ms → 1/3；
2000ms → 1/3；3000ms → 3/3 與 2/3（兩輪）。窗口必須長到涵蓋「newContext＋newPage＋視窗 onLoad」，
沒完全覆蓋的那幾次是 newPage 還沒到就結束轉圈。

命中時的完整錯誤訊息（第一行）：

```
browserContext.close: Protocol error (Browser.removeBrowserContext): can't access property "_maybeDontRestoreTabs", this[#windows][aWindow.__SSi] is undefined
```

## 原生長跑：`repro.mjs`

每次迭代都是新的瀏覽器（launch → newContext → newPage → goto 本機 HTML（3000 個 div＋ResizeObserver）
→ dblclick＋Control+c → context.close → browser.close），本機 `http.createServer`，不連外網。
Linux 吞吐量約 0.9 次／秒（與並行度 4／8／16 無關，CPU 4 核是瓶頸）。

| 變體 | 並行 | CPU 加壓 | 次數 | 命中 | 其他錯誤 |
|---|---|---|---|---|---|
| full | 8 | 0 | 3000 | 0 | 0 |
| nowait | 8 | 0 | 2000 | 0 | 0 |
| nogoto | 16 | 3 執行緒 | 2000 | 0 | 0 |
| full | 16 | 3 執行緒 | 569（背景時限到被中止，最後一筆計數） | 0 | 0 |
| **合計** | | | **7569** | **0** | **0** |

⇒ **Linux 上原生 Firefox 7569 次中命中 0 次**。CPU 加壓（Node 端忙迴圈）放大不了這個窗口：
它需要 Firefox 主執行緒在 `SessionStore.init()` 前**轉 event loop**，單純變慢（見上面 busy-wait 對照）不會命中。
Windows 的 ~2/2250 推測來自 Windows 專屬、啟動期會轉 event loop 的同步路徑，尚未定位。

## 能不能再縮小

- 觸發條件與頁面內容、滑鼠／鍵盤**無關**：確定性版本只用 `setContent('<p>hello</p>')`，連 goto 都不需要。
- 給上游的最小重現就是 `prove-mechanism.mjs`（Playwright 原生 API ＋ 對 Firefox 的一行時序注入）；
  未 patch 的原生版本命中率太低（Windows 約 1/1000、Linux 0/7569），只適合當佐證。
- Windows 上可直接跑同一支 `prove-mechanism.mjs`（fflate 跨平台，不需 unzip/zip）確認同一機制。
- 上游可能的修法（給使用者決定是否開 issue）：
  1. Juggler：`Browser.newPage` 在 `SessionStore.promiseInitialized`（或 `browser-ui-startup-complete`）之前先等；
  2. Firefox：`SessionStore.maybeDontRestoreTabs` 對未追蹤的視窗判空（同檔其他方法多半已判空）。

## 使用方式

```
node docs/handoff/firefox-ssi-repro/repro.mjs --total=3000 --conc=8 --variant=full [--stress=3]
node docs/handoff/firefox-ssi-repro/prove-mechanism.mjs --n=5 --ms=4000
```

`--variant`：`full`／`noinput`／`nowait`／`nogoto`／`minimal`，說明見 `repro.mjs` 開頭。
