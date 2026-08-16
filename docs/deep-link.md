# Deep link（外部連結 → 文章 AID 跳轉）

外部程式（記事本／LINE／Discord）貼一組連結，點開連到本站並自動跳到指定文章。
跳轉本身完全複用 `aid_navigation.js`；本文件只寫外圍：URL 合約、排程、跨分頁。

## URL 合約

| 形式 | 範例 | 產生 | 解析 |
|---|---|---|---|
| `#<Board>/<AID>` | `https://<站台>/#Gossiping/1gIeu-3A` | ✅ 正規 | ✅ |
| `#/<Board>/<AID>` | 前導／尾端斜線 | ✗ | ✅ |
| `#aid=<AID>&board=<Board>` | 順序不拘 | ✗ | ✅ |
| `?board=<Board>&aid=<AID>` | query（會整頁重載） | ✗ | ✅ |

- hash 優先於 query。任一欄位不合法 ⇒ `parseDeepLink` 回 `null` ⇒ 照常開站。
- AID：`/^[0-9A-Za-z_-]{8}$/`（pttbbs `aidu2aidc`，恆 8 字）。
- Board：`/^[0-9A-Za-z][0-9A-Za-z_.-]{1,31}$/`。**字元集必須收緊**：這個字串會被
  原樣送進 `s<board>\r`，夾帶空白／換行等於多送一個按鍵給 PTT。
- **為什麼是 hash 不是 path**：GitHub Pages 無 `404.html` fallback（刻意不加），
  `/Gossiping/1gIeu-3A` 會吃 GitHub 404。hash 另外還有兩個好處：不進 Referer、
  同分頁再貼一次只觸發 `hashchange`（不重載、不用重新登入）。
- 消費後 `history.replaceState` 清掉參數（`stripDeepLink`），否則 F5 會重跳一次。

## 檔案分工

| 檔案 | 職責 | 純度 |
|---|---|---|
| `src/js/deep_link.js` | `parseDeepLink` / `buildDeepLink` / `stripDeepLink` | 純函式 |
| `src/js/deep_link_channel.js` | `createChannel` / `claimHandoff` / `serveHandoff` | 注入 channel+timer |
| `src/js/deep_link_controller.js` | 排程（何時跳、用哪個入口）＋ 複製連結 | 注入 core/view/buf |
| `src/js/deep_link_entry.js` | `claimDeepLink`（boot 前）/ `installDeepLink`（boot 後） | 注入 window |
| `src/components/DeepLinkHandoffAlert.jsx` | 「已在原本的分頁開啟」提示 | — |

## 排程（`DeepLinkController`）

```
request(target) → _canNavigate() ? _dispatch : _hold（存記憶體，等 screenSettled）
_canNavigate  = connectState===1 && _loggedIn && !aidNavigation.active
_loggedIn     = 這次連線的 screenSettled 看過 row0 以【主功能表】開頭
_dispatch     = autoLogin.stop()
                → startedEasyReading ? aidNavigation.start()      // 有原文 ⇒ 有返回 pill
                                     : aidNavigation.startExternal()
reset()       ← App.onClose：清 pending 與 _loggedIn
```

不變量：

- **pending 只在記憶體**，不落 localStorage。重整就該忘掉；幾分鐘前貼的連結在使用者
  早就跑到別處後才搶走畫面，比讓他重點一次糟。
- **`_dispatch` 必須先 `autoLogin.stop()`**。AutoLogin 是 500ms 自走輪詢，其「畫面
  有『請按任意鍵』就送空白鍵」分支（`auto_login.js:407`）會踩到進板畫面，打亂
  CommandQueue 正在等的那一幀。它自己看到主功能表也會 stop，但我們可能比它的下一次
  輪詢更早離開主功能表。
