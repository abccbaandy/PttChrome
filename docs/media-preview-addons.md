# 第三方圖片/媒體預覽套件研究 + 本 fork 整合分析

對象：`3rd_script/ptt-imgur-fix`（userscript, eight04）、`3rd_script/ptt-media-preview`（瀏覽器擴充, mingc00）。
兩者用途皆為「PTT 連結自動顯示圖片/影片 + 修正 imgur referer 封鎖」。
**本次僅研究，不實作整合。** 結論狀態：CONFIRMED＝已讀原始碼實證；guess＝推論。

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

## 6. 近期 git log 分析（回答「新功能 vs bug fix」）

近 25 commit 實查（CONFIRMED）：
- **ptt-imgur-fix**：多為 bug fix（video stream 改用非串流、video CORS #31、youtube iframe 版面、no-referer fetch、twitter url 容錯）；新功能僅零星——meee(2025-06)、srcset loader(2025-06)、meee sniff 副檔名(2025-06)。
- **ptt-media-preview**：多為 fix（meee heuristic、verb.tw no-referrer、config 檢查、ptt web match pattern、surge 背景）；新增僅 webp(2025-12)、verb.tw(2025-03)、meee(2025-06)、twitch(2024-03)。

**結論：圖床 roster 穩定，近一年無大型新功能，以 bug fix + 偶發新增單一圖床為主。**
⇒ 一次性整合「追不上上游」的風險低；但**仍會錯過未來各圖床改版時的 bug fix**（imgur API/twitter URL 格式最常變）。

---

## 7. 整合設計（若日後選擇原生整合；本次不實作）

**核心理念，直接回應「支援所有圖床、非每圖床各寫一套」：** 沿用並擴充既有 `imageUrlResolvers` registry
——它本就是「一條解析鏈 + 資料化 host 條目」的泛型設計，加 host＝加一筆 entry，不是新寫一套開圖邏輯。

1. **一條 generic 副檔名 resolver**：match 任意 URL 結尾 `\.(jpe?g|png|gif|webp|apng|avif|svg|…)`（圖）/ `\.(mp4|webm|ogg)`（影片）。**零 per-host 程式碼即涵蓋所有直連圖床/影片**——「支援所有圖床」的主力。
2. **少數 host-specific resolver 條目**：imgur 單圖/相簿、twitter `:orig`、meee、youtube、twitch。這些 host 不給直連 URL（需轉址/查 API/嵌 iframe），**本質無法泛化**，但集中為同一 registry 的資料條目。
3. **泛化 resolver 輸出**：`{src}` → media descriptor `{type:'image'|'video'|'iframe', src, srcset?}`；
   `ImagePreviewer.Inline` 依 `type` render `<img>/<video>/<iframe>`。referrerPolicy、lazy 等 cross-cutting 在 render 端一次處理，不散落各 host。
4. **referer 修正**：預覽 img 一律 `referrerPolicy="no-referrer"`（Chromium 多數情況已足夠）。穩健 fallback＝網路層去 referer 擴充 / dev server 代抓圖（沿用 `docs/origin-rewrite-extension.md` 思路），記入 doc 不強制。
5. **不需** GM_*/sentinel.js/MutationObserver——本 fork 直接掌控 render path（`LinkSegmentBuilder`/`appendRows`）；album 用原生 `fetch`（imgur API 有 CORS，media-preview `imgur.js` 已證可行）。

可能改動檔：`src/components/ImagePreviewer.js`（擴充 resolver + 泛化 render）、視需要 `Row/LinkSegmentBuilder.js`（descriptor 對應）、`src/css/main.css`（既有 `hyperLinkPreview` 規則）。

---

## 8. 兩條路線比較 + 建議

| | 路線 A：沿用第三方 | 路線 B：原生整合 |
|---|---|---|
| 改動量 | 僅 retarget `@match`/manifest host（零 code） | 擴充 `imageUrlResolvers`（一次性 code，純加法） |
| 使用者安裝 | 需自裝 userscript/擴充 | 內建，免安裝 |
| referer 修正 | media-preview 擴充（網路層）最穩 | img `referrerPolicy`（多數足夠）+ 文件化 fallback |
| 上游維護 | 自動同步 bug fix | 需自行回補（風險低，roster 穩定） |
| 與本 fork 既有預覽 | 重疊/衝突，需擇一停用 | 統一在自家機制，無衝突 |
| 涵蓋廣度 | 兩套件成熟、邊界 case 多 | 初期需自行補齊 host 與容錯 |

### 建議（傾向路線 B，但非現在就做）
理由：
1. 泛型 registry（`imageUrlResolvers`）**已就位**，整合是純加法、風險可控。
2. **目前一般圖片直連根本不預覽**（§5 缺口 1）是實質痛點，路線 B 一條 generic resolver 即解。
3. git log 顯示 roster 穩定、回補成本低（§6）——「追不上上游」的疑慮在實證後變小。
4. 沿用第三方需使用者自裝，且會與本 fork 內建預覽衝突（須先停用內建，反而更亂）。

但**不急於現在實作**：可先以路線 A（retarget host 後掛 media-preview 擴充）驗證實際體驗與 referer 行為，
再決定路線 B 的範圍。第三方保留為「零 code 替代方案 / 穩健去 referer 的 fallback 參考實作」。

唯一路線 B 無法完全自解者：imgur referer 封鎖在「連線重用」極端情況下需網路層處理；屬邊界，先用 `referrerPolicy` + 文件化擴充/proxy fallback 即可。
