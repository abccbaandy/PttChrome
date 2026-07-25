# Ptt-official-app organization 研究筆記

研究對象：[github.com/Ptt-official-app](https://github.com/Ptt-official-app)（PTT 官方 app 開源組織）。
目的：盤點各專案用途，評估對本專案（pttchrome，**終端機 scrape 型** client）的可參考性。

原始碼已淺 clone 至 `3rd_script/ptt-official-app/`（該目錄被 `.gitignore` 忽略，不入 repo）。本檔引用一律 `repo/path` pointer，不貼整檔。

## 核心結論（先讀這段）

官方組織 = **「重新實作的 BBS 後端 + REST API + 原生 client」**，資料是結構化 JSON / Rune grid，client 走 HTTP（axios / OKHttp+Retrofit）。
本專案 = **scrape 真 `ws.ptt.cc` 終端機 80×24 Big5 ANSI 畫面**。

兩者輸入格式根本不同 → 官方資源對本專案多半是**「邏輯/格式的交叉驗證參考」**，極少 drop-in。最值得參考的是 **推文行的終端 byte/ANSI 佈局**（官方是「產生」端，本專案是「解析」端，互為逆運算）。

## 組織全貌：兩條技術線 + 周邊

官方走過兩代後端。**舊線**多已停更（2020–2021），**新線**到 2025 仍活躍（devptt.dev）。

| repo | 語言 | 線 | 用途（一行） |
|------|------|----|------|
| **go-pttbbs** | Go | 新 | [ptt/pttbbs](https://github.com/ptt/pttbbs) 的 Go 重寫；BBS 核心（文章/推文/看板讀寫）。**最有料**。 |
| **pttbbs-backend** | Go | 新 | 架在 go-pttbbs 上的中介應用層；含 telnet 入口 + 真實文章解析 testcase。 |
| **go-bbs** | Go | 新 | 直接解析硬碟上 pttbbs 檔案結構的函式庫（推文/文章 record）。Apache-2.0。 |
| **pttbbs-web** | TS | 新 | devptt.dev 的 web client（Vite + React）。 |
| **Ptt-backend** | Go | 舊 | 第一代 PTT APP 後端（REST）。stars 最多但近年低度更新。 |
| **Ptt-Android** | Kotlin | 舊 | 官方 Android app；MVVM + OKHttp/Retrofit，打 `go-openbbsmiddleware` API。 |
| **Ptt-iOS** | Swift | 舊 | 官方 iOS app。 |
| **PttRN** | TS | 舊 | React Native client；與本專案**同 JS 生態**，最易借鏡資料/狀態邏輯。 |
| AspCoreOpenBBSMiddleware | C# | 舊 | 早期 .NET 中介層（停更）。 |
| PyOpenBBSMiddleware | Python | 舊 | 早期 Python 中介層（停更）。 |
| ptt-web | CSS | — | 早期 web 樣式嘗試。 |
| mongo-cluster-docker-compose | Shell | — | mongo 叢集部署腳本。 |
| ptt_official_app_wanted / ptt-official-app-contributors | doc | — | 招募說明 / 貢獻者名單。 |

> **`go-openbbsmiddleware`**（Android/iOS README 標示的 API repo）**已不在公開 org 列表**，疑轉私有或下架。舊線 client 因此實際上「斷頭」，新線改以 `pttbbs-backend` 為中介層。

## 對本專案的可參考性（逐項 verdict）

### 推文樓層計算 —— 可參考性：**高（交叉驗證）**

官方同時有「產生端」與「解析端」兩份程式碼，剛好框住本專案 scrape 端 `comment_parse.annotateComment` 要處理的格式：

- **推文型別 + Big5 byte/色碼**：`go-pttbbs/ptttype/comment_type.go`
  - 型別：`RECOMMEND(推) / BOO(噓) / COMMENT(→) / FORWARD(轉錄) / REPLY / EDIT / DELETED`。
  - `CommentType.Bytes()`：推 = `ANSIColor("1;37")+\xb1\xc0`、噓 = `ANSIColor("1;31")+\xbcN`、→ = `ANSIColor("1;31")+\xa1\xf7`。**這就是 PttChrome 終端上看到的前綴 byte。**
- **推文行的完整終端佈局（產生端，本專案要逆解析）**：`go-pttbbs/ptt/comments.go` 的 `FormatCommentString()`
  - 欄寬預算 `maxlen = 78 - 3(前綴) - 6(日期) - 1(空白) - 6(時間) - [15 if IP]`。
  - 結構：`<型別bytes> <空白> ESC[33m<帳號>ESC[m: <內容><空白填滿>ESC[m <IP> <MM/DD HH:MM>\n`。
  - **IP 是否出現取決於看板權限 `BRD_IPLOGRECMD`**；帳號是否對齊取決於 `BRD_ALIGNEDCMT` → 解釋了為何不同看板推文格式有差。
- **解析端（regex，floor = 序號）**：`go-bbs/user_comment_record.go`
  - `userCommentPattern = ([a-zA-Z][a-zA-Z0-9]+):.*([0-9][0-9]/[0-9][0-9]\s[0-9][0-9]:[0-9][0-9])`（帳號 + MM/DD HH:MM）。
  - `UserCommentRecord.CommentOrder()` = **樓層即陣列序號**（非另算）。IP 欄位標 `// TODO` 未填。
- **真實素材 fixture**：`pttbbs-backend/queue/testcase/M.1644506392.A.03C.utf8.recommend`（utf8 轉碼版）
  - 同時含 `推 <id>: <內容> <IP> MM/DD HH:MM` 與 `※ <id>:轉錄至看板 <board> MM/DD HH:MM`（FORWARD）兩種行，可直接拿來核對本專案逐列判斷的邊界 case。

**結論**：非 drop-in（官方吃 raw 檔案行；本專案吃**已渲染、會折行/上色**的終端 scrape），但可用來回歸守護本專案的型別分類與邊界（FORWARD/REPLY/EDIT/DELETED、IP 有無、純日期行）。

已落地：格式規則內嵌 `src/js/comment_parse.js` 的 `COMMENT_RE`「Official cross-validation」docstring，userid 子樣式依官方 `[a-zA-Z][a-zA-Z0-9]+` 收緊；守護在 `tests/unit/comment_parse.test.js` 的 `official cross-validation` describe＋兩個轉存 fixture（`tests/unit/fixtures/IpComment_M.1621089154.txt`、`Forward_M.1644506392.txt`——`3rd_script/` 被 gitignore，故轉存進已提交目錄供 CI）。**再引入官方 fixture 時比照此作法轉存**。

### 連線繞過 origin header —— 可參考性：**策略性高、技術性低（負面結論）**

- 官方原生 client **完全不連 `ws.ptt.cc`**：
  - `PttRN/src/api/request.ts` → axios，`baseURL: https://api.devptt.site:...`。
  - `Ptt-Android`（README）→ OKHttp + Retrofit，host 由 env `HOST=https://<api_host>` 注入。
  - 走 HTTP REST 自然**沒有 WebSocket Origin 限制**（CORS 由自家後端控制）。
- `pttbbs-backend` 另開 **telnet 入口（`telnet localhost 8888`，SYSOP/123123）**，並自架一個 PttChrome 部署 **term.devptt.dev** 連上去 → 證明「PttChrome 連自架後端」可行；但那是**他們自己的 BBS 資料（devptt），不是真 ptt.cc**。
- **官方沒有任何「連真 ptt.cc 又繞過 `term.ptt.cc` Origin 檢查」的資源**。他們的做法是**「改用自家後端規避整個問題」**，而非破解 Origin。

**結論**：對「想連真 PTT 又免 Origin 限制」沒有捷徑。本專案現有兩條路仍是正解，官方只是反證了沒有第三條：
1. **server-side proxy 改寫 Origin**（dev server 的 `/bbs` proxy 已做；`term.ptt.cc` 本身也是這類 proxy）。
2. **瀏覽器擴充改寫 Origin**（見本專案 `docs/origin-rewrite-extension.md`）。

### 自動開圖 —— 可參考性：**低–中**

- `PttRN` client 端**沒有** URL linkify / 圖片預覽邏輯（全 repo 僅 api baseURL 命中 http）；`ArticleSummary.url` 只是文章的 ptt.cc web 連結，非內文圖片。
- Android/iOS 的圖片是**原生 SDK 行為**（Glide/Coil、SDWebImage），UI 層綁死，不可移植到終端 client。
- **結論**：官方在此無強參考。本專案既有 `3rd_script/ptt-media-preview`、`ptt-imgur-fix` 更貼近需求。頂多參考其 URL 偵測規則，但連這也不如既有方案。

### 好讀模式 —— 可參考性：**低**

- 官方 client 從結構化資料**原生渲染**，沒有「終端自動翻頁狀態機」這種東西 → 本專案 `EasyReading` 是終端專屬問題，官方無對應。
- 唯一概念參考：後端把文章切成乾淨的 **header / body / comments** 資料模型（見下節），是本專案 scrape 難以達到的「理想態」。

## 其他對本專案有用的資源（4 點以外）

- **結構化文章資料模型（理想態對照）**：`PttRN/src/model/article.ts`
  - `ArticleBlock.content: Rune[][]`（**帶色彩屬性的字元二維陣列，等同本專案 TermChar grid**）、`ArticleSummary` 含 `url / read(已讀) / n_comments / recommend / money / class` 等欄位。
  - 即使官方走 API，內文仍保留 Rune grid → 證明「色彩字元 grid」是 BBS client 共通模型，本專案的 TermChar 設計與之一致。
- **測試站（非破壞測試標的）**：`devptt.dev`（web）、`term.devptt.dev`（自架 PttChrome）、`pttapp.cc`、`api.devptt.site`。
  - README 明示「**測試站資料公開、勿用真密碼**」→ 可當 e2e / 離線重放的安全標的，不冒真帳號風險、不打真 ptt.cc。
- **API / schema 文件**：`doc-pttbbs.devptt.dev`、`doc.devptt.dev`（Swagger）→ 文章/推文/看板 JSON schema，可對照本專案內部資料結構命名。
- **Big5 / ANSI 互驗來源**：`go-pttbbs/types/ansi`、go-pttbbs 轉碼模組 → 與本專案 `src/js/string_util.js`(`b2u`/`u2b`) + `conv/*.bin`、`ansi_parser.js` 互為驗證。
- **同生態 client 借鏡**：`PttRN`(RN/TS)、`pttbbs-web`(Vite/React/TS) 與本專案 JS 生態最近，已讀標記、文章列表分頁、推文渲染等狀態邏輯可參考其拆法。
- **term.devptt.dev 不是 fork（已查證，勿誤會）**：它服務的是 `bbsdocker/PttChrome-static` —— **上游 `robertabcd/PttChrome` 的預編譯 dist**（描述明寫 "generated by robertabcd/PttChrome"，內容只有 webpack 產物，無原始碼，最後 build 於 2021-02）。org 內無 PttChrome 原始碼 repo。差異**僅在部署 config（`DEFAULT_SITE`/`TERM_URL` 指向自家 devptt 後端，非 term.ptt.cc）**，原始碼零修改 → **無任何可合併的程式碼**。要追上游差異請對 `robertabcd/PttChrome@dev`（本專案真正 upstream），此靜態部署比上游 dev 還舊。
  - 反向關係：`pttbbs-web/src/components/Screen.tsx:22` 註明其 `<body>` 閃爍 trick 抄自 PttChrome `term_buf.js` —— 是 pttbbs-web 借用本系，方向相反。
- **授權注意**：官方多為 **GPLv3**（`go-bbs` 為 **Apache-2.0**）。本專案 fork 自 PttChrome，若直接搬用官方 GPLv3 程式碼需留意相容性；**借「格式知識/演算法」而非 copy code 較安全**。

## 一句話總結各需求

| 需求 | 官方有無可用資源 |
|------|------|
| 推文樓層計算／格式 | **有（格式/型別交叉驗證，已落地見上節）**；日後推文格式有疑義時回來查 `go-pttbbs`／`go-bbs` |
| 連線繞 Origin | **無捷徑**（官方改用自家後端規避）——維持 proxy／擴充兩路，不必再找第三條 |
| 自動開圖 | 低（原生 SDK UI，不可移植）——沿用本專案 resolver registry |
| 好讀模式 | 無對應（終端專屬問題）——維持自有 `EasyReading` |
