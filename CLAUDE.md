# pttchrome — 專案指引

PTT BBS 瀏覽器終端機 client。fork 自 `robertabcd/PttChrome @ dev`，是 term.ptt.cc 的原始碼。
Vite 8（Rolldown 核心）+ React19（bundled）。React plugin 用 `@vitejs/plugin-react`（Vite 8 起 Babel-free，內建 oxc transform）；測試 Vitest 4。UI 元件用 Mantine（暗色預設，`@mantine/core/styles.css` 由 entry.js 載；postcss-preset-mantine，Vite 自動讀 `postcss.config.cjs`）。無任何 CDN runtime 依賴。
**含 JSX 的檔案一律用 `.jsx` 副檔名**（Vite 8 oxc 不吃 `.js` 內的 JSX）。

## 跑起來（踩雷點，務必照做）
- 啟動 dev server：`yarn start` → http://localhost:8080（= `vite`）
  - 用 **Node**（≥20.19，建議 v24）跑，**不要用 bun**（bun 的 ws proxy 不轉發 upgrade）。
  - 套件管理用 **yarn**（Yarn v4，`node-modules` linker，設定於 `.yarnrc.yml`）。Node 內建 corepack：`corepack enable` 即可用 `yarn`（版本由 `package.json` 的 `packageManager` 鎖定 4.x）。**勿用 npm**（會產生多餘 `package-lock.json`）。CI 安裝用 `yarn install --immutable`。Yarn v4 不跑自訂 `pre*`/`post*` script；build 產物清理由 Vite `emptyOutDir` 處理（無 `clean` script）。Yarn v4 script 是 portable shell，跨平台支援 `VAR=1 cmd` 行內環境變數（`record:cassette` 用此，勿再引入 cross-env）。
- dev server 內建 `/bbs` WebSocket proxy，改寫 Origin→term.ptt.cc，直連 `wss://ws.ptt.cc/bbs`。開頁即自動連真 PTT，**不需任何中繼**。
- dev 預設站台 `wstelnet://localhost:8080/bbs`（vite.config.js `define` → `DEFAULT_SITE`）。
- 詳見 `docs/run-local.md`。

## 架構關鍵點
- entry：根目錄 `index.html`（Vite entry）→ `src/entry.js` → `src/js/main.jsx`。`main.jsx` 先載 Big5 轉碼表(`conv/*.bin`)→ `startApp()` → `new App().connect(DEFAULT_SITE)`。
- **dev build 啟動會跳 Developer Mode modal，按掉才會 `connect()`**（`main.jsx` 受 `process.env.DEVELOPER_MODE` gate；Vite 下 dev=`vite serve`、prod=`vite build` 自動判定）。
- 登入是 telnet BBS 流程：在終端機畫面打字，**程式碼無自動登入**。
- 核心物件（`new App()` in `src/js/pttchrome.jsx`）：
  - `core`(App) ── `view`(TermView, `src/js/term_view.js`) ── `termBuf`(TermBuf, `src/js/term_buf.js`)
  - `EasyReading(core, view, termBuf)`：`src/js/easy_reading.js`，閱讀模式自動翻頁/捲動狀態機。
- DOM：隱藏 input `#t` 收鍵盤（`index.html`、`term_view.js`）；畫面每列渲染進 `#mainContainer`（`src/components/Screen.jsx`）。**讀「當前畫面文字」用 `buf.getRowText`，勿讀 `#mainContainer.innerText`**（DOM 慢一幀，理由見 `docs/enhanced-addon.md` 踩坑 A）。
- 純邏輯（無 DOM/網路，易測）：`src/js/string_util.js`(Big5轉碼需全域 `window.lib.*`)、`symbol_table.js`、`event.js`、`ansi_parser.js`。
- 緊耦合 DOM/React：`term_view.js`、`term_ui.jsx`、`pttchrome.jsx`、`components/`。
- 偏好雲端同步：`src/js/pref_sync.js`（Google 登入 + Firestore `users/{uid}`，npm modular SDK 走 dynamic `import()` 拆 lazy chunk，未登入零下載；密碼絕不上雲）。儲存層 `src/js/pref_storage.js`。App Check（reCAPTCHA Enterprise）擋 script 直打 API 燒額度；dev 走 debug token（機器 env `APPCHECK_DEBUG_TOKEN`，**不入 repo**）。詳見 `docs/pref-sync-firestore.md`。