- 登入偵測掛 `termBuf` 的 `screenSettled`，**不是**接進 AutoLogin：手動登入不經過它。
- `startExternal` vs `start`：見 `aid_navigation.js`。前者不 gate `startedEasyReading`、
  不按 Q（沒有原文錨點可升級）、`beginJump(null, …)` ⇒ 跳完沒有返回 pill。
- **在主功能表時 `_begin` 跳過 escape preamble**：`_enqueueEscape` 是先送 `←` 再判斷，
  在主功能表送 `←` 會把反白移到 `G)oodbye`。deep link 幾乎每次都落在這個畫面。

## 跨分頁交接

協定（`BroadcastChannel('pttchrome-deeplink')`）：

```
新分頁   → { t:'claim', id, target }        （boot 前，connect() 之前）
既有分頁 → { t:'ack', id } + 自己 request()  （connectState===1 才有資格）
```

- **既有分頁一律同步 ack，中間不准有任何 `setTimeout`。** 使用者從外部點連結的那一刻，
  既有分頁必定是**背景分頁**，而 Chrome 把背景分頁的 timer 節流到最少 1 秒。原本設計的
  「0..60ms 隨機退讓」在真機上會變成 1000ms+，新分頁早就逾時放棄 → 交接看起來像壞掉
  （實測 2026-08-16：新分頁照樣自己登入）。**headless e2e 不節流，所以只有 unit 那條
  「不准用 timer」的測試擋得住這個回歸。** message event 走 task queue 不是 timer，
  不受節流影響。
- 代價：兩個既有分頁同時在線時會**都**接下（誰都還沒看到對方的 ack）。後果溫和——各自
  跳到同一篇文章。Web Locks 能真互斥，但 lock 生命週期綁 callback，要橫跨整個 claim
  窗口又得塞 sleep，繞回 timer。
- claim 逾時 600ms → 沒人接，新分頁自己 boot。
- **claim 必須在 `connect()` 之前**：接手成功卻已連上 PTT 等於白佔一個連線名額。
- 既有分頁「有資格」只要求連線中，不要求已登入：controller 會把目標收著等登入，
  那仍比新分頁重登一次好。
- BroadcastChannel 不會把訊息送回發送端自己 ⇒ 自己送出的 ack 要自己記進 `answered`。

## 瀏覽器硬限制（不要嘗試繞）

| 限制 | 後果 |
|---|---|
| 外部程式點 https 連結一定開新分頁 | 網頁攔不到。唯一例外＝安裝成 PWA |
| 既有分頁沒有 user activation | `window.focus()` 叫不動自己 ⇒ 只能請使用者切回去 |
| `window.close()` 只對 script 開出來的視窗有效 | 外部開的關不掉，提示層才是主要出口 |

## PWA（唯一能真正「復用視窗」的路）

- `public/manifest.webmanifest`：`launch_handler.client_mode = "focus-existing"`，
  `start_url`/`scope`/icons 全部相對路徑（`vite.config.mjs` `base: './'`，部署在
  GitHub Pages 子路徑）。`public/` 內容由 Vite 原樣複製、不 hash 檔名。
- 安裝後（Chrome/Edge）點連結直接聚焦既有視窗，**頁面不重載** ⇒ 啟動時讀 URL 那段
  根本不會跑，必須靠 `window.launchQueue.setConsumer`（`deep_link_entry.js`）。
  少了這條，整個安裝情境失效。
- **link capturing 要使用者手動啟用一次，這不是 bug**：`launch_handler` 只決定「連結
  被導向 PWA 之後開新視窗還是聚焦既有」，**不決定要不要攔截連結**。桌面 Chrome 預設
  不攔，第一次點連結會照樣開分頁、網址列出現「在應用程式中開啟」圖示；點它（並選
  「總是允許」）之後才會直接進 PWA。manifest 的 `handle_links: "preferred"` 是標準
  欄位，用來表達意圖，Chrome 尚未完全實作 —— 加著等它支援，不要以為加了就會自動攔。
- Firefox/Safari 不支援 → 自動落回 BroadcastChannel。

