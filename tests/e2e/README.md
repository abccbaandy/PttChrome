# E2E 測試（Playwright，連真實 PTT）

用真實 Chromium 驅動 app 連真 PTT，驗證功能。出錯時自動截圖/錄影 + dump 瀏覽器 console。

## 跑

```powershell
# guest（PTT guest 名額常滿，滿時會 fast-fail 並提示改用帳號）
yarn test:e2e

# 真實帳號（帳密只讀環境變數，不進 git）
$env:PTT_USER="你的帳號"; $env:PTT_PASS="你的密碼"; yarn test:e2e

yarn test:e2e:headed   # 肉眼看登入過程
yarn test:e2e:ui       # Playwright UI 模式
```

dev server 由 `playwright.config.js` 的 `webServer` 自動啟動（已手動 `yarn start` 時 `reuseExistingServer` 會重用）。

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
  - `attachConsole`：收集 console / pageerror
  - `applyPrefs` / `resetSession` / `gotoBoard`：共用 session 專用（runtime prefs、回主選單復位、進看板）
- `helpers/fixtures.js`：共用登入 session fixture（見上）
- `connect-login.spec.js`：登入到主選單（獨立登入）

## 擴充

新 spec 用 `shared` fixture + `resetSession`/`applyPrefs`/`gotoBoard`（見「共用登入 session」規則），例如
`easy-reading.spec.js`：復位→進看板→開文章→驗證自動翻頁/捲到底（對應 `src/js/easy_reading.js`）。
