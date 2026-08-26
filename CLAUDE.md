# pttchrome — 專案指引

PTT BBS 瀏覽器終端機 client。fork 自 `robertabcd/PttChrome @ dev`，是 term.ptt.cc 的原始碼。
Vite 8（Rolldown 核心）+ React19（bundled）。React plugin 用 `@vitejs/plugin-react`（Vite 8 起 Babel-free，內建 oxc transform）；測試 Vitest 4。UI 元件用 Mantine（暗色預設，`@mantine/core/styles.css` 由 entry.js 載；postcss-preset-mantine，Vite 自動讀 `postcss.config.cjs`）。無任何 CDN runtime 依賴。
**含 JSX 的檔案一律用 `.jsx` 副檔名**（Vite 8 oxc 不吃 `.js` 內的 JSX）。

**核心畫面（文章列表／列表好讀／文章／文章好讀）2026-08 起是純 JS DOM，不用 React**（`src/render/`）：
BBS 畫面每收到一頁就整份重畫，React 在這裡只剩成本（實錄見 `docs/easy-reading.md`「累積頁的每頁 render
成本」）。React 保留給**週邊 UI**：設定頁／右鍵選單／各種 alert／上傳浮層，以及核心畫面裡唯一的葉子島
`ImagePreviewer`。**不要把核心渲染鏈搬回 React，也不要在 `#mainContainer` 上開第二條寫入路徑**
（2026-06 的 detached-node 永久凍結，見 `docs/enhanced-addon.md`）。

## 跑起來（踩雷點，務必照做）
- 啟動 dev server：`yarn start` → http://localhost:8080（= `vite`）
  - **收工前務必關掉**（`yarn kill:dev`）。`.claude/settings.json` 已掛 hook 自動收：Bash/PowerShell 跑到 `yarn start`/`vite` 時記旗標檔 `.claude/.dev-server-running`，Stop／SessionEnd 時才殺——**只殺 Claude 自己開的**，不動使用者手動開的 server。
  - 踩坑：Windows 上 vite 只綁 **IPv6** `[::1]:8080`，舊版 `kill-dev-server.js` 用 `netstat -ano -p tcp`（僅列 IPv4）→ 抓不到 PID、腳本又一律 exit 0 → `yarn kill:dev` **靜默沒殺到**。已改用不帶 `-p` 的 `netstat -ano` 自行篩（純函式守護 `tests/unit/kill_dev_server_parse.test.js`）。
  - 用 **Node**（dev server ≥20.19；`test:unit` 的 jsdom 30 另需 `^22.22.2 || ^24.15.0 || >=26` → 裝最新 v24）跑，**不要用 bun**（bun 的 ws proxy 不轉發 upgrade）。
  - 套件管理用 **yarn**（Yarn v4，`node-modules` linker，設定於 `.yarnrc.yml`）。Node 內建 corepack：`corepack enable` 即可用 `yarn`（版本由 `package.json` 的 `packageManager` 鎖定 4.x）。**勿用 npm**（會產生多餘 `package-lock.json`）。CI 安裝用 `yarn install --immutable`。Yarn v4 不跑自訂 `pre*`/`post*` script；build 產物清理由 Vite `emptyOutDir` 處理（無 `clean` script）。Yarn v4 script 是 portable shell，跨平台支援 `VAR=1 cmd` 行內環境變數（`record:cassette` 用此，勿再引入 cross-env）。
- dev server 內建 `/bbs` WebSocket proxy，改寫 Origin→term.ptt.cc，直連 `wss://ws.ptt.cc/bbs`。開頁即自動連真 PTT，**不需任何中繼**。
- dev 預設站台 `wstelnet://localhost:8080/bbs`（vite.config.mjs `define` → `DEFAULT_SITE`）。
- 詳見 `docs/run-local.md`。

