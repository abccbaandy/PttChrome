# 收尾剩餘 Dependabot alerts（yarn1 限制 → 建議遷 yarn4）

STATUS: TODO（step 0 DONE；剩 step 2/3 + bootstrap）
SCOPE: 上一輪（commit e9bd09e + js-yaml/picomatch lock refresh）已關 #13/#1/#8/#21/#34/#45/#46/#25/#37。
本輪 **step 0 DONE**：移除 firebase-tools devDep、emulator 改 Docker（見下方 step 0）。
本 md 處理**剩餘**且**無法用 yarn1 乾淨修**的 alert。全部 dev/build scope 或 runtime-但無修補版，**實際風險低**。

## 核心限制（先讀，否則會重蹈覆轍）
**yarn1 的 bare `resolutions` 會把該套件「所有 major」壓成同一版本**，不是只動目標那條 major line。
- 已驗證：`minimatch: ^3.1.2` 把 `^5/^6/^9` 的消費者一起壓成 3.1.5（CI 剛好沒踩爆）；
  `js-yaml: ^3.14.2` 會把 `json-schema-ref-parser` 的 `^4.1.0` 壓成 3.14.2（破壞 firebase-tools）；
  `picomatch: ^2.3.2` 會把 css-minimizer/tinyglobby 的 `^4` 壓成 2.3.2。→ **跨 major 壓制 = 語意錯誤的潛在地雷，禁用**。
- yarn1 的 **scoped path resolution**（`request/qs`、`a/b` 形式）在本 repo 版本（1.22.22）**不生效**，只會產生 phantom selector block（已驗證，見 commit e9bd09e 過程）。
- #25/#37 之所以能修，是因為它們的 vulnerable copy 與 patched copy **同 major**，靠「讓 stale `^` 範圍自然重解到同 major 最新 patch」達成（lock refresh，非 resolution）。多 major 並存的就沒這條路。

## 剩餘 alerts（決策表）
step 0 移除 firebase-tools 後，用 `yarn why` 重新確認來源（已驗證，2026-06）：
| # | 套件 | sev/scope | 來源（移除 fb-tools 後） | 為何難修 | 建議 |
|---|---|---|---|---|---|
| #3 | node-fetch <2.6.7 | high / 名義 runtime | `recompose#fbjs#isomorphic-fetch@2.2.1#node-fetch@1.7.3`（fb-tools 的 node-fetch 2/3 已隨移除消失，僅剩此 1.x）| isomorphic-fetch@2 綁 node-fetch@^1.0.1（無 1.x 修補版，跨 major resolution 會破壞）| **實質不可達**：isomorphic-fetch 的 browser field→whatwg-fetch，node-fetch **不進 browser bundle**（grep entry chunk 無）。真要消：移/換 recompose（0.26.0 已停更）或 yarn4 override |
| #43 | uuid <11.1.1 | med / dev | `webpack-dev-server#sockjs#uuid@8.3.2` + `webpack-cdn-plugin#sri-create#request#uuid@3.4.0`（fb-tools 的 gaxios#uuid@9 已消失）| 多 major 並存 | uuid@3.4.0 隨 step 2 消；uuid@8.3.2（dev-server）待 yarn4 override |
| #44 | js-yaml ≤4.1.1 | med / dev | 4.x 線（tree 已 **4.2.0** 修補）| — | 等下次掃描自動關；未關再查 |
| #10 | tough-cookie <4.1.3 | med / dev | `webpack-cdn-plugin#sri-create#request#tough-cookie@2.5.0` | request 上 2.x→4.x major，破壞風險 | 隨 step 2 消滅 |
| #9 | request ≤2.88.2 | med / dev | `webpack-cdn-plugin@3.3.1 → sri-create → request@2.88.2` | request **無任何修補版**（2.88.2 已是 last、deprecated）| 只能**移除 webpack-cdn-plugin**（step 2）|
| #22/#23 | bootstrap 3.4.1 | med / runtime | 直接 dep | **無修補版**（3.x 全系列受影響），UI 綁 BS3（見 `bootstrap_css_guard.offline.spec.js`）| out of scope，除非遷 BS4/5（大工程）|

