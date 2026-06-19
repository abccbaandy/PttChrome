# 第三方圖片/媒體預覽套件研究 + 本 fork 整合分析

對象：`3rd_script/ptt-imgur-fix`（userscript, eight04）、`3rd_script/ptt-media-preview`（瀏覽器擴充, mingc00）。
兩者用途皆為「PTT 連結自動顯示圖片/影片 + 修正 imgur referer 封鎖」。
**路線 B（原生整合）已實作**，見 §7。結論狀態：CONFIRMED＝已讀原始碼實證；guess＝推論。

**關鍵前提（CONFIRMED）**：`term.ptt.cc` 跑的就是 PttChrome，本專案 fork 自 PttChrome ⇒
兩套件針對的 DOM＝**我們自己會產出的 DOM**。耦合高，但方向對我們有利（不需逆向，照搬即合）。

---

## 1. 兩套件總覽（CONFIRMED）

| | ptt-imgur-fix | ptt-media-preview |
|---|---|---|
| 形式 | Userscript（Tampermonkey/Violentmonkey/Greasemonkey），用 GM_* API | 瀏覽器擴充（MV3 `manifest.json` + MV2 `manifest.v2.json`） |
| 版本/最後釋出 | v0.10.2 / 2026-03-01 | v5.5.6 / 2026-04-01 |
| 入口檔 | `ptt-imgur-fix.user.js`（單檔 ~880 行） | content scripts：`imgur.js`(共用)+`term.js`(term)+`web.js`(web)；背景去 referer：`rules.json`(MV3)/`background.js`(MV2) |
| 設定 UI | `GM_webextPref`（豐富選項，見 §3） | 無獨立 UI，**讀 PttChrome 自身** `localStorage['pttchrome.pref.v1']` 的 `enableEasyReading`/`enablePicPreview` |
| referer 修正 | img `referrerPolicy=no-referrer` + `GM_xmlhttpRequest`；README 註明 **term.ptt.cc 因瀏覽器連線重用，referrerPolicy 可能失效，需另裝去 referer 擴充** | **網路層**移除 imgur referer：MV3 `declarativeNetRequest`(`rules.json`)、MV2 `webRequest`(`background.js`)。最穩，但需擴充權限 |
| 作用域 | `www.ptt.cc/bbs/*.html`、`/man/*.html`、`term.ptt.cc/` | `www.ptt.cc/bbs/*`、`term.ptt.cc/` |
| 啟動時機 | `@run-at document-start`；`beforescriptexecute` 攔截 imgur 官方 embed.js | content_scripts 預設 `document_idle` |

---

## 2. 功能矩陣（圖床 × 套件）（CONFIRMED）

| 來源 | imgur-fix | media-preview | 產出元素 |
|---|---|---|---|
| 一般圖片副檔名 jpg/png/gif/jpeg/webp/apng/avif/jfif/pjpeg/pjp/svg | ✅ 完整 | ⚠️ 僅 imgur 路徑 + `.webp` 全域 + twimg | `<img>` |
| 一般影片 mp4/webm/ogg | ✅ | ⚠️ 僅 imgur mp4 | `<video controls>` |
| imgur 單圖 hash | ✅ 依副檔名(預設 .jpg) | ✅ 壞圖修復 / 查 `image/<hash>` API 判型別 | `i.imgur.com/<id>.<ext>` |
| imgur gif→mp4（省流量） | ✅ option `imgurVideo` | ✅ 一律轉 | `<video>` |
| imgur 相簿 `/a/`、`/gallery/` | ✅ `api.imgur.com/post/v1/albums/<id>?client_id=…&include=media`，`albumMaxSize` 上限 + 「載入全部」鈕 | ✅ `api.imgur.com/3/album/<hash>`，**多 client_id 隨機**規避配額 | 展開多圖 |
| twitter `pbs.twimg.com/media` | ✅ `:orig`，png/large/原樣 fallback（`srcset`） | ✅ `?format=` 直連 | `<img>` |
| meee.com.tw | ✅ 副檔名 fallback(.jpg/.jpeg/.png/.gif) + 可選 `meeeSniffExt` 抓真副檔名 | ✅ `i.meee.com.tw/<id>.jpg` | `<img>` |
| youtube watch/youtu.be/embed/shorts/live | ✅ iframe + 自訂 `youtubeParameters` + 時間戳(`t`→`start`) | ✅ iframe + `t`→`start`（限 watch/youtu.be） | `<iframe>` |
| twitch clips | ❌ | ✅ `clips.twitch.tv/embed?clip=…&parent=<host>` | `<iframe>` |
| verb.tw | ❌（落一般圖片） | ✅ 特例：**不加** no-referrer（其圖床需 referer） | `<img>` |
| 跨切面能力 | lazy load（IntersectionObserver, rootMargin 30%）、maxWidth/maxHeight、停用 imgur embed.js、好讀偵測 | 信箱(`.q0.b7`「回信」)不預覽、僅好讀模式啟用、`.q4.b7` 內文偵測 | — |

