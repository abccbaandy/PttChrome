# E2E 測試（Playwright）

| 層 | 指令 | 連 PTT | 範圍 |
|---|---|---|---|
| live | `yarn test:e2e` | 是（整輪 1 次登入） | **只有核心**：`core.spec.js` |
| offline | `yarn test:e2e:offline`（＋`:adverse`） | 否（cassette 重放） | 其餘所有功能 |
| record | `yarn record:cassette`／`yarn record:scenarios` | 是（每次 1 次登入） | 產素材，不是測試 |

## live 範圍（2026-10 定案）

PTT 有登入額度（見「登入預算」）⇒ live 不能像 offline 一樣反覆跑到綠。live **只保證核心**，
其餘一律 offline：

| `core.spec.js` | 判準（**不比對畫面內容**，PTT 改版頻繁） |
|---|---|
| 登入 | 有帳密＝產品自動登入（`shared.boot.auto`），落地 `pageState 1` |
| 主選單／文章列表（原生＋列表好讀）／文章（原生＋好讀）不跑版不亂碼 | `helpers/screen_sanity.js`：每列 DOM 文字＝`buf`、末字右緣＝欄位×`chw`、Big5 每對都解得出、`#mainContainer` 無水平溢出。畫面種類問 `buf.pageState` |
| 列表解析器健康度 | 有序號的列 ≥70% 有 `data-list-author`（產品的 `parseListAuthor`）。取代以前寫死 cols 17-28 的測項 |
| 開圖 | 好讀累積到文末 → `seekMountedPreview` 試 ≤8 張，**至少一張真的畫出來** |

唯一寫死的是選文條件：Stock 板 `/盤後閒聊` 的最新一篇（長文、圖多、天天有新的）。
同一個檢查器在 offline 逐卷跑（`offline/screen_sanity.offline.spec.js`，含突變自證）。

**每輪 live 自動錄一份**（`helpers/fixtures.js` → `tests/e2e/__recordings__/live-*.json`，gitignored，
留最近 10 份，每條 test 的起訖有 `test.begin`／`test.end` log 標記）。格式＝使用者的
`ptt-debug-*.json`：`yarn debug:screens <檔> [ms]` 看畫面；要轉成素材照
`docs/offline-replay-testing.md`「使用者 Debug 錄製檔 → cassette」。**live 紅在新版面／新協定
時的流程：拿錄製檔到 offline 重現 → 修到綠 → live 只再跑一輪確認。**

**每輪 live 之後跑 `yarn triage:recordings`**（零網路零登入）：錄製檔逐幀重放＋同一個檢查器，
每一幀都驗（live 核心只驗幾個畫面）；紅幀自動切成 `cassettes/pending/*.json`＋`<錄製檔>.list.json`
清單，全綠不產出。詳見 `docs/offline-replay-testing.md`「live 錄製檔分流」。

2026-10 前的 live 測項去向（全部改由 scenario 卷重放，素材 `cassettes/scn-*.json`）：

| 舊 live | offline |
|---|---|
| `easy-reading.spec`（h 說明、:N、`/` 提示）、`enhance.spec` 回文選單 | `er_function_mode.offline` |
| `easy-reading-list.spec` `]`、游標捲出視野 ↓ | `scenario_navigation.offline` |
| `aid-navigation.spec` ×3 | `scenario_navigation.offline`（`aid-back` 卷、`aid-back-search` 卷） |
| `deep-link.spec`（落地＋F2） | `deep_link_landing.offline` |
| `board_list_scroll.spec` ×5、`search_prompt.spec` | `board_list.offline`（分類看板子清單，guest 可錄，不含個人最愛） |
| 其餘（樓層、黑名單、pusher、列表好讀各站、第一則推文、End 切原生、行內開圖） | 早已有同名 offline 版（`enhance`／`easy-reading`／`easy-reading-list`／`pusher_highlight`…） |

## 跑

```powershell
# guest（PTT guest 名額常滿，滿時會 fast-fail 並提示改用帳號）
yarn test:e2e

# 真實帳號（帳密只讀環境變數，不進 git）
$env:PTT_USER="你的帳號"; $env:PTT_PASS="你的密碼"; yarn test:e2e

# 帳號有開兩階段驗證（2FA）時**必須**再給密鑰，否則整包 live 會卡在驗證碼畫面
$env:PTT_OTP_SECRET="Base32 密鑰或整段 otpauth:// 網址"

yarn test:e2e:headed   # 肉眼看登入過程
yarn test:e2e:ui       # Playwright UI 模式
```

**2FA 帳號**：有帳密時整輪唯一那次登入走 `helpers/ptt.js#autoLoginBoot`，密鑰
（`PTT_OTP_SECRET`）注入 prefs 交給產品的 `src/js/auto_login.js` 自己算；**沒給密鑰時
app 端會刻意停在驗證碼畫面把鍵盤交還使用者**（該降級路徑守在
`tests/unit/auto_login_2fa.test.js`）。沒有帳密時退回 guest，走 `helpers/ptt.js#login`
手動打字（它用 `src/js/totp.js` 即時算碼，最多送 2 次，重試前先等過 30 秒窗——同一窗
重算是同一組碼）。

