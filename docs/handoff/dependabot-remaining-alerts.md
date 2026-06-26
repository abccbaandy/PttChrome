# 收尾剩餘 Dependabot alerts（yarn1 限制 → 建議遷 yarn4）

STATUS: TODO
SCOPE: 上一輪（commit e9bd09e + 本輪 js-yaml/picomatch lock refresh）已關 #13/#1/#8/#21/#34/#45/#46/#25/#37。
本 md 處理**剩餘**且**無法用 yarn1 乾淨修**的 alert。全部 dev/build scope 或 runtime-但無修補版，**實際風險低**。

## 核心限制（先讀，否則會重蹈覆轍）
**yarn1 的 bare `resolutions` 會把該套件「所有 major」壓成同一版本**，不是只動目標那條 major line。
- 已驗證：`minimatch: ^3.1.2` 把 `^5/^6/^9` 的消費者一起壓成 3.1.5（CI 剛好沒踩爆）；
  `js-yaml: ^3.14.2` 會把 `json-schema-ref-parser` 的 `^4.1.0` 壓成 3.14.2（破壞 firebase-tools）；
  `picomatch: ^2.3.2` 會把 css-minimizer/tinyglobby 的 `^4` 壓成 2.3.2。→ **跨 major 壓制 = 語意錯誤的潛在地雷，禁用**。
- yarn1 的 **scoped path resolution**（`request/qs`、`a/b` 形式）在本 repo 版本（1.22.22）**不生效**，只會產生 phantom selector block（已驗證，見 commit e9bd09e 過程）。
- #25/#37 之所以能修，是因為它們的 vulnerable copy 與 patched copy **同 major**，靠「讓 stale `^` 範圍自然重解到同 major 最新 patch」達成（lock refresh，非 resolution）。多 major 並存的就沒這條路。

## 剩餘 alerts（決策表）
| # | 套件 | sev/scope | 來源 | 為何難修 | 建議 |
|---|---|---|---|---|---|
| #3 | node-fetch <2.6.7 | high / runtime | `firebase-tools → update-notifier-cjs → isomorphic-fetch@1.x → node-fetch@1.7.3` | tree 有 node-fetch 1/2/3 三 major 並存；isomorphic-fetch@1.x 綁 node-fetch@1.x | 升 firebase-tools 或 yarn4 scoped override |
| #43 | uuid <11.1.1 | med / dev | `firebase-tools#gaxios#uuid@9.0.1`（及 8.3.2/3.4.0）| uuid 3/8/9/11/14 五 major 並存 | 升 firebase-tools / yarn4 override |
| #44 | js-yaml ≤4.1.1 | med / dev | 4.x 線 | tree 已是 **4.2.0**（已修補）→ 應**下次掃描自動關**，無需動作 | 等自動關；未關再查 |
| #10 | tough-cookie <4.1.3 | med / dev | `request#tough-cookie@2.5.0` | request 上 2.x→4.x 是 **major**，破壞風險 | 隨「移除 webpack-cdn-plugin」一起消滅 |
| #9 | request ≤2.88.2 | med / dev | `webpack-cdn-plugin@3.3.1 → sri-create → request@2.88.2` | request **無任何修補版**（2.88.2 已是 last、deprecated）| 只能**移除 webpack-cdn-plugin** |
| #22/#23 | bootstrap 3.4.1 | med / runtime | 直接 dep | **無修補版**（3.x 全系列受影響），UI 綁 BS3（見 `bootstrap_css_guard.offline.spec.js`）| out of scope，除非遷 BS4/5（大工程）|

## 建議實作方向 + 順序

