# pttchrome — 專案指引

PTT BBS 瀏覽器終端機 client。fork 自 `robertabcd/PttChrome @ dev`，是 term.ptt.cc 的原始碼。
Vite 8（Rolldown 核心）+ React19（bundled）。React plugin 用 `@vitejs/plugin-react`（Vite 8 起 Babel-free，內建 oxc transform）；測試 Vitest 5。UI 元件用 Mantine（暗色預設，`@mantine/core/styles.css` 由 entry.js 載；postcss-preset-mantine，Vite 自動讀 `postcss.config.cjs`）。無任何 CDN runtime 依賴。
**含 JSX 的檔案一律用 `.jsx` 副檔名**（Vite 8 oxc 不吃 `.js` 內的 JSX）。

**核心畫面（文章列表／列表好讀／文章／文章好讀）2026-08 起是純 JS DOM，不用 React**（`src/render/`）：
BBS 畫面每收到一頁就整份重畫，React 在這裡只剩成本（實錄見 `docs/easy-reading.md`「累積頁的每頁 render
成本」）。React 保留給**週邊 UI**：設定頁／右鍵選單／各種 alert／上傳浮層，以及核心畫面裡唯一的葉子島
`ImagePreviewer`。**不要把核心渲染鏈搬回 React，也不要在 `#mainContainer` 上開第二條寫入路徑**
（2026-06 的 detached-node 永久凍結，見 `docs/enhanced-addon.md`）。

## 跑起來（踩雷點，務必照做）
- 啟動 dev server：`yarn start` → http://localhost:8080（= `vite`）
  - **收工前務必手動關掉：`yarn kill:dev`**。這是規範不是自動化——**只要這個 session 起過 dev server（`yarn start`），結束前就要自己跑一次**，別指望 hook。
    - `.claude/settings.json` 的 hook 只在 SessionEnd 跑 `kill-dev-server.js --own`：只殺本 checkout 的 vite（PID 由 `vite.config.mjs` 寫 pidfile），不碰別的 session／worktree 的 server。不要加 Stop hook：它每個 assistant turn 結束都會觸發，會砍掉 Playwright 自己起的 dev server，讓 e2e 整批 `ERR_CONNECTION_REFUSED`。
  - Windows 上 vite 只綁 IPv6 `[::1]:8080`，所以 `kill-dev-server.js` 用不帶 `-p` 的 `netstat -ano` 篩 PID（守護 `tests/unit/kill_dev_server_parse.test.js`）。
  - 用 **Node**（dev server ≥20.19；Vitest 5 需 ≥22 → 裝最新 v24）跑，**不要用 bun**（bun 的 ws proxy 不轉發 upgrade）。
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
- **Unit（首選，穩定）**：`yarn test:unit`（Vitest，不連網；設定 `vitest.config.mjs`）＝兩個 project：
  `unit`（node env＋`threads` pool，純邏輯／解析／靜態掃描）與 `unit-browser`（**Vitest Browser Mode，真 headless
  Chromium**，DOM／渲染／React 週邊 UI）。需要 DOM 的檔案**第一行**寫 `// @unit-env browser`（純邏輯檔別寫）；
  **本機需先 `yarn playwright install chromium`**（e2e 本來就要）。守護 `tests/unit/unit_environment.test.js`。
  - browser 檔**不能用 node API**（`fs`／`path`／`Buffer`／`require`／`__dirname`／`global`）：fixture 用 JSON
    或 `?raw` import，寫檔用 `vitest/browser` 的 `commands`（`render_dom_equivalence.test.js` 範例），`global`→`globalThis`。
  - 真瀏覽器的唯讀全域（`navigator.credentials`、`window`）不能賦值：用 `Object.defineProperty`／`vi.spyOn`
    （`tests/unit/helpers/credential_api.js`）。版面是真的：要 `scrollTop` 就給元素真的高度＋overflow，不准偽造
    `scrollHeight`／`offsetTop`。`IntersectionObserver` 是真的且非同步，要同步控制就 stub 或注入假的。
  - `vi.resetModules()` 在 browser 無效（原生 ESM 不重跑模組）：有 page-lifetime 快取的模組改 export 測試用
    reset 函式（`auto_login.js#_resetSessionCredentialForTest`）。**jsdom／happy-dom 已移除且禁止帶回**（DOM 模擬跟真
    瀏覽器不一致時測試全綠、實際卻壞；`yarn debug:screens` 也改純 node）。評估與實測見 `docs/build-modernization.md`。
  `tests/unit/` ＝純邏輯（解析／狀態機／轉碼）＋核心畫面渲染（`tests/unit/helpers/mount_screen.js` 掛
  `ScreenController`／`buildRow` + 假 TermChar；週邊 React UI 仍用 @testing-library/react）。
  **含 JSX 的測試檔用 `.test.jsx`**。mock/timer 用 `vi.*`（globals 開啟，`describe/test/expect` 免 import）。
  **模組載入一律放檔案層級，不准在 test body 裡 `await import('../../src/...')`**：那會把整條依賴鏈的
  冷載入算進該 case 的 5000ms testTimeout ⇒ 機器忙時偶發紅（`Test timed out in 5000ms`），單獨重跑又綠，
  而且紅的是一支跟載入無關的測試名稱。靜態守護 `tests/unit/module_load_cost.test.js`。
  增強功能的逐列判斷一律放 `comment_parse.annotateComment` 並在此回歸守護（e2e 素材不穩，純邏輯先測）。
