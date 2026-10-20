# 文章列表的黑名單判準（`list_row_filter.js`）

從文章列表挑文章、或把文章列給人／agent 看的功能，判斷「這一列使用者看不看得到」一律呼叫 `src/js/list_row_filter.js`，不准自己比對 `blacklist`／`titleBlacklist`。原因：每個功能各寫一份比對，漏寫一份就會把列表上已經藏起來的文章又拿出來（「下一篇」卡片就出過這個錯：只跳過刪除文，沒套黑名單）。

## 兩層

| 函式 | 判什麼 | 用在 |
|---|---|---|
| `blacklistHit(text, set, keywords)` | 作者 id 完全相同（不分大小寫）→ `{by:'author'}`；標題含關鍵字（子字串）→ `{by:'title', keyword}`；作者先比 | 原生列表的「（本文已被黑名單）」提示列（`screen_annotations`）、雙欄閱讀左欄、agent 列文章 |
| `isHiddenListText(text, set, keywords)` | 列表形的列，而且是刪除文／鎖文（開不了），或命中 `blacklistHit` | 列表好讀藏列（`list_session#visibleListIndices`）、下一篇卡片、跳到第一篇未讀 |
| `hiddenReason(...)` | 同上，回傳原因 `deleted`／`locked`／`author`／`title` | 錄製檔 log |

- 輸入是一整列的純文字（`rowToText`／`getRowText`）。快照類資料（`split_reader#listPageOf` 的條目、`agent_parse#listEntriesFromScreen`）都帶 `text` 欄位；黑名單本身不存，用到的時候才讀 `listFilterOf(view)`，因為使用者隨時可能改名單。
- 不是列表形的列（表頭、說明列、從列表叫出的整頁畫面）一律看得到，見 `comment_parse#isListShapedRow`。

## 各功能被擋住的列怎麼處理

| 功能 | 處理 |
|---|---|
| 列表好讀 | 不顯示（刪除文、鎖文一起） |
| 原生列表 | 換成「（本文已被黑名單）」提示列；刪除文照 PTT 原樣顯示 |
| 下一篇卡片 | 跳過，繼續看下一號；後面還沒看過的列 ⇒ 卡片不出現 |
| 雙欄閱讀左欄 | 不列；正在讀的那篇就算命中也留著；刪除文照舊列出但不能點 |
| 跳到第一篇未讀 | 當作中性（不算未讀，也不算進「連續已讀」的篇數），所以不會跳到看不到的那篇 |
| agent `ptt_list_articles` | 不回傳；置底文的 `index` 與 `nextBefore` 照畫面算（`ptt_read_article` 照畫面位置找文章） |

## 錄製檔

- `list.filter {authors, titleKeywords}`：錄製開始時記一筆，之後改黑名單設定再記一筆（`App.onPrefChange`）。作者 id 不遮蔽：錄製檔本來就含整個列表畫面上的作者 id；`meta.warning` 有註明這點。
- `nextArticle.pick {current, next, skipped:[{num, why}]}`：卡片挑了哪一篇、跳過哪些、為什麼跳過；同一次錄製裡結果沒變就不重記。

## 守護

- `tests/unit/list_row_filter.test.js`：各層判準，以及 `visibleListIndices` 用的是同一份。
- `tests/unit/list_row_filter_usage.test.js`（靜態掃描）：只有 `list_row_filter.js`／`comment_parse.js` 能拿東西比對黑名單；解析文章列表條目（`parseListEntry`／`listEntriesFromScreen`／`listPageOf`）的模組必須 import 本模組，否則要列進 `EXEMPT` 並寫理由（目前有 `aid_navigation`：它只用來辨認畫面；`home_dashboard`：只讀最新一篇的已讀標記來鏡像 PTT 的看板未讀旗標。兩者都不挑文章給人看）。
- 各功能的行為測試在 `next_article.test.js`、`split_reader.test.js`、`unread_jump.test.js`、`agent_tools.test.js`、`debug_recorder.test.js`。