dev server 由 `playwright.config.js` 的 `webServer` 自動啟動（已手動 `yarn start` 時 `reuseExistingServer` 會重用）。

真 Android Chrome（模擬器）的 e2e 在 `android/`，另一條跑法 `yarn test:e2e:android`（不連 PTT、不登入），
見 `docs/android-e2e.md`。

## PTT 連不上時（preflight 連線健檢）

`live` 與 `record` project 都 `dependencies: ['preflight']`（`preflight.setup.js`）。
preflight 只驗一件事：**連得到 PTT 嗎**（app 有 boot → WebSocket 連上 → server 有吐畫面），
紅了就整包 live 不跑，只留一則明確結論。

判準（訊息會直接寫在錯誤裡）：

| 現象 | 結論 |
| --- | --- |
| `window.__app` 不存在 | 本專案／dev server 問題（bundle 掛了、dev server 沒起來） |
| `connectState=2`（已斷線） | **PTT 端不可達或維護中**，非本專案 code 問題 |
| `connectState=0`（一直在連） | PTT 不可達或網路被擋，非本專案 code 問題 |
| `connectState=1` 但畫面空白 | 連上了但 server 不吐畫面（PTT 維護模式常見） |

**PTT 維護中時 live e2e 必紅，這是預期行為**，先開 https://term.ptt.cc 確認站台狀態，
不要往本專案 code 追。逃生門 `$env:E2E_SKIP_PREFLIGHT="1"`（會跳過健檢直接跑 live）。

純函式 `describeConnectFailure` 的訊息內容由 `tests/unit/e2e_preflight_message.test.js` 守護。

**連線失敗類的行為測試不放這裡**：真 PTT 沒辦法可靠地製造「連不上」，一律測在 offline
project（`offline/connect_failure.offline.spec.js`，用 `installReplay(page, { neverOpen: true })`），
好處是 CI 的 offline-e2e job 也跑得到（live e2e 不在 CI）。

## 連得上但登入卡住時（login 階段判準）

preflight 只管「連得到 PTT」；**帳密送出之後**卡住是另一回事。`login()` 的決策全在純函式
`helpers/login_flow.js`（unit 守護 `tests/unit/e2e_login_flow.test.js`），錯誤訊息直接寫結論：

| 畫面 / phase | 結論 |
| --- | --- |
| `正在檢查帳號與密碼...`（`server-verifying`） | **PTT 端驗證慢，非本專案 code 問題**。logind `auth_start()` 畫完這行就**同步**跑 `auth_user_challenge()`，期間不吐畫面也不吃鍵盤 ⇒ client 只能等 |
| `密碼正確！ 開始登入系統...`（`server-starting`） | **PTT 端交接／配位慢**。logind 已 `start_service()` 交給 mbbsd 等 ack（server 端 `ACK_TIMEOUT_SEC` = 5 分）；mbbsd `multi_user_check()` 另有數秒隨機 sleep |
| `部份系統正在維護中` / `系統過載` / `人數過多` / `已達上限` | PTT 端容量或維護狀態，非本專案 code 問題 |
| `connected=false` | 連線在登入途中被關掉 |
| `phase=unknown` | PTT 出現沒見過的提示頁 ⇒ **這才是要動 code 的情況**：把它加進 `classifyLoginScreen` 並補 unit 測試 |

前四種**直接重跑即可**，不要往被測 code 追。

## 登入預算：整輪 live e2e 只登入一次（**強制規範**）

**任何新 spec 一律用共用 session（`helpers/fixtures.js` 的 `shared` fixture），不准自己
`page.goto('/')` + `login()`，也不准自己開 `browser.newContext()`。**
守護兩條：`tests/unit/e2e_login_budget.test.js`（純靜態掃描，違反就紅）與
`tests/unit/e2e_auto_login_boot.test.js`（假 page 餵畫面序列，鎖住開機本身的登入次數：
被封鎖時不重開站、節流重試有上限、終局畫面快速失敗）。

理由是 PTT 有登入頻率限制，而且踩到之後**重試會讓情況變糟**。開源碼裡讀得到的下界
（`daemon/utmpd/utmpserver3.c#action_frequently`，完整表在
`docs/pttbbs-screen-protocol.md` §11.2）：

| 條件 | 後果 |
|---|---|
| 距上次登入 ≤ 3 秒 | reject |
| 同一分鐘 > 3 次 / > 10 次 | delay / reject |
| 同一小時 > 20 次 / > 60 次 | delay / reject |