- **Integration（雲端同步流程）**：`yarn test:integration`（Vitest + 官方 **Firebase Emulator Suite**：真 modular SDK
  + Auth/Firestore emulator + 真 `firestore.rules`，無 mock）。emulator 跑在 **Docker**（pinned `andreysenov/firebase-tools`，內含 firebase-tools+JDK；vitest 在 host 連容器埠），所以**本機跑需 Docker**（不再需本機裝 Java/firebase-tools）。orchestration 見 `scripts/run-integration.mjs`。
  **`vitest.config.mjs` 刻意不 extends `vite.config.mjs`**：app 的 `define` 會把 emulator env 釘成 undefined，integration 混用會全滅。
  `tests/integration/pref_sync.test.js`：啟動還原/他機推播/echo skip/offline 守門/signIn/signOut/憑證去敏；
  e2e 不連 Firebase，同步流程只能在這驗。細節見 `docs/pref-sync-firestore.md`。
- **E2E（連真 PTT）**：`yarn test:e2e`（Playwright）。帳密走 env `PTT_USER`/`PTT_PASS`，無則 guest（名額常滿會 fast-fail）。
  失敗自動截圖/錄影 + console dump。helper：`tests/e2e/helpers/ptt.js`。細節見 `tests/e2e/README.md`。
  - **live 只有核心（2026-10 定案）**：`tests/e2e/core.spec.js` ＝登入／主選單・文章列表・文章不跑版不亂碼
    （`helpers/screen_sanity.js`：DOM＝buf、格線、Big5 可解、無水平溢出，**不比對畫面內容**）／開圖。
    其餘功能一律 offline；需要新的 PTT 往返就錄 scenario 卷（`yarn record:scenarios`，一次登入，
    見 `docs/offline-replay-testing.md`「scenario 卷」）。守護 `e2e_login_budget`（live 只准 `core.spec.js`）。
    每輪 live 自動存 DebugRecorder 錄製檔到 `tests/e2e/__recordings__/`（gitignored）：live 紅在新版面／
    新協定時，拿它到 offline 重現修綠，live 只再跑一輪確認。`yarn triage:recordings`（零登入）把錄製檔
    逐幀過 `screen_sanity`，紅幀自動切成 `cassettes/pending/`（gitignored）＋清單，全綠不產出。
  - **live／record 跑的期間不准改 `src/`**：Vite HMR 整頁重載 ⇒ 產品自動登入**再登一次**（吃登入額度）。
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
    那一次開機**就是產品自己的自動登入**（`helpers/ptt.js#autoLoginBoot`），核心 spec 的登入測項
    斷言的就是它（`shared.boot`）。重複登入提示、deep link 的登入前暫存排程只由 unit 守，
    **不要為了它們再加登入**。record（`record:cassette`／`record:scenarios`）每跑一次也是一次登入。
    理由：PTT 有登入頻率限制，開源碼讀得到的下界是「同一分鐘 >3 次 delay／>10 次 reject、
    同一小時 >20 次 delay」（`daemon/utmpd/utmpserver3.c#action_frequently`，完整表在
    `docs/pttbbs-screen-protocol.md` §11.2），多輪連跑就會把帳號打進封鎖。
    同理，「乾淨樹 ↔ 有改動」的對照實驗只跑一輪。
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
  - **live／record 不准「按鍵 → 固定睡 → 判一次」**：回應晚到就誤判、多按一個鍵（實錄：進板畫面的
    空白鍵多按一次把文章打開）。按鍵用 `helpers/ptt.js#pressAndSettle`（等 buf 真的變了再 settle），
    判 pass 畫面用產品的 `buf.isPassScreenNow()`；`End` 含置底文，選文開文前就從列表挑。
    詳見 `tests/e2e/README.md`「live／record 的判準與等待」。
  - **`page.goto: net::ERR_CONNECTION_REFUSED` 大面積紅 ＝ dev server 被砍，不是被測 code 壞**：
    判準是「前面若干條全綠、之後**整批**同一個錯、每條耗時一致」。先確認 8080 還活著，
    別往被測 code 追。
  - **offline e2e 多 worker 並行、live 恆 1 worker**（`tests/e2e/workers_policy.js`：只有這輪全是
    `offline*` project 才放開，本機 `50%` 核心／CI 4、逆境 job 8；live 多一個 worker＝多一次登入）。本機整套 offline
    約 2.5 分、adverse 約 3 分，前景跑即可。offline spec 之間**不准有相依性**（`fullyParallel: true`，
    同檔的 test 也會被拆到不同 worker）：不准 `describe.serial`／`beforeAll` 共用 page、不准寫共用檔或佔固定 port。
  - **e2e 整批秒掛、零 AssertionError ＝本機環境問題，不是被測 code 壞**（Playwright 升版後沒裝瀏覽器、
    Windows 上 `STATUS_DLL_INIT_FAILED`／Firefox `spawn UNKNOWN`／content sandbox 等）。症狀→處置對照表見
    `docs/local-env-troubleshooting.md`，先查它再動 code。