## 架構關鍵點
- entry：根目錄 `index.html`（Vite entry）→ `src/entry.js` → `src/js/main.jsx`。`main.jsx` 先載 Big5 轉碼表(`conv/*.bin`)→ `startApp()` → `new App().connect(DEFAULT_SITE)`。
- **dev build 開站即 `connect()`，與正式版 boot 時序一致**（2026-08-16 移除 Developer Mode modal：它把 connect 延後到使用者按掉為止，導致 deep link 這類「開站當下就要消費 URL」的功能在 dev 下量到的行為不可信）。`process.env.DEVELOPER_MODE` gate 仍在，但只負責掛 `window.__app`／`__i18n` 等 e2e 探針；Vite 下 dev=`vite serve`、prod=`vite build` 自動判定。
- 登入是 telnet BBS 流程：在終端機畫面打字，**程式碼無自動登入**。
- 核心物件（`new App()` in `src/js/pttchrome.jsx`）：
  - `core`(App) ── `view`(TermView, `src/js/term_view.js`) ── `termBuf`(TermBuf, `src/js/term_buf.js`)
  - `EasyReading(core, view, termBuf)`：`src/js/easy_reading.js`，閱讀模式自動翻頁/捲動狀態機。
- DOM：隱藏 input `#t` 收鍵盤（`index.html`、`term_view.js`）；畫面每列渲染進 `#mainContainer`（`src/render/screen.js`，純 JS DOM）。**讀「當前畫面文字」用 `buf.getRowText`，勿讀 `#mainContainer.innerText`**（DOM 慢一幀，理由見 `docs/enhanced-addon.md` 踩坑 A）。
- 純邏輯（無 DOM/網路，易測）：`src/js/string_util.js`(Big5轉碼需全域 `window.lib.*`)、`symbol_table.js`、`event.js`、`ansi_parser.js`。
- 緊耦合 DOM：`term_view.js`、`term_ui.js`、`src/render/`（核心畫面，純 JS）；React 只剩 `pttchrome.jsx` 掛的週邊 UI（`components/`）與 `ImagePreviewer`。
- 偏好雲端同步：`src/js/pref_sync.js`（Google 登入 + Firestore `users/{uid}`，npm modular SDK 走 dynamic `import()` 拆 lazy chunk，未登入零下載；密碼絕不上雲）。儲存層 `src/js/pref_storage.js`。App Check（reCAPTCHA Enterprise）擋 script 直打 API 燒額度；dev 走 debug token（機器 env `APPCHECK_DEBUG_TOKEN`，**不入 repo**）。詳見 `docs/pref-sync-firestore.md`。

## 測試
- **Unit（首選，穩定）**：`yarn test:unit`（Vitest，jsdom env，不連網；設定 `vitest.config.mjs` unit project）。`tests/unit/` 30+ 檔＝
  純邏輯（解析／狀態機／轉碼）＋核心畫面渲染（`tests/unit/helpers/mount_screen.js` 掛 `ScreenController`／
  `buildRow` + 假 TermChar；週邊 React UI 仍用 @testing-library/react）。
  **含 JSX 的測試檔用 `.test.jsx`**。mock/timer 用 `vi.*`（globals 開啟，`describe/test/expect` 免 import）。
  增強功能的逐列判斷一律放 `comment_parse.annotateComment` 並在此回歸守護（e2e 素材不穩，純邏輯先測）。
- **Integration（雲端同步流程）**：`yarn test:integration`（Vitest + 官方 **Firebase Emulator Suite**：真 modular SDK
  + Auth/Firestore emulator + 真 `firestore.rules`，無 mock）。emulator 跑在 **Docker**（pinned `andreysenov/firebase-tools`，內含 firebase-tools+JDK；vitest 在 host 連容器埠），所以**本機跑需 Docker**（不再需本機裝 Java/firebase-tools）。orchestration 見 `scripts/run-integration.mjs`。
  **`vitest.config.mjs` 刻意不 extends `vite.config.mjs`**：app 的 `define` 會把 emulator env 釘成 undefined，integration 混用會全滅。
  `tests/integration/pref_sync.test.js`：啟動還原/他機推播/echo skip/offline 守門/signIn/signOut/憑證去敏；
  e2e 不連 Firebase，同步流程只能在這驗。細節見 `docs/pref-sync-firestore.md`。
