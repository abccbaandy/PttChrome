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

## 根因：HiNet→Fastly 的國際出口尖峰壅塞 — CONFIRMED，2026-09-27

量測：HiNet 家用寬頻（IPv4，無 IPv6），**尖峰** 21:20–21:50，同一張 twimg `:orig`（2.38 MB）。
前面各節是「症狀＋解法」，本節回答「為什麼」。

### 共同分母是 Fastly，不是 twimg／imgur／GitHub 各自的問題

| 服務 | 實際 CDN | HiNet 出去的路徑（tracert） |
|---|---|---|
| `pbs/abs/video.twimg.com` | Fastly（`*.twitter.map.fastly.net`） | 經 **PCCW**（63.21x.x.x）→ NRT，或 HiNet 國際線→SIN |
| `i.imgur.com` | Fastly | HiNet 國際線（202.39.x）→ Any2 LA → BUR |
| `*.github.io`、`*.githubusercontent.com`、`github.githubassets.com` | Fastly（185.199.108–111/22 anycast） | HiNet 國際線（220.128.6.165）→ SIN |
| `x.com`（HTML/API） | **Cloudflare** | HiNet↔CF **台北直連**，10 ms |
| `github.com`（HTML） | Azure 日本東 | — |

⇒ x.com／github.com 本體不慢，慢的是它們掛在 Fastly 上的靜態資源（圖、JS、avatar、Pages）。
Fastly 對 HiNet 沒有台灣境內交付點（`x-served-by` 的 `cache-tw-ZZZ1` 不是實體 POP，RTT 仍是國際線），
Cloudflare 有 TPE 且與 HiNet 境內互連。

### 決定性實驗：同一台 Fastly NRT、只換進入的 IP（=換路徑），交錯取樣 ×8

| 連到 | 路徑 | 2.38 MB 耗時 |
|---|---|---|
| `151.101.76.159`（1.1.1.1／8.8.8.8 給的） | HiNet→PCCW | 7.8–30 s，**4/8 撞 30 s 上限** |
| `151.101.192.159`（Fastly 全域 anycast） | HiNet→**NTT**（129.250.x）→東京 | median ~0.85 s，1/8 4.3 s |
| `162.159.137.232`（Cloudflare） | HiNet↔CF 台北 | **0.32–0.60 s** |
| 對照 `speed.cloudflare.com` 同大小 | 同上 | 0.37 s（6.3 MB/s）⇒ 非本機頻寬 |

- `x-served-by` 都是同一組 NRT cache ⇒ **Fastly 伺服器端沒差，差在 HiNet 選的那條國際路徑**。
- TCP connect／TTFB 都正常（0.08／0.3 s），卡在 body ⇒ 典型壅塞丟包＋重傳（ping 丟包 5/60；GitHub avatar 出現 `conn=1.08 s`＝SYN 重傳一次）。
- 本專案 GitHub Pages 主 bundle（1 MB）同時段 ×8：1.4–21.4 s ⇒ 「deploy 後要開一下子才開得起來」同一根因。

### 使用者實驗逐條解釋

| 實驗 | 結果 | 原因 |
|---|---|---|
| VPN | 有用 | 流量先進 VPN 伺服器，再從對方的上游出國，繞過 HiNet→Fastly 壅塞段 |
| Cloudflare WARP | 有用 | HiNet↔CF 台北直連（不出國），CF 骨幹再去 Fastly。＝本專案 Worker 代理有效的同一機制 |
| 改 DNS（1.1.1.1、8.8.8.8） | 沒用 | 兩者都回 `151.101.76.159`（最差那條）。168.95.1.1／9.9.9.9／101.101.101.101 回別的 Fastly IP（SIN），實測同樣慢——**不管 Fastly 哪個 POP，只要走 HiNet 國際出口就慢**；DNS 只能換 POP，換不了 HiNet 的出口路由 |
| hosts `162.159.137.232` | 使用者稱沒用；**本機 curl 實測有效** | 該 IP 是 Cloudflare，對 `pbs.twimg.com` 回 200、有效憑證、`CF-RAY …-TPE`（X 的多 CDN 之一）。`unknown` 為何使用者無效，候選：只改了 `pbs` 沒改 `abs`／`video.twimg.com`；瀏覽器沿用既有連線／DNS 快取（未重啟）；瀏覽器 DoH 設定。未驗證，勿當結論 |

### 對本專案的含意

- 代理的效益來自「繞開 HiNet→Fastly 國際段」，**對所有 Fastly 圖床都成立**；新增圖床前先查它是不是 Fastly（`curl -sI … | grep -i x-served-by`）。
- hosts 釘 CF IP 不是可交付解法（X 隨時可換、HTTPS 憑證靠對方配合）。
- GitHub Pages 本身的慢無法由 app 解（HTML/JS 就在 Fastly 上）；若要解只能換託管（例如 Cloudflare Pages）——`unknown`，未評估。

重現（尖峰時段）：

```bash
U="https://pbs.twimg.com/media/HSWhvjqbMAIr5Ux.jpg:orig"
for i in 1 2 3 4 5 6 7 8; do for ip in 151.101.76.159 151.101.192.159 162.159.137.232; do curl -s -o /dev/null --referer "" --max-time 30 --resolve pbs.twimg.com:443:$ip -w "%{remote_ip} %{time_total}\n" "$U"; done; done
```
```powershell
tracert -d 151.101.76.159; tracert -d 151.101.192.159; tracert -d 162.159.137.232
```

### 繞路入口（hosts 用；2026-09-27 尖峰實測）

- IP 歸屬用 RDAP 查（`curl -s https://rdap.org/ip/<ip>`）：Fastly 的網段名稱是 `SKYCA-*`；PCCW＝`PCCWG-*`；NTT＝`NTTA-129-250`；HiNet＝`HINET-NET`；Cloudflare＝`CLOUDFLARENET`。
- **X 的 Cloudflare 入口可從 DNS 查到**：`<host>.cdn.cloudflare.net`（`pbs.`／`abs.`／`video.twimg.com` 都有，＝X 在 CF 上設好的 CNAME 接入）。CF 是 anycast＋依 SNI 分流，**任何 CF IP 都能服務這幾個 host**（x.com 的 `162.159.140.229` 同樣可用）。pbs 2.38 MB 0.33 s、`CF-RAY …-TPE`。
- **github.io 沒有 CF 入口**，但 Fastly 全域 anycast `151.101.0.133`／`151.101.192.133`（HiNet→NTT）可服務 `*.github.io`、`avatars.`／`raw.`／`objects.githubusercontent.com`：1 MB bundle 0.62–0.84 s vs 官方 `185.199.108–111.153` 5.3–30 s（×3 each）。`github.githubassets.com` 在該 IP TLS 失敗，不能這樣繞。
- 路徑好壞取決於 HiNet 當下的 BGP 選路，`CONFIRMED` 僅限量測當日；換 IP 前用 `curl --resolve host:443:<ip>` 實測。