- **由瀏覽器／OS 決定形狀或順序的輸入**（右鍵、觸控長按、滾輪、捲動、拖放、剪貼簿、IME 組字、
  焦點、全螢幕、圖片 load/error），e2e 不准手捏事件（`new XxxEvent`＋`dispatchEvent`、直呼 `onKeyDown`），
  一律走 `tests/e2e/helpers/real_input.js`（`page.mouse`／`keyboard` 或 CDP `Input.*`）。unit 可以手捏測分支，
  但要有 `// real-input: tests/e2e/...` 指向真輸入 e2e。守護 `tests/unit/e2e_real_input.test.js`；
  對照表、豁免與量到的瀏覽器事實見 `tests/e2e/README.md`「真輸入」。改成真輸入後變紅，先懷疑原測試在說謊。
- **改到渲染/畫面這類易壞 code，提交前必跑 e2e**（`yarn test:e2e:offline`＋`:adverse`，再跑 live 核心 `yarn test:e2e` 一輪）。
  適用 `term_view.js`、`term_ui.js`、`src/render/**`、`src/components/**`、`easy_reading.js`、`pttchrome.jsx` 渲染/切換路徑、`term_buf.js` 渲染相關等。
  理由：unit（unit-browser 雖是真 Chromium，但只掛單一元件）仍**不跑真 WebSocket/完整 boot 鏈**，捕捉不到「一進文章即炸」這類 runtime 崩潰
  （例：`pageLines` 用 `JSON` 克隆剝掉 TermChar prototype 方法 → `ch.isStartOfURL is not a function`）。不可只靠 unit + build 綠就交付。