**step 0 對 alert 的實際效果**：firebase-tools 整棵子樹（node-fetch 2/3、gaxios#uuid@9、update-notifier-cjs、tough-cookie@4.x 那批的 fb-tools 來源等）連同**未來 firebase-tools 漏洞**一次離開 lockfile。但 #3/#43 **不會全關**——node-fetch@1.7.3、uuid@8.3.2/3.4.0 另有 recompose/webpack 來源。push 後以下次 dependabot 掃描為準確認哪些真關閉。

## 建議實作方向 + 順序

### 0. ✅ DONE（2026-06）：firebase-tools 移出 lockfile，emulator 改 Docker —— 治本
**已實作（方案 A）**：
- `package.json`：移除 `firebase-tools` devDep；`test:integration` → `node scripts/run-integration.mjs`。
- `scripts/run-integration.mjs`（新）：`docker run -d` pinned image `andreysenov/firebase-tools:15.22.3-node-22`（內含 firebase-tools+OpenJDK），掛 `firebase.json`/`firestore.rules`/`firestore.indexes.json`（ro）→ `waitHttp`（HTTP 健康檢查，非 TCP） 輪詢 auth:9099/firestore:8089 → host 跑 jest（注入 `*_EMULATOR_HOST` env）→ `finally` 拆容器。
- `firebase.json`：auth/firestore emulator 加 `host: 0.0.0.0`（容器埠映射用）。
- `.github/workflows/test.yml`：integration job 移除 setup-java + jar cache + `setup:emulators:firestore`，改靠 Docker（ubuntu runner 預裝 Docker）。
- 文件：CLAUDE.md「測試/CI」段、`docs/pref-sync-firestore.md`「測試」「為何 Docker」「deploy 改 npx」更新。
- **prod 確認**：設定同步用 `firebase`（client SDK，`dependencies` ^12.14.0，`pref_sync.js` dynamic import），與 firebase-tools 無關 → 移除零影響。
- **本機限制**：本機無 Docker → 本機無法跑 integration，靠 CI 驗（已與使用者確認）。本機驗過 build+unit(223) 綠。
- **效果**：見上方決策表「step 0 對 alert 的實際效果」。

<details><summary>原始評估（保留備查）</summary>
**為何最高 CP**：firebase-tools 是 dev 依賴裡最大膨脹源，也是 #3/#43/#44/#10 的母套件；升級（step 1）只是治標（這批清完還會再噴新的）。
**用途盤點（精準，已查）**：本專案 firebase-tools **只**做兩件事，皆 dev/CI，**絕不進 production bundle**：
- `firebase emulators:exec --only auth,firestore`（`package.json:128` 的 `test:integration`，跑 Auth+Firestore emulator）
- 偶爾手動 `firebase deploy --only firestore:rules`（`docs/pref-sync-firestore.md:65`，部署 `firestore.rules`，非自動化）
→ 所有 firebase-tools alert 都是 **dev/CI-only 低風險**，被 dependabot 掃到多屬「雜訊」（從不出貨）。

**「純 emulator、棄用 firebase-tools npm」的可能性（已查證）**：
- ⚠️ **Emulator Suite 官方只透過 firebase-tools 發布**，沒有獨立的 emulator npm 套件。emulator 本體是 Java jar，由 firebase-tools 啟動時自抓。無法「只裝 emulator 不裝 firebase-tools」。
- `@firebase/rules-unit-testing`：只簡化「測試端 glue」（連 emulator、套 rules），**仍需 emulator 在跑** → **不移除** firebase-tools。對本專案測試碼精簡有限（現用真 modular SDK + `emulators:exec`，見 `docs/pref-sync-firestore.md`）。
- 真正能「讓 firebase-tools 離開 committed lockfile → dependabot 不再掃其子樹」的路：
  - **(A) Docker 容器跑 emulator**（CI 用含 emulator 的映像，如社群 `andreysenov/firebase-tools` 或自建）：firebase-tools 完全移出 `package.json`/lockfile → #3/#43/#44/#10 **連同未來 firebase-tools 漏洞一次消失**。代價：CI 改用 service container；**本機跑 integration 需 Docker**（或本機仍 `npx firebase-tools` 留 local-only）。
  - **(B) 改 `npx firebase-tools@15 emulators:exec ...`，從 devDeps 移除**：不進 lockfile → dependabot 噤聲。代價：失去 lockfile pin（用 `@15` 半 pin）、CI 每次下載（**需自建 cache**，否則變慢）、與現行「yarn 管全部」慣例略衝突。
  - **(C) 移進獨立 `tests/integration/package.json` 或 `optionalDependencies`**：主 `yarn install`（dev/build）不拉 firebase-tools；但只要它仍在**任一 committed lockfile**，dependabot 照掃 → **對消 alert 無效**，僅減少日常 install 體積。要消 alert 必須讓它**完全離開所有 committed lockfile**（即 A 或 B）。

