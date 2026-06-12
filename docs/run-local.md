# 官方版（robertabcd/PttChrome）本機啟動

> 基底：`robertabcd/PttChrome @ dev`（React16）。這就是 term.ptt.cc 的原始碼，也是本 repo。
> build toolchain 已升級 webpack5（2026-06，原 webpack4）。

## TL;DR

```powershell
cd <專案根目錄>
yarn start
# 瀏覽器開 http://localhost:8080
```

跑起來後瀏覽器應出現 PTT 登入畫面。`Ctrl+C` 關閉 server。

## 為何只要一個指令

`webpack serve`（dev server）**已內建** `/bbs` 的 WebSocket 反向代理，並把 `Origin` 改寫成 `https://term.ptt.cc` 以通過 PTT 白名單（見 `webpack.config.js` 的 `devServer.proxy`）。dev 模式預設連線站台正好是 `wstelnet://localhost:8080/bbs`（`webpack.config.js` 的 `DefinePlugin` → `process.env.DEFAULT_SITE`），剛好打到自己的 dev server proxy。

```
瀏覽器 :8080 ──ws /bbs──▶ webpack-dev-server proxy（改 Origin→term.ptt.cc）──▶ wss://ws.ptt.cc/bbs
```

所以**直連真 PTT、不需要任何中繼或第三方 proxy**。

## 必要設定 / 踩雷

| 項目 | 說明 |
|---|---|
| Node ≥ 20.9 | webpack-cli 7 的下限（建議 v24）。webpack5 起**不再需要** `NODE_OPTIONS=--openssl-legacy-provider`。 |
| 用 **Node** 跑，不要用 bun | bun 跑 webpack-dev-server 的 ws proxy 不轉發 upgrade。確認 `node` 已在 PATH。 |
| 套件管理用 **yarn** | repo 為 yarn 專案（`yarn.lock` v1）。Node 內建 corepack：`corepack enable` 即可用 `yarn`（已由 `package.json` 的 `packageManager` 鎖定 1.22.x）。 |
| `node_modules` | 已存在直接用。需重裝時 `yarn install`。 |
| 連外網 | 需能連到 `wss://ws.ptt.cc/bbs`。 |

## 指令對照

| 動作 | 指令 |
|---|---|
| 啟動 dev server | `yarn start`（= `webpack serve`，dev-server v5 無獨立 bin） |
| 打包 production | `yarn build` → 產出 `dist/` |
| 清 build 產物 | `yarn clean` |

production build（`yarn build`）預設站台是 `wsstelnet://ws.ptt.cc/bbs`，純靜態部署時瀏覽器**無法直連**（Origin 白名單），需自備會改寫 Origin 的反向代理、或部署在白名單網域、或用瀏覽器擴充改寫 Origin（見 `origin-rewrite-extension.md`）。本機開發用 `yarn start` 不受此限。

## webpack5 升級踩坑（2026-06）

| 坑 | 處置 |
|---|---|
| dev server 起來但頁面全白、`/assets/pttchrome.js` 404 | webpack-dev-middleware v5+ **不再正規化相對 `output.publicPath`**（`'assets/'`）。修：`devServer.devMiddleware.publicPath: '/assets/'`（production 仍用相對路徑，供子路徑部署）。 |
| build 報 `Can't resolve 'querystring'` | webpack5 不再 polyfill Node core modules。`ImagePreviewer.js` 的 `stringify` 改用原生 `URLSearchParams`，不裝 polyfill。 |
| `devServer.proxy` 語法 | v5 須為**陣列**：`[{ context: ['/bbs'], ... }]`；dev-server 5.2.x 用 http-proxy-middleware **v2**，WS handler 仍是頂層 `onProxyReqWs`（非 hpm v3 的 `on.proxyReqWs`）。 |
| CSS 內 url() 變 `assets/assets/x` | 移除 css-url-relative-plugin，改 `MiniCssExtractPlugin.loader` 的 `options.publicPath: ''`。 |
| hwp5 注入的 script 帶 `defer` | 行為等價（defer 保證依序執行 jquery→bootstrap→…→bundle），無需處理。 |
| `<%= require('./icon/logo.png') %>`（dev.html template） | hwp5 default loader 仍支援，favicon 正常。 |
| asset modules 的 `require()` | `asset/resource` 的 `require()` 回傳 URL 字串，與舊 file-loader `esModule:false` 相容，使用端（main.js/term_buf/pttchrome/term_view）免改。 |
