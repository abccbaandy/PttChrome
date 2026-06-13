# Enhanced Add-on（黑名單／樓層／自動登入）

原生整合自 `3rd_script/PttChrome ...Enhanced Add-on`（原為 DOM-scraping userscript）。功能改用內部
`TermChar[]` 結構，不爬 DOM。測試：`yarn test:unit`（jest，純邏輯+Row 渲染，不連網/不需 DOM，見
`tests/unit/`）；`yarn test:e2e`（Playwright，連真 PTT，需好讀模式）。

## 純邏輯核心：`src/js/comment_parse.js`
- `rowToText(chars)`：`TermChar[]`→Unicode（DBCS 合併，比照 `term_buf.getRowText`）。
- `parseComment(text)`→`{type:'推'|'噓'|'→', userid(lower)}|null`，正則 `/^(推|噓|→)\s+([0-9A-Za-z]+)\s*:.*<COMMENT_TIME_RE>/`。
  **必須**結尾有時間戳 `COMMENT_TIME_RE=/\s\d{1,2}\/\d{2}\s+\d{2}:\d{2}\s*$/`（定義在 `string_util.js`，與 `parsePushInitText` 共用）。
  用以排除「內文中的推文格式文字（無時間戳）」與「`※ 編輯: … MM/DD/YYYY HH:MM:SS`（格式不同+前綴※）」被誤計樓層。
- `parseListAuthor(text)`→userid|null。**欄位常數 cols 17~28**（CONFIRMED 2026-06 對 C_Chat 校準）。
  fail-safe：非 userid→null→不隱藏。`●`(編輯過) 列有全形字位移→fall through（可接受的 under-hide）。
  守護測試：`enhance.spec.js` 「看板列表作者欄位常數仍正確」，PTT 改版位移會先紅。
- `FloorCounter`：`seq`(總樓)、`sub`(該 type 分項)；每篇文章 reset。含 **BePTT meta-latch 規則**
  （`nonComment(text)`，見踩坑 #14）：非推文列在 `※ 發信站/※ 文章網址` latch 前一律歸零計數
  → 內文/簽名檔「帶假時間戳的假推文」拿到的暫時樓號被清掉，真推文從 1 起算。
- `parseBlacklist(str)`→lower-case Set（換行分隔）。
- `parseArticleAuthor(text)`→原PO id(lower)|null，正則 `/^\s*作者\s+([0-9A-Za-z]+)/`。**僅文章首頁首行**（作者列）解析得到；翻頁後 lines[0] 是內文→null。
- **`annotateComment(text, ctx)`→逐列判斷的單一真相**（floor/hidden/pusher/authorId 範圍/pusherHighlight）。
  `ctx={blacklist,showFloorNumbers,floorCounter,highlightAuthor,articleAuthor,selectedPusher}`。**單一渲染路徑
  呼叫它**（`Screen#computeAnnotations`，兩模式共用），不再有第二份接線可發散（2026-06 統一前好讀另有 `appendRows`
  各複製一份，曾因此出 bug，見踩坑 #8）。
  floor 對黑名單列仍 +1（樓號絕對正確）；hidden 短路其餘高亮。回 null=非推文列。守護測試 `tests/unit/comment_parse.test.js`。

## 渲染整合（單一路徑 `<Screen>`→`<Row>`，2026-06 統一）
- `<Row>`(`components/Row/index.js`) 有 props `floor`/`hidden`。`floor`→`LinkSegmentBuilder.readChar`
  在 **col 2**（marker 與 userid 間的空格）插入 `.floorBadge`（CSS `main.css`：`display:inline-block;
  width:0;vertical-align:super` 小字上標，不位移等寬格線；`user-select:none` 故不污染複製）。`hidden`→
  外層 bbsrow `visibility:hidden`（保留行高、不破壞固定格線）。樓層計數：黑名單推文 **仍 +1 樓**（先
  `counter.next` 再決定隱藏/移除），故編號維持絕對正確。