## 測試
- **Unit（首選，穩定）**：`yarn test:unit`（Vitest，jsdom env，不連網；設定 `vitest.config.js` unit project）。`tests/unit/` 30+ 檔＝
  純邏輯（解析／狀態機／轉碼）＋Row/Screen 渲染（@testing-library/react + 假 ASCII TermChar）。
  **含 JSX 的測試檔用 `.test.jsx`**。mock/timer 用 `vi.*`（globals 開啟，`describe/test/expect` 免 import）。
  增強功能的逐列判斷一律放 `comment_parse.annotateComment` 並在此回歸守護（e2e 素材不穩，純邏輯先測）。
- **Integration（雲端同步流程）**：`yarn test:integration`（Vitest + 官方 **Firebase Emulator Suite**：真 modular SDK
  + Auth/Firestore emulator + 真 `firestore.rules`，無 mock）。emulator 跑在 **Docker**（pinned `andreysenov/firebase-tools`，內含 firebase-tools+JDK；vitest 在 host 連容器埠），所以**本機跑需 Docker**（不再需本機裝 Java/firebase-tools）。orchestration 見 `scripts/run-integration.mjs`。
  **`vitest.config.js` 刻意不 extends `vite.config.js`**：app 的 `define` 會把 emulator env 釘成 undefined，integration 混用會全滅。
  `tests/integration/pref_sync.test.js`：啟動還原/他機推播/echo skip/offline 守門/signIn/signOut/憑證去敏；
  e2e 不連 Firebase，同步流程只能在這驗。細節見 `docs/pref-sync-firestore.md`。
- **E2E（連真 PTT）**：`yarn test:e2e`（Playwright）。帳密走 env `PTT_USER`/`PTT_PASS`，無則 guest（名額常滿會 fast-fail）。
  失敗自動截圖/錄影 + console dump。helper：`tests/e2e/helpers/ptt.js`。細節見 `tests/e2e/README.md`。
  - **Playwright 升版後（含 Dependabot bump）本機必跑 `yarn playwright install chromium`**：新版綁新 browser binary，
    沒裝會整批 e2e 秒掛（症狀：`browserType.launch: Executable doesn't exist`），與被測 code 無關。CI 每次都重裝所以不受影響。
- **強制規範：改到渲染/畫面這類易壞 code，提交前必跑 e2e**（`yarn test:e2e`，至少 `easy-reading.spec.js`+`enhance.spec.js`）。
  適用 `term_view.js`、`term_ui.jsx`、`src/components/**`、`easy_reading.js`、`pttchrome.jsx` 渲染/切換路徑、`term_buf.js` 渲染相關等。
  理由：unit（jsdom + testing-library）仍**不跑真瀏覽器/真 WebSocket/完整 boot 鏈**，捕捉不到「一進文章即炸」這類 runtime 崩潰
  （例：`pageLines` 用 `JSON` 克隆剝掉 TermChar prototype 方法 → `ch.isStartOfURL is not a function`）。不可只靠 unit + build 綠就交付。
- **離線重放（不連真實 PTT 也能驗依賴特定文章的 case）**：`yarn test:e2e:offline`（stub WebSocket 重放 byte cassette，
  真瀏覽器/真渲染）；Layer2 `tests/unit/replay_fixture.test.js` 用真實 `findPageOverlap` 純 node 重建跨頁去重。
  素材一次性錄製：`yarn record:cassette`（**guest-only**，capture 為 article-scoped 不含帳號）。細節見 `docs/offline-replay-testing.md`。
