# 搜尋彈窗（`article_search.js`）

動 `article_search.js`、`search_history.js`、`SearchModal.jsx`、term_view 的搜尋鍵攔截前先讀。

## 為什麼

- pttbbs 輸入記憶＝**整個登入 session 一份**：`mbbsd/vtuikit.c` `static InputHistory ih`（508 bytes、≥2 bytes 才存、只有 `VGET_NOECHO` 不存；`vgetstring` 結尾 `InputHistoryAdd`）。所有 `getdata`／`namecomplete` 共用。CONFIRMED。
- 跳號 prompt ` 跳至第幾項: `（`stuff.c#search_num`，NUMECHO＝`VGET_DIGITS`）只關掉**該 prompt 內**的 ↑↓，照樣存檔 ⇒ 列表好讀／看板列表送的 `N\r`（`list_session.js` 的 sync／fetch／open／anchor jump、`board_list_session.js` 同類）把真正的關鍵字擠出 508 bytes。client 端無法關閉 ⇒ 改由 client 記關鍵字。

## 攔截決策

| 入口 | 位置 | 條件 |
|---|---|---|
| 鍵盤 | `term_view.onKeyDown`，長推文攔截之後、easyReading／keyOwner 之前 | `tryOpenSearchModal` 回 true 才 `preventDefault` |
| IME／Android 軟鍵盤 | `term_view.onTextInput`（非貼上、單一字元） | 同上 |
| 手機工具列「搜尋」 | `MobileToolbar` → ContextMenu `openSearch(context.search[0])`，**直接開彈窗、無子選單**（使用者定案：種類在彈窗上方切）。手機上 `SearchModal` 外殼換成 bottom sheet（`mobile` prop → `components/MobileSheet`，表單相同；系統返回＝收起） | 不看 pref |

`shouldInterceptSearchKey`：key ∈ `/ ? a Z s`、無 Ctrl/Alt/Meta、pref `searchKeyOpensModal`（預設 true，**會同步**）、`availableSearchKinds(facts)` 含該種類。
`availableSearchKinds`（工具列共用）：游標在輸入欄（`buf.isCursorOnInputField`）⇒ 無；文章列表（`listRenderOwner==='article-list'` 或 `boardListContextKind==='article-list'`）⇒ title/author/push/board；看板列表、主功能表 ⇒ board；其他 ⇒ 無。
- 看板列表的 `/` 是「看板中文關鍵字」（`board.c:2063`），**不攔**。
- `s`＝board，只在可用種類含 board 的畫面攔（文章列表／看板列表／主功能表）；看板列表的 `a`／`Z` 不攔。小寫 `z` 是精華區（`bbs.c:4406`），不是推文數。
- e2e 的 `helpers/ptt.js#gotoBoard` 兩條路都吃（彈窗出現就填彈窗並等 `searchInFlight` 收尾，否則原生 prompt）。
- 主功能表只有 MMENU/TMENU/XMENU 的 `s` 是選擇看板（`menu.c#menu_on_key`）；目前只認 `主功能表` 標題。

## prompt 指紋（`isSearchPromptFrame`，出處 `read.c#ask_filter_predicate`）

| 種類 | 鍵 | 列 | 前綴 |
|---|---|---|---|
| title | `/` | b_lines | `搜尋標題: `／`增加條件 標題: `（MODE_SELECT） |
| author | `a` | b_lines | `搜尋作者: `／`增加條件 作者: ` |
| push | `Z` | b_lines | `搜尋推文數高於多少`（CONFIG_OLD_RECOMMEND 少了「 (<0則搜噓文數) 」）／`增加條件 推文數: `；LCECHO 欄寬 7，`atoi==0` 當取消 |
| board | `s` | 1（兩段式，row0 是反白標題） | `請輸入看板名稱(按空白鍵自動搜尋)`（`common.h` MSG_SELECT_BOARD；看板列表 `board_cmd_search_global` 同字串）；`VGET_ASCII_ONLY` |

收尾：Enter 送出；取消＝Ctrl-C 或空字串（`vtuikit.c` 只認這兩個，**ESC 不是取消鍵**：KEY_ESC 非可列印 ⇒ bell）。

## 送出（`submitSearch`）

兩步，第二步只在第一步 `expect`（prompt 幀）成立後才排；prompt 沒出現 ⇒ `onFail`，關鍵字**絕不送**（字母會落回列表按鍵）。
- **PTT 正等著 prompt 時不出發**：`submitSearch`／`submitSerializedSteps`（F5 重整、找未讀、全部已讀、首頁抓我的最愛也走它）
  先問本幀 `buf.isPromptPending()`（輸入欄、推文型別選單），開著 ⇒ 回 false、一個 byte 都不送。看板分頁、首頁看板卡片這類浮在
  畫面上的入口在使用者自己按出「跳至第幾項」「搜尋標題」之後還按得到，第一個鍵會被打進輸入欄或被一鍵 prompt 當答案。
  呼叫端的提示一律 `submitBlockedHint(core, fallback)`（prompt 開著＝「請先完成或取消目前的輸入」，否則 serializedOpHint／fallback）。
  守護 `ptt_src_screens.test.js`（upstream 的 search_prompts／push 畫面）。