- **單一渲染路徑（兩模式都走 `renderScreen`→`Screen.js#computeAnnotations`）**：逐列加工只有一處，無法發散。
  `term_view.redraw`/`_renderScreenLines` 傳 `enhance={blacklist,showFloorNumbers,highlightAuthor,
  articleAuthor,selectedPusher,pageState,dropHidden}`。`computeAnnotations`：`pageState==3`→`annotateComment`
  (floor／黑名單 hidden／作者高亮／pusher 高亮)；`pageState==2`→`parseListAuthor`(黑名單 hidden)。
  - 兩模式差別只在傳給 `<Screen>` 的 `lines`：原生/好讀列表選單=`buf.lines`(單頁)；好讀文章=`buf.pageLines`
    (累積長頁，`term_view.accumulatePageLines` 純 JS `findPageOverlap` 去重)。
  - **黑名單列移除 vs 隱藏由 `enhance.dropHidden` 決定**：好讀文章 `dropHidden=true`→Screen render `null`
    （整列移除、長卷無空行）；原生/列表 `dropHidden=false`→`visibility:hidden`（固定格線只能隱藏不移除）。
    render `null` **不位移**其餘列 `data-row`(=pageLines 絕對索引)，故選取/複製跨缺口仍對齊。
  - floor 跨頁：好讀文章 `lines=完整 pageLines`，`computeAnnotations` 每次 `new FloorCounter()` 走完整篇
    → 樓號自然正確。**已無** `view._floorCounter` 持久欄位（舊 `appendRows` 路徑才需要）。
- 測試讀列：`#mainContainer > span[type="bbsrow"]`(Row 外層) > `div` > `span[data-type="bbsline"]`(連結/徽章在此)。
  讀推文用 `[data-type="bbsline"]` 的 **textContent**（`visibility:hidden` 列 innerText 為空），推文正則需容忍
  徽章數字：`/^(推|噓|→)\d*\s+/`。好讀文章黑名單列已 render `null`→DOM 無該列（childCount 下降）。

## 原PO 推文高亮（same-author，只高亮 userid 區塊）
- 推文者 == 原PO id → **只**把 userid 欄位 `[3, 3+len)` 包成 `<span class="commentByAuthor">`（`main.css`
  `#103a5c`）。userid 起始欄 `COMMENT_USERID_COL=3`（marker 2 欄 DBCS + col2 空格；同 floorBadge 假設）。
  char span `b0`(transparent) 透出底色、不蓋 ANSI。
- wrap 在 `LinkSegmentBuilder`（兩路徑共用）：`readChar` 在 `i===authorIdStart` 開 wrap（`_inAuthor=true`、
  segs 改 push 進 `_authorWrap`），`i===authorIdEnd` 收尾包成一個 span；`build()` 對「userid 到行尾」收尾。
  `authorIdStart/End` 任一 undefined→完全跳過。
- 原PO id 由 `view._articleAuthor` 跨頁持久：`redraw` 開頭 `pageState==3` 時 `parseArticleAuthor(lines[0])`，**有值才覆蓋**
  （翻頁 null 沿用上次；新文章首頁覆蓋）。**勿** reset，靠覆蓋即可。
- 逐列判斷由 `annotateComment` 統一（見上）。兩路徑只負責「把回傳值畫出來」：原生 `Screen#computeAnnotations`
  →`ann.authorIdStart/End`→Row props（兩模式同走 `<Screen>`→`<Row>`，2026-06 統一後無第二條接線）。
- pref `highlightAuthorComments`(true)；`pttchrome.onPrefChange`→`view.*`+`redraw(true)`。i18n `options_highlightAuthorComments`。

## 點選推文者高亮（pusher highlight，整列）
- 左鍵點推文列任一處 → 高亮該推文者**本篇所有推文列**（整列 navy `.pusherHighlight` `#000080`；`#mainContainer>span`
  為 block→整行寬）。再點同一人取消、點別人切換。
- 觸發：`pttchrome.mouse_click`（**非** `onMouse_click`——後者只在 mouse browsing 開時跑）。在 `getSelection().isCollapsed`
  分支最前面：`e.target.closest('[data-pusher]')` 命中→`view.togglePusherHighlight(id)`+`preventDefault`+`return`
  （抑制 browsing 導航/leftButtonFunction）。`useMouseBrowsing` 預設 false。