## 冷啟動跳轉的三個坑（2026-08-16 實測，全部有回歸守護）

這三個都只在 **deep link 冷啟動**才會踩到：它是唯一走 viaMenu 板跳、且唯一在「好讀
正在自動翻頁」時插入交易的路徑。既有的 AID 點擊跳文從文章內出發（`more.c:177` 的
`Select()`），三條全部繞過去了。

### 1. 進板畫面有兩種形狀，classifier 只認得一種

`mbbsd/bbs.c#Read:4470` 用 `more(buf, NA)` 顯示進板公告，而 `NA == PMORE_AUTO_EXIT`
（`pmore.c:199-200`）——**這個模式不畫 footer prompt**，於是末列空白、游標 park 在
末列 ⇒ `classifyListScreen` 說 `'prompt'` 而不是 `'article'`。
`_boardLandingExpect` 原本只認 clean-list / pressanykey / article，三個都不匹配 →
永遠等下去 → probe → miss →「切換看板失敗」。已補上 `'prompt'` 分支，並用「row 0
還是不是【主功能表】」把它和「s 沒吃到／板名有誤」分開（後者送 ← 只會把反白移到
`G)oodbye`）。

### 2. 好讀模式會在交易途中自己送鍵

`EasyReading._send` 現在有閘門：**queue 有指令在飛（或 aidNavigation.active）時一個
byte 都不送**。CommandQueue 的前提是「同時只有一個鍵在線上」，而好讀的自動翻頁繞過
queue 直送。症狀：它的 PageDown 餵掉了進板畫面的 pressanykey，導航的 ← 就永遠等不到
它要的畫面。

只進 `functionMode` 擋不住 —— `_onViewUpdated` 處理 `sendCommandAfterUpdate` 那段
沒有看 `_functionMode`，進入鏡像模式**之前**排好的 PageDown 照樣送得出去。

### 3. 按 Q 一定會被送回文章列表

`mbbsd/bbs.c:2375-2377`：

```c
case RET_DOQUERYINFO:
    view_postinfo(ent, fhdr, direct, b_lines-3);
    return FULLUPDATE;      // ← 離開 pager，重畫列表
```

跳轉路徑感覺不到，因為它下一步 `s<board>` 本來就是列表指令。「複製本篇連結」用同一個
Q，就會把使用者丟在列表上。`reopenAfterPostInfo(lineIndex)` 負責走回去：`␣` 關框 →
`⏎` 開回游標下那篇（`i_read` 從沒移動過游標）→ `requestScrollRestore` 帶回閱讀位置。

### 4. 落地的 settle edge 結構性不成立 ⇒ 不會自己進好讀

`aid_navigation._enqueueAidSearch` 的落地畫面 **footer 列是空的**（`#` prompt 清掉它、
跳轉重畫不補、`\f` 也補不回來）⇒ `term_buf.setPageState` 末段

```js
if (this.pageState != 1 && this.isLineEmpty(lastRowNum)) this.pageState = 0;
```

把它判成 **0**。於是目標文章是踩著 **0→3** edge 進來的，而 `nextEasyReadingState` 只認
`1|2 → 3` ⇒ **確定性**不成立。備援 `nextEasyReadingReentry` 又要求 `nativeArticleKey`
已知，冷啟動時必然是 null（fail-safe）。

「有時卻正常」的來源：目標看板若有帶 pmore footer 的進板畫面，`s<board>` 落地是
pageState 3、prev 1 ⇒ 湊出一個 `1→3` edge，好讀在**進板公告上**誤觸發，`_enabled` 被
翻成 true ⇒ 最後歪打正著。

修法三段（缺一不可）：

| Fix | 內容 |
|---|---|
| A | `_enterFunctionMode` 在 `!_enabled` 時 **no-op**（見下一節） |
| B | `nextEasyReadingState` / `nextEasyReadingReentry` 加 `navActive` gate —— 導航途中的畫面都是「別人的」，進板公告尤其 |
| C | `easyReading.ensureEnabledOnArticle(allowRetry)`，由 `aid_navigation._enqueueOpen` 的 `onDone` 呼叫 |

