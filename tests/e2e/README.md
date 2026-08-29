# E2E 測試（Playwright，連真實 PTT）

用真實 Chromium 驅動 app 連真 PTT，驗證功能。出錯時自動截圖/錄影 + dump 瀏覽器 console。

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

一輪的登入次數盤點（27 條 live test 總共 **1 次**）：

| 來源 | 次數 | 說明 |
|---|---|---|
| `helpers/fixtures.js` 的 `shared` | 1 | 27 條**全部**共用它 |

這一次開機**就是產品自己的自動登入**（`helpers/ptt.js#autoLoginBoot`：注入 autoLogin
prefs → 開站 → 完全不按鍵等主功能表），所以它同時是「開站自動登入」那條 spec 的被測
行為；沒有 `PTT_USER`/`PTT_PASS` 時退回 guest + 手動 `login()`，相關 spec 自己 skip。

整輪流程：**開機（＝唯一一次登入，順帶驗自動登入）→ deep link → 其餘 spec**。

### 兩條以前有豁免權的 spec 怎麼改的（2026-08-26）

| spec | 以前 | 現在 |
|---|---|---|
| `enhance.spec.js` 自動登入 | 自己開一個 page 冷啟動 | 斷言 `shared.boot`（fixture 那一次開機留下的證據：`auto`/`screen`/`waitedMs`） |
| `deep-link.spec.js` | 自己開一個 page 帶 `#Board/AID` 冷啟動 | 在**已登入的共用分頁**設 `location.hash` ⇒ 走 `deep_link_entry.js` 明列的第 2 條進入路徑（hashchange，「同一個分頁再貼一次連結，不重載、不用重新登入」） |

deep link 的跳轉本體與冷啟動是**同一段 code**：`consume()` → `DeepLinkController.request`
→ `_canNavigate()` → `_dispatch()`，而 `_dispatch` 在 `startedEasyReading === false` 時走
`nav.startExternal()`，正是冷啟動那一支。所以 spec 開跳前先 `resetSession`（回主功能表
＋關好讀）把前置狀態對齊。

**刻意換掉的兩塊覆蓋度**（都另有 unit 守護，別再為了它們加登入）：

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
  跨 spec 檔重用同一個已登入 page（`workers:1`）。
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
- **例外只有兩條**：`enhance.spec.js` 的自動登入與 `deep-link.spec.js` —— 被測行為本身
  就是「開站自動登入」，不可能共用已登入的 page。名單鎖死在
  `tests/unit/e2e_login_budget.test.js`，要加第三條必須是有意識的決定。
  `connect-login.spec.js` **不**在例外裡：它斷言的就是 fixture 那一次登入的結果。
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
- `helpers/fixtures.js`：共用登入 session fixture（見上）
- `connect-login.spec.js`：登入到主選單（獨立登入）
- `search_prompt.spec.js`：看板列表按 `s` 的搜尋 prompt —— 不上游標底色、殘留列表不可點、prompt 文字不破字。
  **刻意是 live**：判準（輸入欄的實際顏色）是 pfterm 重新編碼後的結果，離線／unit 量不到，見
  `docs/pttbbs-screen-protocol.md` §5.1。

## 規範：evaluate 內點擊後不可同步讀 React 產物

React 19 起，`el.click()` 觸發的 setState 在事件 task **之後**才 commit——同一個 `page.evaluate`
內點完立刻讀 `classList`／DOM 恆讀到舊值（假紅，實例：點圖放大 `imagesEnlarged` 恆 false，2026-07）。
點擊後 `await new Promise(r => setTimeout(r, 300))` 再讀（或拆兩次 evaluate）。

## 規範：live 斷言不准跨兩次讀取比列數

live 測試讀的是**最新文章**，熱門板（C_Chat）的推文會在斷言之間持續灌入。任何形如
「第二次的列數 < 第一次」「兩次的數量差 >= N」的判定都會被新推文蓋過去 ⇒ 偽紅、重跑才綠
（實例：黑名單案量到 `c2=412 > c1=289`，但目標作者其實完全消失、pusher 由 32 降到 13）。

**判定一律用內容，不用計數**：
- 序列前綴：第一次的列（濾掉預期被移除的）必須是第二次的**前綴**，尾端多出來的就是期間新增，允許。
- 穩定識別碼：樓號是絕對編號，新推文只會往後拿更大的號碼、不會位移既有樓號 ⇒ 「某些樓號整組消失」
  是可靠的移除證據。
- 空行等結構性質在**單次讀取內**判定（如「樓號缺口區間內不得有空白列」），不跨時間比。

實作：`helpers/ptt.js` 的 `comparePusherSequences` / `inspectFloorGaps`（純函式，unit 守護在
`tests/unit/blacklist_pusher_diff.test.js`），用法見 `enhance.spec.js` 的黑名單案。
需要「完全等值」等級的嚴格比對就寫離線 cassette 版（bytes 固定，可逐列 `toEqual`），
見 `offline/enhance.offline.spec.js` 同名案。

## 規範：選文與等待不准靠執行順序或固定 timeout