一輪 live 只有 `helpers/fixtures.js` 的 `shared` 這 **1 次**登入，而且那一次開機**就是產品
自己的自動登入**（`helpers/ptt.js#autoLoginBoot`：注入 autoLogin prefs → 開站 → 完全不按鍵
等主功能表）⇒ `core.spec.js` 的登入測項斷言的就是它（`shared.boot`）。沒有 `PTT_USER`/`PTT_PASS`
時退回 guest + 手動 `login()`。

**錄製素材也吃同一份額度**：`record:cassette`／`record:scenarios` 每跑一次＝一次登入；
`record:scenarios` 一次登入錄完全部 scenario，失敗的那段記下來繼續錄下一段（不重登）。

deep link 的冷啟動暫存排程與「重複登入」提示，因為整輪只有一條連線而做不出來，
**刻意**只由 unit 守（別再為了它們加登入）：

| 失去的 | 為什麼 | 誰在守 |
|---|---|---|
| 「重複登入」提示 | 以前靠「共用 session 掛著時再開一條」製造；整輪只剩一條連線就做不出來 | `tests/unit/auto_login_2fa.test.js`、`auto_login_logic.test.js`（one-shot guard `_answeredDup`/`_answeredErr`） |
| deep link「連結先到、人還沒登入」的暫存排程 | 冷啟動特有的時序 | `tests/unit/deep_link_controller.test.js`（`_hold`/`_pending`，含 handoff 通知） |

（2026-08-25 之前是十幾次：`easy-reading-list.spec.js` 一支就自己登入 9 次。
2026-08-26 之前是 3 次，那樣連跑五輪照樣被鎖 —— 實錄見下一節。）

**另一個放大器：Playwright 在 test 失敗後會重啟 worker** ⇒ worker-scoped 的 `shared`
fixture 重建 ⇒ 又登入一次。所以失敗多的那一輪，登入次數會遠超上表。對策有兩道：
共用 session 的 spec 用 `describe.serial`（同一塊裡一條失敗就跳過其餘），以及下一節的閂鎖。

### 「已被暫時禁止登入」＝PTT 的 DDoS/BOT 保護，**不可以靠重跑解決**

畫面出現下列任一句時，帳號已被 PTT 端擋住，**每多試一次就多延長一次封鎖**：

```
[PTT DDoS/BOT 偵測系統] 偵測到連線異常/不當連續登入行為！
[PTT DDoS/BOT 偵測系統] 帳號 xxx 有疑似不當連續登入行為所以暫停連線。
```

這段文字**不在 pttbbs 開源碼裡**（已用 Big5 正確編碼查證），是 PTT 站方自有的防濫用層。
封鎖畫面自己寫了規則（2026-08-25 實錄全文見 `docs/pttbbs-screen-protocol.md` §11.2）：

> 本系統為獨立動態偵測連線，與BBS內帳號權限無關，**無法申請手動解除鎖定**，也不會告知暫停時限。
> 在停止使用機器人或行為不正常的App（**部份App需要關閉自動登入**）、
> **無任何登入行為之後最多 12 小時**後會恢復。
> 注意在暫停期間若持續嘗試登入會被視為機器人，**將無限期延長暫停時間**。

三個直接後果：
- **解除條件是「完全沒有登入行為」，不是「等一下」**——連平常用瀏覽器掛著自動登入都會重置那 12 小時。
- **重試會無限期延長**，所以這是唯一一種「再試一次」比「什麼都不做」更糟的失敗。
- 沒有申訴管道，也不會告訴你還要等多久。

2026-08-25 實測：第一輪 24 綠 2 紅，接著只重跑 `easy-reading-list.spec.js`（9 條），
**9 條全部卡在登入閘門**，沒有一條進得到被測 code。

已內建的自動處置（`helpers/bot_block.js`）：

1. `login()` 認得這兩種畫面（`login_flow.js` 的 `bot-blocked` phase）→ 直接 fail，
   **不重連、不退避重試**（對比「登入太頻繁」是 reconnect 退避，兩者處置相反）。
2. 就地立一個**寫檔的**閂鎖（要跨 worker 重啟才有效），之後這一輪任何 spec 在開
   browser context 之前就直接略過，一個 byte 都不再送給 PTT。
3. 閂鎖由 `global-setup.js` 在每輪開跑時清掉 ⇒ 只在同一輪內有效。

人這邊要做的：

1. **停手**。不要再跑任何 live e2e，並且**關掉平常瀏覽用的自動登入**（計時從「最後一次
   登入行為」重新起算，最多 12 小時）。
2. 這段期間改跑 `yarn test:unit` 與 `yarn test:e2e:offline`（真瀏覽器＋真渲染，不碰 PTT）。
3. 要驗單一行為時只跑**那一條**（`yarn test:e2e <spec> -g "<標題片段>"`），不要整輪重跑。

判準：這是 PTT 端的帳號保護，與被測 code 完全無關；螢幕上就寫著結論，別往專案 code 追。