Fix C 的兩條順序不變量（都寫在 `onDone` 的註解裡）：

- **先解鎖 `active`，再叫好讀**：`easy_reading._send` 第一道閘門就是 `active`，沒解鎖
  就 `enterEasyReading()` 會讓它 replay 出的第一個 PageDown 被整個吞掉 ⇒ 停在第一頁。
- **在 `requestScrollRestore` 之前**：restore 靠 `_onViewUpdated` 推進，好讀沒開就沒有
  那個迴圈。

**刻意不放寬 `nextEasyReadingState` 讓 `0→3` 也算**：文章中途任何一次 footer 半畫的
dip 都會產生 `3→0→3`，那會在同一頁重新 `enterEasyReading()`（內含 `_resetPagingState`
清掉 `_inFlightSig`）並重送 PageDown ⇒ pttbbs typeahead skip ⇒ 整頁文字永久遺失（P4）。

P4 安全性靠 `nextEasyReadingExternalLanding` 的第一個條件 `if (enabled) return false`：
同一次 settle 的執行順序是 `_onPageStateSettled` → `easyReading._onScreenSettled` →
`queue.onDone`（queue 由 `list_session._onScreenSettled` 驅動，而 `pttchrome.jsx` 先建
easyReading 才建 listSession），所以既有 edge 路線若成立，`_enabled` 早已是 true。
**這行 gate 是整個設計最不能拿掉的一行。**

### 5. `_functionMode` 在好讀關閉時會永久卡住

`aid_navigation._begin` 無條件呼叫 `easyReading._enterFunctionMode()`，而冷啟動 deep
link 時 `_enabled` 是 false。`_functionMode` 唯一的出口 `_evalFunctionModeExit` 只能經
`_onScreenSettled` 進入，那裡第一行就是 `if (!this._enabled) { …; return; }` ⇒ 旗標
**永遠清不掉**，一次同時廢掉兩條回好讀的路：

- `nextEasyReadingReentry` 的 `functionMode` gate（自動重入）
- `term_view.onKeyDown` 的 `!buf.easyReadingFunctionMode` gate → `tryReenterFromNative`
  （**End/F8 手動切回也一起死掉**，所以症狀是「怎麼救都救不回來」）

修法：`_enterFunctionMode` 開頭 `if (!this._enabled) return;`。好讀關著時畫面本來就是
原生的，這個函式沒有任何事情要做。

## 複製連結（分享端）

- 熱鍵 pref `deepLinkCopyKey`，預設 **F2**。可用的 F 鍵只剩 F2/F4：Chrome 佔用
  F1/F3/F5/F6/F7/F10/F11/F12，F8＝`easyReadingEndSwitchKey`，F9＝`aidNavBackKey`
  （見 `pref_storage.js:29`）。另有右鍵選單「複製本篇文章連結」（僅 `pageState===3`）。
- 本篇 AID 只能靠 `Q` 資訊框問出來（畫面上的 `#AID` 是內文引用的別篇）。與跳轉共用
  `aidNavigation.queryPostAid`；**關框是呼叫端的責任**——跳轉併進下一個指令
  （`_enqueueBoardJump` 的 `dismissFirst`），複製路徑得自己送 `dismissPostInfo()`。
- 判「在文章裡」用 `parseStatusRow(末列)` 而非 `parsePagerFooterContext`：長文的
  footer 會被頁碼擠掉 ⇒ context 變 `'unknown'`，但那仍是正常文章。
- `board` 為 null（站內信／精華區，pttbbs 印「不明」）⇒ 不產生連結：`#` 只搜
  currboard，沒有看板的 AID 跳不回去。
