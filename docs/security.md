# 安全縱深：CSP 與依賴冷卻期

動 `index.html`、新增外部連線／script／內嵌、或改 Dependabot 設定前先讀這份。

## Content-Security-Policy（`scripts/csp.mjs`）

- **只在正式版**：`cspMetaPlugin`（`apply: 'build'`）在 `vite build` 把 `<meta http-equiv="Content-Security-Policy">`
  插到 `<head>` 最前面。dev server 不加：Vite dev 會塞行內 preamble，加了只會擋自己。
- **GitHub Pages 不能設 header ⇒ 只能用 meta**：沒有 `report-uri`、`frame-ancestors`、`sandbox`。
- **收得緊的只有 script-src**：本站＋建置時算 hash 的行內 `<script>`＋兩組 Google script
  （Firebase Google 登入的 `apis.google.com`、App Check 的 reCAPTCHA Enterprise `www.google.com/recaptcha/`、
  `www.gstatic.com/recaptcha/`）。`object-src 'none'`、`base-uri`／`form-action 'self'`。
- **刻意放寬的**（收不緊，理由寫在 `scripts/csp.mjs` 檔頭）：connect-src 只限協定（使用者自填 proxy／relay、
  oEmbed、APK 的 `ws://127.0.0.1` 本機 proxy）、img／media 任何網站、frame-src `https:`、style 要 `'unsafe-inline'`（Mantine）。
- **APK**：WebView 載的是同一份正式版，CSP 一樣生效；原生注入的 document-start script 與 `evaluateJavascript`
  是內嵌端執行，不受頁面 CSP 管。

### 新增東西時

| 要加的 | 要做的 |
|---|---|
| 行內 `<script>` | 不用改，hash 建置時自動算。但**不准**行內事件屬性（`onclick=`）與 `javascript:` 網址（hash 救不了）。 |
| 動態載入外部 script | 加進 `EXTERNAL_SCRIPT_SOURCES`，在 `tests/unit/csp.test.js` 補該網址。 |
| 新的連線協定（非 https／wss／ws） | 改 `connect-src`。 |
| 內嵌非 https 的 iframe | 不行，改 https。 |

### 守護

- `tests/unit/csp.test.js`：hash 對得上、meta 在任何 script／link 之前、index.html 沒有行內事件屬性、
  Firebase SDK 會載的 script 網址都放行（SDK 換網域先紅）、程式會連的代表網址都放行、plugin 只在 build。
- offline e2e：`tests/e2e/helpers/csp_guard.js` 由 `installReplay` 對每一條 offline spec 收
  `securitypolicyviolation`，有就紅。CI 的 offline／adverse 跑打包版（`E2E_SERVER=bundle`）才有 CSP；
  本機預設 dev server 沒有，要驗就 `E2E_SERVER=bundle yarn test:e2e:offline`。
  `tests/e2e/offline/csp.offline.spec.js` 驗 meta 真的在、而且外部 script 真的被擋（否則 guard 永遠收不到東西）。
- e2e 測不到雲端同步（不連 Firebase）：Google 登入與 App Check 靠上面 unit 掃 SDK 網址；改了 script-src 要在
  正式站實際登入一次。

## Dependabot 冷卻期

`.github/dependabot.yml` 兩個 ecosystem 都是 `cooldown: default-days: 7`：新版發佈滿 7 天才開升版 PR
（被下架的惡意版本通常幾天內就撤），安全性更新不受影響。守護 `tests/unit/dependabot_groups.test.js`。
