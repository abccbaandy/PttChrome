# E2E 測試（Playwright，連真實 PTT）

用真實 Chromium 驅動 app 連真 PTT，驗證功能。出錯時自動截圖/錄影 + dump 瀏覽器 console。

## 跑

```powershell
# guest（PTT guest 名額常滿，滿時會 fast-fail 並提示改用帳號）
yarn test:e2e

# 真實帳號（帳密只讀環境變數，不進 git）
$env:PTT_USER="你的帳號"; $env:PTT_PASS="你的密碼"; yarn test:e2e

# 帳號有開兩階段驗證（2FA）時**必須**再給密鑰，否則整包 live 會卡在驗證碼畫面
$env:PTT_OTP_SECRET="Base32 密鑰或整段 otpauth:// 網址"

yarn test:e2e:headed   # 肉眼看登入過程
yarn test:e2e:ui       # Playwright UI 模式
```

> **踩過兩次的坑：「明明設了 `PTT_OTP_SECRET` 卻讀不到」＝行程環境是舊的快照，不是讀取邏輯壞掉。**
> Windows 行程的環境變數在**啟動當下**就固定了，之後才新增的**使用者層**變數不會回填到已在跑的
> shell／編輯器／agent。症狀正是「`PTT_USER`／`PTT_PASS` 讀得到（設得早），`PTT_OTP_SECRET` 讀不到
> （設得晚）」，整包 live 便全數停在 `需要兩階段驗證，但沒有可用的 PTT_OTP_SECRET`。
>
> 先分辨是哪一種（只印長度，不印值）：
> ```powershell
> 'Process','User','Machine' | % { "$_=" + [Environment]::GetEnvironmentVariable('PTT_OTP_SECRET',$_).Length }
> ```
> `Process=0` 但 `User>0` 就是這個坑。不必重開終端機，當場注入即可：
> ```powershell
> $env:PTT_OTP_SECRET = [Environment]::GetEnvironmentVariable('PTT_OTP_SECRET','User'); yarn test:e2e
> ```

**2FA 帳號**：`helpers/ptt.js#login` 會用 `PTT_OTP_SECRET` 以 `src/js/totp.js` 即時算出 6 位驗證碼
（最多送 2 次，重試前先等過 30 秒窗——同一窗重算是同一組碼）。沒設會直接報錯說明要設什麼，
不會空轉到逾時。`enhance.spec.js` 的自動登入案例也會把密鑰注入 prefs；**沒給密鑰時 app 端會
刻意停在驗證碼畫面把鍵盤交還使用者**（該降級路徑守在 `tests/unit/auto_login_2fa.test.js`）。

dev server 由 `playwright.config.js` 的 `webServer` 自動啟動（已手動 `yarn start` 時 `reuseExistingServer` 會重用）。

## PTT 連不上時（preflight 連線健檢）

`live` 與 `record` project 都 `dependencies: ['preflight']`（`preflight.setup.js`）。
preflight 只驗一件事：**連得到 PTT 嗎**（app 有 boot → WebSocket 連上 → server 有吐畫面），
紅了就整包 live 不跑，只留一則明確結論。

判準（訊息會直接寫在錯誤裡）：

| 現象 | 結論 |
| --- | --- |
| `window.__app` 不存在 | 本專案／dev server 問題（bundle 掛了、dev server 沒起來） |
| `connectState=2`（已斷線） | **PTT 端不可達或維護中**，非本專案 code 問題 |
| `connectState=0`（一直在連） | PTT 不可達或網路被擋，非本專案 code 問題 |
| `connectState=1` 但畫面空白 | 連上了但 server 不吐畫面（PTT 維護模式常見） |

**PTT 維護中時 live e2e 必紅，這是預期行為**，先開 https://term.ptt.cc 確認站台狀態，
不要往本專案 code 追。逃生門 `$env:E2E_SKIP_PREFLIGHT="1"`（會跳過健檢直接跑 live）。

純函式 `describeConnectFailure` 的訊息內容由 `tests/unit/e2e_preflight_message.test.js` 守護。

**連線失敗類的行為測試不放這裡**：真 PTT 沒辦法可靠地製造「連不上」，一律測在 offline
project（`offline/connect_failure.offline.spec.js`，用 `installReplay(page, { neverOpen: true })`），
好處是 CI 的 offline-e2e job 也跑得到（live e2e 不在 CI）。

## 孤兒進程 / stale bundle

以前常見坑：dev server 被中斷後殘留孤兒 `node` 佔住 8080，`reuseExistingServer` 又重用到 stale bundle。
現在所有 e2e 腳本（`test:e2e`、`test:e2e:offline`、`headed`、`ui`、`record:cassette`）跑之前都會先
`yarn kill:dev` 自動清掉佔 8080 的 dev server，再讓 Playwright 起全新 server：

- **每次指令只清/起一次**（非每個 test），不增加 PTT 登入次數。
- `kill:dev` 只砍「佔 8080 且確實是 node+vite」的進程，**不會誤殺**佔 8080 的其他服務（如 java）。
- **會**連帶殺掉你手動 `yarn start` 的 dev server（Playwright 會自己重啟一個）。
- 手動清理：`yarn kill:dev`（`scripts/kill-dev-server.js`，跨平台、永不 fail）。

