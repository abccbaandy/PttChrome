# 建置鏈現代化：webpack+Babel → Vite / jest → Vitest（2026-07 執行）

狀態：CONFIRMED（已完整遷移；unit 632 綠、offline e2e 55 綠、build 綠）。
本文＝決策依據＋全套件掃描表。動建置鏈或評估「換依賴」前先讀。

## 為何換（收益）

| 項目 | 遷移前 | 遷移後 |
|---|---|---|
| 建置/測試 devDeps | 18 套（webpack×3、loader×3、plugin×4、babel×4、jest×3、cross-env） | 4 套（vite、@vitejs/plugin-react、vitest、jsdom） |
| production build | webpack（數十秒級） | `vite build` ~0.6s（Rolldown） |
| dev server 冷啟 | 全量 bundle 後才可用 | esbuild/oxc on-demand，秒開＋HMR |
| Babel 生態協調升級（如 commit 3877496） | 每次大版本都要 | 永久消失（零 Babel） |
| transpile 鏈 | babel-loader + preset-env/react | Vite 8 內建 oxc（`@vitejs/plugin-react` v6 起 Babel-free） |
| CSS | css-loader + postcss-loader + mini-css-extract + css-minimizer | Vite 內建（postcss.config.cjs 自動讀；minify 走 lightningcss） |
| NODE_ENV / clean | cross-env + rimraf | Vite mode 自動判定 + `emptyOutDir` |

風險與實況：lightningcss 比舊鏈嚴格（曾抓到 main.css 一行 `//` 非法註解，直接 build fail——是好事）；esbuild/oxc 產物行為差異在「目標＝現代桌機瀏覽器」下無實際影響（e2e 全綠佐證）。

## 關鍵遷移事實（下次動這區前必知）

- **JSX 一律 `.jsx` 副檔名**：Vite 8 oxc 不吃 `.js` 內 JSX；plugin-react-swc 的 `parserConfig` 硬吃法被官方標「highly discouraged、隨時移除」→ 不採用，改檔名（25 個 src 檔 + 6 個 test 檔，import 全 extensionless 故零連鎖）。
- **React plugin 選型**：`@vitejs/plugin-react@6`（peer vite ^8）依賴只剩 `@rolldown/pluginutils`，Babel 全在 optional peer（React Compiler 才需要）→ 比 plugin-react-swc（拖 80MB @swc/core）更輕更主流。`plugin-react-oxc` 已停在 vite ^7、被併回 plugin-react。
- **`vitest.config.js` 不 extends `vite.config.js`**：app `define` 把 `FIRESTORE_EMULATOR_HOST` 等釘成 undefined（build DCE 用），integration 測試靠這些真 env 連 emulator，混用即全滅。
- **測試檔要純 ESM**：CJS `require()` src 模組在 Vitest 下走 Node 真實解析 → 遇 ESM extensionless import 即 `Cannot find module`（jest+babel 時代僥倖可行）。ESM 檔內也無 `__dirname`，用 `fileURLToPath(import.meta.url)`。
- **`jest.retryTimes` 無 vi 對應**：CI flaky 重試改 `vitest.config.js` integration project `retry`。
- asset：webpack `require('x.png')` → ESM import；`.bin` 用 `?url`；CSS `url(...?inline)` 拿掉 query（58B bmp 低於 assetsInlineLimit 4KB 自動 inline）；`.bin`/`.bmp` 需 `assetsInclude`。
- html：`src/dev.html`(EJS) → 根目錄 `index.html`，title 佔位由 vite.config.js `transformIndexHtml` 小 plugin 替換；favicon `<link href>` Vite 自動 hash/改寫。
- e2e webServer：`node node_modules/vite/bin/vite.js`（單一進程原則不變）；WDS 的 ResizeObserver overlay workaround 已無需要（Vite overlay 只管編譯錯誤）。
- Yarn v4 script＝portable shell，跨平台支援 `VAR=1 cmd` → `record:cassette` 不需 cross-env。

## 全套件掃描（2026-07；「像 Vite>Babel」的過時→主流檢查）

| 套件 | 判定 | 理由／行動 |
|---|---|---|
| webpack 全家(10)、@babel/*(3)、babel-jest、jest×2、cross-env、rimraf | **已移除** | 由 vite/vitest/內建機制取代（上表） |
| base58 1.0.1 | **已移除→內聯** | 2014 年後無維護、僅 Flickr 短網址 decode 用。**不可換 bs58**（Bitcoin 字母表順序不同會解錯）→ 內聯 `image_url_detect.js#flickrBase58Decode`，回歸 test 鎖字母表 |
| resolutions 區塊（node-fetch/qs/uuid/js-yaml/minimatch/form-data/json-schema pin） | **已整塊刪除** | 全為舊鏈 transitive dep 而設，`yarn why` 零 consumer |
| classnames | 保留 | 仍維護中、React 生態常青。clsx 更小但收益微小，不值得動 |
| firebase / @mantine/* / react / react-dom | 保留 | 皆現行主流大版本 |
| @playwright/test、@testing-library/*、husky、lint-staged、prettier、postcss-preset-mantine、postcss-simple-vars、postcss | 保留 | 現代且活躍；postcss 系是 Mantine 官方建議鏈 |
| jsdom | 新增（vitest unit env） | Vitest 不自帶 |

結論：掃描後**無其他「過時陣營」殘留**。未來新增依賴時比照：先查是否已有內建/主流替代，無維護小套件優先內聯。

## Deprecated 瀏覽器 API 清理（2026-07，CONFIRMED）

| 項目 | 處置 |
|---|---|
| `document.execCommand('copy')` + `strToCopy`/`onDOMCopy` DOM copy 事件攔截 | → `navigator.clipboard.writeText`（`pttchrome.jsx#doCopy`）。正規化抽純函式 `string_util.js#normalizeCopyText`（unit 守護 `tests/unit/string_util.test.js`；真瀏覽器全鏈守護 `ui_behavior.offline.spec.js` 複製冒煙測試）。paste 攔截（`onDOMPaste`）非 deprecated，保留 |
| `document.createEvent('MouseEvents')`+`initMouseEvent` | → `new MouseEvent('click', {ctrlKey:true})`（`pttchrome.jsx#doOpenUrlNewTab`，等價替換） |
| `touch_controller.js` + Chrome UA sniffing（`chromeVersion`） | **已移除**（目標＝桌機瀏覽器，觸控/UA 偵測皆死重；連帶刪 ContextMenu touchstart listener 與 touch_controller unit test） |

## 驗證紀錄（pointer）

- unit：`yarn test:unit` 33 檔 632 測試綠（含新增 flickrBase58Decode 守護 `tests/unit/image_url_detect.test.js`）。
- offline e2e：`yarn test:e2e:offline` 55/55 綠（真瀏覽器＋Vite dev server＋cassette 重放）。
- build：`vite build` 綠；dist 結構同前（`dist/index.html`+`dist/assets/`，相對路徑，firebase lazy chunks 仍分離；entry js ~709KB/gzip 225KB、css ~269KB/gzip 40KB，與 webpack 基線相當）。
- integration：本機無 Docker，靠 CI（`.github/workflows/test.yml`）驗證。