- **E2E（連真 PTT）**：`yarn test:e2e`（Playwright）。帳密走 env `PTT_USER`/`PTT_PASS`，無則 guest（名額常滿會 fast-fail）。
  失敗自動截圖/錄影 + console dump。helper：`tests/e2e/helpers/ptt.js`。細節見 `tests/e2e/README.md`。
  - **`live`／`record` project 前置 `preflight`**（`tests/e2e/preflight.setup.js`）：只驗「連得到 PTT」，
    紅了整包 live 不跑，只留一則明確結論（區分「app 沒 boot＝本專案問題」／`connectState=2`＝**PTT 端不可達或維護中**／
    連上但不吐畫面＝維護模式）。**PTT 維護中 live e2e 必紅屬預期**，先開 https://term.ptt.cc 確認站台，別往本專案 code 追。
    逃生門 `E2E_SKIP_PREFLIGHT=1`。訊息純函式守護在 `tests/unit/e2e_preflight_message.test.js`。
  - **連線失敗類情境測在 offline 不在 live**：真 PTT 沒辦法可靠製造「連不上」。用
    `installReplay(page, { neverOpen: true })`（見 `tests/e2e/offline/connect_failure.offline.spec.js`），
    CI 的 offline-e2e job 也跑得到。**`page.routeWebSocket()` 不能用**——它會把 mock 的 WS 在頁面裡開起來，`onConnect` 照跑。
  - **強制規範：整輪 live e2e 只登入一次，沒有例外。** 新 spec 一律用共用 session
    （`tests/e2e/helpers/fixtures.js` 的 `shared` fixture），**不准自己 `page.goto('/')`、
    `login()` 或 `browser.newContext()`**。守護 `tests/unit/e2e_login_budget.test.js`
    （純靜態掃描，違反就紅）。
    那一次開機**就是產品自己的自動登入**（`helpers/ptt.js#autoLoginBoot`：注入 autoLogin
    prefs → 開站 → 完全不按鍵等主功能表），所以「開站自動登入」那條 spec 改成斷言
    `shared.boot`；deep link 改走 hashchange（同一個已登入分頁再貼一次連結，
    `deep_link_entry.js` 明列的第 2 條進入路徑）。流程＝**開機（唯一一次登入，順帶驗
    自動登入）→ deep link → 其餘 spec**。換掉的兩塊覆蓋度（重複登入提示、deep link 的
    登入前暫存排程）都已有 unit 守護，**不要為了它們再加登入**，對照表見
    `tests/e2e/README.md`「登入預算」。
    理由：PTT 有登入頻率限制，開源碼讀得到的下界是「同一分鐘 >3 次 delay／>10 次 reject、
    同一小時 >20 次 delay」（`daemon/utmpd/utmpserver3.c#action_frequently`，完整表在
    `docs/pttbbs-screen-protocol.md` §11.2）。2026-08-25 之前一輪要登入十幾次
    （`easy-reading-list.spec.js` 一支就 9 次），連跑兩輪直接把帳號打進封鎖；
    2026-08-26 一輪 3 次時，為了做一次「乾淨樹 ↔ 有改動」的對照連跑五輪又被鎖一次
    ——**對照實驗一輪就該收手**，別重複這個錯。
  - **被 PTT 鎖住時絕對不可以重跑**：畫面出現「[PTT DDoS/BOT 偵測系統] …已被暫時禁止登入／暫停連線」
    ＝PTT 站方私有的防濫用層（**不在 pttbbs 開源碼**）。封鎖畫面自己寫明：**無法申請手動解除**、
    「**無任何登入行為**之後最多 **12 小時**後會恢復」、「在暫停期間若持續嘗試登入…**將無限期延長**」。
    ⇒ 這是唯一一種「再試一次」嚴格劣於「什麼都不做」的失敗；而且解除計時從**最後一次登入行為**
    重新起算，所以連平常瀏覽用的自動登入都要一起關掉（畫面點名「部份App需要關閉自動登入」）。
    程式已會自己認出來並立閂鎖讓整輪停手（`tests/e2e/helpers/bot_block.js`，實測整輪只送 1 次登入、
    8.6 秒結束）；人這邊只能停手，期間改跑 unit／offline e2e。細節見 `tests/e2e/README.md` 與
    `docs/pttbbs-screen-protocol.md` §11.2。
  - **讀 pttbbs 原始碼搜中文要先轉 Big5**：`3rd_script/pttbbs` 是 Big5 編碼，UTF-8 grep 中文會
    「查無」而不是報錯 ⇒ 很容易誤判成「這行為不在開源碼裡」。用
    `grep -rlF "$(printf '登入太頻繁' | iconv -f UTF-8 -t BIG5)" --include=*.c 3rd_script/pttbbs`，
    讀片段時 `| iconv -f BIG5 -t UTF-8`。
  - **e2e 一律前景跑，不可丟背景（`run_in_background`）**：`.claude/settings.json` 的 **Stop hook 是每個
    assistant turn 結束就觸發**（不是 session 結束），一旦旗標檔在就跑 `kill-dev-server.js` → 把 Playwright
    自己起的 dev server 砍掉。症狀：前幾條綠，之後整批 `page.goto: net::ERR_CONNECTION_REFUSED`，
    看起來像被測 code 大爆炸（實測 95 條有 91 條這樣紅）。前景重跑即全綠。
    - **前景跑也可能中槍**（2026-08 實測：整輪跑到第 4 條時 dev server 被砍）：PostToolUse 的
      `grep -qE '\bvite\b'` 吃的是 tool 的**輸入＋輸出**，所以光是 `cat playwright.config.js`
      這種無害指令就會立起旗標檔，之後任何一次 Stop 都會殺掉 Playwright 的 dev server。
      **跑 e2e 前在同一條指令內先清旗標**：`rm -f .claude/.dev-server-running; yarn test:e2e ...`
      （旗標會在該指令結束後由它自己的 PostToolUse 重新立起，收工照樣清得掉）。
  - **Playwright 升版後（含 Dependabot bump）本機必跑 `yarn playwright install chromium`**：新版綁新 browser binary，
    沒裝會整批 e2e 秒掛（症狀：`browserType.launch: Executable doesn't exist`），與被測 code 無關。CI 每次都重裝所以不受影響。
    - 更早一步的症狀：`yarn test:e2e*` 直接 `command not found: playwright`＝**本機 node_modules 落後 lockfile**
      （Dependabot 升版後沒重裝）。修法 `yarn install --immutable` → `yarn playwright install chromium`，不是 script 壞了。