debug 時想即時看到 page console / pageerror：設環境變數 `$env:E2E_ECHO_CONSOLE="1"`，或對需要的 case 用
`attachConsole(page, { echo: true })`（預設仍只存不印，避免正常跑測試時刷屏）。

## 失敗產物

- `test-results/.../test-failed-1.png`、`video.webm`：失敗當下畫面/錄影
- `playwright-report/`：HTML 報告（`npx playwright show-report`）
- console 紀錄會印在測試輸出（含 app 內 `console.log`，如 easy_reading 的 page state）

## 共用登入 session（避免「登入太頻繁」節流）

整包只登入 ~3 次：共用 session 1 + connect-login 1 + 自動登入 1。

- `helpers/fixtures.js`：worker-scoped fixture `shared`（`{ page, logs }`），整個 worker 只登入一次，
  跨 spec 檔重用同一個已登入 page（`workers:1`）。
- **規則**（新 test 預設照此寫）：
  - `const { test, expect } = require('./helpers/fixtures')`，case 收進 `test.describe.serial`。
  - 每個 case 開頭：`logs.length = 0` → `await resetSession(page)`（回主選單 + prefs baseline）→
    `await applyPrefs(page, {...})` 套本 case 需要的 prefs。
  - prefs **禁用 `addInitScript`**（共用 page 不 reload，載入前注入無效）；一律 `applyPrefs`（runtime）：
    寫 localStorage（`enableEasyReading` 由 easy_reading live 讀，下次進文章生效）+ 立即生效 key 走
    `window.__app.onPrefChange`（`onPrefChange('enableEasyReading')` 是 no-op，關閉時 applyPrefs 會直接退出好讀）。
  - 共用 page 非內建 fixture，失敗不會自動截圖/錄影 → catch 內自行 `page.screenshot`。
  - 某 case 失敗 → serial 後續 skip、Playwright 重啟 worker → fixture 重建（多登入一次，可接受）。
- **例外**：測登入流程本身的 case（`connect-login`、自動登入）用內建 `page` fixture 獨立登入。
- `login()` 內建節流保險：偵測「登入太頻繁」→ 等 20s 重送帳密，最多 2 次。

## 結構

- `helpers/ptt.js`：可重用工具
  - `readScreen` / `waitForScreen`：讀 `#mainContainer` 文字、輪詢等字串（容錯，timeout 帶當前畫面）
  - `typeLine` / `sendKey`：對隱藏 input `#t` 打字
  - `dismissDeveloperModeAlert`：關掉 dev build 的 Developer Mode modal（不關 app 不會 connect）
  - `login`：env 有帳密用真實帳號否則 guest，容錯迴圈處理 PTT 中間提示頁 + 節流退避
  - `waitBbsConnected` / `describeConnectFailure`：連線健檢與其錯誤訊息（見上節；`login` 開頭也會呼叫，
    單跑一支 spec 時同樣拿得到明確結論）
  - `attachConsole`：收集 console / pageerror
  - `applyPrefs` / `resetSession` / `gotoBoard`：共用 session 專用（runtime prefs、回主選單復位、進看板）
  - `getPref(page, key)`：runtime 讀「有效 pref 值」（`DEFAULT_PREFS` 疊 localStorage），見下方規範

## 規範：可設定的快捷鍵不准 hardcode

凡是「使用者可在偏好設定改的鍵」（住在 `src/js/pref_storage.js` 的 `DEFAULT_PREFS`，目前唯一一個是
`easyReadingEndSwitchKey`），測試**一律用 `getPref(page, 'xxxKey')` 動態取值再按**，不准寫死字面。

理由：寫死 = 複製了「預設鍵 = ?」這個唯一真相。預設一改（實例：好讀切原生鍵 `End`→`F8`，commit `d04c7e6`）
測試就 stale 整段壞掉（`4c308a2` 事後補修）。`getPref` 讀的是 app runtime 真正用的值，預設再改測試免動。

```js
const switchKey = await getPref(page, 'easyReadingEndSwitchKey');
await sendKey(page, switchKey);
```

底層：dev build 由 `src/js/main.js` 暴露 `window.__readPrefs = readValuesWithDefault`（與 `window.__app` 同 gate，
production 不洩漏）。**例外**：PTT 原生熱鍵（`End`/`Enter`/`Space`/`ArrowLeft`/`Slash` 等）非本 app 設定項，照常寫死。
- `helpers/fixtures.js`：共用登入 session fixture（見上）
- `connect-login.spec.js`：登入到主選單（獨立登入）

## 規範：evaluate 內點擊後不可同步讀 React 產物

React 19 起，`el.click()` 觸發的 setState 在事件 task **之後**才 commit——同一個 `page.evaluate`
內點完立刻讀 `classList`／DOM 恆讀到舊值（假紅，實例：點圖放大 `imagesEnlarged` 恆 false，2026-07）。
點擊後 `await new Promise(r => setTimeout(r, 300))` 再讀（或拆兩次 evaluate）。

另 live 內容相依測試（最新文章）遇熱門文（推文即時灌入）列數會在斷言間變動，偶發紅屬浮動，重跑即可。

## 擴充

新 spec 用 `shared` fixture + `resetSession`/`applyPrefs`/`gotoBoard`（見「共用登入 session」規則），例如
`easy-reading.spec.js`：復位→進看板→開文章→驗證自動翻頁/捲到底（對應 `src/js/easy_reading.js`）。