- 偵測一律走 DOM（**好讀畫面是重排長卷、不對應 buf 24 列網格**，不能用 `clientToPos`/`getRowText`）。推文列
  `data-pusher`(lower id) 由 `<Row>` 外層 span（prop `pusher`，來自 `ann.pusher`）統一掛上，兩模式同。
- 狀態 `view._selectedPusher`（傳入 `annotateComment` ctx）；`togglePusherHighlight` 兩模式同：設 `_selectedPusher`
  + `redraw(true)` → `computeAnnotations` 重算 `ann.pusherHighlight`，`<Screen>` 重繪套 class。（2026-06 統一前好讀
  另走 `_applyPusherHighlightDOM` 直接 toggle class，已刪。好讀重繪會重入 `accumulatePageLines` 同畫面，
  `findPageOverlap` 去重成 no-op append，故無重複列。）
- 清除：好讀新文章在 `accumulatePageLines` else（新文章）分支 reset；原生 `redraw` `pageState!==3` 時 reset。
- 無 pref/i18n（點擊驅動、恆可用）。

## 設定（`PrefModal.js` 「增強功能」分頁）
pref keys（`DEFAULT_PREFS`，存 localStorage `pttchrome.pref.v1`）：
`showFloorNumbers`(true)、`blacklist`("" 換行)、`autoLogin`(false)、`autoLoginUser/Password`(""；
**password 在支援 Credential API 的瀏覽器不落地**，見「自動登入」節)、
`autoLoginDupConn`('N')、`autoLoginSkipWelcome`(true)。套用見 `pttchrome.onPrefChange`
（`showFloorNumbers`/`blacklist`→`view.*`+`redraw(true)`）。i18n 鍵在 zh_TW/en_US `options_*`。

## 自動登入：`src/js/auto_login.js`
`App` constructor `new AutoLogin(this)`；`onConnect` 末尾 `start()`（promise-based fire-and-forget；
**勿用 async/await**，見踩坑 #15）。**自走
polling**（setTimeout 每 500ms），每 tick 直接從 `buf.getRowText` 讀整頁（**勿用
`#mainContainer.innerText`**：`'change'` 事件在 React re-render **之前** 觸發 → DOM 慢一幀，導致
「要按鍵才動」）。比對提示字串沿用 `tests/e2e/helpers/ptt.js#login` 流程，帳密用 `app.sendData`(Big5)、
空白/Y/N 同。到主功能表即 `stop()`；逾時 90s 自停；reconnect 時 `start()` 重置（`_seq` 防 async 重入）。
e2e：`enhance.spec.js`「自動登入：開頁自動到主選單（不需按鍵）」（需 env PTT_USER/PTT_PASS）。

### 憑證儲存（Credential Management API，2026-06 改版）
密碼**不再明文落地 localStorage**（支援的瀏覽器）。解析順序（`_resolveCredential`）：
1. **session cache**（module-level `sessionCred`；PrefModal 存檔經 `onValuesPrefChange` →
   `setSessionCredential` 寫入，reconnect 不重跳 chooser）
2. **瀏覽器密碼管理員**：`navigator.credentials.get({password:true, mediation:'optional'})`——
   使用者開啟 auto sign-in 後無聲取回，否則 page load 跳帳號選擇器（取消→走 3）
3. **legacy localStorage 明文**（舊資料、Firefox/Safari 等無 `PasswordCredential` 的 fallback、
   e2e addInitScript 注入路徑）

寫入端（`PrefModal.storeCredentialAndStrip`）：存檔時若支援 API 且帳密齊 →
`credentials.store(new PasswordCredential(...))` 觸發瀏覽器「儲存密碼？」提示，localStorage 只寫
**清空 `autoLoginPassword` 的副本**；`onSave` 仍傳完整 values（in-memory 即時生效）。不支援 → 照舊明文。

遷移（自我修復、不弄丟憑證）：legacy 明文登入成功（到主選單）→ `_maybeMigrate()` 呼叫 `store()`
（**此時不清明文**：store resolve ≠ 使用者按了儲存）；之後某次 `get()` 真取回 → 才
`clearLegacyAutoLoginCredential()` 清掉 prefs 明文**帳號+密碼**（帳號沒密碼也沒用，瀏覽器 store 的
cred.id/cred.password 兩者都供）。連動：`autoLoginUser` 同步改 local-only（不上雲，見
`docs/pref-sync-firestore.md`），否則清空的 `""` 會經雲端洗掉其他裝置的 legacy 帳號。
UI 警語/placeholder 依 `window.PasswordCredential`
切換（i18n `tooltip_autoLogin` / `tooltip_autoLoginPlaintext` / `placeholder_autoLoginPassword`）。
需 secure context（localhost/HTTPS）。