- `activeListSession()` 有值 ⇒ `session._beginPassthroughBytes(steps, {kind:'search', resumeOnLanding:true})`（列表好讀：凍結交易＋cursor sync 腿，結果列表一落地就回好讀，找不到的 vmsg／進板畫面認不出 ⇒ 停原生鏡像交給探針，見 `docs/easy-reading-list.md`「落地即回好讀」；看板列表 session 2026-10 起也收陣列，kind 自動帶 `brd-` 前綴＝佇列所有權）。第二步的落地＝prompt 消失（打字回顯那一幀 prompt 還在，不算），預算 `aid_navigation.SLOW_STEP_BUDGET`（要等 server 的搜尋服務／進板）。session `opening`／`functionMode+frozen` ⇒ 回 false，呼叫端提示。
- 否則直接 `commandQueue.enqueue`（`list_session._onScreenSettled` 驅動 onSettle）。
- 關鍵字 `ansiHalfColorConv(u2b(text))`（queue 綁 raw `conn.send`）。
- **在途閘門 `core.searchInFlight`**（`serialized_op_gate` 讀，期間吞鍵＋提示「搜尋中」）：少了它，搜尋鍵已上線、prompt 未到時按的 Enter 會把空 prompt 送出（＝取消），關鍵字落到列表變指令（live 錄製檔實證）。解除＝第二步 onDone／任一步 onFail／onFlushed（兩個 session 的 `_enqueuePassthroughStep` 都轉送 `onFlushed`）＋保底 `SEARCH_INFLIGHT_MAX_MS`。e2e 等搜尋完成一律等它（`core.spec.js#gotoLatestThread`），不可只看「列表＋游標不在輸入欄」。
- **閱讀紀錄**：送出前領書籤（決策表 `article-search`；看板 `s` 走這條時是 `board-search`），prompt 沒開出來＝`fail`、第二步 onDone＝`done`。找不到符合條件時 PTT `vmsg` 後 `READ_REDRAW` 回原列表 ⇒ 列表好讀回原處；有結果時落在搜尋結果（MODE_SELECT），列表端比對編號空間不符自動丟棄。見 `docs/reading-record.md`。
- 錄製工具（`record-cassette`／`record-scenarios` 的 aid-back-search）與重放原生 `/` 的 offline spec 明設 `searchKeyOpensModal:false`：卷裡錄的是原生 prompt 逐字打。

## 看板：原生補全橋接（`board_search_bridge.js`）

比照 PTT 原生的看板名稱補全（`mbbsd/name.c#generalnamecomplete`，`CompleteBoard` 巨集）：
- 逐字：`gnc_cb_data` 用 `SHM->bsorted` 二分搜「有沒有**看得到的**看板以這串開頭」（`completeboard_permission`：非 symbolic、非群組、有權限），沒有就 bell＋丟字。
- 空白鍵：輸入延伸到所有符合者的共同前綴（唯一就補完整名），第 2 列畫「相關資訊一覽表」、第 3 列起逐欄列出；還有下一頁時底列「按空白鍵可列出更多項目」。欄寬＝輸入欄長＋2（`do_select` 22、看板列表 `s` 15），解析不寫死欄寬，依起始欄再依列排序。
- Enter：唯一符合或完全相符才進板，否則字串清空（什麼都不做）。

看板清單只在 server（含權限，因人而異），client 沒有可信的離線來源 ⇒ **彈窗切到看板種類就在背景開原生 `s` prompt**（`submitSearch` 同一條路：有列表 session 走它的 passthrough，否則直接排佇列），之後每次輸入排一趟 `退格×輸入欄長 ＋ 字 ＋ 空白 ＋ \f`（`\f` 必要：被拒的字 PTT 只回 bell 不重畫），讀回輸入欄與清單。一次只一趟在飛、最新輸入勝出（不必 debounce）；退格數在 `onSend` 當下量畫面（量不到才用上一幀記的）。

| 結論 | 判準 | 彈窗 |
|---|---|---|
| 被拒 | 輸入欄與查詢字串（大小寫不分）的共同前綴 < 查詢長度 | 退回到收得下的前綴＋紅字「沒有以「…」開頭的看板」 |
| 收下 | 清單每一項都以輸入欄開頭（排掉還掛著上一趟清單的中間幀） | 列出可點的看板；空白鍵＝補成輸入欄（延伸後）；多個符合時 Enter／搜尋鈕停用 |
| unknown | 逾時且當下畫面判不出（server 沒回） | 不擋送出、不顯示「查詢中」 |

逾時後回頭量畫面時**只收「整串被收下」的幀**：沒回應時畫面停在上一趟（輸入欄較短），會被誤讀成被拒而把使用者的字砍掉。

收尾都在**同一個** prompt 上、都握 `searchInFlight` 直到 prompt 消失：送出＝`退格＋板名＋\r`（不加 `\f`，同 `submitSearch` 第二步）；取消（Esc／切種類／關彈窗）＝`Ctrl-C`＋`\f`（ESC 不是 vgetstring 的取消鍵）。prompt 還沒開出來就送出／取消 ⇒ 排在開啟之後。prompt 開不出來 ⇒ `unavailable`，送出改走 `submitSearch`；開出來後被別的擁有者 `flush`（離板、開文）⇒ 不再送任何鍵。

