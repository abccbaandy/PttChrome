# 第三方圖片/媒體預覽套件（圖床 roster 對照）

對象：`3rd_script/ptt-imgur-fix`（userscript, eight04）、`3rd_script/ptt-media-preview`（瀏覽器擴充, mingc00）。
本專案**已原生整合**同等能力（resolver registry 在 `src/components/ImagePreviewer.jsx`，新增圖床＝加一筆 entry；generic 副檔名 resolver 已涵蓋任意圖床/影片直連）。

本檔用途：**回補上游 bug fix／新圖床時的對照基準**。兩套件針對的 DOM 就是本 fork 自己的產物（term.ptt.cc＝PttChrome＝本 fork 上游），故其 host 判斷與 referer 手法可直接搬概念。結論狀態：CONFIRMED＝已讀原始碼實證。

## 兩套件差異（CONFIRMED）

| | ptt-imgur-fix | ptt-media-preview |
|---|---|---|
| 形式 | Userscript（GM_* API），單檔 ~880 行 | 瀏覽器擴充（MV3 + MV2 manifest） |
| 版本 | v0.10.2 / 2026-03-01 | v5.5.6 / 2026-04-01 |
| URL→型別分類 | `getUrlInfo(url)`＝唯一 dispatch，回 `{type,id,url,embedable,ext?}`；`createEmbed(info,container)` 依型別產 DOM | `imgur.js`(共用)＋`term.js`／`web.js` 分場景 |
| referer 修正 | img `referrerPolicy=no-referrer` + `GM_xmlhttpRequest`；README 註明 **term.ptt.cc 因連線重用可能失效** | **網路層**移除 imgur referer（MV3 `declarativeNetRequest`／MV2 `webRequest`）——最穩但需擴充權限 |
| 相簿 API | `api.imgur.com/post/v1/albums/<id>?client_id=…&include=media`，`albumMaxSize` 上限＋「載入全部」鈕 | `api.imgur.com/3/album/<hash>`，**多 client_id 隨機**規避配額 |
| lazy load | IntersectionObserver rootMargin 30% | MutationObserver 防抖 50ms 掃 `#mainContainer` |

## 圖床 roster（× 套件支援度，CONFIRMED）

| 來源 | imgur-fix | media-preview | 產出元素 |
|---|---|---|---|
| 一般圖片副檔名 jpg/png/gif/jpeg/webp/apng/avif/jfif/svg | ✅ 完整 | ⚠️ 僅 imgur 路徑＋`.webp`＋twimg | `<img>` |
| 一般影片 mp4/webm/ogg | ✅ | ⚠️ 僅 imgur mp4 | `<video controls>` |
| imgur 單圖直連為 `.mp4`（`i.imgur.com/<id>.mp4`） | ✅ | ✅ | `<video controls>`（本專案：`imgurMedia()` 先分流，見下節） |
| imgur 單圖 hash | ✅ 依副檔名(預設 .jpg) | ✅ 壞圖修復／查 `image/<hash>` API 判型別 | `i.imgur.com/<id>.<ext>` |
| imgur **webp 優先**（見下節） | ❌ | ❌ | 本專案獨有 |
| imgur gif→mp4（省流量） | ✅ option `imgurVideo` | ✅ 一律轉 | `<video>` |
| imgur 相簿 `/a/`、`/gallery/` | ✅ | ✅ | 展開多圖 |
| twitter `pbs.twimg.com/media` | ✅ `:orig`，png/large/原樣 fallback（`srcset`） | ✅ `?format=` 直連 | `<img>` |
| meee.com.tw | ✅ 副檔名 fallback＋可選 `meeeSniffExt` 抓真副檔名 | ✅ `i.meee.com.tw/<id>.jpg` | `<img>` |
| youtube watch/youtu.be/embed/shorts/live | ✅ iframe＋自訂 `youtubeParameters`＋時間戳(`t`→`start`) | ✅ 限 watch/youtu.be | `<iframe>` |
| twitch clips | ❌ | ✅ `clips.twitch.tv/embed?clip=…&parent=<host>` | `<iframe>` |
| verb.tw | ❌（落一般圖片） | ✅ 特例 | `<img>` |
| **tenor 分享頁**（`tenor.com/<code>.gif`、`/view/<slug>-<id>`，見下節） | ❌ | ❌ | 本專案獨有：Worker 解析 → `<video autoplay loop muted>` |

## imgur 傳輸實測（CONFIRMED 2026-07-30；curl + 真 Chromium）

素材：`i.imgur.com/ofT90A6.jpeg`（2712×1004, 267 KB）、`I7Thaeo.jpeg`（2380×896, 291 KB），
出處 `www.ptt.cc/bbs/C_Chat/M.1785308048.A.4C4.html`。