- **強制規範：改 code 要連帶補測試，不准「只改不測」。**
  - **每修一個 bug 必先寫一個會重現該 bug 的 test（紅）→ 修到綠**，當回歸守護。沒有對應 test 的修復視為未完成，不可交付／commit。
  - 新功能／行為改動同理補對應 test。能用純邏輯重現的（逐列判斷、解析、轉碼等）一律下放 unit（首選，最穩），抽進
    `comment_parse.annotateComment` 之類純函式再於 `tests/unit/` 守護；只有 DOM/React/網路耦合、unit 抓不到的（一進文章即炸這類 runtime 崩潰）才上 e2e。
  - test 要鎖「行為／症狀」而非實作細節，確保下次同樣 bug 再現會被擋下。
  - commit 前確認新增/相關 test 有跑且綠（`yarn test:unit`；觸及渲染/畫面則加跑 e2e，見下條）。

## 隱私（務必遵守）
- 這是公開 fork repo。**禁止**把以下寫進任何 `.md`、原始碼、commit message：
  - 本機絕對路徑（如 `C:\Users\<name>\...`）、作業系統使用者名稱、PTT帳號、個人 PATH/工具安裝位置、機器專屬環境細節。
- 文件示範路徑用通用佔位，如 `<專案根目錄>`；指令只寫相對動作（`cd <專案根目錄>`、`yarn start`）。
- commit 前 `git diff` 自查，確認不含上述隱私再提交。

## 慣例
- **PTT 邏輯不准猜**：PTT 行為邏輯一律先讀 `3rd_script/pttbbs` 原始碼找出真實實作，禁止自行猜測或從錄製素材/畫面觀察反推規則；素材只用來驗證對 code 的理解是否有誤。詳見 `docs/pttbbs-screen-protocol.md` 開頭「研究方法規範」。
- 編碼：PTT 是 Big5，內部轉 Unicode（`string_util.js` 的 `b2u`/`u2b`，查 `window.lib.b2uArray/u2bArray`）。
- 改 `src/components/**` 會被 husky + lint-staged 跑 prettier。
- docs：`docs/run-local.md`(啟動)、`docs/pttchrome-research.md`(來源＋Origin 白名單根本約束)、`docs/origin-rewrite-extension.md`(部署 Origin 改寫)、`docs/enhanced-addon.md`(黑名單/樓層/推文合併/自動登入整合＋活躍踩坑)、`docs/easy-reading.md`(文章好讀模式：settle 狀態機/render 單軌/functionMode)、`docs/easy-reading-list.md`(列表好讀模式 v5 架構：合約/狀態機/關鍵不變量；改 list_session.js/command_queue.js/term_buf settle 前先讀)、`docs/easy-reading-list-research.md`(該功能為何結構性地難＋App 式重設計選項；決定方向前先讀)、`docs/pttbbs-screen-protocol.md`(PTT server 畫面協定不變量，pttbbs source 逆向；畫面偵測規則依據)、`docs/offline-replay-testing.md`(cassette 錄製/重放/隱私)、`docs/pref-sync-firestore.md`(偏好雲端同步＋Firebase 平台踩坑)、`docs/media-preview-addons.md`(第三方預覽套件的圖床 roster／referer 規則對照)、`docs/ptt-official-app-research.md`(官方組織專案盤點＋推文終端格式交叉驗證)、`docs/merge-caption-ai-assist.md`(裝置端 AI 輔助配對：暫緩＋重啟條件)、`docs/build-modernization.md`(依賴／工具選型基準；動建置鏈或評估換依賴前先讀)。
- 待辦交接：`docs/handoff/`，一個 `.md` = 一個尚未完成的功能/修復；挑一個做完即**刪掉該 md**。詳見 `docs/handoff/README.md`。
- git：**不開新功能分支**，直接在現有分支（`dev`）修改與 commit。
- 不主動 commit
- **push 後必查 CI**：每次 push 完都要確認 GitHub Actions（`Deploy to GitHub Pages` workflow，含 unit／integration／offline-e2e）有 pass，不能 push 完就收工。無 `gh` CLI，用 GitHub API + env `GH_TOKEN` 查：
  `GET /repos/abccbaandy/PttChrome/actions/runs?branch=dev&per_page=3`（看最新 run 的 `conclusion`）→ 失敗再 `.../actions/runs/{id}/jobs` 找失敗 job/step → `.../actions/jobs/{id}/logs` 抓 log。
  - **integration job（Firebase Emulator in Docker）偶發 timeout** 是已知 flaky（CI 冷啟動拉 image + 首次 Firestore 寫入超過 poll deadline，症狀 `waitForCloud timeout: upload`）。緩解手段已用盡（`INTEGRATION_TIMEOUT_MS`、CI vitest `retry: 2`、`scripts/run-integration.mjs` 的 `waitHttp` 就緒輪詢）→ 確認非真錯後直接 `POST /repos/.../actions/runs/{id}/rerun-failed-jobs`。本機跑 `yarn test:integration` 需 **Docker**（無 Docker 只能靠 CI）。
  - **新增 CI job 時步驟順序必須是 `setup-node（取 node）→ corepack enable → setup-node（帶 cache:yarn）`**（照抄現有 job）：`cache: yarn` 會在 corepack 生效前跑 `yarn cache dir`，命中 runner 內建 yarn 1.22 → 遇 `packageManager: yarn@4.x` 直接掛在 setup-node 步（症狀 `current global version of Yarn is 1.22.22`）。