- 剪貼簿被擋（非 secure context／user activation 過期）⇒ 退而用 hint 顯示連結全文。
- **ORDER INVARIANT：`_currentLineIndex()` 必須在 `_enterFunctionMode()` 之前呼叫。**
  後者結尾的 `termBuf.notify()` 是**同步**的（`term_buf` 的 changed 分支直接呼叫
  `view.update()`），而 `term_view.redraw` 的 functionMode 分支第一件事就是
  `mainDisplay.scrollTop = 0`。順序反過來讀到的永遠是 0 ⇒ `_enqueueReopen` 的
  `if (lineIndex …)` falsy ⇒ 複製完雖然回到原篇卻停在第一行（實測 2026-08-16）。
  `aid_navigation.start()` 有同一條不變量的註解。
  守護：`tests/unit/deep_link_controller.test.js` —— 假 easyReading 的
  `_enterFunctionMode` **必須**忠實地把 `scrollTop` 歸零，否則整條測試是假綠燈。

## 接手通知（`term_view`）

既有分頁替新分頁收下連結時，使用者的眼睛在**新開的那個**分頁上 ⇒ 不出聲的話跳轉等於
靜默發生。三層，由 `DeepLinkController.request(target, { source: 'handoff' })` 觸發
（只有 `serveHandoff` 這個來源會帶；開站網址／hashchange／launchQueue 都是使用者本人在
這個分頁的動作，通知他自己剛做的事只是噪音）：

| 層 | 受 pref 控制？ | 備註 |
|---|---|---|
| 頁內橫幅（`flashListHint`，`.ListHint`） | 否 | 成本為零，且是切回來後唯一的痕跡 |
| `document.title` 閃爍 | `deepLinkHandoffNotify`＋非前景 | **沒有通知權限時唯一還有效的通道** |
| 系統 `Notification` | 同上＋瀏覽器權限 | 其 `onclick` 是**唯一**能切分頁的路（那裡有 user activation） |

- **前景抑制**（`notification_gate.isDocumentForeground`）：分頁就在使用者眼前
  （`visibilityState === 'visible'` **且** `document.hasFocus()`）時，後兩層整個略過，只留橫幅。
  不是只擋系統通知——`stopTitleFlash` 掛在 `window 'focus'` 與 `'visibilitychange'` 上，分頁
  本來就在前景的話那兩個事件都不會再來 ⇒ 標題會一直閃到使用者切走再切回來為止。
  兩個條件都要成立才算前景：看得見但焦點在別的視窗（雙視窗並排）仍要出聲，判斷不出來
  （沒有 `hasFocus`）也一律當背景，寧可多通知一則。
  **不重用 `App.appFocused`**：它初值寫死 `true`（背景開的分頁在第一次 blur 前是錯的），
  且語意綁 window focus 並兼任水球解析閘門。
  測試坑：**headless Chromium 沒有真正的背景分頁**——開第二個 page 並 `bringToFront()` 後，
  第一個 page 仍回報 `visible` + `hasFocus()===true`（2026-08-17 實測）。offline e2e 靠
  `addInitScript` 蓋掉 `document.hasFocus` 來模擬背景，見 `deep_link.offline.spec.js`。

- 通知發在**跳轉之前**：接手分頁若還沒登入，`_hold()` 會把目標收著等登入 —— 落地可能
  永遠不會發生，使用者卻得先知道有東西在等他。
- 與水球共用 `showBackgroundNotification` / `_createNotification` / `stopTitleFlash`。
  抽 helper 時順手修掉兩個既有隱患：`new Notification` 沒有 try/catch 與 `typeof` 檢查
  （非 secure context 會 ReferenceError 從 `App.onData` 炸出去）；`App` 的 focus handler
  無條件 `view.notif.close()`（「有 titleTimer 但沒有 notif」＝沒權限的常態 → TypeError）。
- **閃爍基準是當下的 `document.title`，不是 `connectedUrl.site`**：全 app 從來沒把
  title 設成連線位址過（`index.html` 的 `<title>` 一路留著），舊的水球版本拿 site 當
  基準 ⇒ 第一次 tick 就把標題換成 `wsstelnet://…`，停下來也還原成那串。
