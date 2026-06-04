# 官方版（robertabcd/PttChrome）本機啟動

> 基底：`robertabcd/PttChrome @ dev`（webpack4 + React16）。這就是 term.ptt.cc 的原始碼，也是本 repo。

## TL;DR

```powershell
cd <專案根目錄>
$env:NODE_OPTIONS = "--openssl-legacy-provider"
yarn start
# 瀏覽器開 http://localhost:8080
```

跑起來後瀏覽器應出現 PTT 登入畫面。`Ctrl+C` 關閉 server。

## 為何只要一個指令

`webpack-dev-server` **已內建** `/bbs` 的 WebSocket 反向代理，並把 `Origin` 改寫成 `https://term.ptt.cc` 以通過 PTT 白名單（見 `webpack.config.js` 的 `devServer.proxy`）。dev 模式預設連線站台正好是 `wstelnet://localhost:8080/bbs`（`webpack.config.js` 的 `DefinePlugin` → `process.env.DEFAULT_SITE`），剛好打到自己的 dev server proxy。

```
瀏覽器 :8080 ──ws /bbs──▶ webpack-dev-server proxy（改 Origin→term.ptt.cc）──▶ wss://ws.ptt.cc/bbs
```

所以**直連真 PTT、不需要任何中繼或第三方 proxy**。

## 必要設定 / 踩雷

| 項目 | 說明 |
|---|---|
| `NODE_OPTIONS=--openssl-legacy-provider` | **必須**。webpack4 在 Node 17+ 會丟 `error:0308010C digital envelope routines::unsupported`。`yarn start` 沒帶這個，要手動設環境變數。 |
| 用 **Node** 跑，不要用 bun | bun 跑 webpack-dev-server 的 ws proxy 不轉發 upgrade。需 Node 17+（建議 v18/v20/v24），確認 `node` 已在 PATH。 |
| 套件管理用 **yarn** | repo 為 yarn 專案（`yarn.lock` v1）。Node 17+ 內建 corepack：`corepack enable` 即可用 `yarn`（已由 `package.json` 的 `packageManager` 鎖定 1.22.x）。 |
| `node_modules` | 已存在直接用。需重裝時 `yarn install`。 |
| 連外網 | 需能連到 `wss://ws.ptt.cc/bbs`。 |

## 指令對照

| 動作 | 指令 |
|---|---|
| 啟動 dev server | `yarn start`（先設 `NODE_OPTIONS`） |
| 打包 production | `yarn build` → 產出 `dist/` |
| 清 build 產物 | `yarn clean` |

production build（`yarn build`）預設站台是 `wsstelnet://ws.ptt.cc/bbs`，純靜態部署時瀏覽器**無法直連**（Origin 白名單），需自備會改寫 Origin 的反向代理、或部署在白名單網域、或用瀏覽器擴充改寫 Origin（見 `origin-rewrite-extension.md`）。本機開發用 `yarn start` 不受此限。

## 一鍵化（選用）

若不想每次設環境變數，把 `package.json` 的 start script 改成：

```json
"start": "cross-env NODE_ENV=development NODE_OPTIONS=--openssl-legacy-provider webpack-dev-server"
```

之後直接 `yarn start` 即可。
