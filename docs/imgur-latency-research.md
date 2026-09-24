# imgur／twimg／catbox 台灣連線慢 — 量測與根因

> **狀態：已落地。** Worker 在 `proxy/imgur-worker/`（已部署），app 端整合已完成
> （imgur 2026-08-08；twimg／catbox 2026-09-25，見文末兩節）：pref `useImgurProxy`（總開關，**預設開**）＋
> 各站 `imageProxy*`／`imgurProxyUrl`，UI 在設定的「連線」分頁，改寫層 `src/js/image_proxy.js`。契約與守護測試見
> `docs/enhanced-addon.md`「設定」節的「連線」分頁段。**不要重做本文的量測。**

量測環境：台灣家用寬頻（IPv4），2026-08-08 台灣時間 00:2x（**非尖峰**，尖峰只會更差）。
工具 `curl 8.7.1`，`--referer ""`，樣本圖 `i.imgur.com/L976tXr.jpg`（391 092 B PNG）。

## 結論（CONFIRMED）

1. **imgur 把台灣流量導到美國西岸，不是東京。** `i.imgur.com` → `ipv4.imgur.map.fastly.net`
   （Fastly，非 Cloudflare）。`X-Served-By` 6/6 取樣皆為 `cache-bur-*-BUR`（Burbank, CA）
   edge ＋ `cache-iad-*-IAD`（Ashburn, VA）shield。TCP connect 穩定 **137 ms**。
2. **不是 Fastly 對台灣整體差，是 imgur 這個 service 的 POP 選擇。** 同機同時間對照：

   | 目標 | edge POP | TCP connect |
   |---|---|---|
   | `i.imgur.com`（Fastly） | **BUR**（美國加州） | **137 ms** |
   | `files.pythonhosted.org`（Fastly） | NRT（東京） | 98 ms |
   | `www.fastly.com`（Fastly） | NRT（東京） | 61 ms |
   | `www.cloudflare.com` | **TPE（台北）** | **35 ms** |
   | `workers.dev` | **TPE（台北）** | **36 ms** |

3. **主要痛點不是頻寬或檔案大小，是「隨機 stall」。** 同一張圖連續 20 次：

   ```
   n=20  min=0.99  median=0.993  max=23.6  avg=4.31  (秒)
   原始值 23.6 0.99 12.5 0.99 11.9 10.2 0.99 0.99 0.99 0.99
           0.99 0.99 0.99 0.99 13.1 0.99 0.99 0.99 0.99 0.99
   ```

   **15/20 穩定 0.99 s，5/20 落在 10.2–23.6 s（25% 機率慢 10–24 倍）。**
   同時段 Cloudflare TPE 抓等大小（391 092 B）20 次：`min=0.127 median=0.150 max=0.166`
   —— **20/20 全穩，最大最小僅差 30%**。⇒ 本地上行、DNS、client 都沒問題。

4. **stall 發生在 TLS handshake 與 body 傳輸中途，不在 DNS/TCP。** 分段計時（8 次）：

   ```
   正常   dns=0.003 conn=0.137 tls=0.420 ttfb=0.557 total=0.989
   異常A  dns=0.017 conn=0.153 tls=0.992 ttfb=1.994 total=13.551   ← tls 就開始拖
   異常B  dns=0.003 conn=0.136 tls=0.833 ttfb=0.969 total=11.862   ← ttfb 正常，body 中途卡住
   ```

   `conn` 永遠 0.137 s（路由沒變），但 TLS 往返與 body 傳輸隨機卡秒級 ⇒ 典型跨太平洋
   鏈路丟包 + TCP 重傳。

5. **既有的 webp 優化救不了這個。** 同一資產不同變體：`_d.webp?maxwidth=1200` 只有
   36 642 B，`total=0.989`；原圖 391 092 B，`total=1.012` —— **檔案小 10.7 倍，時間一樣**。
   延遲完全由 RTT／stall 主導，壓縮沒有邊際效益。
   （webp 在 `docs/media-preview-addons.md` 記錄的改善，是省掉 imgur 原圖的 per-request
   長尾，與本文的鏈路 stall 是兩回事，兩者並存。）

## 解法實測：Cloudflare Worker 代理（CONFIRMED，已部署）

`proxy/imgur-worker/`，`https://ptt-imgur-cache.ptt-relay-8xquy.workers.dev`。同機同時段對照：

| | n | min | median | max | avg | stall 次數 |
|---|---|---|---|---|---|---|
| **Worker（快取 HIT）** | 20 | 0.943 | **0.963** | **1.036** | **0.969** | **0/20** |
| imgur 直連 | 20 | 0.988 | 0.994 | **15.667** | 3.182 | 4/20（8.9／11.4／11.7／15.7 s） |

**median 幾乎沒差（0.963 vs 0.994），但最壞情況 15.7 s → 1.04 s、平均 3.18 s → 0.97 s。**
代理的價值**不是變快，是消除隨機 stall**——這正好就是使用者感受到的「尖峰很慢」。

### 兩個推論被實測推翻，勿再沿用

1. **`workers.dev` 對台灣走 LAX，不是 TPE。** 部署後實測 `colo=LAX`、`conn=137 ms`。
   前面表格裡 `workers.dev` 根域回 TPE 是 **Cloudflare 自家 zone 的路由**，不代表使用者
   部署上去的 Worker——免費方案的 Worker 落在洛杉磯。（同理 `wsrv.nl` 也是 LAX/SJC。）
   ⇒ 代理有效**不靠地理位置**，靠的是「使用者→Cloudflare」這段鏈路比「使用者→Fastly BUR」
   穩定得多。`unknown`：Workers Paid（US$5/月）是否改善 colo 未驗證；若能落 TPE/NRT，
   median 應可從 0.96 s 降到 0.2 s 量級。