## 未移植（原腳本失效/越界）
axios/tippy/GM_config/國旗 IP 查詢(外部 osk2.me:9977 已失效)、滑鼠瀏覽友善模式、右鍵搜尋作者選單。
（add-on (B) 原PO 推文高亮、(C) 點推文者高亮所有推文 皆已移植，見上方兩節。）

## 踩坑筆記（本次整合，CONFIRMED）

1. **渲染雙路徑：好讀開啟時所有畫面繞過 Screen**。**[已消除 2026-06 統一渲染]** 好讀文章改走
   `<Screen lines={buf.pageLines}>`、列表選單與原生同走 `<Screen lines={buf.lines}>`，逐列加工只剩
   `Screen#computeAnnotations` 一處（見「渲染整合」段）。以下為歷史脈絡：`view.useEasyReadingMode==true` 時，
   redraw 對「任何」pageState 都走好讀分支：文章→`populateEasyReadingPage`、列表/選單→`hideEasyReading`，全都
   `appendRows` 直接竄改 DOM，**不經 `Screen.js`**。⇒ 任何「逐列加工」必須**同時**做在 `Screen#computeAnnotations`
   (原生) 與 `appendRows`(好讀) 兩處，且 `hideEasyReading` 也要傳 `enhance=true`。← 「列表黑名單沒作用」根因。
2. **`'change'` 事件早於 React 重繪**：`term_buf.notify()` 先 `dispatchEvent('change')` 才 `view.update()`
   (`term_buf.js:800/803`)。要讀「當前畫面文字」一律用 `buf.getRowText`，**勿讀 `#mainContainer.innerText`**
   （慢一幀、需下一次更新才追上）。← auto-login「要按鍵才會動」根因；改自走 polling + getRowText 解決。
3. **`innerText` 對 `visibility:hidden` 回空字串**（Chromium）；要讀隱藏列文字用 `textContent`。e2e 測黑名單
   隱藏列時踩過。
4. **行內徽章污染 DOM 文字**：floorBadge 插在 bbsline 內 → DOM 文字變 `"推9 userid"`。app 邏輯都讀 buf 不受影響、
   複製用 buf + `user-select:none` 也不受影響；只有 DOM scraping 要容忍：正則 `/^(推|噓|→)\d*\s+/`。
5. **dev server 模式陷阱**：Playwright `reuseExistingServer:true` 可能重用到 **production 模式**舊 server →
   `DEFAULT_SITE=wsstelnet://ws.ptt.cc/bbs`（直連、Origin 未改寫）→ **WebSocket 403**。啟動務必
   `NODE_ENV=development`，並驗證 served bundle：`curl .../assets/pttchrome.js | grep DEFAULT_SITE` 應為
   `wstelnet://localhost:8080/bbs`。
6. **`parseListAuthor` 欄位需實機校準**（目前 cols 17–28 @ C_Chat），已加守護測試；PTT 改版位移會先紅。
7. **e2e flake**：最新文章常無推文（測樓層/黑名單要從 End 往舊文找）；guest 名額滿時用 env `PTT_USER/PTT_PASS`；
   連線偶發 403/ECONNRESET（PTT 端）。
8. **好讀路徑 `var` 作用域滲漏**：`appendRows` 早期版本對「原PO id 範圍」用 `var authorIdStart/End` 但**未每圈重設**
   （JS `var` 是函式作用域、非 block）。第一個原PO 列設了範圍後，後續非原PO 列因不符 `userid===_articleAuthor`
   而不重新賦值 → 沿用上一列的值 → **每列都套固定 col 3~N 高亮，畫成一條直條色塊**（原生路徑用 `const ann={}`
   每圈新物件故無此症 → 只在好讀爆）。⇒ 根因是**踩坑 #1 的「逐列加工複製兩份」導致發散**；已把判斷抽成
   `comment_parse.annotateComment` 單一純函式，兩路徑共用，並加 `tests/unit/comment_parse.test.js` 回歸守護
   「非原PO 列不得繼承 author 範圍」。教訓：凡兩路徑共用的逐列邏輯，一律走 `annotateComment`，勿再各寫一份。

