# imgur 台灣連線慢 — 量測與根因

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