2. **MISS 也比直連快，冷門圖同樣受益。** 原推論「MISS 時要回源、不會比直連快」錯誤：

   ```
   id        size      MISS    第二次HIT   imgur直連
   ofT90A6   266 843   1.052   0.883      8.470
   Z4gDlVE   568 675   1.164   1.125      1.092
   ajHklmb   396 574   1.141   0.983     22.885
   lP0NHpE    33 469   0.653   0.657     15.696
   ```

   Cloudflare LAX → imgur BUR 是**美國境內**回源，不吃跨太平洋 stall；使用者只走穩定的
   Cloudflare 鏈路。⇒ 效益不限於熱門文章。

### 其他已排除的選項

- 公用圖片 proxy：`wsrv.nl` 代抓 imgur 實測回 `{"code":404,"message":"The requested URL
  returned error: 429"}` ⇒ imgur 對共用 proxy 出口 IP 限流。自建 Worker 需防同一風險
  （見 proxy 的 fail-open 設計）。
- 繼續壓縮檔案：見上面第 5 點，webp 小 10.7 倍、耗時一樣。

## 重現方式

```bash
for i in $(seq 1 20); do curl -s -o /dev/null --referer "" -w "%{time_total}\n" https://i.imgur.com/L976tXr.jpg; done
curl -s -o /dev/null -D - --referer "" https://i.imgur.com/L976tXr.jpg | grep -i x-served-by
curl -s https://www.cloudflare.com/cdn-cgi/trace | grep -E '^colo|^loc'
```

## twimg（pbs.twimg.com）— CONFIRMED，2026-09-25

量測：台灣家用寬頻，凌晨非尖峰，樣本 `HSWhvjqbMAIr5Ux`。

| 項目 | 結果 |
|---|---|
| 預設尺寸（175 KB）直連 ×20 | 0.62–5.34 s；TTFB 穩 ~0.4 s ⇒ **卡在 body 傳輸** |
| `:orig`（2.38 MB，app 第一候選）直連 ×20 | 27.5–40 s，**14/20 撞 40 s 上限**（24–70 KB/s） |
| `:large`／`name=large`／webp large | 16.7／7.1／4.2 s（同樣 24–70 KB/s） |
| 同機到 Cloudflare 同大小 2.38 MB ×5 | 0.34–0.45 s（5–7 MB/s）⇒ 不是本機頻寬 |
| **prod Worker `/twimg/orig/…`（HIT）×20** | **1.424–1.477 s，median 1.444**（部署後量） |
| `wrangler dev --remote` 預覽 ×20 | 0.58–1.52 s，median 0.59（多一段本機轉送、連線重用，偏樂觀） |
| 同時段直連 `:orig` ×5 | 24.1–40.0 s |

- `x-served-by` 走 `cache-tw-ZZZ1`（twimg 自家台灣節點），吞吐卻只有 ~50 KB/s ⇒ 問題在 twimg 對台灣的交付。
- 與 imgur 不同，**這裡代理是真的變快**（不只消除離群值）。
- 部署前的閘門量測用 `wrangler dev --remote`（跑在 Cloudflare 邊緣，colo SJC）；它比 prod 快，
  **引用數字一律用 prod 那列**。

## catbox（files.catbox.moe）— CONFIRMED，2026-09-25

| 項目 | 結果 |
|---|---|
| 47 KB 直連 ×20 | 0.84–1.00 s，全穩（單一 origin，nginx，無 CDN） |
| **prod Worker `/catbox/…`（HIT）×20** | **0.591–0.618 s，median 0.608** |
| `wrangler dev --remote` 預覽 ×20 | 0.36–0.40 s（偏樂觀，理由同上） |

- 使用者回報的「偶爾慢」在非尖峰量不到；代理的價值是 HIT 後不再依賴那台單點 origin。
- **踩坑：catbox 對無 User-Agent 的請求直接斷線**，而 Workers 的 `fetch` 預設不帶 UA
  ⇒ Cloudflare 回 **520**，整條代理全數 fail-open 成 302（看起來像「代理沒效果」而不是錯誤）。
  本機 `curl -A "" https://files.catbox.moe/…` 可重現（回 000）。Worker 回源一律帶
  `UPSTREAM_UA`，守護 `proxy/imgur-worker/test/fetch.test.js`。
- 公用代理無法拿來近似 Worker 效果（wsrv.nl 302／corsproxy.io 401／Photon 400 不吃 `:orig`／codetabs 522），
  要驗證只能用自家 Worker（`wrangler dev --remote`）。

重現：

```bash
for i in $(seq 1 20); do curl -s -o /dev/null --referer "" -w "%{time_total}\n" "https://pbs.twimg.com/media/HSWhvjqbMAIr5Ux.jpg:orig"; done
W=https://ptt-imgur-cache.ptt-relay-8xquy.workers.dev
for i in $(seq 1 20); do curl -s -o /dev/null -w "%{time_total}\n" "$W/twimg/orig/HSWhvjqbMAIr5Ux.jpg"; done
for i in $(seq 1 20); do curl -s -o /dev/null -w "%{time_total}\n" "$W/catbox/rdpjcp.png"; done
```