9. **`appendRows` 的 `var floor;` 滲漏 → 非推文列繼承前一樓號（樓層 bug 主因，2026-06，CONFIRMED 實機）**。
   迴圈內 `var floor;`（**無初值**）不會每圈重設（JS `var` 函式作用域）：最後一則推文設 `floor=ann.floor` 後，
   後續**非推文列**（推文下方空白、`※ 編輯`、內文）`ann=null` 不重新賦值 → 沿用上一樓號 → `renderRowHtml` 給它畫徽章。
   實機 dump：只有 2 推文的文章，推文下方 7 個空白列全標「2」。同 #8 那一類（`var` 未每圈重設），只是換成 `floor`。
   修法：`var floor = undefined;`（`term_view.js` appendRows）。驗證：空白處/※編輯/內文混雜 3 篇 SUSPECT 清空。
   ⇒ 這是使用者回報「空白處/※編輯/內文被標樓層」的**真正成因**（非偵測太鬆；原生用 `const ann` 每圈新物件故正常）。
10. **推文偵測加錨定結尾時間戳（次要：內文推文格式 case）**。`COMMENT_RE` 結尾加
    `COMMENT_TIME_RE=/\s\d{1,2}\/\d{2}\s+\d{2}:\d{2}\s*$/`（`string_util.js`），排除**內文中的推文格式文字**
    （`→ tony :`、`推 bbignose :`，**無時間戳**、在 `※ 發信站:` 前；例 M.1780738427）被當真推文。`※ 編輯: …
    MM/DD/YYYY HH:MM:SS` 也因格式不同+前綴 ※ 排除。守護：`comment_parse.test.js` + `tests/unit/fixtures/*.txt`
    （5 篇真實文章逐列標 `C`/`N`）；e2e `enhance.spec.js` 斷言每個 `[data-floor]` 徽章所屬列含時間戳。
11. **直接設 `useEasyReadingMode=false` ⇒ 畫面永久凍結（2026-06，CONFIRMED 實機）**。**[已消除 2026-06 統一
    渲染]** React 現恆擁有 `#mainContainer`（兩模式都走 `<Screen>`），切原生只是 `lines` 由長頁 reconcile 回 24 列，
    `exitEasyReading` 已移除 `unmountComponentAtNode`，凍結路徑不復存在。以下為歷史脈絡：好讀期間 `appendRows`/
    `clearRows` 直接竄改 `#mainContainer`，React 樹（`componentScreen`）的 Row nodes 已 detached。此時把
    `view.useEasyReadingMode` 直接設 false，渲染切回 React `renderScreen` 路徑 → 更新全打在 detached nodes →
    **畫面從此不動**（按鍵有送、server 有回、`page state` log 正常，但 innerText 凍住；連動態看板都停格）。
    症狀極易誤判成「連線死了/按鍵被吃」。正規關閉配方見 `easy_reading.js` `switchToNativeAtBottom`：
    `useEasyReadingMode=false` → `core.switchToEasyReadingMode()`（還原 lastRow/replyRow/pageLines + 送 Ctrl-L）
    → `ReactDOM.unmountComponentAtNode(view.mainDisplay)`（下次 render 重掛新樹）。e2e `helpers/ptt.js`
    `applyPrefs` 已照此實作。**已修（2026-06）**：退出配方抽成 `easy_reading.js` `exitEasyReading()`，
    `switchToNativeAtBottom`、`_onChanged` 的 pref 關閉路徑（僅在原 `_enabled===true` 時觸發）、e2e
    `applyPrefs` 三處共用。任何新的關好讀路徑一律呼叫 `exitEasyReading()`。