踩過的坑（2026-08，`connect-login.spec.js` 偶發紅、單獨重跑 3 秒就過）：

- 登入互動迴圈原本只有固定 40 秒預算，且**沒有任何分支認得「正在檢查帳號與密碼」** ⇒
  PTT 端驗證慢時撞死在該畫面，吐一則看不出是誰的問題的泛用逾時。現在這兩個「server
  正在跑」的畫面會**從進入該畫面起算**延長預算（上限 `LOGIN_SERVER_PROGRESS_BUDGET_MS`），
  換階段（verifying → starting）重新起算，超過才逾時並吐上表的結論。
- 卡住的是**那條連線**而不是站台：整輪 live e2e 只有一條卡滿 46 秒紅掉，下一條 spec
  12 秒後另開連線就登入成功。所以停在同一畫面超過 `LOGIN_SERVER_STALL_MS`（15s）就
  **就地重連重送帳密**（短退避 2s，最多 2 次，比照節流分支的配方），換連線通常就過。
  重連過還是卡住，逾時訊息會寫「已就地重連 N 次」——那才代表站台層級有問題。
- 觀察到的觸發條件：卡住的**幾乎都是整輪跑到後段那次登入**（實測兩輪都卡在
  `easy-reading-list.spec.js` 的第一條，也就是同一輪的第 4 次登入），疑似 PTT 對短時間
  重複登入的節流，只是表現成「靜靜卡住」而不是吐「登入太頻繁」。修好之後同一條 case
  照樣卡了一次，重連後 27.8s 內綠。**降低整輪登入次數**（共用 session fixture）仍是根治方向。
- 同時 `connect-login.spec.js` 是**唯一沒有自訂 timeout 的 live spec**，吃 60s 全域值 ⇒
  就算把等待策略放寬也沒有空間可用（其餘 live spec 一律 `test.setTimeout(120000)` 起跳）。
  已補 `test.setTimeout(180000)`。**新增會呼叫 `login()` 的 spec 記得也設**。

## live e2e 跑的時候**不要動工作目錄**（2026-09 實錄）

一輪 live 跑到一半時去改 `src/` 底下的檔案、或另外跑一次 `yarn build`，Vite dev server
會對開著的分頁下 **full-reload** —— 頁面重開之後：

- 測試在 `page.evaluate` 裡掛的東西（`window.__diag` 這類診斷 hook）**整個消失**，
  症狀是 `TypeError: Cannot read properties of undefined`，而且炸在**診斷輸出那一行**，
  真正的失敗點被蓋掉；
- console dump 裡會混進一整段**開機 log**（`pttchrome onConnect`、
  `auto_login: credential source = …`、`page state: 0->0`）——這就是判準：
  測試中途出現開機 log ＝ 頁面被重載，不是被測 code 壞掉。

**而且會多登入一次**：重載後的頁面照樣開站即 connect，localStorage 裡還有自動登入的
prefs ⇒ 產品自己又登了一次（2026-10 錄製 scenario 時改 `src/js/redact.js` 實際發生）。
⇒ live／record 在跑的期間只准改 `tests/`、`docs/`（不在 app 的 module graph 裡，不會觸發
重載）；要改 `src/` 就等它跑完。

**判斷順序**：先確認是不是自己在跑的時候動了檔案，再去懷疑被測 code —— 重跑一次要付一次
登入額度（見上方「登入預算」）。

## 孤兒進程 / stale bundle

以前常見坑：dev server 被中斷後殘留孤兒 `node` 佔住 8080，`reuseExistingServer` 又重用到 stale bundle。
現在所有 e2e 腳本（`test:e2e`、`test:e2e:offline`、`headed`、`ui`、`record:cassette`）跑之前都會先
`yarn kill:dev` 自動清掉佔 8080 的 dev server，再讓 Playwright 起全新 server：

- **每次指令只清/起一次**（非每個 test），不增加 PTT 登入次數。
- `kill:dev` 只砍「佔 8080 且確實是 node+vite」的進程，**不會誤殺**佔 8080 的其他服務（如 java）。
- **會**連帶殺掉你手動 `yarn start` 的 dev server（Playwright 會自己重啟一個）。
- 手動清理：`yarn kill:dev`（`scripts/kill-dev-server.js`，跨平台、永不 fail）。

debug 時想即時看到 page console / pageerror：設環境變數 `$env:E2E_ECHO_CONSOLE="1"`，或對需要的 case 用
`attachConsole(page, { echo: true })`（預設仍只存不印，避免正常跑測試時刷屏）。

## 失敗產物

- `test-results/.../test-failed-1.png`、`video.webm`：失敗當下畫面/錄影
- `playwright-report/`：HTML 報告（`npx playwright show-report`）
- console 紀錄會印在測試輸出（含 app 內 `console.log`，如 easy_reading 的 page state）

## 共用登入 session

