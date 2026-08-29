# 離線重放測試（byte cassette）

把會過期的「特定文章」e2e 素材永久化：錄一次真實 PTT 的 byte 流 → 之後不連網確定性重放並斷言。
解決 `tests/e2e/*.spec.js` 依賴特定文章（過期就 `test.skip`、回歸失守）的問題。

## 為什麼不是單一靜態快照
好讀模式是**互動式翻頁**：靠 `EasyReading._send('\x1b[6~')`（`src/js/easy_reading.js`）主動向 server 要下一頁，
逐頁累進 `termBuf.pageLines`（`src/js/term_view.js accumulatePageLines` + `comment_parse.resolvePageOverlap` 去重：狀態列行號為主、`findPageOverlap` 內文為輔）。
「第一則推文消失 / 樓號錯位」是跨頁累積產生 → 必須忠實重放逐頁節奏。

## 架構（單一錄製源，兩層消費）
```
一次真實錄製(guest) → recorder
   ├─ tests/e2e/cassettes/<name>.json        → Layer1 Playwright 離線重放（真瀏覽器/真渲染）
   └─ tests/unit/fixtures/replay/<name>.page.json → Layer2 vitest 純邏輯（node, 秒級）
```
- **注入點**：stub `window.WebSocket`（不連網、吞 send）讓 app 離線 boot；把 cassette 每頁 recv 餵回
  `App.onData`（`src/js/pttchrome.jsx`，= 真實 parser→termBuf→`<Screen>`）；以好讀自己送出的
  `\x1b[6~`/`\x1b[4~` 當「放下一頁」門控。見 `tests/e2e/helpers/replay.js`。
- **Layer1**：產出真實 DOM → 可跑現有全部斷言（翻頁回歸 / 樓層 / 黑名單 / pusher / 列表）。
- **Layer2**：用 *真實* `resolvePageOverlap`（狀態列行號為主＋`findPageOverlap` 為輔）從「每頁文字快照」
  重建累積（鏡像 accumulatePageLines；快照末列即原始狀態列，可解析行號），純 node 守護去重 off-by-one
  + 重複區塊 + FloorCounter + blacklist。見 `tests/unit/replay_fixture.test.jsx`。

## 檔案格式
cassette（`tests/e2e/cassettes/<name>.json`）：
```
{ meta:{mode:"article"|"list", board, recordedAs:"guest", pages, commentCount, firstCommentAuthor},
  cols:80, rows:24,
  steps:[ {on:"start",recv:"<base64 latin1>"}, {on:"pagedown",recv:...}, ... {on:"end",recv:...}? ] }
```
- `recv` = 錄製時 `App.onData` 收到的 post-telnet bytes（Big5+ANSI），latin1 逐位元組 base64。
- player 立即餵所有 `start`；之後每偵測到 `\x1b[6~`→餵下一 `pagedown`、`\x1b[4~`→餵 `end`。
- `list` 模式只有單一 `start`（pageState 2 列表畫面），重放時 `easyReading:false`。

fixture（`tests/unit/fixtures/replay/<name>.page.json`）：
```
{ meta, pageScreens:[[24列settled文字],...], golden:{comments[], commentCount, firstCommentAuthor} }
```