**取捨結論**：emulator 無更輕的官方替身；棄用 firebase-tools = 把「dev 套件漏洞掃描雜訊」換成「多一層 Docker infra」或「CI 變慢+失 pin」。
- 若覺得 firebase-tools alert 反覆噴很煩、且 CI 已有/願加 Docker → **(A) 最乾淨**（治本，含未來）。
- 若只想止血又不想動 infra → 先 step 1 升版治標即可，**別為了消 dev-only alert 引入 Docker/失 pin**（同 ROI 邏輯）。
- **務必保留**：`demo-` 前綴 project id（保證離線、不打正式專案）、`firestore.rules` 實際 enforce、真 SDK 無 mock 這幾個 integration 測試的核心性質（見 `docs/pref-sync-firestore.md`）。換任何方案後，`yarn test:integration` 等價行為（啟動還原/他機推播/permission-denied）必須照舊全綠。

</details>

### 1. ~~升 firebase-tools~~ —— MOOT（step 0 已整個移除 firebase-tools，不再升版）
<details><summary>原始 step 1（保留備查）</summary>
升 firebase-tools `^15.20.0 → ^15.22.3`
一次清掉 firebase-tools 子樹的 transitive 漏洞（**#43 uuid、#3 node-fetch 的 2.x 那批、#37/#44 類**），15.22.3 已宣告 `js-yaml ^4.2.0` 等較新範圍。
- 動作：改 package.json devDeps → `yarn install` 重解子樹。
- **風險**：firebase-tools 子樹龐大，重解會大幅改 lock；且 **integration emulator CI 本來就 flaky**（見 CLAUDE.md「integration job 偶發 timeout」）。
- **驗證（必跑）**：本機 `yarn test:integration`（需 Java 21+，<5s 全綠才算過）→ build → unit → offline-e2e → push 後盯 integration job 兩三次 run 確認沒被搖出 flaky。
- 註：#3 的 `isomorphic-fetch@1.x` 那條可能仍殘留（深埋 update-notifier-cjs），升完再查 `dependabot/alerts/3` 是否真關。
</details>

### 2.（中風險、可選，下一步）移除 `webpack-cdn-plugin` → 清 #9 + #10 + uuid@3.4.0
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
- **建議順序**：先 0.（firebase-tools 升版治標，或評估隔離/Docker 治本）+ 2.（移 cdn-plugin）能清的清掉，**剩下真的非 yarn4 不可的才評估遷移**。多數剩餘 alert 是 dev-only 低風險，遷 yarn4 的 churn/風險很可能**不划算** → 先確認「還剩哪些、嚴重度、是否 runtime」再決定，不要為了湊綠而遷。
- 遷移本身做法：`corepack prepare yarn@4.x --activate` → `yarn set version 4.x` → 建 `.yarnrc.yml`（`nodeLinker: node-modules`）→ `yarn install` 重生 lock → 全測試矩陣（unit/integration/offline-e2e/live-e2e）+ build + 本機 `yarn start` 連真 PTT 冒煙 → 改 CI。**改後務必跑 live e2e**（渲染/連線路徑）。

## 完成定義
- 做完每步後，更新本 md 的決策表（移除已關 alert）；若所有剩餘 alert 都關閉或確認 won't-fix，刪掉本 md。
- 每步 push 後查 CI（`deploy.yml` 全綠，integration flaky 處置見 CLAUDE.md）。
- 純安全修補、無使用者可見新功能 → **不需動 README**。
