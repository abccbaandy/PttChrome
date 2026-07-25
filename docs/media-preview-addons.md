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
| imgur 單圖 hash | ✅ 依副檔名(預設 .jpg) | ✅ 壞圖修復／查 `image/<hash>` API 判型別 | `i.imgur.com/<id>.<ext>` |
| imgur gif→mp4（省流量） | ✅ option `imgurVideo` | ✅ 一律轉 | `<video>` |
| imgur 相簿 `/a/`、`/gallery/` | ✅ | ✅ | 展開多圖 |
| twitter `pbs.twimg.com/media` | ✅ `:orig`，png/large/原樣 fallback（`srcset`） | ✅ `?format=` 直連 | `<img>` |
| meee.com.tw | ✅ 副檔名 fallback＋可選 `meeeSniffExt` 抓真副檔名 | ✅ `i.meee.com.tw/<id>.jpg` | `<img>` |
| youtube watch/youtu.be/embed/shorts/live | ✅ iframe＋自訂 `youtubeParameters`＋時間戳(`t`→`start`) | ✅ 限 watch/youtu.be | `<iframe>` |
| twitch clips | ❌ | ✅ `clips.twitch.tv/embed?clip=…&parent=<host>` | `<iframe>` |
| verb.tw | ❌（落一般圖片） | ✅ 特例 | `<img>` |

## referer 規則（本專案已沿用，改動前先讀）

- imgur 系一律 `referrerPolicy="no-referrer"`（否則被 referer 封鎖擋圖）。
- **`*.verb.tw` 例外：其圖床需要 referer**，不可加 no-referrer（本專案 `needsReferer()`）。
- imgur 相簿 API 用多 client_id 隨機 + `fetch(mode:cors)` 規避單一 client_id 配額。
- 純 in-page JS **無法 100% 自解** term 場景的 referer 問題（連線重用）；真要保險只有擴充的網路層攔截。

## pointer

- imgur-fix：`getUrlInfo`／`createEmbed`／`lazyLoader`／`initTerm`（`detectEasyReading` 監看 `#easyReadingLastRow` 的 `style.display`）／`beforescriptexecute`（攔掉 imgur 官方 embed.js）。
- media-preview：`imgur.js#get`（多 client_id）、`term.js#getConfig`（讀 `pttchrome.pref.v1`）、`rules.json`／`background.js`（去 referer）。
- 本專案：`src/components/ImagePreviewer.jsx`（`imageUrlResolvers` most-specific→generic、`resolveSrcToImageUrl` 回 media descriptor `{type:'image'|'video'|'iframe'|'album', src, srcset?, images?}`、`FallbackImage` 逐一試 srcset 候選）。