- **強制規範：改到渲染/畫面這類易壞 code，提交前必跑 e2e**（`yarn test:e2e`，至少 `easy-reading.spec.js`+`enhance.spec.js`）。
  適用 `term_view.js`、`term_ui.js`、`src/render/**`、`src/components/**`、`easy_reading.js`、`pttchrome.jsx` 渲染/切換路徑、`term_buf.js` 渲染相關等。
  理由：unit（jsdom + testing-library）仍**不跑真瀏覽器/真 WebSocket/完整 boot 鏈**，捕捉不到「一進文章即炸」這類 runtime 崩潰
  （例：`pageLines` 用 `JSON` 克隆剝掉 TermChar prototype 方法 → `ch.isStartOfURL is not a function`）。不可只靠 unit + build 綠就交付。
- **離線重放（不連真實 PTT 也能驗依賴特定文章的 case）**：`yarn test:e2e:offline`（stub WebSocket 重放 byte cassette，
  真瀏覽器/真渲染）；Layer2 `tests/unit/replay_fixture.test.js` 用真實 `findPageOverlap` 純 node 重建跨頁去重。
  素材一次性錄製：`yarn record:cassette`（**guest-only**，capture 為 article-scoped 不含帳號）。細節見 `docs/offline-replay-testing.md`。
  - **`yarn test:e2e:offline` 含 `offline-firefox` project**（只跑 `selection.offline.spec.js`）：**本機需先
    `yarn playwright install firefox`**，否則整批 `browserType.launch: Executable doesn't exist`。選取／複製類
    症狀 Chromium 測不出來（見 `docs/enhanced-addon.md` 踩坑 A「終端機的任何祖先都不可有 `user-select: none`」）。
    - **Windows 上 Firefox 的 content sandbox 起不來時，那一批會整包 `browserContext.newPage: Test timeout`**
      （瀏覽器 log 只有 `RenderCompositorSWGL failed mapping default framebuffer`＋`remoteTab is null`＝content
      process 沒生出來，連空白頁都開不了，看起來卻像被測 code 大爆炸）。判準：**還原 code 後照樣紅**＝環境問題。
      修法已寫進 `playwright.config.js` 的 `offline-firefox` project：`launchOptions.env` 加
      `MOZ_DISABLE_CONTENT_SANDBOX=1`（2026-08-15 實測：headless/有頭、關 WebRender、關硬體加速、
      `security.sandbox.content.level=0`、關 fission/e10s 全都無效，只有這個有用）。
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
- docs：`docs/run-local.md`(啟動)、`docs/pttchrome-research.md`(來源＋Origin 白名單根本約束)、`docs/origin-rewrite-extension.md`(部署 Origin 改寫)、`docs/enhanced-addon.md`(黑名單/樓層/推文合併/自動登入整合＋活躍踩坑)、`docs/easy-reading.md`(文章好讀模式：settle 狀態機/render 單軌/functionMode)、`docs/easy-reading-list.md`(列表好讀模式 v5 架構：合約/狀態機/關鍵不變量；改 list_session.js/command_queue.js/term_buf settle 前先讀)、`docs/easy-reading-list-research.md`(該功能為何結構性地難＋App 式重設計選項；決定方向前先讀)、`docs/pttbbs-screen-protocol.md`(PTT server 畫面協定不變量，pttbbs source 逆向；畫面偵測規則依據)、`docs/offline-replay-testing.md`(cassette 錄製/重放/隱私)、`docs/pref-sync-firestore.md`(偏好雲端同步＋Firebase 平台踩坑)、`docs/media-preview-addons.md`(第三方預覽套件的圖床 roster／referer 規則對照)、`docs/ptt-official-app-research.md`(官方組織專案盤點＋推文終端格式交叉驗證)、`docs/merge-caption-ai-assist.md`(裝置端 AI 輔助配對：已實作 opt-in＋實測數據；AI 設定總開關與分頁見 `docs/enhanced-addon.md`「設定」節)、`docs/build-modernization.md`(依賴／工具選型基準；動建置鏈或評估換依賴前先讀)、`docs/imgur-latency-research.md`(imgur 台灣連線 stall 的根因量測＋Cloudflare Worker 代理實測；碰圖片載入效能前先讀，勿重做量測)、`docs/mouse.md`(滑鼠總體設計：pref schema／區域決策表／gating 表／點擊優先權／左側退出提示帶的座標契約；動 mouse_regions.js 或任何滑鼠入口前先讀)、`docs/deep-link.md`(外部連結→AID 跳轉：URL 合約／登入前暫存排程／BroadcastChannel 交接／PWA launch_handler／瀏覽器硬限制；動 deep_link*.js 前先讀)、`docs/image-upload.md`(圖片上傳到 urusai 圖床：API 合約／CORS 實測／插入位置決策表／浮層與滑鼠讓位規則；動 image_upload*.js 或上傳浮層前先讀)、`docs/long-push.md`(長推文一鍵發送：位移模型／畫面決策表／不變量（不送 \f、段末全形留 1 byte、非 Big5 必濾）；動 long_push*.js 前先讀，PTT 端協定見 `docs/pttbbs-screen-protocol.md` §11.3)。
- 待辦交接：`docs/handoff/`，一個 `.md` = 一個尚未完成的功能/修復；挑一個做完即**刪掉該 md**。詳見 `docs/handoff/README.md`。
- git：**不開新功能分支**，直接在現有分支（`dev`）修改與 commit。
- 不主動 commit
- **換行一律 LF**，由 `.gitattributes`（`* text=auto eol=lf`）強制，不依賴各機器的
  `core.autocrlf`。2026-08-17 已一次性 `git add --renormalize .`（commit `76afcc6`），
  在那之前有 7 個 fork 來的 `src/js` 檔以 CRLF 儲存 ⇒ 工具寫 LF 就整檔被當成全改
  （改 10 行的 `term_view.js` 噴出 3904 行 diff）。勿再把任何檔案轉回 CRLF。
  - **原始碼裡不可以放真正的 NUL 位元組**（要用就寫跳脫序列）：git 看到一個 NUL 就把
    整份檔案當二進位 ⇒ `text=auto` 對它失效、diff 退化成「Binary files differ」。
    `caption_ai_logic.js` 的 `spanKey` 踩過，已改成跳脫序列並就地註解。
  - 純格式 commit 記進 `.git-blame-ignore-revs`（GitHub blame 自動讀；本機要跑一次
    `git config blame.ignoreRevsFile .git-blame-ignore-revs`）。
  - 通則：**commit 前看 `git show --stat`／`git diff --stat` 的行數是否與實際改動相稱**。
