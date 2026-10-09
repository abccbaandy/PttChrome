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
- `activeListSession()` 有值 ⇒ `session._beginPassthroughBytes(steps, {kind:'search'})`（cursor sync 腿＋進原生鏡像；看板列表 session 2026-10 起也收陣列，kind 自動帶 `brd-` 前綴＝佇列所有權）。session `opening`／`functionMode+frozen` ⇒ 回 false，呼叫端提示。
- 否則直接 `commandQueue.enqueue`（`list_session._onScreenSettled` 驅動 onSettle）。
- 關鍵字 `ansiHalfColorConv(u2b(text))`（queue 綁 raw `conn.send`）。
- **在途閘門 `core.searchInFlight`**（`serialized_op_gate` 讀，期間吞鍵＋提示「搜尋中」）：少了它，搜尋鍵已上線、prompt 未到時按的 Enter 會把空 prompt 送出（＝取消），關鍵字落到列表變指令（live 錄製檔實證）。解除＝第二步 onDone／任一步 onFail／onFlushed（兩個 session 的 `_enqueuePassthroughStep` 都轉送 `onFlushed`）＋保底 `SEARCH_INFLIGHT_MAX_MS`。e2e 等搜尋完成一律等它（`core.spec.js#gotoLatestThread`），不可只看「列表＋游標不在輸入欄」。
- 錄製工具（`record-cassette`／`record-scenarios` 的 aid-back-search）與重放原生 `/` 的 offline spec 明設 `searchKeyOpensModal:false`：卷裡錄的是原生 prompt 逐字打。

## 記憶（`search_history.js`）

localStorage `pttchrome.searchHistory.v1` = `{title,author,push,board}`，各 MRU 去重、上限 20。**不在 `pttchrome.pref.v1`** ⇒ 不同步、不進匯出（使用者要求）。彈窗內 ↑ 從最新開始、↓ 回草稿；下方列最近 6 筆可點（手機沒有方向鍵）。刪除：每筆旁 ×（`forgetSearch`）；「全部清除」（`forgetSearchKind`）**只清目前這一類**，其他種類不動。刪除後 ↑ 游標歸零。

## 測試

unit：`article_search.test.js`（判準／指紋／兩條送出路徑／看板列表 session 多步）、`search_history.test.js`、`search_modal.test.jsx`、`search_key_intercept.test.js`。offline e2e：`article_search.offline.spec.js`（線上 bytes＝`/\f` → prompt 幀 → `關鍵字\r`、↑ 叫回、Esc 零 byte、pref 關＝原生、已有 prompt 時不攔）；手機入口在 `mobile_toolbar.offline.spec.js`。
