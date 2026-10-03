# 建置鏈：依賴／工具選型基準

現況：Vite 8（Rolldown 核心）＋Vitest 5，零 Babel／webpack。本文＝**動建置鏈或評估「換依賴」前的判斷依據**（CLAUDE.md 指定先讀），不是遷移紀錄。

## 關鍵事實（動這區前必知）

- **JSX 一律 `.jsx` 副檔名**：Vite 8 oxc 不吃 `.js` 內 JSX。plugin-react-swc 的 `parserConfig` 硬吃法被官方標「highly discouraged、隨時移除」→ **不採用**，改檔名。
- **React plugin 選型＝`@vitejs/plugin-react`**（peer vite ^8，依賴只剩 `@rolldown/pluginutils`，Babel 全在 optional peer、只有 React Compiler 才需要）：比 plugin-react-swc（拖 80MB `@swc/core`）更輕更主流；`plugin-react-oxc` 已停在 vite ^7 並被併回 plugin-react，勿改用。
- **設定檔副檔名＝模組格式，勿改回 `.js`**：`vite.config.mjs` / `vitest.config.mjs` 是 ESM（`import` 語法），`playwright.config.js` / `postcss.config.cjs` 是 CJS（`require`/`module.exports`）。repo 沒有也**不要加** `package.json` 的 `"type": "module"`——那會把所有 `.js` 一律當 ESM，`playwright.config.js` 與 `tests/e2e/helpers/*.js`（CJS `require`）會整批爆。副檔名標註格式即可，逐檔精準。踩坑：兩個 config 原本叫 `.js`，Vite 8 的 `configLoader: 'native'`（未來預設）會用 CJS 載入 → 每次 `yarn start`／`yarn test:unit` 都印 unsupported feature 警告。
- **`vitest.config.mjs` 刻意不 extends `vite.config.mjs`**：app 的 `define` 把 `FIRESTORE_EMULATOR_HOST` 等釘成 undefined（給 build DCE），integration 測試靠這些真 env 連 emulator，混用即全滅。
- **測試檔要純 ESM**：CJS `require()` src 模組在 Vitest 下走 Node 真實解析 → 遇 ESM extensionless import 即 `Cannot find module`。ESM 檔內也無 `__dirname`，用 `fileURLToPath(import.meta.url)`。
- **Vitest 5 起 `clearMocks` 預設為 `true`**（每個 test 前自動清 mock 呼叫記錄，等同舊 `clearMocks: true`；只清 calls，不清 implementation／return value）：新測試**不要**再依賴「mock 呼叫次數跨 test 累積」，要累積就自己在 `beforeAll` 建 counter。其他 v5 硬性前提：Node ≥22、Vite ≥6.4；config 不再往上層目錄找（必須在 repo 根跑）；未 await 的非同步 assertion 現在會直接紅。
- **CI flaky 重試無 `vi` 對應**（沒有 `jest.retryTimes`）：設 `vitest.config.mjs` integration project 的 `retry`。
- asset：`.bin` 用 `?url` import；`.bin`/`.bmp` 需列入 `assetsInclude`；小圖（< `assetsInlineLimit` 4KB）自動 inline，CSS 內不必寫 `?inline`。
- entry＝根目錄 `index.html`，title 佔位由 `vite.config.mjs` 的 `transformIndexHtml` 小 plugin 替換；favicon `<link href>` Vite 自動 hash。
- **`public/` 是「路徑要穩定」的專用出口**（目前只有 PWA 的 `manifest.webmanifest` ＋ 兩張 icon）：內容由 Vite 原樣複製、**不 hash 檔名**，所以 manifest 才引用得到 icon。反過來說 `src/icon/**` 那些會被 hash，不能寫進 manifest。無 `vite-plugin-pwa`（沒有 service worker，也不打算有）——manifest 純粹是為了 `launch_handler: focus-existing`，見 `docs/deep-link.md`。
- e2e webServer 跑 `node node_modules/vite/bin/vite.js`（單一進程原則，teardown 才殺得乾淨）。
- **lightningcss（CSS minify）比舊鏈嚴格**：非法註解之類會直接 build fail——這是好事，修 CSS 而不是繞過。
- **`src/fonts/symmingliu.woff` 是等寬格線的字寬契約，不是裝飾**（CONFIRMED，直接解字型表）：`unitsPerEm 1024`，ASCII `U+0020–U+007E` advance `512` ＝**正好 0.5em**（＝ `term_view` 的 `chw = chh/2`），符號區（`→ ← ● □ ※ Ⅰ …`）`1024` ＝ 1em（兩格），CJK 不在字型內、交給系統全形字型。Windows 有 local MingLiu，**macOS 沒有** ⇒ Mac 上整個格線押在這支 webfont 上；落地前 ASCII 退回系統 monospace（Menlo advance `0.602em`）⇒ 整列橫向偏 20%，而 `#cursor` 的欄位算術不會跟著偏。故 `@font-face` 用 `font-display: block`，且 `main.jsx` 的 `loadResources()` 與轉碼表並行 `await loadTerminalFont()`（`document.fonts.load`，3s 逾時就照跑——字型問題絕不擋連線）。**勿改成 `swap`／勿拿掉那個 await**。守護：`cursor_shape.offline.spec.js`「格線字寬契約」。
- Yarn v4 script＝portable shell，跨平台支援 `VAR=1 cmd` 行內環境變數 → **勿引入 cross-env**。
- **`build.target` ＝ Vite 的 `'baseline-widely-available'` 字面值，禁止手寫版本號陣列**（2026-09 改）：Vite 把它解析成 Baseline Widely Available 那組（Vite 8.2 ＝ `chrome111/edge111/firefox114/safari16.4/ios16.4`，基準日 2025-05-01），而且**每個 Vite major 自己往前 bump** ⇒ 零維護，且「所有核心瀏覽器支援滿 30 個月」是 WebDX 的標準定義，比任何手挑版本號都有依據。手寫的下場實錄：原本釘在 `chrome110/edge110/firefox110/safari16`（2023 年初）**整整三年沒人動**，比 CLAUDE.md 慣例寫的「主流桌機瀏覽器現代版」寬鬆得多，而且當初挑那組數字時沒有依據來源。守護 `tests/unit/build_target_baseline.test.js`。
  - **這條線不含 `:has()`（要 Firefox 121）與原生 CSS nesting。**想用超出 target 的語法／CSS 特性時，`build.target` 是**唯一**防線：**Playwright 跑的是它自帶的最新 Chromium/Firefox ⇒ 整套 e2e 一條都不會紅**。CSS 尤其致命——選擇器清單裡只要有一個無效，**整條規則會被丟棄**（2026-09 灰階鈕的 `.inlinePreviewSlot:has(img:hover)` 差點踩到：在 FF 121 以下整條顯示規則失效＝按鈕永遠叫不出來，比它要修的問題更糟，改用 `pointer-events` 收斂解決，見 `docs/easy-reading.md`）。
  - 要解鎖某個特性時的正解：**升 Vite**（字面值自動前進），而不是把 target 改回手寫。

