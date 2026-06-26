# PttChrome 來源驗證與官方版基底

調查日期 2026-06-02。目標：確認 https://term.ptt.cc 前端碼來源，並確立自維護基底。**結論：以官方版 `robertabcd/PttChrome @ dev` 為唯一基底（即本 repo）。**

---

## 0. 結論摘要（TL;DR）

- **來源驗證 = CONFIRMED**：term.ptt.cc 就是 `robertabcd/PttChrome`（branch `dev`）的 webpack 建置產物。最強證據：本機 `build` 產出的 `logo.c8fa42175331bab52f24fd5e64cf69bb.png` 雜湊與線上站台**逐位元相同**。
- **上游狀態**：`robertabcd/PttChrome:dev` 自 `2023-12-08` 起零提交（停滯但穩定，且為 PTT 實際服務之碼，信任度最高）。
- **安全**：採用前已對候選做過供應鏈/keystroke/端點稽核；官方版由 PTT 實際服務、無第三方依賴問題，作為基底最低疑慮。
- **基底決策**：採 **upstream**，按需自行現代化或 cherry-pick。曾評估兩個維護中 fork（`cf5146` 現代化 TS+Vite、`ccns` Docker 部署），**已棄用**（細節見 §5 歷史 pointer）。

---

## 1. 來源驗證 term.ptt.cc == robertabcd/PttChrome：CONFIRMED

| # | 證據 | 來源 |
|---|---|---|
| 1 | `dist/index.html` 結構（`#cmdHandler`/`#cmenuReact`/`#BBSWindow`+`id="t"` input／`#cursor.terminal_display`/`#reactAlert`）與線上 body 逐字相符 | 線上 curl ↔ `src/dev.html`（模板）/ build 後 `dist/index.html` |
| 2 | **建置產物雜湊吻合**：本機 build 的 `assets/logo.c8fa42175331bab52f24fd5e64cf69bb.png` == 線上 | `dist/assets/` ↔ 線上首頁 |
| 3 | bundle 命名 `assets/pttchrome.<hash>.js/.css`；`package.json` `name:"pttchrome"` | 線上首頁 ↔ `package.json` |
| 4 | 從 unpkg 載入 react@16.14 / jquery / bootstrap@3.4.1 / hammerjs（external）由 `src/dev.html` template 注入（版本取自 installed package；前身 `webpack-cdn-plugin` 已移除）| 線上 `<script src=unpkg…>` ↔ deps |
| 5 | repo `homepage` 欄位 = `https://term.ptt.cc` | GitHub API repo metadata |

> JS bundle 雜湊（線上 vs 本機）不同屬正常 —— minify/依賴版本漂移會變動 JS 雜湊；靜態圖片 asset 位元相同已足證來源。

**血緣**：`iamchucky/PttChrome`（最初 Chrome extension）→ `robertabcd/PttChrome`（web/term 版，term.ptt.cc 採用，預設分支 `dev`）。

---

## 2. Origin 白名單（決定部署設計的根本約束）

實測（bun headless WebSocket）：

| Case | 連線 | Origin | 結果 |
|---|---|---|---|
| A | `wss://ws.ptt.cc/bbs` | `https://term.ptt.cc` | **OK**，101 + 1024 bytes（首訊息 `HTTP/1.1 200 OK\r\n\r\n` + 畫面）|
| B | 同上 | `http://localhost:8080` | **拒絕**，`Expected 101 status code`、close 1002、0 bytes |

→ 瀏覽器無法自設 `Origin`（forbidden header），故從 localhost/自有網域**直連必被擋**；必須有一個**會把 Origin 改寫成 `https://term.ptt.cc` 的反向代理**。

官方版的因應：
- **本機開發**：`webpack-dev-server` 內建 `/bbs` proxy 已改寫 Origin，`yarn start` 直連真 PTT（見 `run-local.md`）。
- **純靜態部署**：需自備改寫 Origin 的反向 proxy、部署於白名單網域，或用瀏覽器擴充於網路層改寫 Origin（見 `origin-rewrite-extension.md`）。

---

## 3. 可運作性驗證

`dist/` 預設只含空 `.gitkeep`（未附 bundle），須 build。src 為 JSX/ES6，須 webpack 編成 bundle 瀏覽器才載入。

| 工具鏈 | install | build | 產物 | 線上佐證 |
|---|---|---|---|---|
| webpack4 | OK（1010 pkgs）| **OK** | `dist/assets/pttchrome.<hash>.js`；logo 雜湊吻合線上 | term.ptt.cc |

> 本機跑：見 `run-local.md`（`yarn start` / `yarn build`）。連線 PTT 需可達 `wss://ws.ptt.cc/bbs`。

---

## 4. 端點清單（稽核 ground truth）

- 官方 BBS websocket：`wss://ws.ptt.cc/bbs`（Origin allowlist：`https://term.ptt.cc`）
- 連線 scheme：`wsstelnet://` → `wss:443`、`wstelnet://` → `ws:80`（解析於 `src/js/pttchrome.js:172,199`）

---

## 5. 歷史 pointer（已棄用的 fork 路線）

> 2026-06 期間曾並列評估兩個維護中 fork 作為基底，**最終採 upstream，已刪除兩 fork**（皆有 GitHub remote 可還原）。摘要保留以備日後 cherry-pick 參考：
>
> - **`cf5146/PttChrome` @ dev**（ahead 51）：現代化重構 —— TypeScript + Vite + Vitest + React 19 + Bootstrap 5 + CI/Pages。安全稽核 CLEAN，唯 dev/Pages 預設將 PTT websocket 經維護者 Cloudflare Worker 中轉（自架須改）。棄用原因：相對線上實證的 webpack 版分歧過大、單人維護。
> - **`ccns/PttChrome` @ main-ccns.2021**（ahead 86）：部署服務化 —— Docker + nginx + 多網域部署 + 可設定 BBS host；保留 webpack4/React16；運營中 term.ccns.cc。安全稽核 CLEAN。棄用原因：含 CCNS 品牌與部署設定，與「貼近官方」目標不符。
> - 兩 fork 的核心客戶端邏輯（`pttchrome`/`ansi_parser`/`term_*`/websocket/telnet）皆保留上游語意；若需現代化或部署 infra，可從這兩個 GitHub repo 選擇性 cherry-pick。

---

## 附錄：本機資料佈局

```
ptt_client/            ← = robertabcd/PttChrome @ dev 的 .git 那層（本 repo）
  src/  dist/  node_modules/  package.json  webpack.config.js
  docs/
    run-local.md                 本機啟動官方版
    pttchrome-research.md         本檔
    origin-rewrite-extension.md   瀏覽器直連 PTT 的擴充方案
```
