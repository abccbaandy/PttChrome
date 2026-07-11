# 離線重放測試（byte cassette）

把會過期的「特定文章」e2e 素材永久化：錄一次真實 PTT 的 byte 流 → 之後不連網確定性重放並斷言。
解決 `tests/e2e/*.spec.js` 依賴特定文章（過期就 `test.skip`、回歸失守）的問題。

## 為什麼不是單一靜態快照
好讀模式是**互動式翻頁**：靠 `EasyReading._send('\x1b[6~')`（`src/js/easy_reading.js:82,318`）主動向 server 要下一頁，
逐頁累進 `termBuf.pageLines`（`src/js/term_view.js accumulatePageLines` + `comment_parse.resolvePageOverlap` 去重：狀態列行號為主、`findPageOverlap` 內文為輔）。
「第一則推文消失 / 樓號錯位」是跨頁累積產生 → 必須忠實重放逐頁節奏。

## 架構（單一錄製源，兩層消費）
```
一次真實錄製(guest) → recorder
   ├─ tests/e2e/cassettes/<name>.json        → Layer1 Playwright 離線重放（真瀏覽器/真渲染）
   └─ tests/unit/fixtures/replay/<name>.page.json → Layer2 jest 純邏輯（node, 秒級）
```
- **注入點**：stub `window.WebSocket`（不連網、吞 send）讓 app 離線 boot；把 cassette 每頁 recv 餵回
  `App.onData`（`src/js/pttchrome.js:252`，= 真實 parser→termBuf→`<Screen>`）；以好讀自己送出的
  `\x1b[6~`/`\x1b[4~` 當「放下一頁」門控。見 `tests/e2e/helpers/replay.js`。
- **Layer1**：產出真實 DOM → 可跑現有全部斷言（翻頁回歸 / 樓層 / 黑名單 / pusher / 列表）。
- **Layer2**：用 *真實* `resolvePageOverlap`（狀態列行號為主＋`findPageOverlap` 為輔）從「每頁文字快照」
  重建累積（鏡像 accumulatePageLines；快照末列即原始狀態列，可解析行號），純 node 守護去重 off-by-one
  + 重複區塊 + FloorCounter + blacklist。見 `tests/unit/replay_fixture.test.js`。

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
- `record:cassette` = `cross-env RECORD_CASSETTE=1 playwright test --project=record`（無 RECORD_CASSETTE 會 skip）。
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
- `playwright.config.js` 三 project：`live`（現有 spec，排除 offline/tools）、`offline`、`record`。
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
- 守護測試：`tests/unit/redact.test.js`、`tests/unit/debug_recorder_logic.test.js`、
  `tests/unit/debug_recorder.test.js`、`tests/e2e/offline/debug_record.offline.spec.js`。

## 回歸捕捉力驗證（關鍵，證明素材真能守門）
錄好 cassette 後：臨時改壞 `comment_parse.findPageOverlap`（或 stash 第一則推文修復 commit），
`yarn test:e2e:offline` + `yarn test:unit` 必須**變紅**（首推作者缺席 / commentCount 不符 / 樓號錯位）；
復原後轉綠。

## 踩坑
- 必須先 `applyPrefs(enableEasyReading:true)` 寫 localStorage **再** `enterEasyReading()`，否則
  `_onChanged` 讀到 pref off 會立刻 `exitEasyReading`（`easy_reading.js:182`）。
- `installReplay()` 的 `addInitScript` 必須在 `page.goto` **之前**（覆寫 `window.WebSocket` 要早於 bundle）。
- Layer2 重建要 `pageScreens[p].slice(0,-1)` 去掉狀態列（與 accumulatePageLines 一致）。
- `getRowText(row,0,cols,pageLines)` 第 4 參傳 pageLines 才讀累積頁（不傳讀 24 列原生 buf）。