- **push 後必查 CI**：每次 push 完都要確認 GitHub Actions（`Deploy to GitHub Pages` workflow，含 unit／integration／offline-e2e）有 pass，不能 push 完就收工。
  - **一律用 `yarn ci:status`**（`scripts/ci-status.mjs`，需 env `GH_TOKEN`）：等該 commit 的所有 run 跑完 → 印每個 run 結果 → 失敗時自動挖出失敗 job/step 並印 log 尾巴。
    參數：`--branch <b>`／`--sha <sha>`／`--no-wait`（只看當下）／`--rerun-failed`（僅在它判定為已知 flaky 時才會送出重跑）。
    exit code：`0` 全綠、`1` 有失敗、`2` 工具或設定問題（**刻意分三種**，「查不到」不可被當成「沒問題」）。
    **「只查到 `Push on dev`（`event: dynamic`）」不等於全綠**：那是 CodeQL default setup 的 run，
    本專案的 `Deploy to GitHub Pages` 可能只是還沒被建立（2026-08-27 實測 push 事件到 run 建立
    延遲了 **11 分鐘**）。舊版會因為 CodeQL 那顆已完成就印「CI 全綠」exit 0 —— 已改成必須看到
    本專案的 workflow run（`isProjectRun`，排除 `dynamic/*`）才判定，等不到就 exit 2；CI 逾時
    也改成從「本專案 run 出現」那刻起算。守護 `tests/unit/ci_status_parse.test.js`。
    `--sha` 吃短 sha／`HEAD`／tag（腳本會自己 `git rev-parse` 展開；GitHub runs API 的 `head_sha` **只吃完整 40 字元**，
    直接送短 sha 會回空陣列＝假的「查無 run」）。剛 push 完 run 尚未建立時會寬限等 90s 才判定查無（2026-08 補，三坑都實際踩過）。
  - **本機沒有 `jq`，也沒有 `gh` CLI**。**禁止**再用 `curl … | jq` 或 `gh run …` 拼輪詢迴圈：jq 不存在 → 解析永遠是空字串 → 判不出「跑完了沒」而空轉到逾時，錯誤又常被 `2>/dev/null` 吞掉，看起來像 CI 卡住（實際早就綠了）。此坑已重複踩多次，故改用 Node 腳本（Node 是專案硬需求，Bash／PowerShell 兩種工具都跑得動）。純函式守護在 `tests/unit/ci_status_parse.test.js`。
  - **`ci:status` 收尾禁用 `process.exit()`**：Windows 上 Node 內建 fetch（undici）的 keep-alive socket 還開著時強制退出，
    會撞 libuv `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94` → 進程回 **`exit=127`**，
    把刻意分的 0/1/2 整個蓋掉（實例：短 sha 查不到時本該回 2，卻回 127）。已改成設 `process.exitCode` + 主動收連線池，勿改回去。
  - **禁止把 `yarn ci:status` 接管線**（`| tail`／`| grep`／`| head`）：shell 的管線 exit code 取自**最後一個**指令，`tail` 幾乎永遠回 0 → 上面刻意分的三種 exit code 被整個吃掉，紅的 CI 會被讀成綠的（實例：deploy job failure 卻回報 `exit=0`）。而且 `head -N` 會提早關閉管線送出 SIGPIPE，可能把還在等 run 的 `ci:status` 直接砍掉。**一律 `yarn ci:status ... > <file> 2>&1; echo "EXIT=$?"` 再讀檔**。同理適用任何「exit code 就是結論」的指令（`yarn test:unit`、`playwright test`）。
  - **deploy job 偶發 `actions/deploy-pages@v5` timeout**：Pages 服務端卡在 `deployment_in_progress`，輪詢約 76s 後 `##[error]Timeout reached, aborting!` 並取消部署 → **測試/build 全綠但 run 紅、站台停在舊 commit**。屬 Pages 基礎設施問題，非本專案 code。判準：該 run 只有 `deploy` 一個 job 紅、`test-*`／`build` 全綠。處置：重跑失敗 job（`POST /repos/{o}/{r}/actions/runs/{id}/rerun-failed-jobs`；`ci:status --rerun-failed` 目前只認 integration flaky，不會自動重跑它）。**事後必須確認 `github-pages` 環境最新一筆 deployment 的 sha 是本次 commit 且 state=success**，否則站台仍是舊版。
  - **integration job（Firebase Emulator in Docker）偶發 timeout** 是已知 flaky（CI 冷啟動拉 image + 首次 Firestore 寫入超過 poll deadline，症狀 `waitForCloud timeout: upload`）。緩解手段已用盡（`INTEGRATION_TIMEOUT_MS`、CI vitest `retry: 2`、`scripts/run-integration.mjs` 的 `waitHttp` 就緒輪詢）→ 確認非真錯後用 `yarn ci:status --rerun-failed`。本機跑 `yarn test:integration` 需 **Docker**（無 Docker 只能靠 CI）。
  - **GITHUB_TOKEN 造成的事件不會再觸發 workflow**（GitHub 防遞迴，例外只有 `workflow_dispatch`／`repository_dispatch`）：任何在 Actions 內做 merge／push 的步驟若用 `secrets.GITHUB_TOKEN`，產生的 push **不會**觸發 `deploy.yml` 的 `on: push` → 站台靜默停在舊 commit（實例 PR #16）。`dependabot-auto-merge.yml` 因此改用 GitHub App installation token（secret `AUTOMERGE_APP_CLIENT_ID`／`AUTOMERGE_APP_PRIVATE_KEY`），勿改回 GITHUB_TOKEN。查驗方式：merge commit 的 SHA 上要看得到 `Deploy to GitHub Pages` run（只有 `Push on dev` 那個 `dynamic` run 是 CodeQL default setup，不算）。
  - **新增 CI job 時步驟順序必須是 `setup-node（取 node）→ corepack enable → setup-node（帶 cache:yarn）`**（照抄現有 job）：`cache: yarn` 會在 corepack 生效前跑 `yarn cache dir`，命中 runner 內建 yarn 1.22 → 遇 `packageManager: yarn@4.x` 直接掛在 setup-node 步（症狀 `current global version of Yarn is 1.22.22`）。
