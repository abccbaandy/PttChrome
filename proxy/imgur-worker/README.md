# ptt-imgur-cache — imgur 快取代理（Cloudflare Worker）

根因與量測數據見 [`docs/imgur-latency-research.md`](../../docs/imgur-latency-research.md)。
一句話：imgur 的 Fastly 把台灣流量導到美國西岸 BUR，20–25% 的請求隨機 stall 9–24 s。
本代理**不是靠地理位置**（免費 Workers 對台灣落在 LAX，RTT 與直連 imgur 相同），
而是把不穩定的「使用者→Fastly BUR」鏈路換成穩定的「使用者→Cloudflare」＋美國境內回源。

**已部署**：`https://ptt-imgur-cache.ptt-relay-8xquy.workers.dev`

實測（20 次取樣，同機同時段）：

| | median | max | avg | stall |
|---|---|---|---|---|
| 本代理（HIT） | 0.963 s | **1.036 s** | **0.969 s** | **0/20** |
| imgur 直連 | 0.994 s | 15.667 s | 3.182 s | 4/20 |

MISS 也比直連快（LAX→BUR 是美國境內），冷門圖同樣受益：`ajHklmb` MISS 1.14 s vs 直連 22.9 s。

**這個目錄與 app 完全獨立**（自己的 `package.json`，不進主專案 workspace，`yarn install`
不會碰它）。app 端整合是後續工作，見 `docs/handoff/imgur-proxy-integration.md`。

## 契約

```
GET|HEAD  https://<worker>/<imgur-id>.<jpg|jpeg|png|gif|webp>
          → 200 圖片，Cache-Control: public, max-age=31536000, immutable
          → 302 https://i.imgur.com/<id>.<ext>   （上游 4xx/5xx/非圖片/連線失敗）
          → 404 （路徑不合白名單）
```

- **mp4／webm 刻意不支援**：Cloudflare 服務條款允許 Workers 服務圖片／音訊，**排除影片檔**。
  影片維持直連 imgur。
- 回源不帶 `Referer`（imgur 對 `*.ptt.cc` 回 403）。
- 回應帶 `Access-Control-Allow-Origin: *` 與 `Access-Control-Expose-Headers: content-type,
  content-length` ⇒ `src/js/imgur_probe.js` 的 HEAD 探測可直接改打這裡。
- **fail-open**：代理出任何狀況都 302 回原址，最差等於現況。

## 部署

需 Cloudflare 帳號（免費方案即可）與 Node。

```bash
cd proxy/imgur-worker && npm install && npx wrangler login && npx wrangler deploy
```

`wrangler login` 會開瀏覽器做 OAuth。部署完會印出 `https://ptt-imgur-cache.<subdomain>.workers.dev`。

**踩坑：部署後最初數次請求會回 500**（實測連 4 次），約一分鐘後自行恢復且之後穩定。
原因未確認（疑似 Workers Cache 首次啟用的傳播）。**別急著改 code**——先隔一分鐘重試，
並用 `/`（應 404）、`OPTIONS`（應 204）確認 handler 本身沒問題。

## 驗證快取真的生效（必做）

Workers Cache 命中時 **Worker 不會執行**，所以回應裡的 `x-imgur-proxy-fetched-at`
不會更新——兩次請求拿到**相同**時間戳即為命中：

```bash
W=https://ptt-imgur-cache.ptt-relay-8xquy.workers.dev
for i in 1 2 3; do curl -s -o /dev/null -D - "$W/L976tXr.jpg" -w "  total=%{time_total}\n" | grep -iE 'x-imgur-proxy-fetched-at|^age:|total='; done
```

預期：三次的時間戳**完全相同**且 `Age` 逐次遞增（實測 35→36→37）。
注意 **HIT 不會讓單張圖變快**（median 仍 ~0.96 s，代理落在 LAX 而非台灣），
價值在於消除 10 s 級離群值——所以**別用「有沒有變快」判斷快取是否生效**，要看時間戳。
若時間戳每次都變 ⇒ 快取沒生效，先查：

- `wrangler.jsonc` 的 `cache.enabled` 是否為 `true`，且 `wrangler >= 4.69.0`
- `compatibility_date` 是否夠新
- 回應是否真的帶得出 `Cache-Control: public, max-age=...`（`no-store` 不會被快取）

穩定性回歸（對照 research doc 的 20 次取樣）：

```bash
for i in $(seq 1 20); do curl -s -o /dev/null -w "%{time_total}\n" "$W/L976tXr.jpg"; done
```