註：media-preview 在 **web 版**(`web.js`)涵蓋面較窄（imgur/twimg/meee/twitch/youtube 修時間戳/webp）；
其 **term 版**(`term.js`)才是與本 fork 對等的場景。imgur-fix 兩場景對等（`initWeb`/`initTerm`）。

---

## 3. 逐套件功能細節（CONFIRMED，pointer 形式）

### ptt-imgur-fix（`ptt-imgur-fix.user.js`）
- `getUrlInfo(url)`#650：唯一的 URL→型別分類器，回 `{type,id,url,embedable,ext?}`。型別：imgur / imgur-album / youtube / twitter / meee / image / video / url。**所有 host 判斷集中於此**（單一 dispatch）。
- `createEmbed(info,container)`#732：依型別產 DOM/HTML。imgur gif/gifv→mp4 視 `imgurVideo`；youtube→`resize-container` iframe；twitter→多候選 `srcset`；album→fetch API 後遞迴 `createRichContent`；meee→sniff 或副檔名 fallback。
- `lazyLoader`#116：IntersectionObserver 管理 img/video/iframe 載入；video 走 `loadVideo`#245（先直連，失敗用 `GM_xmlhttpRequest` referer:"" 抓 blob，或 MediaSource 串流——v0.10.2 已停用 buggy 串流）。
- `initTerm`#489：`detectEasyReading`#532 監看 `#easyReadingLastRow` 的 `style.display`；用 `sentinel.on("span[type=bbsrow] a:not(.embeded)")` 補捉新連結 → `onLink`#499 找 `span[type=bbsrow] > div` 的 `children[1]` 當預覽容器，塞 `.richcontent`。
- `initWeb`#553：先刪官方 `.richcontent`，再對 `#main-content a` 同行多連結逐一嵌入。
- `beforescriptexecute`#384：攔掉 `*.imgur.com` 的 script（停用官方 embed.js）。
- 設定 `GM_webextPref`#36：embedImage/embedVideo/embedAlbum(+albumMaxSize)/imgurVideo/embedYoutube(+youtubeParameters)/meeeSniffExt/lazyLoad/maxWidth/maxHeight/term。

### ptt-media-preview（`term.js` 為主）
- `imgur.js`：`get(path)`#1 多 client_id 隨機 + `referrerPolicy:no-referrer` 打 `api.imgur.com/3/`；`resolveAlbum`#38、`resolveUnknown`#51（回 `{type,link}`）；`createImageEl`#29 對非 `i.verb.tw` 加 no-referrer。
- `term.js`：`getConfig()`#1 讀 `pttchrome.pref.v1`；`MutationObserver`#235 防抖 50ms 掃 `#mainContainer`；`getPreviewContainer = a => a.parentNode.nextSibling`#96；`onUpdate`#100 分類 targets(一般圖/twimg)/album/videoImgs/meee/yt/twitch，各自塞入容器。`isMail()`#40 用 `.q0.b7`==「回信」跳過信箱；需 `.q4.b7`(內文)才動作。
- `rules.json` / `background.js`：對 `https://*.imgur.com/*` 的 image/media 請求移除 `referer` header（網路層，content script 做不到）。

---

## 4. 與 term.ptt.cc(=本 fork) 的耦合分析（CONFIRMED）

### DOM 契約（本 fork 完全相同的產物）
- `#mainContainer`；每列結構 `span[type=bbsrow] > div > [ span.bbsline(連結在此), div(預覽容器) ]`。
  - 對應本專案 `src/components/Row/LinkSegmentBuilder.js:101-117`：`<div><span data-type=bbsline>{segs}</span><div>{inlineLinkPreviews}</div></div>`，外層 `Row` 包 `span[type=bbsrow]`（`Row/index.js:18`）。✅ 與兩套件假設逐一吻合。
- imgur-fix 取容器：`node.closest("span[type=bbsrow] > div").children[1]`。
- media-preview 取容器：`a.parentNode.nextSibling`（bbsline span 的下一個 sibling＝預覽 div）。
- media-preview 另依賴：`#easyReadingLastRow`（好讀 marker，本專案 `term_view.js` 既有）、色票 class `.q4.b7`/`.q0.b7`（`ColorSegmentBuilder` 產）、`localStorage['pttchrome.pref.v1']`（本專案 `PrefModal.js` 既有，含 `enableEasyReading`/`enablePicPreview`）。

### 為何「剛好」可用
因 term.ptt.cc＝PttChrome＝本 fork 上游，DOM/色票/pref/好讀 marker 皆同源。兩套件等於替「我們的輸出」寫的外掛。

### 沿用第三方原樣，用在本 fork 需改什麼
1. **作用域**：imgur-fix 的 `@match`、media-preview manifest 的 `matches`/`host_permissions` 要把 `term.ptt.cc/` 換成本 fork 部署 host（dev `localhost:8080`、prod GitHub Pages 網域）。
2. **referer 修正**：media-preview 的網路層去 referer 需擴充權限；userscript 版在 term 場景**可能失效**（連線重用）。此為 in-page JS 無法 100% 自解的點。
3. **與本 fork 內建預覽重疊**：本專案自帶 imgur/flickr inline + hover 預覽（§5），沿用第三方會雙重渲染，需擇一停用。
4. 程式碼本身**不需改**。