## 套件選型判定（新增／替換依賴時的基準）

| 套件 | 判定 | 理由 |
|---|---|---|
| webpack 全家、`@babel/*`、jest、cross-env、rimraf | 已移除，**勿加回** | 由 vite／vitest／Vite 內建機制（postcss 自動讀 `postcss.config.cjs`、`emptyOutDir`、mode 判定）取代 |
| base58 | 已內聯成 `image_url_detect.js#flickrBase58Decode` | 2014 年後無維護。**不可換 bs58**：Bitcoin 字母表順序不同會解錯（回歸 test 鎖字母表） |
| `resolutions` 區塊 | 已整塊刪除，**勿再加 pin** | 全為舊鏈 transitive dep 而設，`yarn why` 零 consumer |
| `@grpc/grpc-js`（firestore transitive，`~1.9.0`） | Dependabot alert 以 `not_used` dismiss，**不加 resolutions** | 只在 firestore 的 Node entry（`index.node.mjs`）；瀏覽器 entry `index.esm.js` 不含。Node 端只有 integration 當 client，已知 CVE（getAuthContext、server 錯誤訊息外洩）都是 server 端。等 firebase 自己放寬範圍 |
| classnames | 保留 | 仍維護、React 生態常青；clsx 更小但收益微小，不值得動 |
| firebase／`@mantine/*`／react／react-dom | 保留 | 皆現行主流大版本 |
| `@playwright/test`、`@testing-library/*`、husky、lint-staged、prettier、postcss 系 | 保留 | 現代且活躍；postcss-preset-mantine + postcss-simple-vars 是 Mantine 官方建議鏈 |
| jsdom、happy-dom | 已移除，**勿加回**（守護 `unit_environment.test.js`） | DOM 模擬跟真瀏覽器不一致時測試全綠、實際卻壞。unit 的 DOM 測試改 Vitest Browser Mode（下節）；`yarn debug:screens` 改純 node（解析路徑本來就不需要 DOM，`term_buf_no_dom.test.js`） |
| `@vitest/browser-playwright`、`playwright` | 新增（unit-browser project） | Vitest 官方的 Browser Mode provider；peer 是**精確**的 vitest 版本，`playwright` 必須與 `@playwright/test` 同版（Dependabot 以 group 綁一起升） |

