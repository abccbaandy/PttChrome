# 官方版（robertabcd/PttChrome）本機啟動

> 基底：`robertabcd/PttChrome @ dev`（term.ptt.cc 的原始碼，即本 repo），已升 React 19。
> build toolchain：Vite 8（Rolldown 核心；React plugin 走內建 oxc transform，無 Babel）。

## TL;DR

```powershell
cd <專案根目錄>
yarn start
# 瀏覽器開 http://localhost:8080
```

跑起來後瀏覽器應出現 PTT 登入畫面。`Ctrl+C` 關閉 server。

## 為何只要一個指令

`vite`（dev server）**已內建** `/bbs` 的 WebSocket 反向代理，並把 `Origin` 改寫成 `https://term.ptt.cc` 以通過 PTT 白名單（見 `vite.config.mjs` 的 `server.proxy`）。dev 模式預設連線站台正好是 `wstelnet://localhost:8080/bbs`（`vite.config.mjs` 的 `define` → `process.env.DEFAULT_SITE`），剛好打到自己的 dev server proxy。

```
瀏覽器 :8080 ──ws /bbs──▶ Vite dev server proxy（改 Origin→term.ptt.cc）──▶ wss://ws.ptt.cc/bbs
```

所以**直連真 PTT、不需要任何中繼或第三方 proxy**。

## 必要設定 / 踩雷

| 項目 | 說明 |
|---|---|
| Node ≥ 20.19 | Vite 8 的下限（建議 v24）。 |
| 用 **Node** 跑，不要用 bun | bun 跑 dev server 的 ws proxy 不轉發 upgrade。確認 `node` 已在 PATH。 |
| 套件管理用 **yarn** | repo 為 yarn 專案（Yarn v4，`node-modules` linker，`.yarnrc.yml`）。Node 內建 corepack：`corepack enable` 即可用 `yarn`（版本由 `package.json` 的 `packageManager` 鎖定 4.x）。CI 用 `yarn install --immutable`（非 `--frozen-lockfile`）。 |
| `node_modules` | 已存在直接用。需重裝時 `yarn install`。 |
| 連外網 | 需能連到 `wss://ws.ptt.cc/bbs`。 |

## 指令對照

| 動作 | 指令 |
|---|---|
| 啟動 dev server | `yarn start`（= `vite`） |
| 打包 production | `yarn build`（= `vite build`，自帶 emptyOutDir 清舊產物） → 產出 `dist/` |

production build（`yarn build`）預設站台是 `wsstelnet://ws.ptt.cc/bbs`，純靜態部署時瀏覽器**無法直連**（Origin 白名單），需自備會改寫 Origin 的反向代理、或部署在白名單網域、或用瀏覽器擴充改寫 Origin（見 `origin-rewrite-extension.md`）。本機開發用 `yarn start` 不受此限。

### 連自訂 proxy（設定頁，預設關閉）

使用者要連自訂 proxy（如 Cloudflare Worker 中繼），在**設定 → 連線**勾選「透過 proxy 連線」並填入 Proxy 位址即可，不必改 build、也不必裝其他套件：

- 位址可填裸 host（如 `ptt-proxy.example.workers.dev`，自動補 `wsstelnet://` 與 `/bbs`）或完整 `ws(s)telnet://host/path`。預設位址為公開 CF Worker 中繼。
- 偏好存於 `pref_storage.js`（`useProxy` / `proxyUrl`），組站邏輯為 `util.js` 的 `proxySiteFromPrefs()`，於 `main.jsx` connect 時套用。
- **連線在啟動時建立，改設定後須重新整理才生效**。

連線優先序（`main.jsx`）：`?site` 覆寫（預設關）→ proxy 偏好 → `DEFAULT_SITE`。

#### `?site=` query 覆寫（預設關閉）

`ALLOW_SITE_IN_QUERY` 預設為 **關閉**（`vite.config.mjs`），網址的 `?site=` 會被忽略（避免被任意連結／頁面導向任意 WebSocket host）。需要時 build 設 `ALLOW_SITE_IN_QUERY=yes` 重新開啟：

```
https://<部署網址>/?site=wstelnet://your-proxy.example.com/bbs
```