---

## 5. 本 fork 既有機制與缺口（CONFIRMED）

本專案**已有**可擴充的泛型預覽基礎建設（非從零）：
- `src/components/ImagePreviewer.js`：
  - `imageUrlResolvers` 陣列 + `registerImageUrlResolver()`#153：regex+request 的**解析器鏈**（unshift 插隊，default 在尾端 reject）。
  - `resolveSrcToImageUrl({src})`#8：找第一個 `test()` 為真的 resolver 呼叫 `request()`。
  - `ImagePreviewer`(React PureComponent)#23：吃 `request`(Promise)，resolve 後依 `component` render。
  - 兩種 render：`ImagePreviewer.Inline`#127（好讀內嵌 `<img class="easyReadingImg hyperLinkPreview">`）、`ImagePreviewer.OnHover`#94（hover 浮動圖）。
  - 現有 resolver：flickr#157、imgur#192，**輸出僅 `{src}`（純圖片）**。
- 接線：`Row/LinkSegmentBuilder.js:51-59` 每個連結 push 一個 `<ImagePreviewer>`。好讀模式 `term_view.js appendRows(...,showsLinkPreview=true)`#821 → `renderRowHtml(...,enableLinkInlinePreview=true)`(`term_ui.js:22`)；hover 預覽走 `enablePicPreview`(`term_view.js:294`)。

### 缺口（相對兩套件）
1. **一般副檔名圖片（任意圖床直連）不預覽**——非 imgur/flickr 的 URL 落到 default resolver→reject。這是最大實質缺口。
2. 無 twitter `:orig`、imgur 相簿、meee、verb.tw、webp 特例。
3. 無影片(`<video>`)、youtube/twitch(`<iframe>`)——resolver 介面只回圖片 `{src}`。
4. imgur 預覽 img 未加 `referrerpolicy=no-referrer`（可能被 imgur referer 封鎖擋掉）。

---

## 6. 決策：採路線 B（原生整合）

兩條路線曾評估：A=沿用第三方（retarget `@match`/manifest host，零 code，但需使用者自裝、與本 fork 內建預覽衝突、追上游 bug fix）；B=擴充既有 `imageUrlResolvers` registry（一次性純加法 code、內建免安裝、無衝突，但需自行回補上游 bug fix）。

**採 B**：泛型 registry 已就位（加 host＝加一筆 entry），一條 generic 副檔名 resolver 即補上「§5 缺口 1：一般圖片直連不預覽」這個主要痛點；git log 顯示兩套件圖床 roster 穩定、近一年以 bug fix + 偶發單一圖床為主，自行回補成本低。第三方保留為「零 code 替代 / 穩健去 referer 的 fallback 參考」。實作見 §7。

---

## 7. 實作狀態（路線 B 已實作，CONFIRMED）

於 `src/components/ImagePreviewer.js` 完成原生整合（commit `702c4d2`）：

- **descriptor 泛化**：`resolveSrcToImageUrl()` 回 media descriptor `{type:'image'|'video'|'iframe'|'album', src, srcset?, images?}`（缺 `type` 視為 image，向後相容）。
- **`imageUrlResolvers` 陣列**（most-specific→generic，`.find` 取首個 `test()` 真）：imgur 相簿→imgur 單圖→twitter→meee→youtube→twitch→flickr→**generic 影片副檔名→generic 圖片副檔名**→default(reject)。新增 host＝加一筆 entry。
- **generic 副檔名 resolver**（`RE_IMAGE_EXT`/`RE_VIDEO_EXT`）：零 per-host 即涵蓋任意圖床/影片直連——補上「§5 缺口 1：一般圖片不預覽」。
- **render**：`ImagePreviewer.Inline` 依 type 出 `FallbackImage`(img，載入失敗逐一試 `srcset` 候選) / `<video class=easyReadingVideo controls>` / iframe 容器；album 展開多圖。`OnHover` 僅對 image 顯示，其餘回 false。
- **referer**：`FallbackImage` 與 hover img 一律 `referrerPolicy="no-referrer"`，`needsReferer()` 對 `*.verb.tw` 例外（其圖床需 referer）。imgur 相簿 `resolveImgurAlbum()` 用多 client_id 隨機 + `fetch(mode:cors)`。
- 接線未改：仍走既有 `Row/LinkSegmentBuilder.js`（好讀內嵌）與 `Screen.js`（hover）。**不需** GM_*/sentinel/MutationObserver。

驗證：`yarn build` 通過（webpack production）；resolver dispatch+URL 組裝以 Node 實測 15 代表性 URL 全數正確。
**未做**：對真 PTT 的實際 render（img/video/iframe 顯示）屬手動/e2e（flaky+需帳密），待後續驗證。
已知小瑕：twitter `?format=` 形式的 `srcset` 首兩項可能重複（無害，FallbackImage 重試同 URL）。
