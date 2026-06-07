# 交接：e2e 改成「登入一次、共用 session 跑多數 case」

STATUS: `未做`。目標：避免整包 e2e 連續多次登入觸發 PTT「登入太頻繁, 請稍後再試」節流。

## 現況（問題）
Playwright 預設每個 `test()` 用全新 context/page → **每個 test 各自 `login(page)`**。`playwright.config.js` 為
`workers:1`、`fullyParallel:false`，整包約 8 次登入序列執行 → PTT 端節流（`登入太頻繁`）。各 test 用
`addInitScript` 在載入前塞**不同 prefs**（`enableEasyReading`/`showFloorNumbers`/`autoLogin`…）並從乾淨 localStorage
導航，所以原本才各自登入。

現有 test（`tests/e2e/`）：
- `connect-login.spec.js`（1）、`easy-reading.spec.js`（2）、`enhance.spec.js`（4 + 自動登入 1）。
- helper：`tests/e2e/helpers/ptt.js`（`login/readScreen/sendKey/typeLine/waitForScreen/attachConsole`）。

## 目標做法
用 `test.describe.serial` + `beforeAll` 建立**單一已登入 page**，文章/樓層/黑名單/列表類 case 共用它：
- per-test prefs 改成**進站後**呼叫 `window.__app.onPrefChange(key, val)`（而非 `addInitScript` + reload），
  或 set localStorage 後走 app 內既有的 pref 重套路徑；每個 case 開始時把會互相影響的 prefs reset 成已知狀態。
- 每個 case 結束**回到看板列表/主選單**的乾淨起點（離開文章、清搜尋），避免狀態污染下一個 case。
- **例外**：`connect-login` 與「自動登入」本質就是測登入流程 → 仍各自獨立登入，不共用。

## 注意/坑
- 共用 session 後 case 間有順序相依 → 必須 `describe.serial`，且每個 case 自我復位（離開文章、回列表）。
- `addInitScript` 設 prefs 只在「載入前」有效；共用 page 不會重載，故 prefs 必須改走 runtime（`onPrefChange`）。
- `login()` helper 已處理重複登入/中間提示；可順手在 helper 加「偵測『登入太頻繁』→ 等待退避重試」當保險。
- 驗證：重構後跑整包 `yarn test:e2e` 應只登入 ~3 次（共用 1 + connect-login 1 + 自動登入 1）且全綠。
- 帳密走 env `PTT_USER`/`PTT_PASS`；連續開發跑多輪仍可能被節流，退避重試可緩解。
