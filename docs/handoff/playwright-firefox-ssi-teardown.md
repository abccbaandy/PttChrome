# Playwright Firefox teardown 偶發 `_maybeDontRestoreTabs`：做最小重現 → 發上游 issue

狀態：**已發上游 issue，等回覆**：https://github.com/microsoft/playwright/issues/43413
（確定性重現 `prove-mechanism.mjs`、Linux 原生長跑 `repro.mjs`、`RESULT.md` 放在分支
`claude/intelligent-bohr-f0xfzk`，issue 以 commit `840a929` 的 permalink 引用 ⇒ **該分支留到 issue 結案才刪**，
不合進 `dev`）。
本專案只在 `docs/local-env-troubleshooting.md` 記了症狀，**沒有**任何 workaround。
上游修好（Playwright 換了含修正的 Firefox revision，升版後確認消失）或 issue 被關閉不修 ⇒ 刪本檔與上述分支，
並同步改 local-env-troubleshooting 那條。期間維護者若要更多資訊，照下方「接手步驟」1 補量。

## 症狀（CONFIRMED）

```
browserContext.close: Protocol error (Browser.removeBrowserContext): can't access property
"_maybeDontRestoreTabs", this[#windows][aWindow.__SSi] is undefined
```
- 出現在 fixture teardown，測試本體已經過。
- 只在 Windows 的 `offline-firefox` 壓力跑出現：
  `yarn playwright test --project=offline-firefox tests/e2e/offline/selection.offline.spec.js --repeat-each=5`（8 worker）。
- 環境：Playwright 1.64.0、Firefox 157.0（build `firefox-1555`）、Node 24、Windows 10 19045。
- **1.64.1 不用測**：它綁的 Firefox 也是 `1555`（`playwright-core/browsers.json`），release notes 只修
  Electron／Chromium；bug 在 Firefox build 內（Juggler＋SessionStore），升 Playwright 不會變。
  換 Firefox revision 的版本出來才需要重測。
- 上游 issue 搜 `_maybeDontRestoreTabs`：0 筆（2026-10-14）。

## 頻率（2026-10-14 實測）
- 現行設定（1597b23 起 `network.http.fast-fallback-to-IPv4=false`）：**0/414**。
- 開回 IPv4 快速備援（每輪約 15% `page.goto` refused ⇒ worker 頻繁重啟）：2/450、0/450、0/900。
  2 次命中**同一輪、同一條**（雙擊選字），相隔 10 秒，**都在剛重啟的 worker**（新瀏覽器）。
- ⇒ 舊紀錄「約 3/225」是 IPv4 修好之前量的；觸發跟「新開的瀏覽器」有關，成群出現。

## 機制（用診斷版 Firefox 量到，CONFIRMED）

1. 呼叫鏈：`Browser.removeBrowserContext → BrowserContext.destroy → PageTarget.close →
   gBrowser.removeTab → #beginRemoveTab（fast path）→ closeWindow(true, …, "close-last-tab") →
   SessionStore.maybeDontRestoreTabs`，最後這步沒檢查 entry 存不存在。
2. 平常路徑：`windowCount=1`、`canQuitApplication("lastwindow")` **沒被取消**，所以每次 context.close 都會
   走到 `maybeDontRestoreTabs`。不炸是因為視窗有 `__SSi`（`window0`），而且在 `#windows` 裡。
3. 命中時：`__SSi=undefined`、`#onBeforeBrowserWindowShown` **從未對該視窗執行**、`#windows` 整個是空的，
   `closed=false`、`RunState.isQuitting=false`、沒有任何刪除紀錄（不是 onClose 也不是 purge 刪掉的）。
   ⇒ 不是「entry 被提早刪掉」的競態，而是**這個視窗從沒被 SessionStore 註冊**。
4. 註冊唯一入口是 `browser-window-before-show`，只在 `gBrowserInit.onLoad()` 中段發出
   （`browser/omni.ja` → `chrome/browser/content/browser/browser-init.js`）。SessionStore 本身在
   `browser-before-ui-startup` 就 `init()` 了，早於任何視窗，所以不是「還沒開始監聽」。
   ⇒ **unknown**：命中的視窗是 `onLoad` 沒跑、跑到一半 throw，還是 `load` 根本沒觸發。
   第三層診斷（`onLoad` 入口／notify 前打旗標＋`readyState`）已就位，但那 900 條沒命中。
5. 不能在本專案關掉 `closeWindowWithLastTab`：Playwright 自己靠它關視窗。

## 診斷版 Firefox 做法（下次要加量時照做，不動共用安裝）
- 複製 `$PLAYWRIGHT_BROWSERS_PATH/firefox-1555`、`ffmpeg-*` 到暫存目錄，跑測試時用
  `PLAYWRIGHT_BROWSERS_PATH=<暫存>` 指過去。
- `firefox/omni.ja`（toolkit）與 `firefox/browser/omni.ja` 用 `unzip` 解開、改 JS，再用 Python `zipfile`
  （`ZIP_DEFLATED`）整包重打即可，Firefox 讀得了一般 zip。
- 改點：`SessionStore.sys.mjs` 的 `maybeDontRestoreTabs`（miss 時改 throw 帶診斷字串，會原樣出現在
  Playwright 錯誤裡）、`#onBeforeBrowserWindowShown` 入口、`#onClose`／`#onPurgeSessionHistory` 的 delete；
  `globalOverlay.js#closeWindow`；`browser-init.js#onLoad`。
- 寫檔用**同步** `nsIFileOutputStream`（路徑走 env，Windows 要反斜線）。`IOUtils.writeUTF8` 在關閉中的
  視窗裡會被丟掉，什麼都寫不出來。
- 壓測腳本要把 json reporter 的 `errors[].message` 搜 `_maybeDontRestoreTabs`／診斷字串。**壓測期間別另外跑
  Playwright**：它可能沿用別人起的 dev server，結束時又把它關掉，結果整輪 `CONNECTION_REFUSED`。

## 接手步驟

1. 要追第 4 點的 unknown：用上面的做法、開回 IPv4 快速備援（只在暫存設定，別 commit），把命中率拉高，
   例如讓 worker 更常重啟，或專跑「新瀏覽器的第一個 context」，看 `onLoad`／`beforeShowSent` 旗標。
2. 最小重現候選：獨立小專案、每次 `firefox.launch()` → `newContext` → `newPage` → `goto` → 立刻
   `context.close()`，大量並行啟動新瀏覽器（命中集中在新瀏覽器的第一個視窗）。舊的獨立腳本是
   「每個瀏覽器跑 25 個 context」，所以測不到。
3. ~~開 issue~~（已完成：microsoft/playwright#43413）。原本的規格留作參考：開 issue 到 `microsoft/playwright`（`bug.yml` 範本：Version／Steps to reproduce＝
   小 repo 連結／Expected／Actual／Additional context／Environment）。
   Additional context 貼上面「機制」1–4，修法建議：Juggler 端改成
   `this.#windows[aWindow.__SSi]?.`，或 `PageTarget.close()` 用
   `removeTab(tab, { closeWindowWithLastTab: false })` 再自己關視窗。
   **發之前先給使用者看內容**（會以使用者的 GitHub 帳號公開發出）。環境資訊不可含本機路徑。