**次數盤點與強制規範見上面「登入預算」一節**（唯一登入點＝這個 fixture；守護
`tests/unit/e2e_login_budget.test.js`）。這裡只寫怎麼用。

- `helpers/fixtures.js`：worker-scoped fixture `shared`（`{ page, logs }`），整個 worker 只登入一次，
  跨 spec 檔重用同一個已登入 page（live 恆 `workers:1`，由 `workers_policy.js` 保證；offline 才並行）。
- **規則**（新 test 預設照此寫）：
  - `const { test, expect } = require('./helpers/fixtures')`，case 收進 `test.describe.serial`。
  - 每個 case 開頭：`logs.length = 0` → `await resetSession(page)`（回主選單 + prefs baseline）→
    `await applyPrefs(page, {...})` 套本 case 需要的 prefs。
  - prefs **禁用 `addInitScript`**（共用 page 不 reload，載入前注入無效）；一律 `applyPrefs`（runtime）：
    寫 localStorage（`enableEasyReading` 由 easy_reading live 讀，下次進文章生效）+ 立即生效 key 走
    `window.__app.onPrefChange`（`onPrefChange('enableEasyReading')` 是 no-op，關閉時 applyPrefs 會直接退出好讀）。
  - 共用 page 非內建 fixture，失敗不會自動截圖/錄影 → catch 內自行 `page.screenshot`。
  - 某 case 失敗 → serial 後續 skip、Playwright 重啟 worker → fixture 重建（多登入一次）。
    **`describe.serial` 就是為了壓這個放大器**：沒有它，一塊裡 N 條紅就是 N 次重登。
- 沒有例外：自己開站的 spec 名單是空的（`tests/unit/e2e_login_budget.test.js`）。
- fixture 同時掛 DebugRecorder（登入**之後**才開錄）與每條 test 的 `test.begin`／`test.end`
  標記（auto fixture `_recordingMarks`），worker 收尾時寫錄製檔，見「live 範圍」。
- `login()` 兩道保險（處置相反，別搞混）：
  - 「登入太頻繁」（`mbbsd/talk.c`，開源碼有）→ 等 30s 重新連線重送帳密，最多 2 次；
  - 「[PTT DDoS/BOT 偵測系統]…」（PTT 私有）→ **直接 fail 並立閂鎖，整輪不再連線**。

## 結構

- `helpers/ptt.js`：可重用工具
  - `readScreen` / `waitForScreen`：讀 `#mainContainer` 文字、輪詢等字串（容錯，timeout 帶當前畫面）
  - `typeLine` / `sendKey`：對隱藏 input `#t` 打字
  - `login`：env 有帳密用真實帳號否則 guest；容錯迴圈只負責副作用，「看到這個畫面該做什麼」
    全在 `helpers/login_flow.js` 的純函式（見「連得上但登入卡住時」節）
  - `waitBbsConnected` / `describeConnectFailure`：連線健檢與其錯誤訊息（見上節；`login` 開頭也會呼叫，
    單跑一支 spec 時同樣拿得到明確結論）
  - `attachConsole`：收集 console / pageerror
  - `applyPrefs` / `resetSession` / `gotoBoard`：共用 session 專用（runtime prefs、回主選單復位、進看板）
  - `getPref(page, key)`：runtime 讀「有效 pref 值」（`DEFAULT_PREFS` 疊 localStorage），見下方規範
- `helpers/screen_sanity.js`：不跑版／不亂碼的結構檢查（live 核心與 offline 共用）
- `helpers/recording.js`：DebugRecorder 開／停／redact 把關、live 錄製檔存檔、錄製檔 → scenario cassette、
  `waitWireQuiet`（往返靜止＋背景佇列 idle）
- `helpers/recording_triage.js`（純邏輯：切幀／切點／切段／再 redact／寫檔把關）＋
  `helpers/triage_runner.js`（瀏覽器逐幀重放與切段驗證）＋`tools/triage-recordings.spec.js`（入口，
  project `offline-triage`）：live 錄製檔分流，見 `docs/offline-replay-testing.md`「live 錄製檔分流」
- `tools/record-scenarios.spec.js`：scenario 錄製器（見 `docs/offline-replay-testing.md`「scenario 卷」）
- `helpers/fixtures.js`：共用登入 session fixture（見上）
- `core.spec.js`：live 核心（見「live 範圍」）

## 規範：可設定的快捷鍵不准 hardcode

凡是「使用者可在偏好設定改的鍵」（住在 `src/js/pref_storage.js` 的 `DEFAULT_PREFS`，目前唯一一個是
`easyReadingEndSwitchKey`），測試**一律用 `getPref(page, 'xxxKey')` 動態取值再按**，不准寫死字面。

理由：寫死 = 複製了「預設鍵 = ?」這個唯一真相。預設一改（實例：好讀切原生鍵 `End`→`F8`，commit `d04c7e6`）
測試就 stale 整段壞掉（`4c308a2` 事後補修）。`getPref` 讀的是 app runtime 真正用的值，預設再改測試免動。

