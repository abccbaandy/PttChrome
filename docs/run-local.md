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

`vite`（dev server）**已內建** `/bbs` 的 WebSocket 反向代理，並把 `Origin` 改寫成 `https://term.ptt.cc` 以通過 PTT 白名單（見 `vite.config.mjs` 的 `server.proxy`）。dev 模式預設連線站台是 `wstelnet://{pageHost}/bbs`（`vite.config.mjs` 的 `define` → `process.env.DEFAULT_SITE`），runtime 由 `util.js#resolveDefaultSite` 把 `{pageHost}` 換成 `location.host`，所以永遠打到「開這個頁面的那台」dev server proxy。**不可寫死 `localhost`**：手機用區網位址（`yarn start --host`）開站時 `localhost` 是手機自己，連不到 proxy。

```
瀏覽器 :8080 ──ws /bbs──▶ Vite dev server proxy（改 Origin→term.ptt.cc）──▶ wss://ws.ptt.cc/bbs
```

所以**直連真 PTT、不需要任何中繼或第三方 proxy**。

## 必要設定 / 踩雷

| 項目 | 說明 |
|---|---|
| Node ≥ 20.19（跑測試需 ≥ 22） | Vite 8 的下限 20.19；Vitest 5 要求 ≥ 22。裝最新 v24 一次滿足。`yarn test:unit` 的 unit-browser 另需 `yarn playwright install chromium`。 |
| 用 **Node** 跑，不要用 bun | bun 跑 dev server 的 ws proxy 不轉發 upgrade。確認 `node` 已在 PATH。 |
| 套件管理用 **yarn** | repo 為 yarn 專案（Yarn v4，`node-modules` linker，`.yarnrc.yml`）。Node 內建 corepack：`corepack enable` 即可用 `yarn`（版本由 `package.json` 的 `packageManager` 鎖定 4.x）。CI 用 `yarn install --immutable`（非 `--frozen-lockfile`）。 |
| `node_modules` | 已存在直接用。需重裝時 `yarn install`。 |
| 連外網 | 需能連到 `wss://ws.ptt.cc/bbs`。 |

## 雲端 session（Claude Code on the web）

環境由兩段接力，目標是開 session 就能直接跑 unit／offline e2e：

| 階段 | 做什麼 | 在哪 |
|---|---|---|
| 環境 Setup script（建環境時跑一次，結果被快取） | Node 24、corepack/Yarn 4、`yarn install --immutable`、`yarn playwright install --with-deps chromium firefox`、字型對齊 CI、clone `3rd_script/pttbbs`／`ptt-term` | `scripts/cloud-setup.sh` |
| SessionStart hook（每個 session） | 快取比 dev 舊時補上：`yarn.lock` 比 `node_modules` 新 ⇒ `yarn install --immutable`；`playwright-core` 要的 chromium／headless shell／ffmpeg／firefox revision 不在 ⇒ `yarn playwright install chromium firefox`。裝不起來才退回提醒；字型對齊 CI 沒做過就補做 | `scripts/check-remote-commits.mjs`（`CLAUDE_CODE_REMOTE=true` 才自己裝；本機只提醒） |

環境設定的 Setup script 欄位只放下面兩行（不假設當下工作目錄就是 repo），之後改 `scripts/cloud-setup.sh` 即可，新 session 生效：

```bash
f="$(find / -maxdepth 6 -path '*/scripts/cloud-setup.sh' -not -path '*/node_modules/*' 2>/dev/null | head -1)"
if [ -n "$f" ]; then bash "$f"; else echo "[setup] 找不到 scripts/cloud-setup.sh"; fi
```

Setup script 的輸出記在 `/root/.cache/pttchrome-cloud-setup.log`（第一行是呼叫端工作目錄、各步驟成敗），環境設定頁看不到，在 session 裡 `cat` 它查。

為什麼要第二段：Setup script 的結果被快取，dev 之後升了 `@playwright/test` 時，新 session 拿到的瀏覽器 revision 是舊的，unit-browser 與 e2e 會整批 `Executable doesn't exist`。headless shell 的目錄名是底線（`chromium_headless_shell-<rev>`），只查 chromium 本體會漏報。

**字型對齊 CI**（`scripts/cloud-fonts.mjs`）：雲端容器多裝了 CI 的 Playwright image 沒有的 DejaVu，終端機字型 `MingLiu, monospace` 在 Linux 落到 monospace＝DejaVu Sans Mono（CI 是 WenQuanYi Zen Hei Mono），字寬不同 ⇒ `screen_sanity` 的 `gridMisaligned`、`recording_triage` 在雲端必紅、CI 綠。以 fontconfig `rejectfont`（`/etc/fonts/conf.d/99-pttchrome-ci-parity.conf`）排除，不刪套件。雲端看到這兩支紅，先 `fc-match monospace` 確認不是 DejaVu。

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
