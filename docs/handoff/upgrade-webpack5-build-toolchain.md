# 升級 build toolchain：webpack 4 → 5

## 為什麼

webpack 4 的 acorn 不認 ES2020 語法（`?.` / `??`），且 babel-loader 只轉譯 `src/` 不碰 node_modules → 任何發行檔含新語法的 npm 套件都無法 import（firebase v9+ 為代表，已被迫用 compat CDN lazy-load 繞過，見 `docs/pref-sync-firestore.md`）。

## 範圍

| 套件 | 動作 |
|---|---|
| webpack 4 → 5 | 主升級 |
| webpack-cli 3 → 5 | 配合 |
| webpack-dev-server 3 → 4/5 | **`/bbs` WS proxy 設定語法會變**（`devServer.proxy` 格式改陣列/物件），升級後必須重驗 Origin 改寫直連 `wss://ws.ptt.cc/bbs`（webpack.config.js 內 proxy + onProxyReqWs） |
| html-webpack-plugin 3 → 5 | 配合；html-webpack-harddisk-plugin 相容性需確認 |
| uglifyjs-webpack-plugin | 移除（webpack5 內建 terser） |
| css-loader / mini-css-extract-plugin | 升版 |
| file-loader / url-loader | 改 webpack5 asset modules |
| webpack-cdn-plugin | 確認 webpack5 相容（不行就換 externals + 手寫 script tag） |
| `NODE_OPTIONS=--openssl-legacy-provider` | 升級後可移除（webpack5 ≥5.61 不用 md4） |

## 驗收

- `yarn start` 開頁自動連 PTT（/bbs proxy 正常）
- `yarn test:unit` + `yarn test:e2e` 全過
- production build 成功、CDN script 注入正常

## 完成後收益（回遷）

- 可 `yarn add firebase` 改用 modular SDK：把 `src/js/pref_sync.js` 的 compat CDN script loader 換成 `import { initializeApp } ...`，API 對應：`firebase.auth()` → `getAuth`、`signInWithPopup`、`firestore().collection("users").doc(uid)` → `doc(db, "users", uid)`。其餘（pref_sync_logic、pref_storage、PrefModal）不用動。
