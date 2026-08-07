# imgur 快取代理 — app 端整合

## 狀態

| 項目 | 狀態 |
|---|---|
| 根因驗證 | **CONFIRMED**，數據見 `docs/imgur-latency-research.md` |
| Worker 實作 | **已完成**，`proxy/imgur-worker/`（未進 app build，獨立 package） |
| Worker 部署 | **已上線**，快取／CORS／影片阻擋／fail-open 皆已實測通過 |
| Worker URL | `https://ptt-imgur-cache.ptt-relay-8xquy.workers.dev` |
| 持有者 | **專案方統一部署，全站共用**（使用者無須自建；額度與隱私揭露見下） |
| app 端整合 | **未開始**（本檔待辦） |

## 一句話背景

imgur 的 Fastly 把台灣流量導到美西 BUR（137 ms RTT），同一張圖 20 次取樣有 4–5 次
stall 9–24 s。既有 webp 優化無效：檔案小 10.7 倍、耗時完全一樣（延遲由 stall 主導）。

代理實測：median 幾乎不變（0.963 vs 0.994 s），但 **max 15.7 s → 1.04 s、avg 3.18 → 0.97 s、
stall 0/20**。⇒ **賣點是「不再卡住」而非「更快」**，設定 UI 與 README 文案要照這個寫，
不要宣稱加速。

## 整合點

主要在 `src/components/ImagePreviewer.jsx`，兩個產 URL 的函式：

| 函式 | 行 | 產出 | 是否改寫 |
|---|---|---|---|
| `imgurMediaFromProbe(id, kind)` | ~429 | `video`→`.mp4` / `gif`→`.gif` / `static`→`.webp`+srcset | gif／static 改寫；**video 不動** |
| `imgurMedia(id, ext)` | ~451 | 依副檔名分流 | 圖片分支改寫；`RE_VIDEO_EXT` 分支**不動** |
| `probeImgurAsset` HEAD 探測 | `src/js/imgur_probe.js:73` | `i.imgur.com/<id>.jpg` + `.mp4` | 見下方「探測是否改走代理」 |

建議新增純函式模組 `src/js/imgur_proxy.js`：

```
proxiedImgurUrl(id, ext, { enabled, base }) → string
  enabled=false            → https://i.imgur.com/<id>.<ext>   （原樣）
  ext ∈ {mp4, webm, …}     → https://i.imgur.com/<id>.<ext>   （影片一律不代理，見下）
  否則                      → <base>/<id>.<ext>
```

所有分支下放 `tests/unit/imgur_proxy.test.js` 守護（純字串邏輯，unit 首選）。

## 硬約束

1. **影片（mp4／webm）不得走代理。** Cloudflare 服務條款允許 Workers 服務圖片／音訊，
   **排除影片檔**。Worker 端的路徑白名單已擋（回 404），app 端也必須不送過去。
2. **srcset 必須留原址當 fallback。** `FallbackImage` 已有逐候選退回機制
   （`ImagePreviewer.jsx` 的 `srcset`）。代理位置放**第一順位**，原 `i.imgur.com` URL
   保留在後：Worker 掛掉／額度用盡（Error 1027）時自動退回現況。
   `static` 分支現為 `[<base>.webp, <base>.jpg]` → 改成
   `[proxy(.webp), imgur(.webp), imgur(.jpg)]`。
3. **開關預設值＝專案方決策，已定為「全站共用專案方 Worker」。** 走 `enableAi` 那套：
   設定項 + 總開關，見 `docs/enhanced-addon.md`「設定」節。
   `未決`：預設開或關。權衡——預設開才吃得到效益（多數人不會去翻設定），但代理由
   專案方持有 ⇒ 隱私揭露責任較重、且 100 k req/day 額度會被全站消耗。
   建議**預設開 + 設定可關 + 首次使用明確揭露**，但這是專案方的決定，動手前先確認。
4. **隱私（專案方持有，責任較重）**：Worker 會看到「哪個 IP 在看哪張圖」。
   必須在設定 UI 與 README 明說圖片請求會經過專案方的 Cloudflare Worker。
   Worker 目前不寫任何 log（僅 `observability` 預設值），**別加上會留存使用者請求的紀錄**。

## 探測是否改走代理（未決）

`imgur_probe.js` 用 HEAD 打 `.jpg` + `.mp4` 判資產型別。

- `.jpg` HEAD 走代理：可省一次跨太平洋往返，Worker 已放行 HEAD 與 CORS
  （`content-type` 在 `Access-Control-Expose-Headers`）。
- `.mp4` HEAD **不能**走代理（白名單擋掉，會拿到 404 → 誤判成 `static`，動圖被靜音，
  正是 `imgur_probe.js` 開頭記載的回報案例 `imgur.com/lP0NHpE`）。

⇒ 若要改，只改 `.jpg` 那一發，`.mp4` 維持直連。**改了必須補 unit 測試覆蓋
`classifyImgurAsset` 的四種分支仍正確**，並用 `docs/offline-replay-testing.md` 的
離線重放驗一次動圖不被靜音。

## 驗收

- `yarn test:unit` 綠，含新增的 `imgur_proxy.test.js`
- 觸及 `src/components/**` ⇒ **必跑 e2e**（`yarn test:e2e`，至少 `enhance.spec.js`）
- 手動：開一篇含多張 imgur 圖的文章，DevTools Network 確認
  (a) 圖片走 Worker、(b) mp4 走 i.imgur.com、(c) 第二次載入命中快取
- README.md 新功能列表 + 設定 UI 文案（`zh_TW_messages.js` / `en_US_messages.js` 兩語系）

## 上線後要盯的風險

| 風險 | 徵兆 | 處置 |
|---|---|---|
| imgur 對 Cloudflare 出口 IP 限流 | 302 fail-open 比例升高（`npx wrangler tail`） | 最壞情況＝退回現況（fail-open 已保證），評估是否改自建東京 VPS |
| 100 k req/day 額度用盡 | Error 1027 | srcset fallback 會自動退回 i.imgur.com；考慮 Workers Paid。查用量：`npm --prefix proxy/imgur-worker run usage` |
| 快取命中率過低 | `Age` 常為 0 | 檢查 app 端是否對同一資產產出不一致的 URL（大小寫、變體後綴） |

## 額度估算（影響「預設開／關」的決定）

**計費單位是回源次數，不是使用者請求數**——快取命中時 Worker 不執行、不計額度
（CONFIRMED，實測見 `proxy/imgur-worker/README.md`）。
⇒ 100 k/day ≈ **每天 10 萬張「全站沒人看過的」imgur 圖**，而非 10 萬次圖片載入。
PTT 熱門文章重複率高、資產 TTL 一年 ⇒ 實際消耗遠低於直覺。預設開啟的額度風險比想像小。

## 未來優化（非必要）

代理落在 **LAX 而非 TPE**（免費 Workers 的路由），所以 median 沒改善。若要連 median 也降到
0.2 s 量級，需要落在台灣／東京的節點：`unknown` — Workers Paid（US$5/月）是否改善 colo
未驗證；替代是東京 VPS 自架。**現階段不必做**，離群值已被消除，那才是使用者的痛點。

## 若決定放棄此方案

刪 `proxy/` 與本檔；`docs/imgur-latency-research.md` 留著（根因分析本身有價值）。
**不要重做量測** —— 根因與解法效益都已 CONFIRMED，重測只會再花一輪時間得到同樣結論。
已排除的替代方案：公用圖片 proxy（`wsrv.nl` 被 imgur 429，且同樣走 LAX）、
繼續壓縮檔案（webp 實測無邊際效益）。