11. **`parsePushInitText` 收緊（安全強化，非「推文不見」修法）**。`/→ \w+ *: +/` 會把已完成的箭頭推文也當「推文
    輸入提示列」；改 `it.search(/→ \w+ *: +/)===0 && !COMMENT_TIME_RE.test(it)`（真推文有時間戳→排除；只收緊、對
    合法輸入列無害）。守護：`comment_parse.test.js`「parsePushInitText」。**注意：這不是 `→ BlueBird5566` 不見的
    根因**——實機 ERDBG 證實是 `populateEasyReadingPage` 的 `i==4` 首頁 hack 造成跨頁去重 `beginIndex` 多跳 1 列
    （內文→第一則推文邊界 over-skip）。已於 #12 根治（改純內容比對去重）。
12. **好讀跨頁去重改純內容比對，捨棄狀態列行號算術（「第一則推文消失」根治，2026-06，CONFIRMED 實機）**。
    舊 `populateEasyReadingPage` 去重靠 PTT 狀態列 `parseStatusRow` 的 `rowIndexStart` vs 自累積 `actualRowIndex`/
    `pageWrappedLines`，外加首頁 `i==4` hack（強制把 buffer 第 4 列併入第 3 列當 wrapped 續行，卻仍 append 全部
    23 列）→ `actualRowIndex` 比 PTT 行號多算 1 → 後續頁邊界 `beginIndex` over-skip 1 列，把第一則推文（尤其 `→`）
    當重疊跳掉、後續樓號少 1。改法：新增純邏輯 `comment_parse.findPageOverlap(accText, newText)`，**逐螢幕列比對**
    新畫面頂端與已累積尾端的實際重疊量（取最大重疊 + 要求重疊區至少 1 列非空白；尾隨空白正規化），只 append
    重疊之後的列。完全不讀狀態列數值（`parseStatusRow` 僅留作「這是文章頁」gate）。同步移除 `actualRowIndex`、
    `buf.pageWrappedLines`（僅此函式用），`term_buf.isTextWrappedRow` 變孤兒（留定義）。**借鑒 BePTT**：它同樣
    連 `wss://ws.ptt.cc/bbs` 逐頁讀終端機畫面，跨頁去重用「近 40 列含顏色的內容 ring buffer」比對（`f3959j3`）
    ——同為內容比對路線。（更正：#14 全反編譯後發現它**有** regex 文章頁 footer 的 `(\d+)%`/頁數/行數，
    用於進度與分頁控制；「完全不解析狀態列」是第一輪字串搜尋的誤判，惟去重確實不靠行號算術。）守護：`comment_parse.test.js`
    新增 `findPageOverlap` 單元測試（含「重疊後第一則推文不得被跳過」回歸）；e2e `easy-reading.spec.js`
    「好讀模式第一則推文不消失」實機驗證 `→ BlueBird5566` 重現為第 1 樓（文章過期則 skip）。
    教訓：跨頁拼接寧可信內容、勿信脆弱的行號算術；折行續行用逐螢幕列比對自然處理，無需 wrapped-line 記帳。
13. **auto_login「重複登入」/「錯誤嘗試」回應需 one-shot guard（2026-06，CONFIRMED 實機）**。`_tick` 的 #3/#4
    原本只靠 `ACTION_COOLDOWN_MS`(900ms) 節流，畫面過場慢於 cooldown 時重複送 `N\r`/`n\r`，雜鍵流到後續
    歡迎頁/主功能表 → 畫面帶離主選單（實測停在看板列表）。修法：`_answeredDup`/`_answeredErr` 旗標
    （`start()` 重置）+ 兩者 gate 在 `_sentPass` 之後（提示只出現在密碼後）。另收緊鬆散比對：歡迎 banner 可能
    殘留「重複登入」字樣，loose match 須同時命中 `[Y/n]`/`(Y/N)`。守護：e2e「自動登入」test 已改為**不關**
    共用 session（刻意留另一條連線重現 dup-conn 提示頁）。