- 增強功能整合的活躍陷阱（讀畫面用 `buf.getRowText` 而非 innerText、勿把 build.target 降回舊瀏覽器等）見 `docs/enhanced-addon.md`「踩坑筆記」A 段。
- 渲染已統一單路徑（兩模式都走 `ScreenController`）見 `docs/easy-reading.md`「render 單軌」。改渲染路徑前先讀它。
- **核心渲染鏈的 DOM 是外部契約，由整份 golden 快照守**：`tests/unit/fixtures/screen_golden/*.html`
  ＋`tests/unit/render_dom_equivalence.test.js`。`data-type="bbsline"`／`data-row`（選取複製反查）、
  `.wpadding`（`fixedResize` 直接掃 DOM 改寬度）、`data-pusher-col`（滑鼠防誤觸）、`data-list-author/-title`
  （右鍵加黑名單）這些消費端都在 unit 測不到的地方，漏一個就靜默壞掉。**刻意**要改渲染輸出時才
  `UPDATE_GOLDEN=1 yarn test:unit render_dom_equivalence`，並逐行看 diff。
- **dirty-row 逐列 patch 的守門在 `src/js/screen_annotations.js#annotationsAreRowIndependent`，不在 `term_view`**：
  `term_view` 只回報事實（`enhance.changedRows`＝server 這一幀寫了哪幾列、`enhance.rowIdentityStable`＝這批列是快照），
  「這組 enhance 能不能只重畫 dirty 列」由標註端決定（跨列耦合全長在 `computeAnnotations` 裡）。**在
  `computeAnnotations` 新增任何跨列邏輯時必須同步該函式**，否則會靜默畫出上一幀（症狀：樓號位移、
  推文合併塊錯位）。細節與停用開關見 `docs/easy-reading.md`「render 單軌」第 3 層。
  連帶：`TermChar.needUpdate` 已去 sticky（`term_buf.updateCharAttr` 消費完就清），`lineChangeds` 的唯一
  清除點仍是 `term_view.redraw` —— 別在 `updateCharAttr` 裡順手清它，那會廢掉
  `easy_reading._forceRepaint` / `list_session._forceRedraw`。