```js
const switchKey = await getPref(page, 'easyReadingEndSwitchKey');
await sendKey(page, switchKey);
```

底層：dev build 由 `src/js/main.js` 暴露 `window.__readPrefs = readValuesWithDefault`（與 `window.__app` 同 gate，
production 不洩漏）。**例外**：PTT 原生熱鍵（`End`/`Enter`/`Space`/`ArrowLeft`/`Slash` 等）非本 app 設定項，照常寫死。

## 規範：要測「原生模式」就自己關好讀（2026-09-16 翻預設之後）

`enableEasyReading`／`enableEasyReadingList`／`enableBoardListSmoothScroll` 三顆自
2026-09-16 起**預設開**（`src/js/pref_storage.js`）。offline spec 多半是全新 context、
localStorage 空 ⇒ **直接吃到好讀**；live 這邊 `resetSession` 仍把三顆關成 baseline。

所以：**驗原生行為的 spec 一律自己 `applyPrefs(page, { enableEasyReadingList: false })`**
（或對應那顆），不准靠預設值。翻預設當天實際被咬的兩支，症狀都不像 pref 問題：

| spec | 症狀 |
|---|---|
| `blacklist_quick_add.offline` | 列表好讀重畫整份列表 ⇒ 標好的 `[data-e2e-target]` 連同那一列消失，錯在 `waitRectStable：找不到元素` |
| `long_push.offline`（文章列表按 X） | 列表 session engage 後自己往線路送機器鍵 ⇒ 「只送出一個 `X`」的斷言收到多餘 bytes，錯訊息看起來是 `Expected: "X" / Received: "X"` |

## 規範：瀏覽器負責的輸入一律走真輸入管線（2026-10）

**由瀏覽器／OS 決定形狀或順序的輸入**（右鍵、觸控長按、滾輪、捲動、拖放、剪貼簿、IME 組字、焦點、
全螢幕、圖片 load/error）不准在 e2e 裡手捏（`new XxxEvent`＋`dispatchEvent`、直呼 `view.onKeyDown`）。
一律走 `helpers/real_input.js`（Playwright `page.mouse`／`keyboard`／`touchscreen`，或 CDP `Input.*`）。
unit 可以手捏來測分支邏輯，但檔案要有 `// real-input: tests/e2e/...` 指向對應的真輸入 e2e。
守護 `tests/unit/e2e_real_input.test.js`（純靜態掃描；豁免表 `E2E_EXEMPT`／`UNIT_EXEMPT` 必附理由，過期會紅）。
範圍外：自己畫的按鈕被 `fireEvent.click`、unit 的鍵盤、WebSocket data/close。

改成真輸入後變紅，**先懷疑原本的測試在說謊**，不要改回手捏。每條改寫都要做一次變異驗證（拿掉被守的那行
產品碼 → 要紅），並補「前提斷言」（該點本來就有可觀察的後果），否則會沉默地永真。

| 事件 | 真輸入（helper） |
|---|---|
| 右鍵 contextmenu | `rightClickSelectedText`（真拖曳選字＋範圍內右鍵）／`rightClickElement`／`rightClickPlainText` |
| contextmenu 有沒有被 preventDefault | `recordContextMenu`＋`lastContextMenu`（capture 抓事件物件，派發完才讀） |
| 觸控長按 | **桌機 Chromium 做不出來**（CDP 長按不發 contextmenu，CONFIRMED 見 `docs/mobile.md`）⇒ 只能 Android emulator；豁免中 |
| 拖把手後的非定位 contextmenu | CDP `Input.dispatchKeyEvent` ContextMenu 鍵（同一個 Blink `ShowNonLocatedContextMenu`） |
| click／mousedown／mousemove | `page.mouse.*`（點之前 `assertElementUnder`） |
| wheel | `page.mouse.wheel` |
| wheel＋按住某鍵 | `mousePress`＋`mouseWheel(…, { buttons })`（CDP）。`page.mouse.wheel` 恆 `buttons=0`（實測） |
| 鍵盤 | `page.keyboard.press`（先 `#t` focus） |
| paste（文字） | `pasteText`：`grantPermissions(['clipboard-read','clipboard-write'])` 後寫剪貼簿＋`ControlOrMeta+V` |
| paste（截圖） | `navigator.clipboard.write([new ClipboardItem({'image/png': canvasBlob})])`＋`ControlOrMeta+V` |
| IME 組字 | `imeSetComposition`＋`imeCommit`（CDP `Input.imeSetComposition`／`insertText`） |
| 拖放檔案 | `dragFiles`（回 `{drop, cancel}`）／`dropFiles`：CDP `Input.dispatchDragEvent`，檔案寫進 test output 目錄，MIME 由副檔名決定 |
| window blur | 見下表 |