**referer 封鎖（CONFIRMED）** — 同一張圖併發 A/B：

| Referer | 結果 |
|---|---|
| 無 / `http://localhost:8080/` | `200`, 266843 bytes |
| `https://www.ptt.cc/bbs/…` | **`403`, 0 bytes** |
| `https://term.ptt.cc/` | **`403`, 0 bytes** |

→ `referrerPolicy="no-referrer"` 是**出圖的必要條件**，不可移除（守護測試
`tests/unit/imgur_webp_resolver.test.jsx`「referrerPolicy 守護」）。403 只花 0.58s，
故封鎖症狀是「不出圖」而非「慢」——**別把慢誤診成 referer 問題**。

**原圖有 per-request 長尾（CONFIRMED）** — 真 Chromium、三個獨立快取 context、
**同一瞬間**請求**同一 URL**：`806 / 785 / 803 ms`、`816 / 2539 / 8782 ms`、
`766 / 792 / 767 ms`、`833 / 767 / 766 ms`。
→ 「同時間 web 版快、BBS 版慢」在兩邊 code 完全相同時也會發生，**不足以推論 client 有 bug**。

**`.webp` 衍生檔無長尾（CONFIRMED）** — 每輪全新 context 交叉測：

| | 5 輪耗時 | 解析度 | 體積 |
|---|---|---|---|
| `.jpeg` | 783 / 788 / **9226** / **6513** / 764 ms | 2712×1004 | 267 KB |
| `.webp` | 592 / 592 / 585 / 571 / 571 ms | 2712×1004（**相同**） | 54 KB（1/5） |

→ 本專案採 **webp 優先 + 原副檔名 fallback**（`imgurMedia()`，走既有 `srcset` 候選鏈）。
**兩個第三方套件都沒有這個優化，別再從它們身上找加速手法。**

**imgur 忽略 URL 副檔名（CONFIRMED，關鍵約束；僅限原始檔是圖片）** — 回儲存的原始格式：

| URL | 實際回應 |
|---|---|
| `ofT90A6.png` / `.gif` / `.jpeg` | 全部 `image/jpeg` 266843 B |
| `auVUJzV.jpg` / `.png` | 全部 `image/gif` 10850053 B（**完整動畫**） |

唯一例外是 `.webp`——那是真正的轉檔衍生端點。推論：**URL 副檔名不是可靠的型別判準**，
無副檔名時補的 `.jpg` 對圖片原檔拿得到原檔。**但原始檔是影片時這條不成立**，見下節。

**影片型資產：圖片副檔名只回單幀靜態縮圖（CONFIRMED）** — 回報案例 `imgur.com/lP0NHpE`
（自動開圖變靜態圖）。現代 imgur 把上傳的動畫／影片存成 `video/mp4`：

| URL | status | content-type | bytes |
|---|---|---|---|
| `lP0NHpE.jpg` / `.gif` | 200 | `image/jpeg` | 33469（**靜態單幀**） |
| `lP0NHpE.mp4` | 200 | `video/mp4` | 82794（會動） |
| `auVUJzV.jpg`（gif 原檔） | 200 | `image/gif` | 10850053 |
| `456CKaj.mp4`（靜態原檔） | **400** | `text/html` `Not an animated gif` | — |

API `/3/image/lP0NHpE` 佐證：`type: "video/mp4"`, `animated: true`。`<img>` 對這張靜態單幀
**onload 成功** → FallbackImage 不會退回 ⇒ 動圖被靜音，`.gif`／`.gifv` 副檔名同樣失效。

→ 判定改用 **HEAD 雙探測**（`src/js/imgur_probe.js`，不吃 API 額度）：`i.imgur.com` 回應帶
`Access-Control-Allow-Origin: *`，HEAD 屬 CORS simple method（無 preflight）、`content-type`
屬 safelisted response header ⇒ 瀏覽器讀得到。對 `<id>.jpg` 與 `<id>.mp4` 並行各發一發：

| 圖片回應 content-type | `.mp4` | 判定 | descriptor |
|---|---|---|---|
| `image/gif` | 任意 | gif 原檔 | `{image, .gif}`（**不得** webp） |
| 其他 `image/*` | 200 | 影片型動圖 | `{video, .mp4}` |
| 其他 `image/*` | 400 | 真靜態圖 | `{image, .webp + .jpg 候選}` |
| 非圖片／探測失敗 | — | unknown | `{image, .jpg}`（舊行為） |