掃描結論（2026-07）：**無其他「過時陣營」殘留**。新增依賴時比照上表——先查是否已有內建／主流替代，無維護的小套件優先內聯。

### jsdom → happy-dom 評估（2026-10，happy-dom 20.14.5 vs jsdom 30.1.1，Vitest 5.0.2）

做法：把 127 支宣告 jsdom 的 unit 檔全換成 `happy-dom` 後跑，本機 `--maxWorkers=3`，每種各跑 2 輪。

| 範圍 | jsdom | happy-dom |
|---|---|---|
| 只跑 jsdom 檔 | 59.3／57.6s | 40.3／40.1s（-31%） |
| 整套 unit | 73.5／74.1s | 56.4／56.5s（-24%） |

7 個檔案、46 支測試紅，全部是環境行為不同，不是產品 bug：

| 差異 | 檔案 | 哪邊接近真瀏覽器 |
|---|---|---|
| `navigator.credentials` 是唯讀 getter，測試直接賦值會 throw | `auto_login_credentials`、`credential_store`、`pref_modal_autologin_tab` | happy-dom（瀏覽器也是唯讀）⇒ 改用 `Object.defineProperty`／`vi.stubGlobal` |
| inline style 顏色不會正規化成 `rgb()`（`#fff` 原樣保留） | `long_push_modal`、`render_dom_equivalence`（golden `article_caption_merge`） | jsdom（瀏覽器會正規化）⇒ golden 會跟真瀏覽器輸出不一樣 |
| 有 `IntersectionObserver` 但永遠不觸發；jsdom 沒有它，會走「立即掛載」的 fallback | `image_preview` | 都不像 ⇒ 改成注入假 IO（`inline_preview_slot.js` 已有測試用入口） |
| `localStorage.setItem` 是 instance 自己的屬性，spy `Storage.prototype` 攔不到 | `long_push_draft` | jsdom ⇒ 改 spy instance |

判定：不採用，改評估 Browser Mode（見下節）。happy-dom 跟 jsdom 一樣是模擬環境，只是偏差的地方不同；Browser Mode 更快也更真實。

### jsdom → Vitest Browser Mode（2026-10 採用，`@vitest/browser-playwright`＋`playwright`，Chromium headless）

現行設定：`vitest.config.mjs` 拆兩個 project。`unit`（node）跑純邏輯；檔案第一行是 `// @unit-env browser`（`scripts/unit-browser-marker.mjs`）的檔案跑 `unit-browser`（真 Chromium）。用檔頭標記分流而不是改檔名，是為了不讓 docs 裡大量 `<file>#…` pointer 失效。CI 的 `test-unit` 跑在 Playwright image 裡。守護 `tests/unit/unit_environment.test.js`、`ci_playwright_container.test.js`。