window 失焦（Playwright 1.62 實測，`isTrusted`／`document.hasFocus()`）：Playwright 預設開 focus emulation，
一般的切頁／`bringToFront`／popup **都不會**發 blur。可用：
- headless：焦點移進 iframe（`frameLocator(...).locator(...).focus()`）⇒ 真 window blur（trusted），`hasFocus` 仍 true；Firefox 不發。`wheel_stuck_button` 路徑 A 用這條。
- 最接近 alt-tab：有頭＋CDP `Emulation.setFocusEmulationEnabled({enabled:false})`＋另開 context 視窗 `bringToFront` ⇒ 真 blur／`hasFocus=false`。需獨立 headed project；xvfb 無 WM 時能否切 OS 焦點 UNVERIFIED。headless＋關 emulation 不發 blur。

改寫時量到的瀏覽器事實（CONFIRMED，Chromium headless）：
- InputHelper 標題列在 pointerdown 上 preventDefault ⇒ 真滑鼠在那裡**不發 mousedown**（只有 pointerdown＋click）。
- app 的 wheel listener 是 window **capture** 且原生模式會 `stopPropagation` ⇒ 測試自己的 wheel listener 要掛 capture，掛在 `.main` 上的（如 debug recorder）只有好讀下收得到。
- `page.mouse.wheel` 的捲動在 promise 回來**之後**才落地，之後程式設 `scrollTop` 不會中止它 ⇒ 要量「滾完的位置」先等 `scrollend`。
- passive wheel listener 執行時合成器可能已經捲完（錄到的 `scrollTop` 已是新值）。
- CDP 拖放的 drop 是「先 dragover、再 drop」兩段 IPC，drop 派給 dragover 當下的命中元素。命中元素若在兩段之間
  被卸載（例如還在跑關閉動畫的 Mantine Modal），drop 會派給脫離文件的節點 ⇒ window 上的 listener 收不到、沒人
  preventDefault ⇒ 瀏覽器改開新分頁載入檔案，app 的遮罩卡住。⇒ **拖放前先等上一個對話框真的卸載**
  （`long_push_image_upload.offline.spec.js#openLongPushModal`）。
- contextmenu 時機依 OS：Windows 在 mouseup 發、Linux／macOS 在 mousedown 發 ⇒「按住右鍵滾輪」類斷言要依實際觀察到的時機分支，不寫死平台。

## 規範：evaluate 內點擊後不可同步讀 React 產物

React 19 起，`el.click()` 觸發的 setState 在事件 task **之後**才 commit——同一個 `page.evaluate`
內點完立刻讀 `classList`／DOM 恆讀到舊值（假紅，實例：點圖放大 `imagesEnlarged` 恆 false，2026-07）。
點擊後 `await new Promise(r => setTimeout(r, 300))` 再讀（或拆兩次 evaluate）。

## 規範：live／record 的判準與等待

- **不比對畫面內容**：畫面種類問 `buf.pageState`／`listRenderOwner`，版面用 `screen_sanity`。
  例外只有「選文條件」（板名＋搜尋字）與錄製器裡導覽用的提示字。
- **不跨兩次讀取比計數**：熱門板的推文、看板列表的「人氣」都會在兩次讀取之間變
  （2026-10 錄製器拿整頁文字當清單指紋，每次回來都對不上）。判「回到哪一層」問產品狀態。
- **等待綁內容條件，不准「按鍵 → 固定睡 → 判一次」**：回應還沒到就判 ⇒ 誤判 ⇒ 多按一個鍵
  （2026-10 錄製器：進板畫面的空白鍵多按一次，落在列表上把文章打開了）。用 `waitForFunction`／
  `expect.poll` 等內容出現；錄製器的動作邊界用 `helpers/recording.js#waitWireQuiet`，
  沒在錄時要先 `installRecvCounter` 它才看得到 recv。
- **進板畫面**（movie 是一張 ANSI 圖，不是「請按任意鍵」列）：判 pass 一律用產品的
  `buf.isPassScreenNow()`；`gotoBoard` 的落地判準＝有序號列＋不是 pass 畫面（只看「看板」＋
  「標題/人氣」會被進板畫面騙過，之後第一個鍵被 pressanykey 吃掉）。
- 按鍵後等畫面：`helpers/ptt.js#pressAndSettle`（按 → 等 buf 真的變了 → 等 settle；零回應的鍵
  回 false 不丟錯）。`resetSession`／`gotoBoard` 已全面改用，沒有固定睡眠。
- **選文開文前就挑好**：列表上就看得到推文數與是否置底（`readListCandidates`）；`End` 含置底文。
- **把前提斷言出來**：`waitEasyReadingComplete` 逾時不丟例外，呼叫端自己 `expect(acc.reachedEnd)`。

### offline：`waitForTimeout` 一律要具名理由（守護 `tests/unit/e2e_no_bare_sleep.test.js`）