只有「無副檔名／`gif`／`gifv`／未知副檔名」走探測；明寫 `mp4`/`webm`/`ogg` 或
`jpg`/`jpeg`/`png`/`webp` 走原本的快速路徑（imgur 為影片型資產產的直連本來就是 `.mp4`）。
相簿路徑不探測——API 回的 link 已是正確型別。副作用（正面）：確認為靜態後才敢吃 webp，
過去「無副檔名一律放棄優化」的保守作法解除。守護測試 `tests/unit/imgur_probe.test.js`。

**動圖必須排除 webp（CONFIRMED）** — imgur 的 webp 對 gif 只回**靜態單幀**：
`auVUJzV` gif 10.85 MB／完整動畫 → webp 27950 B／`VP8 static`／零 `ANMF` frame。
且 `<img>` 會 **onload 成功** → FallbackImage 不會退回 → 動圖被靜音成一張圖。
故 `imgurMedia()` 只在副檔名**明確是 jpg/jpeg/png** 時才直接要 webp；未知（無副檔名，
imgur 分享連結的預設形式）與 gif/gifv 交給上節的 HEAD 探測判定，探測到 gif 原檔一律
維持原檔。守護測試見 `tests/unit/imgur_webp_resolver.test.jsx`。

**gif→mp4 不採用（CONFIRMED）** — `ptt-media-preview` `term.js#createImgurGif` 的做法。
動畫與尺寸都保得住（gif 500×281 → mp4 500×280，H.264 偶數高度所致），體積 10.85 MB →
1.12 MB，但 **imgur 的 mp4 衍生有嚴重長尾**：真瀏覽器 fetch 完整檔案 4 輪
`1203 / 1162 / 66664 / 65195 ms`，而同一張 gif 原檔 4 輪穩定 `2271 / 2428 / 2437 / 2437 ms`。
→ 改用 mp4 反而更差。三個素材 `auVUJzV` / `zalXDgv` / `rpNNbpw` 的 `.mp4` 都存在且可播
（3.8～11.0s），但 curl 也量到 39.6s / 43.6s 的長尾，非單一素材問題。

**驗證陷阱**：`.webp` 貼進**網址列**會 `302` 導到 `imgur.com/<id>.webp`（HTML 頁）→
看起來像「打不開」。imgur 依 `Sec-Fetch-Dest` 分流：`document` → 302；`image`（即
`<img src>`，我們的實際情境）→ `200 image/webp`。要驗證請用 DevTools console 的
`new Image().src = …` 或真的放進 `<img>`。

## tenor 實測（CONFIRMED 2026-08-11；curl）

素材 `https://tenor.com/bgOd4.gif`。**結論：短連結無法在瀏覽器端解析，只能伺服端代解。**

| 事實 | 值 |
|---|---|
| 短連結本體 | `301` → `tenor.com/view/faker-hug-smile-happy-shy-gif-16360306`（是 HTML 頁，不是圖檔） |
| 頁面 CORS | **無 `access-control-allow-origin`** → 前端 `fetch` 讀不到 HTML |
| `/view/` 框入 | `x-frame-options: DENY` → 不能用 iframe 迂迴 |
| `/embed/<數字 id>` | `200`、無 XFO、無 `frame-ancestors` → 可 iframe，但**只吃數字 id**（短碼 404） |
| Tenor API v1 | 已下線（`{"code":7,"error":"Tenor API is discontinued"}`）；v2 需 Google API key |
| `tenor.com/oembed` | `404` |
| og tag 媒體 | mp4 `media.tenor.com/TjWRuqajuC0AAAPo/faker-hug.mp4`、webm `…AAAPs….webm`、gif `media1.tenor.com/m/TjWRuqajuC0AAAAd/faker-hug.gif` |
| 體積 | mp4 **960 400 B** vs gif **4 168 932 B**（4.3×）⇒ 採 mp4 |
| media 主機 | mp4 帶 `Access-Control-Allow-Origin: *`、`Cross-Origin-Resource-Policy: cross-origin`；帶 `Referer: https://term.ptt.cc/` 仍 `200`（**不擋 hotlink**，無需 referer workaround） |

**短碼大小寫敏感（踩過）** — `tenor.com/bgOd4.gif` = 16360306、`tenor.com/bgod4.gif` = **16260362**，
兩張不同的圖。而 tenor 對 `/bgOd4`（無副檔名）、`/embed/gif/bgOd4`、`/view/bgOd4.gif` 一律
`301` 轉小寫 → 解析到**錯的圖**。⇒ 只有 `tenor.com/<原樣短碼>.gif` 可信，鏈路上任何一段都不得
做大小寫正規化（`parseTenorTarget` 只丟 query/hash，不碰 pathname）。