### 1.（低風險、優先）升 firebase-tools `^15.20.0 → ^15.22.3`
一次清掉 firebase-tools 子樹的 transitive 漏洞（**#43 uuid、#3 node-fetch 的 2.x 那批、#37/#44 類**），15.22.3 已宣告 `js-yaml ^4.2.0` 等較新範圍。
- 動作：改 package.json devDeps → `yarn install` 重解子樹。
- **風險**：firebase-tools 子樹龐大，重解會大幅改 lock；且 **integration emulator CI 本來就 flaky**（見 CLAUDE.md「integration job 偶發 timeout」）。
- **驗證（必跑）**：本機 `yarn test:integration`（需 Java 21+，<5s 全綠才算過）→ build → unit → offline-e2e → push 後盯 integration job 兩三次 run 確認沒被搖出 flaky。
- 註：#3 的 `isomorphic-fetch@1.x` 那條可能仍殘留（深埋 update-notifier-cjs），升完再查 `dependabot/alerts/3` 是否真關。

### 2.（中風險、可選）移除 `webpack-cdn-plugin` → 清 #9 + #10
- 現況：`webpack.config.js:128` 用它把 React/jQuery/Bootstrap externalize 到 CDN（見 `new WebpackCdnPlugin({...})`）。
- 替代：改用 webpack 原生 `externals`（map `react→React` 等）+ 在 HTML template 手動注入對應 CDN `<script>`（含 SRI 可選）。或改本地打包（會變大、失去 CDN 快取，不建議）。
- **影響部署 bundle 與首屏載入** → 改後**必跑 e2e**（live + offline），確認 React/jQuery/Bootstrap 仍正確載入、畫面不爆。
- 收益僅 #9 + #10（皆 med、dev-only），ROI 偏低 → 排在 firebase-tools 之後，視意願做。

### 3.（戰略、最後）yarn1 → yarn4 遷移
**動機**：上面 #3/#43 等「多 major 並存」漏洞，yarn1 無法 surgical 修（bare resolution 跨 major 壓制、scoped path 不生效）。yarn3/4 的 `resolutions`＋npm 風格 `overrides` 支援**可靠的巢狀/路徑指定**，能「只把 request 的 form-data 釘 2.5.6、其餘走 4.0.6」這種精準操作，根治本類問題。
- **但這是大工程，且抵觸現行慣例**：CLAUDE.md 明訂用 yarn1、`yarn.lock` v1、`packageManager: yarn@1.22.22`、corepack。遷移要動：
  - lockfile 格式（v1 → berry `yarn.lock` 不同語法）、linker 選 `node-modules`（**勿用 PnP**，webpack5/babel/jest/playwright 對 PnP 相容性雷多）。
  - `.yarnrc.yml`（`nodeLinker: node-modules`、`enableGlobalCache` 等）。
  - `package.json` `packageManager` → `yarn@4.x`；CI workflow（`deploy.yml`）的 `corepack enable` / install 步驟。
  - husky/lint-staged、所有 `yarn xxx` script 行為差異複查。
- **建議順序**：先把 1.（firebase-tools）和 2.（移 cdn-plugin）能清的清掉，**剩下真的非 yarn4 不可的才評估遷移**。多數剩餘 alert 是 dev-only 低風險，遷 yarn4 的 churn/風險很可能**不划算** → 先確認「還剩哪些、嚴重度、是否 runtime」再決定，不要為了湊綠而遷。
- 遷移本身做法：`corepack prepare yarn@4.x --activate` → `yarn set version 4.x` → 建 `.yarnrc.yml`（`nodeLinker: node-modules`）→ `yarn install` 重生 lock → 全測試矩陣（unit/integration/offline-e2e/live-e2e）+ build + 本機 `yarn start` 連真 PTT 冒煙 → 改 CI。**改後務必跑 live e2e**（渲染/連線路徑）。

## 完成定義
- 做完 1（或 1+2）後，更新本 md 的決策表（移除已關 alert）；若所有剩餘 alert 都關閉或確認 won't-fix，刪掉本 md。
- 每步 push 後查 CI（`deploy.yml` 全綠，integration flaky 處置見 CLAUDE.md）。
- 純安全修補、無使用者可見新功能 → **不需動 README**。
