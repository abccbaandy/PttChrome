# 開站快取（Service Worker）

`public/sw.js`（SW 本體，classic script，不經 Vite 打包）＋`src/js/open_cache.js`（頁面端註冊／移除）。
pref `enableOpenCache`（設定 → 連線 → 開站快取），預設開。

## 為什麼要 SW

GitHub Pages 對所有檔案都回 `Cache-Control: max-age=600`、`Vary: Accept-Encoding`，而且改不了。
過了 10 分鐘，瀏覽器每次開站都要逐檔問「有沒有變」（ETag → 304），而且是串連的：
網頁 → 主 JS／preload 的轉碼表與字型 → 主 JS 執行後才抓的 lazy chunk。
沒有變的檔不會重新下載，但每一段都要等一趟來回。

Vite 產的檔名帶內容 hash（`assets/<名>-<8 字 hash>.<副檔名>`），檔名一樣內容就一定一樣，
所以真正需要問伺服器的只有網頁本身。頁面沒辦法叫瀏覽器跳過那些確認，只有 SW 攔得下來。

## 合約

| 請求 | 處理 |
|---|---|
| 導航到 scope 根目錄或 `index.html`（帶 query 也算） | 先問網路（navigation preload 與 SW 開機並行）；成功就用並存一份。斷線或 5xx 才退回存的那份；4xx 照原樣給 |
| scope 下 `assets/<名>-<hash>.<副檔名>` 的 GET（非 Range） | cache-first：有就直接用、一次網路都不打；沒有才下載，200 且 same-origin 才存 |
| 其他（manifest、圖示、`sw.js`、`.js.map`、跨站的圖床／Firebase／WebSocket） | 不碰，交給瀏覽器 |

- **每次都是最新版**：網頁本身永遠先問網路，所以不需要「有新版請重新整理」的提示。
  網頁本身仍照 HTTP 快取規則（navigation preload 走 HTTP 快取），10 分鐘內不會再問，跟沒有 SW 時一樣。
- **安裝時就存好**：install 時抓一次網頁，照它列出的帶 hash 檔先存（這時檔案都在瀏覽器的 HTTP 快取裡，幾乎不花網路），
  `clients.claim()` 接管目前頁面 ⇒ 第二次開站就生效。
- **比對一律 `ignoreVary`**：頁面的 crossorigin 請求在 Chromium 帶 `Origin`，SW 自己補抓的不帶；
  伺服器只要回 `Vary: Origin`（vite preview 就是）就永遠對不上、每次重抓。檔名已經決定內容，Vary 對這些檔沒意義。
- **清理**：網頁列出的檔案清單跟上次不同（新 build）才清，清掉新網頁沒列出的檔。lazy chunk 不在網頁清單裡，
  所以每次部署後第一次用到會再下載一次。舊版本 cache 名（`pttchrome-open-cache-` 開頭、不是目前版本）在 activate 時刪掉。
- **開關**：關掉＝頁面端 unregister 本站的 `sw.js`＋刪掉 `pttchrome-open-cache-` 開頭的 cache；這一頁仍由舊 SW 控制到下次開站為止。
  開機時開關是關的也會再清一次（關的過程中 SW 可能又把 cache 建回來）。
- **不註冊的情況**：dev server（`DEVELOPER_MODE`，Vite 檔名不帶 hash、HMR 不能被快取擋住）；
  沒有 `navigator.serviceWorker`（非安全來源，例如 APK 的區網 dev server 模式）。
- 一個 byte 都不送 PTT ⇒ 不在安全模式名單。

## 量測（vite preview＋Chromium，開站到 `#bootLoading` 拆掉，暖機後各 3 次）

| 情境 | 無 SW | 有 SW |
|---|---|---|
| 需要逐檔確認（過了 10 分鐘），RTT 300 ms | 約 1,320 ms | 約 450 ms |
| 同上，RTT 100 ms | 約 470 ms | 約 250 ms |
| 同上，RTT 0（本機） | 約 100 ms | 約 145 ms（SW 開機＋讀 Cache API 的固定成本） |
| 10 分鐘內（HTTP 快取還新鮮），RTT 0／100 ms | 約 85 ms | 約 85 ms |

結論：網路越慢差越多；10 分鐘內兩者一樣；只有本機零延遲時 SW 多約 40 ms（實際網路不會是零延遲）。

## 測試

- `tests/unit/open_cache_sw.test.js`：node vm 原樣載入 `public/sw.js`，假的 caches（照真的尊重 `Vary: Origin`）／fetch，
  驗上表每一列、換 build 清理、install／activate。
- `tests/unit/open_cache.test.js`：頁面端註冊時機（load 之後）、只移除本站的 SW 與 cache、dev 不註冊。
- e2e 跑在 dev server，不會註冊 SW；真瀏覽器行為（第二次開站零 assets 請求、離線照樣開站、關開關後零 SW）是用
  `vite preview`＋Playwright 手動驗的，改 `sw.js` 時照做一次：開站兩次後第三次只有網頁本身一個請求。