**HEAD 陷阱** — gif 位址對 `HEAD` 回 `404`、`GET` 回 `200 image/gif` 4.17 MB。
tenor 資產**不可**用 HEAD 探測型別（與 `imgur_probe.js` 的手法相反）。

**實作**：`proxy/imgur-worker/src/index.js` 的 `/tenor?url=` 路由（抓頁面 → 解 og tag → 回 JSON，
帶 CORS）＋ `src/js/tenor.js`（`RE_TENOR` 在 `image_url_detect.js`）。resolver 必須排在泛用
`RE_IMAGE_EXT` 之前，否則 `.gif` 結尾的網頁會被當直連圖載入而必定失敗（本功能的原始 bug）。
Worker **只回位址不代理影片位元組**（Cloudflare ToS 排除影片檔，同 `RE_ASSET` 擋 mp4 的界線）。
開關沿用 `useImgurProxy`；關閉時不預覽（不退回泛用規則，否則又變破圖）。
守護測試：`tests/unit/tenor.test.js`、`tests/unit/tenor_resolver.test.jsx`、
`proxy/imgur-worker/test/tenor.test.js`。

## referer 規則（本專案已沿用，改動前先讀）

- imgur 系一律 `referrerPolicy="no-referrer"`（否則被 referer 封鎖擋圖，403 實證見上節）。
- **`*.verb.tw` 例外：其圖床需要 referer**，不可加 no-referrer（本專案 `needsReferer()`）。
- **影片無法比照辦理**：HTML 的 `video` 元素**不支援 `referrerpolicy` 屬性**，imgur 影片直連
  只能吃文件層級的 referrer policy。實測（2026-07-31，`i.imgur.com/8MYpXhr.mp4`）本專案的部署
  來源 `https://abccbaandy.github.io/` 與 dev 的 `http://localhost:8080/` 皆回 `206 video/mp4`，
  只有 `https://term.ptt.cc/` 被擋 `403` → 現況不受影響。**不要**為此加文件層級
  `meta name="referrer" content="no-referrer"`：會波及 reCAPTCHA Enterprise／Firebase 的
  網域驗證（見 `docs/pref-sync-firestore.md`），風險大於收益。
- imgur 相簿 API 用多 client_id 隨機 + `fetch(mode:cors)` 規避單一 client_id 配額。
- 純 in-page JS **無法 100% 自解** term 場景的 referer 問題（連線重用）；真要保險只有擴充的網路層攔截。

## pointer

- imgur-fix：`getUrlInfo`／`createEmbed`／`lazyLoader`／`initTerm`（`detectEasyReading` 監看 `#easyReadingLastRow` 的 `style.display`）／`beforescriptexecute`（攔掉 imgur 官方 embed.js）。
- media-preview：`imgur.js#get`（多 client_id）、`term.js#getConfig`（讀 `pttchrome.pref.v1`）、`rules.json`／`background.js`（去 referer）。
- 本專案的**延遲載入層**：`src/components/LazyInlinePreview.jsx` ＋ `src/js/lazy_media.js`。好讀累積長頁對每個連結都掛預覽，實錄的 8500 行長文有 287 個圖片連結 ⇒ 舊行為是全部立即解析＋下載＋解碼且永不釋放（記憶體吃滿）。改成兩個共用 IntersectionObserver（掛載 1500px／卸載 6000px 遲滯區）。**延後的是整個 `<ImagePreviewer>` 的掛載，連 `requestPreview()`（含 `probeImgurAsset` 的兩發 HEAD）都不先跑** —— `<img loading="lazy">` 攔不到解析階段，而且未載入時 `<img>` 是 `display:none`，瀏覽器對 `display:none` 元素本來就不觸發 lazy。卸載前把 `offsetHeight` 釘進佔位盒 `min-height`，閱讀位置才不會位移。
- 本專案：`src/components/ImagePreviewer.jsx`（`imageUrlResolvers` most-specific→generic、`resolveSrcToImageUrl` 回 media descriptor `{type:'image'|'video'|'iframe'|'album', src, srcset?, images?}`、`FallbackImage` 逐一試 srcset 候選、`renderMedia()` 單一 descriptor→元素、`imgurMedia()`／`imgurAlbumMedia()`／`imgurMediaFromProbe()` 影片分流＋靜態圖 webp 優先）、`src/js/imgur_probe.js`（`classifyImgurAsset` 純決策表＋`probeImgurAsset` HEAD 雙探測，per-id promise 快取）。**`album` 的 `images` 是 descriptor 陣列（非 URL 字串）**，相簿內的圖因此也吃到 srcset 候選鏈。