### 彈窗版面

打字時彈窗高度不可跟著補全結果變（手機 sheet 貼底、桌機彈窗，高度一變輸入框就被推動 ⇒ 邊打邊抖）：
- 補全區固定高度（`SearchModal.css`）：狀態列恆佔一行（單行省略）、清單框恆定高度內捲（桌機 160px、手機 112px，留給軟鍵盤）、「只列出前一部分」放在框內。
- 查詢在飛時先顯示上一份收下的清單本地篩選的結果（`interimCandidates`，淡化），不先清空再長回來；以 q 開頭的板必以 q 的前綴開頭，篩下來不會多出錯的板，只是可能少列（上一份被截斷時），不拿來判送出。
- 桌機 Modal 貼頂（`yOffset`）不置中：切種類、刪記憶這類高度變化時輸入框也不動。

守護 `search_modal.test.jsx`「看板補全區高度固定」（真 Chromium 量表單高度，桌機／手機各一）。

## 搜尋狀態列（`search_status.js`）

停在搜尋結果時，終端機右上角（蓋在標題列右段「系列《板》」上；手機在 App Bar 下方靠右）浮一條
「搜尋中：標題「Re」・作者「abc」 ＋條件 ✕」（`components/SearchStatus`，pref `enableSearchStatus` 預設開）。

| 項目 | 規則 | 理由 |
|---|---|---|
| 出現 | `searchListMode`＝'select'：底列 caption「系列文章」；舊版 caption「文章選讀」靠標題列右段「系列《板》」（只能證明「是」）。文摘、完整列表、認不出、文章裡（pageState 3）都不出現 | 認不出 ⇒ 不顯示 |
| 條件 | 只記搜尋彈窗送出、PTT 收下（第二步 onDone）的：送出前那一幀是完整列表＝新的一串，是搜尋結果＝增加條件（`rememberSubmitted`）。看到完整列表就忘（剛記下的那一刻不算，見 `nextSearchMemory` 的 fresh）；原生搜尋 prompt 出現且不是彈窗送的（`searchInFlight` 沒握著）⇒ 只顯示「搜尋結果」 | PTT 畫面上沒有搜尋條件；顯示不完整的條件比不顯示更誤導 |
| 換板 | 從搜尋結果 `s` 換板仍在搜尋模式、條件照舊（新版 read_ctx 帶著走）⇒ 不比對板名 | 同 `aid_navigation.landedOnBoardList` |
| ✕ | `view.sendKeyAsUser('ArrowLeft')`：列表上 ← 是 read_cmd_quit，只離開子模式 | 走鍵盤同一條分派（列表好讀、閘門照舊） |
| ＋條件 | `view.sendKeyAsUser('/')`：攔截開著是搜尋彈窗（在搜尋結果送出＝「增加條件 標題:」），關著是原生 prompt | 同上；不另開一條送鍵路 |
| 篇數 | 不顯示 | PTT 不給總數，列表好讀累積的只是看過的部分 |

只替使用者按鍵 ⇒ 不在安全模式名單。e2e 預設關（`bootOffline` 的 `opts.searchStatus` 才開，浮層會擋右上角的滑鼠）。
守護：`search_status.test.js`（認法、記憶、控制器）、`search_status.offline.spec.js`（彈窗搜尋 → 狀態列寫條件、✕ 送 ←、原生進去只說「搜尋結果」、＋條件開彈窗不送鍵、pref 關）。

## 記憶（`search_history.js`）

localStorage `pttchrome.searchHistory.v1` = `{title,author,push,board}`，各 MRU 去重、上限 20。**不在 `pttchrome.pref.v1`** ⇒ 不同步、不進匯出（使用者要求）。彈窗內 ↑ 從最新開始、↓ 回草稿；下方列最近 6 筆可點（手機沒有方向鍵）。刪除：每筆旁 ×（`forgetSearch`）；「全部清除」（`forgetSearchKind`）**只清目前這一類**，其他種類不動。刪除後 ↑ 游標歸零。

## 測試

unit：`article_search.test.js`（判準／指紋／兩條送出路徑／看板列表 session 多步）、`board_search_bridge.test.js`（畫面解析／鍵序／被拒／最新勝出／逾時／收尾閘門）、`search_history.test.js`、`search_modal.test.jsx`（看板補全用假橋接）、`search_key_intercept.test.js`。offline e2e：`article_search.offline.spec.js`（線上 bytes＝`/\f` → prompt 幀 → `關鍵字\r`、↑ 叫回、Esc 零 byte、pref 關＝原生、已有 prompt 時不攔；看板補全用頁內照 `name.c` 寫的迷你 namecomplete 模擬）；`board_note_skip.offline.spec.js` 的主選單 `s` 卷含一趟合成的補全回應；手機入口在 `mobile_toolbar.offline.spec.js`。
