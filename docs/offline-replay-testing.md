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
yarn test:e2e:offline   # 離線重放（stub WebSocket，零網路），斷網/無帳密也全過
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
| `image` | path+search 命中 `\.(jpe?g\|png\|gif\|webp\|bmp\|apng\|avif)($\|[?#:])` | `tests/e2e/fixtures/preview.png`（800×600，`image/png`） |
| `imgur-album` | host `api.imgur.com` | 假 JSON，兩張 `i.imgur.com/offline*.png` |
| `flickr` | host `api.flickr.com` | 假 photo JSON |
| `blocked` | 其餘（youtube/twitch embed、未知 host） | 404 空身（iframe 的 `load` 與 status 無關，仍觸發） |

- 純函式 `classifyOfflineRequest` 守護在 `tests/unit/offline_network_route.test.js`。
- 「零外流」守門在 `easy-reading.offline.spec.js` 的行內開圖測（`offlineServedUrls(page)`
  必須涵蓋 `page.on('request')` 看到的每一筆外部 URL），拿掉路由即紅。
- **影片副檔名刻意不給 fixture**：現有 cassette 無直連影片。日後錄到影片素材會以
  「`video` 未 `loadeddata` → `display:none` → 等不到 visible」紅出來，屆時補一支最小 mp4。

### skip 政策（圖片本地化後同步收緊）
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
- **在好讀長頁上量元素座標，一定要等版面停下來再量**：長頁裡的行內預覽是佔位盒
  （IntersectionObserver → mount → onLoad → ResizeObserver 撐高），`scrollIntoView` 本身就會把
  它們捲進視窗而觸發載入 ⇒ 捲完當下量到的 `getBoundingClientRect` 之後還會再位移。位移之後
  用舊座標點下去就落在別的元素上，斷言會退化成看不出原因的失敗（實例：`mouse.offline` 的
  「點推文內容＝同作者高亮」在 CI 拿到 0 個高亮列，本機因 fixture 圖秒回而測不出來）。
  作法見 `mouse.offline.spec.js#commentRow` 的 `settle()`：連續兩次量到同一個 top 才收；
  並在點擊前用 `pusherUnder` 再確認一次指標底下還是同一列。
- Layer2 重建要 `pageScreens[p].slice(0,-1)` 去掉狀態列（與 accumulatePageLines 一致）。
- `getRowText(row,0,cols,pageLines)` 第 4 參傳 pageLines 才讀累積頁（不傳讀 24 列原生 buf）。