offline spec 的每個 `waitForTimeout` 都要在同行或緊鄰上方註解寫 `sleep-ok: <理由>`，否則 unit 紅。
合法理由只有：按鍵節奏、找不到 idle 訊號的「沒發生」觀察窗、刻意抽樣中間態、存活型觀察窗。替代品：

| 想等的事 | 用這個 |
|---|---|
| 餵畫面後讀畫面 | `helpers/replay.js#waitScreenSettled(page, rows?)` |
| 動作後讀值 | `expect.poll`／多條斷言包 `expect(async () => {…}).toPass()` |
| 「這個動作沒送 byte」 | `helpers/capture.js#expectOnlyFence`：之後做一個同管道必送的對照動作，斷言紀錄**恰好**是它 |
| 左鍵點擊處理完（滑鼠瀏覽開著） | 等 `__app.dblclickTimer` 清空。**連點兩下之間也要等**：350ms 內第二下被當雙擊整個略過 |
| 列表好讀的按鍵副作用落地 | `waitState(page, x => x.queueIdle)`（指令在 keydown 裡同步入列） |
| `page.mouse.wheel` 真的派發了 | 自己掛 capture `wheel` listener 計數（`mouse.wheel` 不等派發） |
| hover／`scrollTop =` 後的 handler 跑了 | `helpers/real_input.js#nextFrames` |
| 選取／高亮「之後沒被打斷」（存活型） | `helpers/real_input.js#waitClickSettled`：dblclick／mb／#t 焦點計時器＋notify／settle 全清空再兩幀。固定睡眠撐不過 350ms 的 dblclickTimer |
| 裝置端 AI「沒有推論」／「推論都回來了」 | `helpers/replay.js#aiTaskStats`（`screen.js#aiTaskStats`）：沒推論＝`runs === 0`（任務只在 render 裡同步啟動）；回來了＝`runs > 0 && inFlight === 0` |
| 時間語意（閃爍等 `setInterval`） | `page.clock`：開機**前** `install()`（之後才建的 timer 才歸它管）、取樣時 `pauseAt`＋逐拍 `runFor`、取完 `resume()`（範例 `offline/blink_cursor.offline.spec.js`） |

### 好讀累積與行內預覽的等待（live 開圖，`core.spec.js`）

規則（守護 `tests/unit/e2e_live_wait_contract.test.js`，純靜態掃描）。由來：2026-08 舊 live 開圖
測項用「Enter 後睡 4.5 秒當累積完」＋「每格睡 250ms 手寫 seek」，長文還在自動翻頁時
`easy_reading` 在控 scrollTop ⇒ 佔位盒從沒進視野，整輪紅／紅／綠。

- 累積一律 `waitEasyReadingComplete`，**不准**用固定睡眠當終點。
- 行內預覽的 seek 一律 `helpers/layout.js#seekMountedPreview`（`scrollIntoView` +
  內容條件），**不准**自己寫 `scrollTop = …`。
- **live 不可用 `waitPreviewsSettled`**：它要求 `.previewLoading` 歸零，而真圖床
  （imgur stall，`docs/imgur-latency-research.md`）＋「產品端沒有圖片載入 timeout」
  ⇒ 讀取指示器可以永遠留著 ⇒ settle 必逾時，只是換一種假紅。它是 offline 專用
  （那邊有受控 route 與在途請求計數）。
- **斷言分層**：有圖片連結 ⇒ 必有 `.inlinePreviewSlot`（與外網無關）→ 捲到 ⇒ `seek.mounted`
  （與外網無關）→ `seek.loadedImage`（**真的有一張 `<img>` 畫出來**）。2026-10 起第三層在 live
  也是**必驗**（「開圖正常」是核心）：一次試最多 8 張，單一圖床偶發失敗不會紅，全部載不出來
  才紅——那對使用者也是「開圖壞了」。圖片載入的完整情境（慢／404／301）在 offline 四桶。
  `loadedImage` 只算 `img`（iframe/YouTube 不算），不然「首圖是 YouTube」會被當成載到。

## 擴充

**live 不再加功能測項**（見「live 範圍」）。新功能／修 bug 的 e2e 一律 offline：
1. 既有 cassette 夠用就直接寫 offline spec；
2. 需要新的 PTT 往返 ⇒ 在 `tools/record-scenarios.spec.js` 加一段 scenario（prep 不錄、
   開錄後首幀 Ctrl-L、每個動作前後 `waitWireQuiet`、prefs 寫進 meta），`yarn record:scenarios`
   （`RECORD_SCENARIOS_ONLY=<名稱>` 只錄那段）＝**一次登入**；
3. offline spec 用 `helpers/replay.js#bootScenario` ＋ `waitFed` 照錄製時的節拍操作。
   細節見 `docs/offline-replay-testing.md`「scenario 卷」。

live 只在「核心路徑本身」需要新的判準時才動 `core.spec.js`，而且仍不准比對畫面內容。