- **離線重放（不連真實 PTT 也能驗依賴特定文章的 case）**：`yarn test:e2e:offline`（stub WebSocket 重放 byte cassette，
  真瀏覽器/真渲染）；Layer2 `tests/unit/replay_fixture.test.js` 用真實 `findPageOverlap` 純 node 重建跨頁去重。
  - **offline e2e 不接受 flaky：不是時序問題，是斷言不夠嚴謹。** 量元素座標一律走
    `tests/e2e/helpers/layout.js`（`waitPreviewsSettled` / `waitRectStable` / `assertElementUnder` /
    `stableCommentRow` / `plainLeftEdge`），**禁止**用 `waitForTimeout` 當版面等待。理由：行內預覽是
    延遲載入的佔位盒，`scrollIntoView` 本身會觸發載入 ⇒ 捲完立刻量的 rect 之後還會位移，點下去落在
    別的元素上，斷言退化成沉默的 0（50fa35c 的現場）。靜態守護 `tests/unit/e2e_layout_settle.test.js`。
  - **本機預設情境是「圖片秒回」，測不出上面那類 bug。** 改渲染／版面 code 時除 `yarn test:e2e:offline`
    外加跑 **`yarn test:e2e:offline:adverse`**（圖片改成 慢 5.2s／404／301／混合四桶，決定性）。
    CI 有對應的平行 job `test-e2e-offline-adverse`。情境表與 CONFIRMED 事實（產品端**沒有**圖片載入
    timeout；Chromium 不跟隨 `route.fulfill` 的 301）見 `docs/offline-replay-testing.md`。
    該 script（`scripts/run-adverse-e2e.mjs`）**exit code 分三種：0 綠／1 真失敗／2 環境問題**。
  素材一次性錄製：`yarn record:cassette`（**guest-only**，capture 為 article-scoped 不含帳號）。細節見 `docs/offline-replay-testing.md`。
  - **`yarn test:e2e:offline` 含 `offline-firefox` project**（只跑 `selection.offline.spec.js`）：**本機需先
    `yarn playwright install firefox`**，否則整批 `browserType.launch: Executable doesn't exist`。選取／複製類
    症狀 Chromium 測不出來（見 `docs/enhanced-addon.md` 踩坑 A「終端機的任何祖先都不可有 `user-select: none`」）。
- **改 code 要連帶補測試，不准「只改不測」。**
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
- **系統／瀏覽器的原生行為不准模擬，一律接入使用**：觸控板手勢、返回導航、捲動慣性、
  原生選單／對話框、輸入法組字、剪貼簿、拖放、全螢幕、通知這類由 OS 或瀏覽器 chrome
  負責的行為，**先找官方入口接上去**（讓它照跑，我們只在結果發生時接住），**不准**用
  頁面事件自己重寫一套。
  理由（2026-09 觸控板左滑的實錄，完整分析在 `docs/mouse.md`「手勢與瀏覽器返回」）：
  1. **視覺指示畫不出來** —— 返回箭頭是瀏覽器 chrome 畫的，四家樣式各不同，自己畫只會
     多出第五種；
  2. **關鍵輸入資訊頁面拿不到** —— DOM 的 `WheelEvent` 不含 macOS `NSEvent` 的
     `phase`／`momentumPhase`，分不出「手指還在／放開了／慣性尾巴」⇒「放手才生效」
     「半途放手取消」原理上做不到，不是調參數能解的；
  3. **會違反使用者的系統設定** —— 系統層把手勢關掉或改成三指時，模擬版照樣有
     `deltaX` ⇒ 做出使用者已經關掉的行為；原生版自動尊重。
  接入時通常要**同時拆掉自己擋原生的那道牆**（該次是 CSS `overscroll-behavior`，且必須
  **拆軸**——兩軸簡寫的 `contain`／`none` 會連瀏覽器導航一起停用）。這種「不要擋」的一行
  最容易被下一個人順手改回去，**一律補靜態守護測試**（範例
  `tests/unit/native_gesture_css.test.js`）。