- 停止條件掛 `window 'focus'` **和** `document 'visibilitychange'`：分頁列切換不保證觸發
  前者。`visibilitychange` 只呼叫 `stopTitleFlash()`，**不碰 `appFocused`** —— 那個旗標
  的語意是 window focus，且是水球解析的閘門（`App.onData`）。
- pref `deepLinkHandoffNotify` 刻意不複用 `enableNotifications`（文案是「啟用水球通知」，
  且實際是水球封包解析的閘門）。
- **權限請求時機**（`notification_gate.ensureNotifyPermission`）：勾選 checkbox 的當下
  （user activation 最穩）**以及每次關閉設定頁時**都檢查一次。只靠前者不夠——兩個通知 pref
  的預設值都是 `true`，使用者不會去勾一個已經勾好的框 ⇒ 權限永遠停在 `default`，系統通知
  永遠不出現，得「關掉再打開」才問得到（實測回報）。關閉設定頁時只要
  `deepLinkHandoffNotify || enableNotifications` 為真就問（兩者共用同一個瀏覽器權限，而水球
  那個從來不曾自己問過）。已是 `granted`／`denied` 都不再送。
  用 Esc 關閉不算 user activation（HTML 規範明文排除 Esc），那次請求可能被忽略——可接受，
  下次關閉設定頁還會再檢查。

## 測試

| 層 | 檔案 |
|---|---|
| unit | `tests/unit/deep_link.test.js`（URL 合約＝規格書） |
| unit | `tests/unit/deep_link_channel.test.js`（假 BroadcastChannel bus + 同步時鐘） |
| unit | `tests/unit/deep_link_controller.test.js`（排程 + 複製連結） |
| unit | `tests/unit/deep_link_entry.test.js`（三條進入路徑 + 清網址） |
| unit | `tests/unit/aid_navigation.test.js` → `describe('startExternal（deep link）')`；落地要呼叫 `ensureEnabledOnArticle` 且 `active` 已解鎖 |
| unit | `tests/unit/easy_reading_function_mode_gate.test.js`（坑 5：好讀關閉時 `_enterFunctionMode` 必須 no-op） |
| unit | `tests/unit/easy_reading_landing_enable.test.js`（坑 4：`ensureEnabledOnArticle` 條件矩陣 + one-shot 只重試一次 + 已 enabled 絕不重開） |
| unit | `tests/unit/easy_reading_logic.test.js` → `nextEasyReadingExternalLanding`、`navActive` gate |
| unit | `tests/unit/background_notification.test.js`（通知降級與 null-safety；標題閃爍基準；前景抑制） |
| unit | `tests/unit/notification_gate.test.js`（權限請求時機＋前景判定的規格書） |
| unit | `tests/unit/pref_modal_notify_permission.test.jsx`（關閉設定頁時的權限檢查） |
| e2e offline | `tests/e2e/offline/deep_link.offline.spec.js`（cassette 是固定 byte 流，只驗解析／暫存／清網址，**不驗完整跳轉**；另含交接通知：標題閃爍→`bringToFront()`→還原，且全程 `pageerror` 為空 —— 預設 context 沒有通知權限，剛好是要守的常態路徑；前景抑制另有一條，headless 無真正背景分頁故以 `addInitScript` 蓋 `document.hasFocus`） |
| e2e offline | `tests/e2e/offline/ui_behavior.offline.spec.js`（PrefModal 的 `deepLinkHandoffNotify` 開關） |
| e2e live | `tests/e2e/deep-link.spec.js`（唯一驗得到「冷啟動→登入→主功能表→切板→跳文」完整鏈的地方；需 `PTT_USER`/`PTT_PASS`，AID 先用共用 session 按 Q 撈真的。落地後斷言 `useEasyReadingMode === true` 且 `easyReadingFunctionMode === false`） |