| 範圍（本機 16 核、預設 workers，牆鐘時間） | jsdom | 採用後 |
|---|---|---|
| 整套 unit | 73.5／74.1s | 16.2–17.2s（連跑 4 輪） |
| 整套 unit，worktree 限流 `--maxWorkers=2` | — | 28.9s |

換過去時要改的東西（日後新寫的測試照同一套做法）：

| 類別 | 做法 |
|---|---|
| src 讀 `process.env.*`（瀏覽器沒有 `process`） | browser project 用 `define` 轉發，目前只有 `UPDATE_GOLDEN` |
| 測試讀 fixture／原始碼用 `fs`／`path`／`require`／`__dirname` | JSON 直接 import、原始碼用 `?raw`、Big5 表用 `?inline`＋`atob`（`helpers/load_big5_tables.js`，node／browser 共用）、golden 讀寫用 `vitest/browser` 的 `commands.readFile`／`writeFile` |
| `Buffer`、`global` | `atob`、`globalThis` |
| `vi.mock` factory 沒列出被用到的 named export：node 要等存取時才報錯，瀏覽器的 ESM 在載入時就失敗 | factory 先 `...actual` 再覆寫 |
| `vi.resetModules()` 無效（原生 ESM 不重跑模組） | 模組 export 測試用 reset 函式（`auto_login.js#_resetSessionCredentialForTest`） |
| `navigator.credentials`／`window` 是唯讀 getter；真 Chromium 本來就有 `PasswordCredential` | `Object.defineProperty`／`vi.spyOn`；「環境不支援」要主動藏起來（`helpers/credential_api.js`） |
| 真版面：沒有可捲動內容時 `scrollTop` 會被夾回 0 | 給元素真的高度＋overflow，斷言改成量真 rect（`bottom_stick`、`inline_video_fullscreen`、`debug_recorder`） |
| 真的 `IntersectionObserver`（非同步） | 要測立即掛載就 `vi.stubGlobal('IntersectionObserver', undefined)`＋`resetLazyObserversForTest`（`image_preview`） |
| `new ClipboardEvent({clipboardData})` 只吃真 `DataTransfer` | 傳 `new DataTransfer()` |
| node 的 `unhandledRejection` | `window` 的 `unhandledrejection` 事件 |
| golden HTML 序列化不同：屬性值裡的 `<`／`>` 會跳脫、`box-shadow` 會正規化 | 以真瀏覽器為準重產 golden（消費端用 `getAttribute`，值不變） |

多 session／worktree（CONFIRMED）：
- 不碰 8080／Docker／PTT。browser API server 預設 port 63315，被佔用時自動往下一個 port（實測兩份同時跑分到 63315／63316，結果完全一樣）。
- 平行的測試檔之間 `localStorage` 互相隔離（實測 `maxWorkers=2` 時兩檔各自寫入、互相看不到）。
- worktree 的 `unitLimits`（maxWorkers 2）一樣適用。
- Chromium 執行檔放在 Playwright 的共用快取，所有 checkout 共用；升 Playwright 版本時要重裝（`yarn playwright install chromium`）。
- `screenshotFailures: false`；`.vitest/` 已列入 `.gitignore`。

## Deprecated 瀏覽器 API

已清零（2026-07）：`execCommand('copy')`→`navigator.clipboard.writeText`（正規化在純函式 `string_util.js#normalizeCopyText`，unit＋`ui_behavior.offline.spec.js` 複製冒煙測試守護）、`createEvent('MouseEvents')`→`new MouseEvent`、`touch_controller.js`＋Chrome UA sniffing 整份移除（目標＝桌機瀏覽器）。paste 攔截（`onDOMPaste`）非 deprecated，保留。**別再重複掃描這一區**。