14. **假推文污染樓層 → 移植 BePTT meta-latch 規則（2026-06-11，CONFIRMED 反編譯源碼級）**。
    症狀：內文/簽名檔偽裝推文列**連假時間戳、ANSI 仿色都有**（C_Chat `#1g8zcjhj`「辨識能力測試」），
    逐列層面無任何信號可判別（文字/時間戳/顏色全仿）→ 真推文不從 1 起算。
    解法 = BePTT 7.0.9 登入模式 telnet parser 的原版演算法（jadx 反編譯確證，使用者實測過行為）：
    - 推文列照常 `++` 計數（假推文**會**短暫拿到樓號，BePTT 同款行為）；
    - **latch 前非推文列（含空白列）一律歸零**：`※ 發信站: `/`※ 文章網址: ` 尚未出現過時，
      遇任何非推文列把 seq/推/噓/→ 全清 0；
    - **meta latch 單向**（每篇文章 reset 時清回）：見過 `※ 發信站/※ 文章網址` 後永不再歸零
      （真推文間的 `※ 編輯:` 不打斷編號）。
    - 效果：假推文 1..6 → `--`/空白列歸零 → meta 列先歸零再 latch → 真推文 1..N。
      無 meta 行文章（`Test #1g9GI-Zh`）文末連續推文照常 1..N（歸零只在非推文列觸發）。
      已知同款邊緣（與 BePTT 一致=目標行為）：轉錄文內複製的 `※ 發信站` 提早 latch；
      無 meta 文章推文間夾空白列會重計；原生（非好讀）模式每頁新 FloorCounter，latch 不跨頁。
    實作：`comment_parse.js` `FloorCounter.nonComment(text)` + `annotateComment` 對非推文列呼叫之
    （兩渲染路徑自動共用，呼叫端零改動）。守護：`comment_parse.test.js`「BePTT meta-latch rule」
    + fixture `C_Chat_M.1780734381.txt`（label `F`=假推文，斷言 C 列 1..N；fixture README 有 label 表）。
    **BePTT 架構結論**（反編譯 `3rd_script/BePTT` xapk，`tw.ystudio.beptt` 7.0.9）：文章閱讀依登入分流
    （`N7/C0632k.java`=ArticleContentFragment，`n8()`）——免登入走 www.ptt.cc HTML（AID→URL 還原在
    `Z7/b.java`=AidConverter；okhttp `over18=1`；只有 `div.push` 計樓，結構天然排除假推文）；登入走
    telnet 逐頁解析（`I3()` 等多個 parser 變體，規則同上，grep 錨點 `f3943g1`）。「檢查新推文」=telnet
    重進文章（AID+`$$00`）增量解析共用計數器——這就是「網頁版未同步仍能算最新推文樓層」的原因。
    反編譯配方：xapk(zip)→`y_studio.ka5983.ptt2.apk`→portable Temurin JRE21 zip + jadx 1.5.1 到
    `3rd_script/tools/`（gitignored 免安裝），`jadx --no-res --no-debug-info -j 6 -d <out> <apk>` ~3 分。
    **踩坑**：①jadx 保留 `/* compiled from: Xxx.java */` 原始檔名註解，混淆單字母類名可還原
    （androguard 字串層看不到，是前一輪「無法確證演算法」的主因）；②**大方法反編譯失敗會被整個略過**
    （`I3()` 的樓層邏輯就在失敗方法裡，第一輪因此誤判「只有網頁路線」）——補救
    `--single-class "N7.k`$h" --show-bad-code --single-class-output <dir>`（PowerShell 對 `$` 用 backtick
    escape；bad-code 條件式可能顛倒，以結構/字串為準，跨 parser 變體交叉比對）；③androguard 路線僅夠
    字串/xref：dex 內 Big5 位元組字串 MUTF-8 解碼會損壞，UTF-16 中文常數正常。
15. **src 內禁用 async/await：無 regenerator-runtime，整包 bundle 載入即炸（2026-06-11，CONFIRMED 實機）**。
    babel 把 async fn 轉成 `regeneratorRuntime.mark(...)`（module 評估期就呼叫），本專案 babel 設定
    沒帶 regenerator-runtime（webpack5 升級後依然如此）→ 頁面 `pageerror: regeneratorRuntime is not defined`、app bootstrap 全掛
    （**空白畫面、連 Developer Mode modal 都不出現**；e2e 症狀 = `waitForScreen` 40s 等不到首畫面且
    「當前畫面」全空）。webpack **編譯不會報錯**，純 runtime 炸。修法：非同步邏輯一律寫 Promise chain
    （`auto_login._resolveCredential`/`start`）。診斷捷徑：Playwright 開頁掛 `page.on('pageerror')`。