## 錄製（一次性，連真實 PTT）
環境變數：`RECORD_MODE`(article|list)、`RECORD_BOARD`、`RECORD_NAME`、`RECORD_MAX_PAGES`(預設 12，0=不限)、
`RECORD_SEARCH`(article：'/' 標題搜尋指定文章，過期則拋錯)、`RECORD_END`(article：加錄 End→原生的 'end' step)、
`RECORD_ALLOW_LOGIN`(用 env 帳密登入)、`RECORD_REDACT_EXTRA`("id1,id2" 額外要等長遮蔽的 id，
用於 Fw 轉錄文「※ 轉錄者: <自己另一個 id>」≠ 登入帳號的情形)。
```
# 指定文章（如黃仁勳那篇 #1g8znzQ3，golden 首推 bluebird5566）+ 加錄 End 場景
$env:RECORD_ALLOW_LOGIN="1"; $env:RECORD_MODE="article"; $env:RECORD_BOARD="Stock"
$env:RECORD_SEARCH="黃仁勳喊話增產成功"; $env:RECORD_NAME="stock-huang"; yarn record:cassette
# article（最新一篇）+ End step（供 End→原生 測試）
$env:RECORD_ALLOW_LOGIN="1"; $env:RECORD_END="1"; $env:RECORD_MAX_PAGES="4"; $env:RECORD_MODE="article"
$env:RECORD_BOARD="Stock"; $env:RECORD_NAME="stock-end"; yarn record:cassette
# list（看板列表）
$env:RECORD_ALLOW_LOGIN="1"; $env:RECORD_MODE="list"; $env:RECORD_BOARD="C_Chat"; $env:RECORD_NAME="cchat-list"; yarn record:cassette
```
offline spec 遍歷所有 article cassette 逐卷守門；End 測試自動挑帶 'end' step 的那卷。
- `record:cassette` = `RECORD_CASSETTE=1 playwright test --project=record`（無 RECORD_CASSETTE 會 skip；Yarn v4 portable shell 直接支援行內 env）。
- 錄製器在 `tests/e2e/tools/record-cassette.spec.js`。
- **憑證優先序**：`tests/e2e/.ptt-creds.json`（gitignored，`{"user","pass"}`）> env `RECORD_ALLOW_LOGIN=1` + env `PTT_USER`/`PTT_PASS` > 否則強制 guest。
- 頁數上限在 hook 內吞掉超額 `\x1b[6~`（無 race：pageLines 停在已 flush 的頁），控制素材大小/重放時長。
  實測 Stock 12 頁 ≈ cassette 27KB + fixture 44KB；不設上限的盤中閒聊可達 416 頁 / 2.6MB。

### 隱私（CLAUDE.md，公開 fork 必守）—— CONFIRMED 關鍵設計
- **capture 是 article-scoped**：hook 裝在登入*之後*、Enter 前清空 `cur` → cassette/fixture 只含
  「文章 recv（公開內容）」，**不含登入畫面 / 帳號回顯 / 個人化狀態列**。
- 預設**強制 guest**（刪 `PTT_USER`/`PTT_PASS` env）：guest 無密碼、PTT 不回顯密碼 → 素材零憑證。
- 用真實帳號登入時（guest 名額滿 "太多 guest 在站上"）：寫檔前對 recv + fixture 文字做
  **登入帳號等長 redact**（`(?<![0-9A-Za-z])id(?![0-9A-Za-z])` → `xxxx`，保 byte/欄位對齊）+ `assertNoLeak`
  把關（解碼全部 recv/文字，含帳號即拋錯不寫）。`meta.recordedAs` 只記 `guest`/`account`，不存帳號名。
- **額外遮蔽（2026-06）**：`RECORD_REDACT_EXTRA="id1,id2"` 等長遮蔽「登入帳號以外、文章裡出現的自己其他 id」
  （典型：Fw 轉錄文「※ 轉錄者: <另一 id>」），`assertNoLeak` 一併把關；並自動等長遮蔽所有 **IPv4**
  （轉錄者/「來自: <IP>」會帶發文者個資）。`test-xmen` 卷即用此錄製（帳號 + 轉錄者 id + IP 皆已 redact 成 x）。
- redact 是手動掃描（`redactUser`）：id 須右側非英數邊界；左側認「非英數 / 字串開頭 / Big5 尾位元組」
  （前一位元組 0x40-0x7E 且其前 ≥0x80）。故 article 的「→ 你的id:」「推 你的id:」與 list 狀態列
  「我是<id>」（id 緊貼 Big5「是」0xAC4F，trail 0x4F='O'）都能正確遮成 xxxx → **article / list 用真實帳號皆可**。
- `assertNoLeak` 是最後防線：萬一 redact 漏了就拋錯不寫。實測 stock-huang / stock-end / cchat-list 三卷
  獨立掃描皆 0 洩漏。
- commit 前仍務必 `git diff` 複查產出檔不含帳號 / 本機路徑 / OS 使用者名。文章內容是公開 PTT，可入 repo。

## 跑
```
yarn test:e2e:offline           # 離線重放（stub WebSocket，零網路），斷網/無帳密也全過
yarn test:e2e:offline:adverse   # 同一批 spec，但圖片改成 慢5.2s / 404 / 301 / 混合（見下）
yarn test:unit          # 含 Layer2 重建（無對應 fixture 則 skip）
yarn test:e2e           # 仍連真實 PTT 的 live e2e（共存，--project=live）
```
- `playwright.config.js` 四 project：`preflight`（PTT 連線健檢）、`live`（現有 spec，排除
  offline/tools；`dependencies: ['preflight']`）、`offline`、`record`（亦依賴 preflight）。