- **純 JS 渲染鏈要自己收生命週期**：列被換掉／整份重建時，該列建立的延遲載入佔位盒
  （IntersectionObserver + ResizeObserver + `ImagePreviewer` 的 React root）必須 `destroy()`。
  入口只有 `render/screen.js#disposeNode` 一處，守護 `tests/unit/render_dispose.test.js`。
- **`pttchrome.modalShown` 是推導值，禁止直接賦值**：它是終端機鍵盤／焦點的總閘門，一律走
  `App.setModalOpen(source, open)`（具名來源集合）。React 側由 `components/ContextMenu/index.jsx`
  的 `useEffect` 依 render state 推導後呼叫。歷史坑：手動兩邊維護時，只要關閉路徑中途 throw
  就會「畫面上有對話框、app 卻以為沒有」→ keyup/mouseover/mouseup 永久把焦點搶回隱藏 input `#t`，
  整頁只能重整才能打字。守護：`tests/unit/modal_shown_sources.test.js`、`tests/e2e/offline/connect_failure.offline.spec.js`。
  界線：`showsInputHelper`／`showsLiveArticleHelper` 刻意**不算** modal（終端機仍收鍵盤），勿順手納入。
- **`view.conn` 只在 `App.onConnect` 被設**：連線從未成功時是 `undefined`。送資料一律走
  `view._send()`／`_convSend()`（內含 `if (this.conn)`），禁止直接 `this.view.conn.send(...)`。