- **PTT 邏輯不准猜**：PTT 行為邏輯一律先讀 `3rd_script/pttbbs` 原始碼找出真實實作，禁止自行猜測或從錄製素材/畫面觀察反推規則；素材只用來驗證對 code 的理解是否有誤。詳見 `docs/pttbbs-screen-protocol.md` 開頭「研究方法規範」。
- 編碼：PTT 是 Big5，內部轉 Unicode（`string_util.js` 的 `b2u`/`u2b`，查 `window.lib.b2uArray/u2bArray`）。
- 改 `src/components/**` 會被 husky + lint-staged 跑 prettier。
- docs：`docs/run-local.md`(啟動)、`docs/pttchrome-research.md`(來源＋Origin 白名單根本約束)、`docs/origin-rewrite-extension.md`(部署 Origin 改寫)、`docs/enhanced-addon.md`(黑名單/樓層/推文合併/自動登入整合＋活躍踩坑)、`docs/easy-reading.md`(文章好讀模式：settle 狀態機/render 單軌/functionMode)、`docs/easy-reading-list.md`(列表好讀模式 v5 架構：合約/狀態機/關鍵不變量；改 list_session.js/command_queue.js/term_buf settle 前先讀)、`docs/easy-reading-list-research.md`(該功能為何結構性地難＋App 式重設計選項；決定方向前先讀)、`docs/pttbbs-screen-protocol.md`(PTT server 畫面協定不變量，pttbbs source 逆向；畫面偵測規則依據)、`docs/offline-replay-testing.md`(cassette 錄製/重放/隱私)、`docs/pref-sync-firestore.md`(偏好雲端同步＋Firebase 平台踩坑)、`docs/media-preview-addons.md`(第三方預覽套件的圖床 roster／referer 規則對照)、`docs/ptt-official-app-research.md`(官方組織專案盤點＋推文終端格式交叉驗證)、`docs/merge-caption-ai-assist.md`(裝置端 AI 輔助配對：已實作 opt-in＋實測數據；AI 設定總開關與分頁見 `docs/enhanced-addon.md`「設定」節)、`docs/build-modernization.md`(依賴／工具選型基準；動建置鏈或評估換依賴前先讀)、`docs/imgur-latency-research.md`(imgur／twimg／catbox 台灣連線慢的根因量測＋Cloudflare Worker 代理實測；碰圖片載入效能或圖片代理前先讀，勿重做量測)、`docs/mouse.md`(滑鼠總體設計：pref schema／區域決策表／gating 表／點擊優先權／左側退出提示帶的座標契約；動 mouse_regions.js 或任何滑鼠入口前先讀)、`docs/deep-link.md`(外部連結→AID 跳轉：URL 合約／登入前暫存排程／BroadcastChannel 交接／PWA launch_handler／瀏覽器硬限制；動 deep_link*.js 前先讀)、`docs/image-upload.md`(圖片上傳到 urusai 圖床：API 合約／CORS 實測／插入位置決策表／浮層與滑鼠讓位規則；動 image_upload*.js 或上傳浮層前先讀)、`docs/board-list-smooth-scroll.md`(看板列表平滑捲動：範圍指紋／為何抓頁不用 PgUp,PgDn／兩個列表 session 的所有權層；動 board_list*.js 或 term_view 的看板列表分支前先讀)、`docs/long-push.md`(長推文一鍵發送：位移模型／畫面決策表／不變量（不送 \f、段末全形留 1 byte、非 Big5 必濾）；動 long_push*.js 前先讀，PTT 端協定見 `docs/pttbbs-screen-protocol.md` §11.3)、`docs/terminal-size.md`(終端機大小兩模式／NAWS 與 server 端 clamp／欄數恆 80 與水平置中的 LOCKED 條款；動 term_size.js、setTermFontSize 或任何「畫面靠左/置中」的念頭前先讀)、`docs/android-app.md`(Android APK：WebView 殼＋前景服務本機 proxy＋原生密碼管理員 bridge／不寫回 prefs／origin 與 token 鎖／assetlinks／建置發佈；動 android/**、android_bridge.js、credential_store.js、boot_site.js 前先讀)、`docs/ptt-announcement-bot.md`(PttCurrent 公告→issue→Claude routine 的 Cloudflare Worker cron bot；動 proxy/ptt-announcements-worker 或 scripts/ptt-announcements.mjs 前先讀)、`docs/mobile.md`(手機版面：分階段狀態／runtime 覆寫不寫回 prefs／`#t` inputmode／底部工具列送鍵規則與黏滯 Ctrl；動 mobile_layout.js、MobileToolbar 或任何觸控相關前先讀)、`docs/article-search.md`(搜尋彈窗：PTT 輸入記憶被跳號污染的根因／攔截決策表／prompt 指紋／送出兩條路；動 article_search.js、search_history.js、SearchModal 前先讀)、`docs/android-e2e.md`(真 Android Chrome 模擬器 e2e：`yarn test:e2e:android`／exit 0/1/2／本機 WHPX＋SDK 設定／模擬器踩坑表；寫 android spec 或動 tests/e2e/android 前先讀)。
- **使用者給 debug 錄製檔（`ptt-debug-*.json`）一律先用 `yarn debug:screens`**（`scripts/debug-screens.mjs`）：
  不帶時間點＝時間軸（send 解成可讀字串＋log，`--from/--to` 截段）；帶時間點（ms）＝印出那一刻的**畫面**
  （app 自己的 TermBuf/AnsiParser 經 Vite ssrLoadModule 載入，列數取 `cassette.rows`）。**不要另寫迷你 VT**：
  2026-09-24 臨時手寫的版本把 `351661` 解成 `2026661`、多出 `116;18H…` 殘渣，看起來像 PTT 送的。
  錄製是中途開始的，第一次整頁重繪前的畫面不完整。守護 `tests/unit/debug_screens.test.js`。
- 待辦交接：`docs/handoff/`，一個 `.md` = 一個尚未完成的功能/修復；挑一個做完即**刪掉該 md**。詳見 `docs/handoff/README.md`。
- git 規則依執行環境分三套（判準：env `CLAUDE_CODE_REMOTE=true` ＝雲端 session，Claude Code on the web；
  否則 `.git` 是檔案且指向 `.git/worktrees/` ＝本機 worktree（`scripts/worktree.js#isLinkedWorktree`）；其餘＝本機主目錄）：
  - **本機主目錄**：**不開新功能分支**，直接在現有分支（`dev`）修改；**不主動 commit**（等使用者說）。
  - **本機 worktree（多 session 並行）**：測試只跑 `yarn test:unit`（自動限流 `maxWorkers` 2、`testTimeout` 20s）；
    e2e／integration／record／android 由 `scripts/worktree.js` 以 **exit 2 拒絕**（會搶 8080／Docker 容器／PTT 登入預算／CPU，
    且 Playwright `reuseExistingServer` 會靜默測到主目錄的 code）。逃生門 `ALLOW_WORKTREE_E2E=1` 只在使用者確認主目錄沒在跑測試時用。
    ⇒ 自己開分支 `claude/<主題>`、commit、push、開 PR 到 `dev`，`yarn ci:status --branch <分支>` loop 修到全綠。
    停止條件：失敗與被測 code 無關 ⇒ 照 `docs/ci-troubleshooting.md` 判斷／`--rerun-failed`，不改 code；
    同一個失敗修 3 輪仍紅 ⇒ 停手回報。**不自行合併**（等使用者）。live e2e 由主目錄 session 合回 `dev` 後統一跑一輪（登入預算）。
    「改渲染提交前必跑 e2e」在 worktree 以 CI 的 offline＋adverse 代替，交付時註明 live 未跑。
  - **雲端 session**：以 session 指定的工作分支（通常 `claude/*`）為準，**不要切回或直推 `dev`**；
    做完**要自己 commit＋push 到該分支**（雲端容器結束即銷毀，沒 push＝工作全丟），需要時開 PR 到 `dev`。
    上面兩條本機規則在雲端**不適用**；其餘 commit 前檢查（隱私 `git diff` 自查、`--stat` 行數相稱、補測試、README 新功能列表）照舊。
  - 雲端 CI：`deploy.yml` 只在 push `dev` 觸發，`claude/*` 分支要**開 PR 後**才會跑 `pr.yml`（同一份 `test.yml`）；
    `yarn ci:status --branch <工作分支>` 查它（需 `GH_TOKEN`；沒有就明講「CI 未驗」，不可當綠）。
  - 雲端是 Linux：本文中 Windows 專屬的坑（IPv6-only 綁定、`STATUS_DLL_INIT_FAILED`、Firefox `spawn UNKNOWN`／content sandbox、無 `jq`/`gh`）不一定適用；
    live e2e 帳密（`PTT_USER`/`PTT_PASS`）通常不在雲端 env，**不要在雲端跑 live e2e**（登入預算／BOT 封鎖風險，見「測試」節），改跑 unit＋offline e2e 並在交付時註明。
- **換行一律 LF**，由 `.gitattributes`（`* text=auto eol=lf`）強制，不依賴各機器的
  `core.autocrlf`。勿把任何檔案轉成 CRLF：工具寫 LF 時整檔會被當成全改。唯一例外 `*.bat`（`android/gradlew.bat`，簽出為 CRLF）。
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
    **「只查到 `event: dynamic` 的 run」不等於全綠**：那是 GitHub 動態 workflow（Dependabot 等）的 run，
    本專案的 `Deploy to GitHub Pages` 可能只是還沒被建立（push 到 run 建立可延遲十分鐘以上）；
    腳本必須看到本專案的 workflow run（`isProjectRun`）才判定，等不到就 exit 2。
    `--sha` 吃短 sha／`HEAD`／tag（腳本自己 `git rev-parse` 展開；runs API 的 `head_sha` 只吃完整 40 字元）。
    守護 `tests/unit/ci_status_parse.test.js`。
  - **本機沒有 `jq`，也沒有 `gh` CLI**。**禁止**再用 `curl … | jq` 或 `gh run …` 拼輪詢迴圈：jq 不存在 → 解析永遠是空字串 → 判不出「跑完了沒」而空轉到逾時，錯誤又常被 `2>/dev/null` 吞掉，看起來像 CI 卡住（實際早就綠了）。
  - **`ci:status` 收尾禁用 `process.exit()`**：Windows 上 Node 內建 fetch（undici）的 keep-alive socket 還開著時強制退出，
    會撞 libuv `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94` → 進程回 **`exit=127`**，
    把刻意分的 0/1/2 整個蓋掉。收尾一律設 `process.exitCode` + 主動收連線池。
  - **禁止把 `yarn ci:status` 接管線**（`| tail`／`| grep`／`| head`）：shell 的管線 exit code 取自**最後一個**指令，`tail` 幾乎永遠回 0 → 上面刻意分的三種 exit code 被整個吃掉，紅的 CI 會被讀成綠的（實例：deploy job failure 卻回報 `exit=0`）。而且 `head -N` 會提早關閉管線送出 SIGPIPE，可能把還在等 run 的 `ci:status` 直接砍掉。**一律 `yarn ci:status ... > <file> 2>&1; echo "EXIT=$?"` 再讀檔**。同理適用任何「exit code 就是結論」的指令（`yarn test:unit`、`playwright test`）。
  - **CI 紅了但失敗的 job／step 看起來跟被測 code 無關**（deploy-pages timeout、裝瀏覽器時 apt `Hash Sum mismatch`、integration emulator timeout、GITHUB_TOKEN 觸發不了 workflow），以及 Code scanning alert 的 API 處理、**新增 CI job 的步驟順序與 required checks**：見 `docs/ci-troubleshooting.md`。
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
- **改專案檔一律用 Edit／Write，不准經 shell**（`sed -i`、heredoc／`-c`／`-e` 行內腳本寫檔、
  重導向、`Set-Content`）：由 hook `scripts/edit-guard.mjs` 強制擋下，寫入後也會檢查
  NUL／CRLF／大段重複；pre-commit 再查一次 staged 內容。理由與規則都寫在該檔開頭。
  被擋時照訊息做，**別去找繞過的寫法**。批次改動先用 Write 寫腳本檔再 `node` 執行；
  腳本裡的 `String.replace` 替換值一律傳函式（`s.replace(old, () => neu)`），因為 `$` 序列會把全文再貼一次。
- 踩坑後若判斷**多數**後續 session 也會踩，就寫進 md：寫進該主題的 `docs/*.md`；只有每個 session 都會碰到的才進本檔（本檔每 session 都付 token）。寫現行規則＋一句理由，不寫事件經過與日期。
- 每次commit前都要檢查本次更動是否含新功能，如果有的話要更新README.md新功能列表，新功能定義：以一般使用者角度，所以優化、修bug都不算
- 重大技術升級（框架/建置/依賴的升版或替換，如 React 升版、換 UI 庫、建置/測試工具替換）要同步更新「設定 → 關於」的「重大技術升級」區塊：`src/js/zh_TW_messages.js` 與 `src/js/en_US_messages.js` 的 `about_new_content`（兩語系都要改）
- **依賴／建置鏈已全面現代化（2026-07，見 `docs/build-modernization.md` 掃描表），維持此狀態**：遇坑優先升級／換套件（並提報使用者），不要堆疊 workaround／`!important` 硬調。穩定性與現代化優先於最小改動。
  - **不只升版本，還要換陣營**：實作時發現某依賴的「同類但更主流」替代品已成生態標準（如 webpack+Babel→Vite、jest→Vitest），優先評估整組替換而非原地升版。無維護的小套件（如當年的 base58）優先內聯或換維護中的主流品。評估紀錄寫進 `docs/build-modernization.md`。
  - **目標對象＝主流桌機瀏覽器現代版**（Chrome/Edge/Firefox/Safari，見 `vite.config.mjs` `build.target`）＋ **Android Chrome 現代版**（手機版面，分階段支援中，見 `docs/mobile.md`）：**不考慮**舊版、冷門瀏覽器相容性；不為它們加 polyfill/transpile/workaround。
  - `src/js` 核心仍是 fork 來的舊式碼**風格**（prototype 掛載/`var`）：功能正常且有測試守護，**不主動大規模重寫**；觸及該檔時順手現代化即可。deprecated 瀏覽器 API 已清零（2026-07），別再重複掃描。