- 沒錄過任何 cassette/fixture：offline 文章/增強 spec 與 Layer2 unit **skip**（非失敗）；
  `harness.offline.spec.js` 永遠不需素材（驗離線 boot+onData 渲染）。

## 使用者 Debug 錄製檔 → cassette
使用者在「設定 → 關於」開 Debug 錄製模式錄下的檔（`ptt-debug-*.json`，schema 見
`src/js/debug_recorder_logic.js`）內建 `cassette` 欄位（`meta.mode:'debug-derived'`）：
- 直接取 `json.cassette`、把 `meta.mode` 改成 `article`/`list` 後存進 `tests/e2e/cassettes/`
  即可被 offline spec 撿到重放（`debug-derived` 預設不會被 `findCassettes` 誤撿）。
- `events` 為完整雙向時間序（send/recv/log + 每事件狀態快照），修 bug 時人工閱讀用。
- 限制：導出用 send 反查鍵表（`classifySend`），非翻頁類按鍵會標 `on:'raw'`（replay.js
  不認得，需人工裁剪或只取 start~pagedown 段）；下載前已自動 redact 已知帳密/IP，但
  **手動鍵入的密碼無法偵測**，入 repo 前務必人工複查。
- 存進 `cassettes/` 後**必須補齊 golden meta**（`commentCount`／`firstCommentAuthor`，
  article 卷）：逐卷測試 `easy-reading.offline.spec.js` 直接拿它們當斷言基準，缺了會
  `expect(undefined)` 紅。
- 實例：`ask-urlline-blank.json`（ptt-debug-20260812-010606 轉出，2 頁 5 推）——
  唯一能重現「非媒體連結佔位盒留下假高度」的素材，見下方「素材選用」。
- 實例：`ask-aid-wrap.json`（ptt-debug-20260828-002500 轉出，2 頁 10 推）——守護
  「跨行 AID 接合」：末兩則同作者推文是 `#1gU3wwNZ` ＋ 下一則開頭的 `(Browsers)`。
  **刻意保留 `mode:'debug-derived'`**（不改成 `article`）⇒ `findCassettes('article')`
  不會撿它、逐卷 spec 一律不受影響，只由 `aid_wrap.offline.spec.js` 以
  `loadCassette('ask-aid-wrap')` 指名載入。裁剪方式：丟掉列表 step 與跳轉失敗留下的
  `on:'raw'` step（`replay.js` 不認得 raw），把文章第一頁那步的 `on` 改成 `start`。
- 守護測試：`tests/unit/redact.test.js`、`tests/unit/debug_recorder_logic.test.js`、
  `tests/unit/debug_recorder.test.js`、`tests/e2e/offline/debug_record.offline.spec.js`。

## 素材選用（逐卷測試的前提，選錯＝測試恆綠）
逐卷 spec 會把 `cassettes/` 裡每一卷都跑一遍，但**不是每卷都能重現每個 bug**：

| 測試 | 前提 | 選錯的後果 |
|---|---|---|
| `lazy_preview_blank.offline.spec.js`（非媒體連結不留高度） | 文章夠長／夠多圖，把「※ 文章網址」那列推出 lazy 卸載邊界 | 短文（`test-xmen`）整篇都在視野內、從不卸載 ⇒ 佔位盒永不釘高度 ⇒ **恆綠**（實際踩過） |
| `lazy_preview_enlarge_blank.offline.spec.js`（放大態釘的高度不留到縮小態） | 多圖且**放大後**總高足以把上方佔位盒推出 6000px 卸載邊界（`stock-end` 9 張圖：實測放大態釘住 8 個、最高 908px） | 圖太少／太短 ⇒ 放大態從不卸載 ⇒ 恆綠。spec 內以 `pinnedWhileEnlarged > 0` 硬紅擋住此情形 |
| `easy-reading.offline.spec.js` 掉頁自癒 | **≥2 個 `pagedown` step**（吞的是「中間」頁） | 只有 1 個 pagedown 的卷吞掉即只剩第一頁，沒有中間頁可自癒，前提不成立 |

新增素材後請照「回歸捕捉力驗證」那節，實際把修復還原一次確認會紅。