- 增強功能整合的活躍陷阱（讀畫面用 `buf.getRowText` 而非 innerText、勿把 build.target 降回舊瀏覽器等）見 `docs/enhanced-addon.md`「踩坑筆記」A 段。
- 渲染已統一單路徑（兩模式都走 `<Screen>`）見 `docs/easy-reading.md`「render 單軌」。改渲染路徑前先讀它。
- 改渲染/畫面易壞 code 必跑 e2e（見「測試」段強制規範）。
- 每次踩坑如果後續session也會踩，就要寫進md
- 每次commit前都要檢查本次更動是否含新功能，如果有的話要更新README.md新功能列表，新功能定義：以一般使用者角度，所以優化、修bug都不算
- 重大技術升級（框架/建置/依賴的升版或替換，如 React 升版、換 UI 庫、建置/測試工具替換）要同步更新「設定 → 關於」的「重大技術升級」區塊：`src/js/zh_TW_messages.js` 與 `src/js/en_US_messages.js` 的 `about_new_content`（兩語系都要改）
- **依賴／建置鏈已全面現代化（2026-07，見 `docs/build-modernization.md` 掃描表），維持此狀態**：遇坑優先升級／換套件（並提報使用者），不要堆疊 workaround／`!important` 硬調。穩定性與現代化優先於最小改動。
  - **不只升版本，還要換陣營**：實作時發現某依賴的「同類但更主流」替代品已成生態標準（如 webpack+Babel→Vite、jest→Vitest），優先評估整組替換而非原地升版。無維護的小套件（如當年的 base58）優先內聯或換維護中的主流品。評估紀錄寫進 `docs/build-modernization.md`。
  - **目標對象＝主流桌機瀏覽器現代版**（Chrome/Edge/Firefox/Safari，見 `vite.config.js` `build.target`）：**不考慮**手機、舊版、冷門瀏覽器相容性；不為它們加 polyfill/transpile/workaround。
  - `src/js` 核心仍是 fork 來的舊式碼**風格**（prototype 掛載/`var`）：功能正常且有測試守護，**不主動大規模重寫**；觸及該檔時順手現代化即可。deprecated 瀏覽器 API 已清零（2026-07），別再重複掃描。