2026-08-29 `enhance.spec.js`「樓層編號」在整輪 live 裡紅（60s test timeout），單獨重跑
卻 7 秒就綠 —— 兩個原因疊在一起，都是**判定法**的問題，不是 PTT 不穩：

| 症狀來源 | 事實 | 修法 |
|---|---|---|
| pref 跨 spec 殘留 | `easy-reading-list.spec` 打開 `enableEasyReadingList` 之後沒人關，之後跑的 spec 在「列表好讀開著」的狀態下操作列表，End/Enter 走的是 ListSession 交易路徑，落點與原生不同 | `resetSession` 一併關掉它（`helpers/ptt.js`）。**測試之間不該靠執行順序** |
| 用 End → Enter 當「開最新一篇」 | End ＝ read.c 的 `last_line`，**包含置底文**。C_Chat 的置底是十幾頁的公告 ⇒ 累積跑不完；公告常常零推文 ⇒ 樓層／推文者類斷言必紅 | `pickListArticleWithComments(page, {min, max})`：推文數就印在列表上（`bbs.c#readdoent`：1..99 印 `%2d`、≥100 印「爆」）⇒ **開文前**就能保證「有推文且不是爆文」，再 `openArticleByNumber` 跳號開文 |

連帶規則：

- **等待綁內容條件**：`openArticleByNumber` 等的是「游標列的序號＝目標」（`waitForFunction`），
  不是 `waitForTimeout(1200)`。跳號回應的到達時間取決於連線，睡固定秒數不是慢就是不夠。
- **把前提斷言出來**：`waitEasyReadingComplete` 逾時不丟例外，呼叫端要自己
  `expect(acc.reachedEnd).toBe(true)`；否則「只累積到一半」會紅在後面的遞增檢查上，
  看起來像功能壞了。
- 舊式「開了發現不合用 → 退回列表 → 往上一篇再試」的重試迴圈（本檔黑名單／pusher 兩案）
  仍在，能動就先不動；新測試一律用上面的選文 helper。

### 好讀累積與行內預覽的等待（2026-08-29，`easy-reading.spec.js`「自動行內開圖」）

同一條 spec 整輪 live 紅／紅／綠，乾淨樹對照過 ⇒ 不是被測 code，是等待條件在賭：

| 舊寫法 | 事實 | 後果 |
|---|---|---|
| `Enter` 後 `waitForTimeout(4500)` 當「累積完」 | 好讀是自動翻頁，時間隨文長／連線變動 | 長文那時還在翻，`easy_reading` 同時在控 `.main` 的 scrollTop ⇒ 測試自己寫的 `scrollTop = y` 被拉走，佔位盒從沒進視野 |
| 手寫單趟 seek：每格固定 `sleep(250)` 就往下捲 | mount 鏈＝IntersectionObserver → `renderInto`（React root）→ `requestPreview` promise → commit | 掃過去那格接著被 far observer 卸掉 ⇒ 掃完整篇 0 個預覽節點（現場：7 個可預覽連結、`found=0`、`scrollTop=1752`） |
| `End` → `Enter` 開最新一篇 | `End` 含置底公告 | 開到十幾頁的公告 ⇒ 更難累積完 |

規則（守護 `tests/unit/e2e_live_wait_contract.test.js`，純靜態掃描）：

- 累積一律 `waitEasyReadingComplete`，**不准**用固定睡眠當終點。
- 行內預覽的 seek 一律 `helpers/layout.js#seekMountedPreview`（`scrollIntoView` +
  內容條件），**不准**自己寫 `scrollTop = …`。
- **live 不可用 `waitPreviewsSettled`**：它要求 `.previewLoading` 歸零，而真圖床
  （imgur stall，`docs/imgur-latency-research.md`）＋「產品端沒有圖片載入 timeout」
  ⇒ 讀取指示器可以永遠留著 ⇒ settle 必逾時，只是換一種假紅。它是 offline 專用
  （那邊有受控 route 與在途請求計數）。
- **斷言分三層**，因為相依對象不同：
  1. 有可預覽連結 ⇒ 必有 `.inlinePreviewSlot`（`enableLinkInlinePreview` 被寫死 false
     時一個都不會建 —— 這就是本 spec 要守的 regression）。與外網無關，必驗。
  2. 捲到 slot ⇒ `seek.mounted`（slot 裡出現預覽產物，含讀取中指示器）。與外網無關，必驗。
  3. `seek.mediaFound` / `seek.loadedImage` ⇒ 才驗媒體節點與點圖放大／縮回。
     **依賴圖床**，載不出來就 console 記錄後略過，不讓圖床決定 CI 顏色
     （圖片載入的完整情境覆蓋在 offline 的 cache/slow/404/301 四桶）。

## 擴充

新 spec 用 `shared` fixture + `resetSession`/`applyPrefs`/`gotoBoard`（見「共用登入 session」規則），例如
`easy-reading.spec.js`：復位→進看板→開文章→驗證自動翻頁/捲到底（對應 `src/js/easy_reading.js`）。