## 回歸捕捉力驗證（關鍵，證明素材真能守門）
錄好 cassette 後：臨時改壞 `comment_parse.findPageOverlap`（或 stash 第一則推文修復 commit），
`yarn test:e2e:offline` + `yarn test:unit` 必須**變紅**（首推作者缺席 / commentCount 不符 / 樓號錯位）；
復原後轉綠。

## 離線網路（`installOfflineNetwork`）—— 「零網路」的另一半
`stub WebSocket` 只擋掉 **PTT 連線**。行內開圖（`ImagePreviewer`）拿到的是 cassette 裡
**真實文章的真實圖床網址**，瀏覽器照樣會去連 `i.imgur.com`／`pbs.twimg.com`／`i.urusai.cc`。
故 `bootOffline()` 另裝 `installOfflineNetwork(page)`（`helpers/replay.js`），把所有非本機
請求改由本地 fixture 回應。

| 分類 | 判準 | 回應 |
|---|---|---|
| `passthrough` | 非 http(s)／host ∈ {localhost,127.0.0.1,::1} | 不進攔截層 |
| `image` | path+search 命中 `\.(jpe?g\|png\|gif\|webp\|bmp\|apng\|avif)($\|[?#:])` | 依**圖片載入情境**，見下節（預設＝`tests/e2e/fixtures/preview.png`，800×600 `image/png`，秒回） |
| `imgur-album` | host `api.imgur.com` | 假 JSON，兩張 `i.imgur.com/offline*.png` |
| `flickr` | host `api.flickr.com` | 假 photo JSON |
| `blocked` | 其餘（youtube/twitch embed、未知 host） | 404 空身（iframe 的 `load` 與 status 無關，仍觸發） |

- 純函式 `classifyOfflineRequest` 守護在 `tests/unit/offline_network_route.test.js`。
- 「零外流」是**三層**，不是一層（2026-08-28 事故後補齊，見下方 CONFIRMED）：
  1. 述詞 route（`installOfflineNetwork`）——正常路徑全部本地回應。
  2. 轉址終點鑄在保留域（`offline_images.js#GONE_ORIGIN`）——**不得**沿用原址 origin。
  3. 瀏覽器層硬斷網（`playwright.config.js#OFFLINE_NO_NETWORK`）——所有 offline project 的出口
     指向連不上的 proxy，localhost bypass。靜態守護 `tests/unit/e2e_offline_no_network.test.js`。
- 證據來源有兩份，語義不同，別混用：
  `offlineServedUrls(page)` ＝**被離線規則接住的**請求；
  `offlineExternalUrls(page)` ＝**頁面實際發出的**每一筆非本機請求（由 `installOfflineNetwork`
  自己掛 `page.on('request')` 記錄，所有 spec／所有 profile 通用）。兩者的差集＝逃出 `page.route` 的。
  `easy-reading.offline.spec.js` 的行內開圖測斷言該差集為空（拿掉路由即紅）；
  `image_load_conditions.offline.spec.js` 的 301 那條另外釘住「`__offline-gone__` 的請求只能落在 `GONE_ORIGIN`」。
- **影片副檔名刻意不給 fixture**：現有 cassette 無直連影片。日後錄到影片素材會以
  「`video` 未 `loadeddata` → `display:none` → 等不到 visible」紅出來，屆時補一支最小 mp4。

### 圖片載入情境（profile / scenario）

`helpers/offline_images.js`。**profile** ＝一整輪測試的設定，**scenario** ＝單一 URL 實際拿到的
回應。決定性：固定延遲、URL 的 FNV-1a 雜湊分桶，無隨機／無順序相依。純函式守護
`tests/unit/offline_image_profile.test.js`（含分桶結果的鎖定值）。

| scenario | 回應 | 產品端 |
|---|---|---|
| `cache` | 立即 `preview.png` | 秒開（＝本地快取命中，本層引入前的唯一行為） |
| `slow` | 等 `SLOW_IMAGE_MS`（預設 **5200**，`OFFLINE_SLOW_IMAGE_MS` 可覆寫）後 `preview.png` | 期間維持 `.previewLoading`；終局 DOM 與 `cache` 相同 |
| `broken` | `404` + **空 `text/plain`** | 候選耗盡 → `.previewError`；佔位盒不得被釘高度 |
| `redirect` | `301` → `https://offline-gone.invalid/__offline-gone__/<n>.png`（該路徑一律 `broken`） | 圖拿不到 → `.previewError` |

