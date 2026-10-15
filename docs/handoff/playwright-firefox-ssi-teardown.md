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
  `yarn playwright test --project=offline-firefox tests/e2e/offline/selection.offline.spec.js --repeat-each=5`
  （8 worker）。累計約 3/225 條；`--repeat-each=10` 那輪 0/90。正常 1 倍跑 5 輪 0 次。
- 環境：Playwright 1.64.0、Firefox 157.0（build `firefox-1555`）、Node 24、Windows 10 19045。
  上游 1.64.1 已出，**未測**。
- 上游 issue 搜 `_maybeDontRestoreTabs`：0 筆（2026-10-14）。

## 機制（讀 Playwright 內建 Firefox 的 `firefox/omni.ja` 得出，該檔可直接 `grep -a`）

1. Juggler `Browser.removeBrowserContext` → `BrowserContext.destroy()`：先
   `ContextualIdentityService.remove(userContextId)`（不關分頁），再逐頁 `page.close()`
   → `gBrowser.removeTab(tab)`。
2. `playwright.cfg` 設 `browser.tabs.closeWindowWithLastTab = true` ⇒ 關最後一個分頁 →
   `closeWindow(true)`（`chrome/toolkit/content/global/globalOverlay.js`）→
   `window.SessionStore?.maybeDontRestoreTabs(window)`。
3. `SessionStore.maybeDontRestoreTabs` 直接 `this.#windows[aWindow.__SSi]._maybeDontRestoreTabs = true`，
   沒檢查 entry 存不存在。
4. entry 在 `#onLoad`（由 `#onBeforeBrowserWindowShown` 同步呼叫）建立，在 `onClose`、
   `#onPurgeSessionHistory`（刪掉「不在 `#browserWindows` 裡」的視窗；該 iterator 註解自承
   「Might miss the most recent one」）刪除。
   ⇒ 跑到 closeWindow 時，視窗不是已經被註銷（重複關），就是還沒被追蹤到。
   **unknown**：實際是哪一條路徑。`#onPurgeSessionHistory` 不是 container 刪除觸發的
   （`SessionHistoryCleaner` 沒有 `deleteByOriginAttributes`）。
5. 不能在本專案關掉 `closeWindowWithLastTab`：Playwright 自己靠它關視窗。

## 已試過、重現不了的最小腳本

獨立 node 腳本（不用本專案 app）：本機 `http.createServer` 吐一頁 3000 個 div＋一個 ResizeObserver；
8 個 `firefox.launch()` 並行，每個跑 25 次 `newContext → addInitScript → newPage → goto →
mouse.click → keyboard.press('Control+c') → context.close()`；有／無 `recordVideo` 各 400 次
context ⇒ **0 次**。所以差異在完整 spec 的某個步驟（候選：`page.route` 述詞攔截、
stub WebSocket、`proxy` 設定、長文 1500 行＋content-visibility 分塊、`page.mouse.wheel`、
test runner 的 `video: 'retain-on-failure'`＋`screenshot`）。

## 接手步驟

1. 先升 `@playwright/test`／`playwright` 到最新 patch，`yarn playwright install firefox`，
   跑上面的 `--repeat-each=5` 3 輪。消失 ⇒ 刪本檔＋改 troubleshooting 那條，結束。
2. 還在 ⇒ 二分 spec：逐項移除上面的候選，直到在獨立的 `npm init playwright@latest`
   小專案（只放必要的 code，上游只跑他們信得過的 code）重現。
3. ~~開 issue~~（已完成：microsoft/playwright#43413）。原本的規格留作參考：開 issue 到 `microsoft/playwright`（`bug.yml` 範本：Version／Steps to reproduce＝
   小 repo 連結／Expected／Actual／Additional context／Environment）。
   Additional context 貼上面「機制」1–4，修法建議：Juggler 端改成
   `this.#windows[aWindow.__SSi]?.`，或 `PageTarget.close()` 用
   `removeTab(tab, { closeWindowWithLastTab: false })` 再自己關視窗。
   **發之前先給使用者看內容**（會以使用者的 GitHub 帳號公開發出）。環境資訊不可含本機路徑。