目標：20/20 落在 ~1 s、**無 10 s 級離群值**（實測 min 0.943／max 1.036）。

## 快取 TTL

| 層 | 值 | 在哪調 |
|---|---|---|
| 邊緣 + 瀏覽器 TTL | **1 年**（`max-age=31536000, immutable`） | `src/index.js` 的 `IMMUTABLE` 常數 |
| 跨 Worker 版本共用 | **開啟** | `wrangler.jsonc` 的 `cross_version_cache: true` |
| 錯誤回應 | 不快取（`no-store`） | `passthroughHeaders` 的 `cacheable` 分支 |

- imgur 資產以 hash 定址、**內容永不變** ⇒ 1 年 + `immutable` 是正確選擇，沒有調短的理由。
- 調長也沒意義：實際保留時間受 Cloudflare 的 LRU eviction 決定（冷門資產會被踢掉），
  官方**不保證**保留到 max-age。`Age` 標頭就是該物件目前的實際存活秒數。
- **`cross_version_cache` 必須維持 `true`**：預設 `false` 會讓每次 `wrangler deploy` 作廢
  全部快取、命中率從零重算。已實測：開啟後重部署，`Age` 從 1738 延續到 1800、
  `x-imgur-proxy-fetched-at` 維持原值。
  代價是改了本 Worker 的**回應內容**後仍會吐舊回應——真要強制汰換就改路徑前綴，
  別把這個關回 `false`。

## 額度與風險

### 怎麼看用量

```bash
npm --prefix proxy/imgur-worker run usage
```

`scripts/usage.mjs`：沿用 `wrangler login` 的 OAuth token 打 GraphQL Analytics API，
印出今日執行次數 / 100 000 免費額度。`--days=N` 可看多天。
（本機沒有 `jq`，別用 `curl | jq` 拼——見 CLAUDE.md 記載的踩坑。）
Dashboard 路徑：Workers & Pages → `ptt-imgur-cache` → Metrics。

### 額度

| 項目 | 免費方案 | 備註 |
|---|---|---|
| 請求數 | 100 000/day（UTC 午夜重置） | 超過回 Error 1027。**快取命中不計入**，見下 |
| CPU time | 10 ms/request | 本 Worker 是 streaming pass-through，遠低於上限 |
| Subrequest | 50/request | 本 Worker 每次執行 1 個 |
| 可快取物件 | 512 MB | imgur 單圖遠低於此 |

**快取命中不消耗額度（CONFIRMED）**：命中時 Cloudflare 直接回應、Worker 根本不執行。
實測本 session 的開發驗證共發出約 70 次 HTTP 請求，Analytics 只記錄 19 次 invocation
（`subrequests=18`≈ 每次執行都回源一次），且按分鐘分組後 **19 次全部集中在快取建立的
那 11 分鐘內**，之後的請求（含刻意打的 10 次命中）沒有產生任何 invocation。
⇒ 計費單位是**回源次數**，不是使用者請求數。對整合後的估算意義重大：命中率越高，
額度消耗越低，而 imgur 資產永不變、TTL 一年 ⇒ 熱門圖幾乎只付第一次的錢。

**Analytics 延遲約 2–3 分鐘，但不保證逐筆精確。** 實測有 1 次確實執行了 Worker 的
invocation（回應帶著新的 `x-imgur-proxy-fetched-at`）從未出現在 Analytics —— 資料集名稱
裡的 "Adaptive" 就是自適應取樣，低流量下通常 1:1，但不保證。
⇒ **看趨勢與量級可信，別拿它逐筆對帳。** 要確認某次請求是否執行了 Worker，直接看回應的
`x-imgur-proxy-fetched-at` 有沒有更新，比查 Analytics 快也準。
（重部署**不會**影響記錄——曾懷疑過，已用「部署後打三張新圖 → 2 分鐘內如實 +3」推翻。）

- **imgur 對 Cloudflare 出口 IP 限流**：公用 proxy `wsrv.nl` 實測被回 429。自建 Worker
  流量小應無虞，但要監控 302 fail-open 的比例（`wrangler tail`）。**這是本方案最大的
  未知風險**——流量上來後才會知道 imgur 會不會擋，上線初期要盯。
- **落在 LAX 不是 TPE**（免費方案）。median 因此沒有改善，只有離群值被消除。
  `unknown`：Workers Paid（US$5/月）是否改善 colo 未驗證。