profile 取值：`cache`（預設）／`slow`／`broken`／`redirect`／`mixed`（四桶決定性分派）。
解析優先序 **env `OFFLINE_IMAGE_PROFILE` > Playwright project 名 > `cache`**
（`offline-slow`／`offline-broken`／`offline-mixed`；用 project 名而非 env 才不必引入 cross-env）。
單一測試可用 `bootOffline(page, ptt, { imageProfile })` 直接指定。

三條硬性不變量（改這層之前先讀）：
1. **決定性**。逆境 profile 的用途是把偶發紅變成**必現紅**，它自己不可以是不確定的。
2. **轉址鏈一跳即止**：終點帶 `/__offline-gone__/` 前綴，`imageScenarioFor` 看到就回 `broken`。
   終點的 **origin 固定是 `https://offline-gone.invalid`**（RFC 2606 保留域，永不解析），**絕不可沿用原址** ——
   理由見下方 CONFIRMED 的第三條。
3. **`broken` 的 body 不得是可解碼的圖**。`<img>` 不看 HTTP status，body 能 decode 就 `onLoad`
   ——「imgur 的 404 頁身也是一張 PNG」正是靠這個假綠了很久。

CONFIRMED 事實（實測，別再重驗）：
- **產品端沒有圖片載入 timeout**。`ImagePreviewer` 只有 onError 驅動的 backoff 重試
  （`MAX_RETRIES_PER_CANDIDATE=2`、`RETRY_BASE_MS=300` ⇒ 每候選 1+2 次、300/600ms），
  候選耗盡才 `.previewError`。**永遠 hang 的請求會永久停在 `.previewLoading`。**
  唯一有 timeout 的是 imgur 型別探測（`imgur_probe.js`，3s abort）。
- **Chromium 會跟隨 `route.fulfill` 吐出的 301，但那一跳不再經過 `page.route`**
  （2026-08-28 更正；08-27 曾誤判成「不會跟隨」）。從測試這一端看到的現象與「不跟隨」**一模一樣**
  ——handler 只被打到一次、`offlineServedUrls` 裡沒有終點、`<img>` 直接 onerror——但那筆請求
  是**真的送上公網**的。所以 `redirect` 情境驗得到的仍只是「圖床回 3xx ⇒ 圖拿不到」，
  **驗不到**「跟隨轉址後再 404」；斷言照實際能觀察到的寫。
- **這就是轉址終點的 origin 絕不可沿用原址的原因。** 原本沿用，而產品預設 `useImgurProxy:true`
  會把 imgur 網址改寫成自架 Worker 位址（`src/js/imgur_proxy.js`）⇒ 終點被鑄在正式基礎設施上，
  每輪 offline e2e 都真的去打它。發現方式是 Cloudflare access log 出現
  `GET https://ptt-imgur-cache.…workers.dev/__offline-gone__/783.png`（`fnv1a` 對得上，逐字吻合）。
  同一機制也對 `i.imgur.com`／`pbs.twimg.com`／`i.urusai.cc` 等圖床發出真實請求，只是看不到別人的 log。
  修法＝終點固定 `GONE_ORIGIN`（保留域）＋ 瀏覽器層硬斷網（見上方「零外流」三層）。
  當時所有守門全數漏接：零外流斷言只跑在 `cache`／`slow` 兩個**永遠不吐 301** 的 profile；
  轉址鏈斷言只看 `served`（終點從未進 served ⇒ 恆為空轉）；unit 甚至反過來斷言「終點與原址同 origin」。

### 逆境 project 與 CI job

`yarn test:e2e:offline:adverse` ＝ `offline-slow` + `offline-broken` + `offline-mixed`，
CI 另開一個平行 job `test-e2e-offline-adverse`（`.github/workflows/test.yml`）。
清單在 `playwright.config.js` 的 `ADVERSE_LAYOUT_SPECS` / `ADVERSE_IMAGE_SPECS`：

