# pttchrome — 專案指引

PTT BBS 瀏覽器終端機 client。fork 自 `robertabcd/PttChrome @ dev`，是 term.ptt.cc 的原始碼。
webpack5 + React16（React/jQuery/Bootstrap 走 CDN，非 import）。

## 跑起來（踩雷點，務必照做）
- 啟動 dev server：`yarn start` → http://localhost:8080（= `webpack serve`；**不再需要** `NODE_OPTIONS=--openssl-legacy-provider`）
  - 用 **Node**（≥20.9，建議 v24）跑，**不要用 bun**（bun 的 ws proxy 不轉發 upgrade）。
  - 套件管理用 **yarn**（`yarn.lock` v1）。Node 內建 corepack：`corepack enable` 即可用 `yarn`（版本由 `package.json` 的 `packageManager` 鎖定）。**勿用 npm**（會產生多餘 `package-lock.json`）。
- dev server 內建 `/bbs` WebSocket proxy，改寫 Origin→term.ptt.cc，直連 `wss://ws.ptt.cc/bbs`。開頁即自動連真 PTT，**不需任何中繼**。
- dev 預設站台 `wstelnet://localhost:8080/bbs`（webpack.config.js `DefinePlugin` → `DEFAULT_SITE`）。
- 詳見 `docs/run-local.md`。

## 架構關鍵點
- entry：`src/entry.js` → `src/js/main.js`。`main.js` 先載 Big5 轉碼表(`conv/*.bin`)→ `startApp()` → `new App().connect(DEFAULT_SITE)`。
- **dev build 啟動會跳 Developer Mode modal，按掉才會 `connect()`**（`main.js` 受 `process.env.DEVELOPER_MODE` gate）。
- 登入是 telnet BBS 流程：在終端機畫面打字，**程式碼無自動登入**。
- 核心物件（`new App()` in `src/js/pttchrome.js`）：
  - `core`(App) ── `view`(TermView, `src/js/term_view.js`) ── `termBuf`(TermBuf, `src/js/term_buf.js`)
  - `EasyReading(core, view, termBuf)`：`src/js/easy_reading.js`，閱讀模式自動翻頁/捲動狀態機。
- DOM：隱藏 input `#t` 收鍵盤（`src/dev.html`、`term_view.js`）；畫面每列渲染進 `#mainContainer`（`src/components/Screen.js`），`innerText` 可讀整頁文字。
- 純邏輯（無 DOM/網路，易測）：`src/js/string_util.js`(Big5轉碼需全域 `window.lib.*`)、`symbol_table.js`、`event.js`、`ansi_parser.js`。
- 緊耦合 DOM/React：`term_view.js`、`term_ui.js`、`pttchrome.js`、`components/`。
- 偏好雲端同步：`src/js/pref_sync.js`（Google 登入 + Firestore `users/{uid}`，Firebase compat CDN lazy-load；webpack5 已可改 modular SDK，回遷待辦見 `docs/handoff/firebase-modular-sdk-migration.md`；密碼絕不上雲）。儲存層 `src/js/pref_storage.js`。詳見 `docs/pref-sync-firestore.md`。

## 測試
- **Unit（首選，穩定）**：`yarn test:unit`（jest，預設 node env，不連網）。`tests/unit/`：純邏輯
  (`comment_parse.test.js`) + Row 渲染 (`row_render.test.js`，react-test-renderer + 假 ASCII TermChar)
  + 雲端同步 (`pref_sync.test.js`，jsdom env + **模擬 firebase**：假 `window.firebase` 重播
  auth/onSnapshot/set 全流程；e2e 不連 Firebase，同步邏輯只能在這驗)。
  增強功能的逐列判斷一律放 `comment_parse.annotateComment` 並在此回歸守護（e2e 素材不穩，純邏輯先測）。
- **E2E（連真 PTT）**：`yarn test:e2e`（Playwright）。帳密走 env `PTT_USER`/`PTT_PASS`，無則 guest（名額常滿會 fast-fail）。
  失敗自動截圖/錄影 + console dump。helper：`tests/e2e/helpers/ptt.js`。細節見 `tests/e2e/README.md`。

## 隱私（務必遵守）
- 這是公開 fork repo。**禁止**把以下寫進任何 `.md`、原始碼、commit message：
  - 本機絕對路徑（如 `C:\Users\<name>\...`）、作業系統使用者名稱、PTT帳號、個人 PATH/工具安裝位置、機器專屬環境細節。
- 文件示範路徑用通用佔位，如 `<專案根目錄>`；指令只寫相對動作（`cd <專案根目錄>`、`yarn start`）。
- commit 前 `git diff` 自查，確認不含上述隱私再提交。

## 慣例
- 編碼：PTT 是 Big5，內部轉 Unicode（`string_util.js` 的 `b2u`/`u2b`，查 `window.lib.b2uArray/u2bArray`）。
- 改 `src/components/**` 會被 husky + lint-staged 跑 prettier。
- docs：`docs/run-local.md`(啟動)、`docs/pttchrome-research.md`(來源驗證)、`docs/origin-rewrite-extension.md`(部署 Origin 改寫)、`docs/enhanced-addon.md`(黑名單/樓層/自動登入整合 + 踩坑)、`docs/media-preview-addons.md`(第三方圖片/媒體預覽套件研究 + 整合分析)、`docs/pref-sync-firestore.md`(偏好雲端同步 + Firebase 設定踩坑)。
- 待辦交接：`docs/handoff/`，一個 `.md` = 一個尚未完成的功能/修復；挑一個做完即**刪掉該 md**。詳見 `docs/handoff/README.md`。
- git：**不開新功能分支**，直接在現有分支（`dev`）修改與 commit。
- 增強功能整合的渲染雙路徑/事件時序等踩坑見 `docs/enhanced-addon.md`「踩坑筆記」。
- 每次踩坑都要把值得紀錄的細節寫進md
