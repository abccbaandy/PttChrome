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

## 測試

| 層 | 檔案 |
|---|---|
| unit | `tests/unit/deep_link.test.js`（URL 合約＝規格書） |
| unit | `tests/unit/deep_link_channel.test.js`（假 BroadcastChannel bus + 同步時鐘） |
| unit | `tests/unit/deep_link_controller.test.js`（排程 + 複製連結） |
| unit | `tests/unit/deep_link_entry.test.js`（三條進入路徑 + 清網址） |
| unit | `tests/unit/aid_navigation.test.js` → `describe('startExternal（deep link）')` |
| e2e offline | `tests/e2e/offline/deep_link.offline.spec.js`（cassette 是固定 byte 流，只驗解析／暫存／清網址，**不驗完整跳轉**） |
| e2e live | `tests/e2e/deep-link.spec.js`（唯一驗得到「冷啟動→登入→主功能表→切板→跳文」完整鏈的地方；需 `PTT_USER`/`PTT_PASS`，AID 先用共用 session 按 Q 撈真的） |