| Tier | 內容 | 跑哪些 profile | 理由 |
|---|---|---|---|
| A `ADVERSE_LAYOUT_SPECS` | 版面／座標敏感，但與圖片**成敗**無關（mouse、pusher_highlight、blacklist_quick_add、comment_merge、enhance、quick_search） | slow / broken / mixed | 斷言語義完全不變，三種都成立才算穩 |
| B `ADVERSE_IMAGE_SPECS` | 主題就是圖片本身（lazy_preview_*、easy-reading） | 只跑 slow | 「圖有高度」是它們的前提；`broken` 下語義會變，那條路徑由 `image_load_conditions.offline.spec.js` 專門驗 |

`image_load_conditions.offline.spec.js` 刻意**不在**逆境清單裡：它自己逐條指定 profile
（明確傳入優先序最高），放進去只會原封不動再跑一次。

實測（2026-08-27，本機 Windows／chromium）：`offline` 215 passed **6.3m**、
`offline:adverse` 189 passed **10.4m**（連跑兩輪結果一致）。CI 上這兩個 job 平行跑，牆鐘時間不變。

**捕捉力已驗證**：把 `pusher_highlight.offline#commentRow` 還原成「捲完立刻量 → 用舊座標點」，
`offline-slow` 與 `offline-mixed` 各 3 條**全紅**。這就是這套逆境 profile 存在的理由。

第三個層次 `scrollIntoViewStable`（捲到中央 → 等停 → 確認**仍在視窗內**，否則重來）是實作時
被逆境抓出來才補的：只做一次「捲 → 等 → 量」會拿到一個**穩定但已經捲出視窗**的 rect
（`offline-mixed` 下量到 y=1090，視窗只有 720 高），之後 `elementFromPoint` 回 null。

### 本機跑 adverse 的 worker 崩潰（Windows，環境問題）

2026-08-29 本機連兩次跑 `yarn test:e2e:offline:adverse`，跑到第四個 project
（`offline-mixed`，約第 174～181 條）整個 worker 掛掉：

```
Error: worker process exited unexpectedly (code=3221225794, signal=null)
```

`3221225794` ＝ `0xC0000142` `STATUS_DLL_INIT_FAILED` —— **新進程連 DLL 都初始化不了**
（掛掉的是 Playwright 的 node worker，而且是啟動當下就死），不是被測 code 的問題。
判準（三個一起看，缺一就要往 code 查）：

1. 失敗訊息是上面那行，**沒有任何 AssertionError／Test timeout**；
2. 失敗案例的耗時是 `0ms`（worker 死掉時把它排隊中的 case 一起標紅）；
3. 同一批 spec 在 `yarn test:e2e:offline`（一般情境）全綠。

成因是一輪連續開關上百個 Chromium（每條測試一個 page ＝ 一個 renderer 進程；前面剛跑完整包
offline 更容易踩）耗盡 Windows 單一桌面 session 的 desktop heap／handle。

**處置已自動化**：`yarn test:e2e:offline:adverse` 現在走 `scripts/run-adverse-e2e.mjs`
（不再是一句 `playwright test --project=a --project=b --project=c`）：

| 手段 | 內容 |
|---|---|
| 分批 | 一桶一個獨立 playwright 進程。批次結束＝playwright 與所有 Chromium 完全退出，OS 才真的回收 |
| 冷卻 | 批次間隔預設 5s（env `ADVERSE_COOLDOWN_MS`） |
| 共用 dev server | 腳本自己起一次 vite，各批靠 `reuseExistingServer` 附上去，不反覆啟停 |
| 條件式補跑 | **只有**命中崩潰指紋（`worker process exited unexpectedly` ＋ `3221225794` ＋ 零 AssertionError／Test timeout）才用 `--last-failed` 補跑一次；真斷言失敗**永不重試** |
| 本機不錄影 | 逆境三桶 `video: process.env.CI ? 'retain-on-failure' : 'off'`（`ADVERSE_USE`）。`retain-on-failure` 是**每條都在錄**、只有失敗才留檔 ⇒ 189 條就是 189 份 screencast 通道與暫存檔 handle |

exit code 刻意分三種：`0` 全綠｜`1` 有真失敗（往被測 code 查）｜`2` 環境崩潰或沒跑完（**不要**改被測 code）。
逃生門：`--only=offline-slow,offline-mixed`（挑桶，逗號分隔）、`--batch=spec`（每支 spec 各一個
playwright 進程，最保守；實測只多付約 0.4m）、`--no-retry`。每批結束會印當下 `chrome.exe`／
`node.exe` 進程數（只讀不殺），下次再崩時可直接看是不是孤兒累積。