- 改渲染/畫面易壞 code 必跑 e2e（見「測試」段強制規範）。
- 每次踩坑如果後續session也會踩，就要寫進md
- 每次commit前都要檢查本次更動是否含新功能，如果有的話要更新README.md新功能列表，新功能定義：以一般使用者角度，所以優化、修bug都不算
- 重大技術升級（框架/建置/依賴的升版或替換，如 React 升版、換 UI 庫、建置/測試工具替換）要同步更新「設定 → 關於」的「重大技術升級」區塊：`src/js/zh_TW_messages.js` 與 `src/js/en_US_messages.js` 的 `about_new_content`（兩語系都要改）
- **依賴／建置鏈已全面現代化（2026-07，見 `docs/build-modernization.md` 掃描表），維持此狀態**：遇坑優先升級／換套件（並提報使用者），不要堆疊 workaround／`!important` 硬調。穩定性與現代化優先於最小改動。
  - **不只升版本，還要換陣營**：實作時發現某依賴的「同類但更主流」替代品已成生態標準（如 webpack+Babel→Vite、jest→Vitest），優先評估整組替換而非原地升版。無維護的小套件（如當年的 base58）優先內聯或換維護中的主流品。評估紀錄寫進 `docs/build-modernization.md`。
  - **目標對象＝主流桌機瀏覽器現代版**（Chrome/Edge/Firefox/Safari，見 `vite.config.mjs` `build.target`）：**不考慮**手機、舊版、冷門瀏覽器相容性；不為它們加 polyfill/transpile/workaround。
  - `src/js` 核心仍是 fork 來的舊式碼**風格**（prototype 掛載/`var`）：功能正常且有測試守護，**不主動大規模重寫**；觸及該檔時順手現代化即可。deprecated 瀏覽器 API 已清零（2026-07），別再重複掃描。
