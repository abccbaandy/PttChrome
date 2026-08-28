# 建置鏈：依賴／工具選型基準

現況：Vite 8（Rolldown 核心）＋Vitest 4，零 Babel／webpack。本文＝**動建置鏈或評估「換依賴」前的判斷依據**（CLAUDE.md 指定先讀），不是遷移紀錄。

## 關鍵事實（動這區前必知）

- **JSX 一律 `.jsx` 副檔名**：Vite 8 oxc 不吃 `.js` 內 JSX。plugin-react-swc 的 `parserConfig` 硬吃法被官方標「highly discouraged、隨時移除」→ **不採用**，改檔名。
- **React plugin 選型＝`@vitejs/plugin-react`**（peer vite ^8，依賴只剩 `@rolldown/pluginutils`，Babel 全在 optional peer、只有 React Compiler 才需要）：比 plugin-react-swc（拖 80MB `@swc/core`）更輕更主流；`plugin-react-oxc` 已停在 vite ^7 並被併回 plugin-react，勿改用。
- **設定檔副檔名＝模組格式，勿改回 `.js`**：`vite.config.mjs` / `vitest.config.mjs` 是 ESM（`import` 語法），`playwright.config.js` / `postcss.config.cjs` 是 CJS（`require`/`module.exports`）。repo 沒有也**不要加** `package.json` 的 `"type": "module"`——那會把所有 `.js` 一律當 ESM，`playwright.config.js` 與 `tests/e2e/helpers/*.js`（CJS `require`）會整批爆。副檔名標註格式即可，逐檔精準。踩坑：兩個 config 原本叫 `.js`，Vite 8 的 `configLoader: 'native'`（未來預設）會用 CJS 載入 → 每次 `yarn start`／`yarn test:unit` 都印 unsupported feature 警告。
- **`vitest.config.mjs` 刻意不 extends `vite.config.mjs`**：app 的 `define` 把 `FIRESTORE_EMULATOR_HOST` 等釘成 undefined（給 build DCE），integration 測試靠這些真 env 連 emulator，混用即全滅。
- **測試檔要純 ESM**：CJS `require()` src 模組在 Vitest 下走 Node 真實解析 → 遇 ESM extensionless import 即 `Cannot find module`。ESM 檔內也無 `__dirname`，用 `fileURLToPath(import.meta.url)`。
- **CI flaky 重試無 `vi` 對應**（沒有 `jest.retryTimes`）：設 `vitest.config.mjs` integration project 的 `retry`。
- asset：`.bin` 用 `?url` import；`.bin`/`.bmp` 需列入 `assetsInclude`；小圖（< `assetsInlineLimit` 4KB）自動 inline，CSS 內不必寫 `?inline`。
- entry＝根目錄 `index.html`，title 佔位由 `vite.config.mjs` 的 `transformIndexHtml` 小 plugin 替換；favicon `<link href>` Vite 自動 hash。
- **`public/` 是「路徑要穩定」的專用出口**（目前只有 PWA 的 `manifest.webmanifest` ＋ 兩張 icon）：內容由 Vite 原樣複製、**不 hash 檔名**，所以 manifest 才引用得到 icon。反過來說 `src/icon/**` 那些會被 hash，不能寫進 manifest。無 `vite-plugin-pwa`（沒有 service worker，也不打算有）——manifest 純粹是為了 `launch_handler: focus-existing`，見 `docs/deep-link.md`。
- e2e webServer 跑 `node node_modules/vite/bin/vite.js`（單一進程原則，teardown 才殺得乾淨）。
- **lightningcss（CSS minify）比舊鏈嚴格**：非法註解之類會直接 build fail——這是好事，修 CSS 而不是繞過。
- **`src/fonts/symmingliu.woff` 是等寬格線的字寬契約，不是裝飾**（CONFIRMED，直接解字型表）：`unitsPerEm 1024`，ASCII `U+0020–U+007E` advance `512` ＝**正好 0.5em**（＝ `term_view` 的 `chw = chh/2`），符號區（`→ ← ● □ ※ Ⅰ …`）`1024` ＝ 1em（兩格），CJK 不在字型內、交給系統全形字型。Windows 有 local MingLiu，**macOS 沒有** ⇒ Mac 上整個格線押在這支 webfont 上；落地前 ASCII 退回系統 monospace（Menlo advance `0.602em`）⇒ 整列橫向偏 20%，而 `#cursor` 的欄位算術不會跟著偏。故 `@font-face` 用 `font-display: block`，且 `main.jsx` 的 `loadResources()` 與轉碼表並行 `await loadTerminalFont()`（`document.fonts.load`，3s 逾時就照跑——字型問題絕不擋連線）。**勿改成 `swap`／勿拿掉那個 await**。守護：`cursor_shape.offline.spec.js`「格線字寬契約」。
- Yarn v4 script＝portable shell，跨平台支援 `VAR=1 cmd` 行內環境變數 → **勿引入 cross-env**。

## 套件選型判定（新增／替換依賴時的基準）

| 套件 | 判定 | 理由 |
|---|---|---|
| webpack 全家、`@babel/*`、jest、cross-env、rimraf | 已移除，**勿加回** | 由 vite／vitest／Vite 內建機制（postcss 自動讀 `postcss.config.cjs`、`emptyOutDir`、mode 判定）取代 |
| base58 | 已內聯成 `image_url_detect.js#flickrBase58Decode` | 2014 年後無維護。**不可換 bs58**：Bitcoin 字母表順序不同會解錯（回歸 test 鎖字母表） |
| `resolutions` 區塊 | 已整塊刪除，**勿再加 pin** | 全為舊鏈 transitive dep 而設，`yarn why` 零 consumer |
| classnames | 保留 | 仍維護、React 生態常青；clsx 更小但收益微小，不值得動 |
| firebase／`@mantine/*`／react／react-dom | 保留 | 皆現行主流大版本 |
| `@playwright/test`、`@testing-library/*`、husky、lint-staged、prettier、postcss 系 | 保留 | 現代且活躍；postcss-preset-mantine + postcss-simple-vars 是 Mantine 官方建議鏈 |
| jsdom | 保留（vitest unit env） | Vitest 不自帶 |

掃描結論（2026-07）：**無其他「過時陣營」殘留**。新增依賴時比照上表——先查是否已有內建／主流替代，無維護的小套件優先內聯。

## Deprecated 瀏覽器 API

已清零（2026-07）：`execCommand('copy')`→`navigator.clipboard.writeText`（正規化在純函式 `string_util.js#normalizeCopyText`，unit＋`ui_behavior.offline.spec.js` 複製冒煙測試守護）、`createEvent('MouseEvents')`→`new MouseEvent`、`touch_controller.js`＋Chrome UA sniffing 整份移除（目標＝桌機瀏覽器）。paste 攔截（`onDOMPaste`）非 deprecated，保留。**別再重複掃描這一區**。