**已排除的方向（別再重想一遍）**：重用 BrowserContext 省不到進程 —— context 不是進程，一個
**page** 才對應一個 renderer process，共用 context 但每條仍開自己的 page，進程數完全不變。
真能減進程的是重用 **page**，但 `tests/e2e/offline/` 有 183 處 `bootOffline`／`installReplay`
全依賴「每條全新 boot ＋ `addInitScript` 在 `goto` 之前覆寫 `window.WebSocket`」，而 init script
**加了無法移除** ⇒ 共用 page 會讓那些 stub 疊加。要走得先把 cassette 供給改成 `exposeBinding`，
屬中型重構且會波及跑得好好的 215 條一般 offline，**目前不做**。

實測（2026-08-29，本機 Windows／chromium，分批後）：`offline-slow` 85 條 5.7m、`offline-broken`
52 條 2.1m、`offline-mixed` 52 條 3.0m，合計 189 條約 10.8m（與分批前的 10.4m 同量級），全綠。

### 媒體測試不准用 `test.skip` 吸收訊號

外部圖床時代，媒體相關測試裡塞了不少 `test.skip`（`loaded imgs = 0`、`enlarge did not
apply`…）當防禦，避免圖載不到就假紅。**圖改本地 fixture 後這些防禦全部失效** —— 圖必定
載得到，所以那些狀況一律是真 bug，已改為硬失敗（`expect(r.error).toBeUndefined()`）。
新增媒體測試時比照辦理，別再用 skip 吸收訊號。

適用性判斷則移到**產生測試之前**：`easy-reading.offline.spec.js` 以 `withImages`
（掃 cassette 內文找圖片連結，iframe 類不算）決定要不要為該卷生成「點圖縮放」測試。
不適用的卷根本不出現在測試清單裡，而不是跑起來才 skip —— 後者在報告上看起來像覆蓋
漏洞，也會把真問題混在同一個 skip 理由裡。素材整組為空時才留一個顯式 skip 標記。

### 踩坑（此段修過兩次，別再重來）
- **`page.route` 必須用述詞過濾，不可用 `'**/*'` + `route.continue()`**：Vite dev server
  一頁幾百個 module 請求，全部拉進攔截層再 `continue()`（等於每筆重發）會讓整批 offline
  e2e 大面積逾時，且失敗散落在與圖片毫無關係的 spec（`ui_behavior`／`debug_record`…），
  極易誤判成別的問題。
- **twitter 的 `:orig`／`:large` 尾綴**：`pbs.twimg.com/<id>.jpg:orig` 的副檔名後面是 `:`，
  圖片判準漏掉它 → 落入 `blocked` → 四個候選全 404 → `previewError`。
- **不要靠「圖床回 404 但身體是圖」僥倖**：`stock-huang` 的 `i.imgur.com/L976tXr` 現在
  `.webp` 回 404（0.6～4.2s 抖動）、`.png` 直接 hang（>15s）；過去會綠純粹因為 imgur 的
  404 頁身也是一張可解碼 PNG（`<img>` 不看 HTTP status，body 能 decode 就 `onLoad`）。
  等於測試早就在測「imgur 的錯誤圖」而非我們的渲染路徑。

## 踩坑
- 必須先 `applyPrefs(enableEasyReading:true)` 寫 localStorage **再** `enterEasyReading()`，否則
  `easy_reading.js` 的 `_onChanged` 讀到 pref off 會立刻 `exitEasyReading`。
- `installReplay()` 的 `addInitScript` 必須在 `page.goto` **之前**（覆寫 `window.WebSocket` 要早於 bundle）。
- **「從未連上」要用 `installReplay(page, { neverOpen: true })`**（不 fire `open`，改 fire
  `error`+`close`）。它與「先連上再斷線」是**兩條不同路徑**：`App.onConnect` 從不執行 ⇒
  `TermView.setConn` 沒被呼叫 ⇒ `view.conn === undefined`，任何直接 `view.conn.send()`
  立刻 TypeError；先連上再斷線時 `view.conn` 是已關閉的 socket，`send()` 依規範是 no-op 不 throw。
  守護：`tests/e2e/offline/connect_failure.offline.spec.js`。
  **不要改用 Playwright 的 `page.routeWebSocket()`** —— 它會把 mock 的 WebSocket 在頁面裡
  **開起來**（官方 types：「Playwright assumes that WebSocket will be mocked, and opens the
  WebSocket inside the page」），`onConnect` 照跑，測不到這條路徑。
