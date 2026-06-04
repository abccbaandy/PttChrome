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

## 結構

- `helpers/ptt.js`：可重用工具
  - `readScreen` / `waitForScreen`：讀 `#mainContainer` 文字、輪詢等字串（容錯，timeout 帶當前畫面）
  - `typeLine` / `sendKey`：對隱藏 input `#t` 打字
  - `dismissDeveloperModeAlert`：關掉 dev build 的 Developer Mode modal（不關 app 不會 connect）
  - `login`：env 有帳密用真實帳號否則 guest，容錯迴圈處理 PTT 中間提示頁
  - `attachConsole`：收集 console / pageerror
- `connect-login.spec.js`：登入到主選單（首個場景）

## 擴充

複用 `login()` + `waitForScreen()` 寫新 spec，例如 `easy-reading.spec.js`：登入→進看板→開文章→驗證自動翻頁/捲到底（對應 `src/js/easy_reading.js`）。