- **stub WebSocket 只准接管 `/bbs` 那一條**（`replay.js#isBbsSocketUrl`，pathname 結尾 `/bbs`），
  其餘交還原生 `WebSocket`。覆寫的是**全域** `window.WebSocket`，一度連 Vite dev server 的
  HMR socket 也被接管 ⇒ HMR client 送出的 `vite:forward-console` JSON 被記進
  `window.__sent` / `__replay.sent`，混進「app 送給 PTT 的 bytes」。症狀是**偶發紅**（頁面吐出
  任何 console error / unhandled rejection 才觸發轉發，所以哪支 spec 中槍看當下運氣）：
  `long_push.offline` 期望 `sentText === 'X'` 卻拿到
  `X{"type":"custom","event":"vite:forward-console",...}`；`mouse.offline` 也中過。
  連帶：`window.__stubWS` 之前會被後建立的 HMR socket 蓋掉。
  判準是純函式，守護 `tests/unit/offline_ws_stub_url.test.js`；症狀層守護
  `tests/e2e/offline/harness.offline.spec.js`（主動製造一顆 unhandled rejection 再驗 `__sent` 空）。
  `addInitScript` 的 callback 看不到模組作用域，所以判準以 `.toString()` 帶進頁面重建 ——
  **別在頁面裡另抄一份**，那就沒有單一來源了。
- **產品端的 promise 一律要接住 rejection**（同一個根因的另一半）：`navigator.clipboard.writeText`
  在 document 沒有焦點 / 非 secure context / 權限被拒時 reject `NotAllowedError`，
  `navigator.clipboard` 本身在非 secure context 更是不存在。`App.doCopy` 原本裸呼叫 ⇒ 真實使用者
  console 冒紅字、離線 e2e 被 HMR 轉發污染。守護 `tests/unit/copy_clipboard_reject.test.js`。
- **在好讀長頁上量元素座標，一定要走 `tests/e2e/helpers/layout.js`**：長頁裡的行內預覽是
  佔位盒（IntersectionObserver → mount → onLoad → ResizeObserver 撐高），`scrollIntoView`
  本身就會把它們捲進視窗而觸發載入 ⇒ 捲完當下量到的 `getBoundingClientRect` 之後還會再位移。
  位移之後用舊座標點下去就落在別的元素上，斷言會退化成看不出原因的失敗（實例：`mouse.offline`
  的「點推文內容＝同作者高亮」在 CI 拿到 0 個高亮列）。
  三個層次：`waitPreviewsSettled`（整頁終局：**Node 端在途圖片請求**＋`.previewLoading`＋
  版面指紋連續三次相同）／`waitRectStable`（單一元素 rect 連續 3 次×100ms 不動）／
  `assertElementUnder`（點擊前再確認，失配時直接說出「預期 X、實際 Y」）。
  推文列與左緣純文字的取點合併成 `stableCommentRow` / `plainLeftEdge`。
  - **本機測不出這類 bug**：預設 profile 是 `cache`（fixture 圖秒回），版面在量測前就穩了。
    要逼出來必須 `yarn test:e2e:offline:adverse`（`offline-slow`）。
  - 靜態守護 `tests/unit/e2e_layout_settle.test.js`：會量座標又會動滑鼠的 offline spec 一律
    要 require 這個模組（豁免要具名並寫「結構上免疫」的理由）。50fa35c 的 settle 只活在一支
    spec 的內層閉包裡，於是 `pusher_highlight.offline` 那份逐字拷貝原封不動地留著同一個 bug
    ——這條測試就是為了不再發生那件事。
  - `waitPreviewsSettled` 逾時**丟錯**而不是靜默放行；`mountLazyPreviewsAt` / `seekInlineMedia`
    的停止條件也改成它（舊版靠固定 sleep，在 `slow` 下會在圖還沒回來時就收工）。
- Layer2 重建要 `pageScreens[p].slice(0,-1)` 去掉狀態列（與 accumulatePageLines 一致）。
- `getRowText(row,0,cols,pageLines)` 第 4 參傳 pageLines 才讀累積頁（不傳讀 24 列原生 buf）。
