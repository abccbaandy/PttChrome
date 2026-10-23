# 指令面板（`command_palette.js`）

動 `command_palette.js`、`components/ContextMenu/CommandPalette.jsx`、ContextMenu 的 `openPalette`／`runPaletteItem` 前先讀。

## 是什麼

快捷鍵（pref `commandPaletteKey`，預設 F4）或右鍵／長按選單「指令面板」叫出一個輸入框，一個框整合：

| 輸入 | 列出 | 接到哪個既有入口 |
|---|---|---|
| ptt.cc 文章網址、本站 deep link、`#AID (看板)`、`看板 #AID`、`看板/AID` | 開啟文章 | `deepLinkController.request`（登入前暫存、AID 跳轉、閱讀紀錄 `deep-link-jump`） |
| 空白，或標題／板名含輸入（pref `enableRecentArticles`） | 稍後再讀＋最近讀過的文章（最多 5 篇，稍後再讀在前，排在看板後面） | 同上一列「開啟文章」（`recent_articles.js`，見 `docs/recent-articles.md`） |
| 空白，或板名開頭 | 最近去過的看板＋我的最愛（空白最多 12 個、打字最多 5 個，最近的在前） | 同下一列「前往看板」 |
| 板名（`BOARD_RE`） | 前往看板 | 搜尋彈窗的送出（`onSearchConfirm` kind `board` → `submitSearch`，閱讀紀錄 `board-search`） |
| 任意字／帳號字元／數字 | 搜標題／作者／推文數 | 同上（kind `title`／`author`／`push`） |
| 動作關鍵字（兩語系） | 重新整理、跳到第一篇未讀、設為全部已讀、複製本篇連結、返回原文、開啟設定、安全模式開／關 | `screenRefresh.refresh`、`unreadJump.start`、`markAllRead.start`、`copyCurrentPostLink`、`aidNavigation.back`、設定頁、`setNativeSafeMode` |
| 設定名稱 | 設定項（最多 4 筆） | 開設定頁＋`PrefModal jumpTarget`（與設定搜尋同一套跳轉） |

## 規則

- **面板不發明 PTT 操作**：每一項都走既有入口，送鍵、閱讀紀錄、忙碌提示、認不出就不動都由那些入口負責。
- **能不能用在開面板當下量**（`openPalette` 的 `paletteCtx`），判準與右鍵選單／手機工具列同一組函式（`availableSearchKinds`、`screenRefresh.target`、`unreadJump.available`、`markAllRead.available`、`pageState === 3`、`aidNavigation.canGoBack`）。不能用的不列，不是列出來再失敗。忙碌中（`serializedOpHint`）不列搜尋。
- 沒寫看板的 `#AID` 不收：面板外沒有可靠的「目前看板」。
- 排序：文章 → 最近／最愛的看板 → 關鍵字**開頭**符合的動作 → 前往看板 → 搜尋 → 只是中間含有的動作 → 設定項。
  空白時看板排在動作前面：F4 → ↓ → Enter 就回到剛剛的板（第一個通常是現在這個板）。打的字跟某個最近／最愛的板名一樣時，不再另列一個「前往看板」。
- 最近／最愛的看板（pref `paletteQuickBoards`，預設開）：資料是首頁儀表板現成的（`HomeDashboard.quickBoards()`：最近看板在每次進板就記、我的最愛是儀表板抓過的快取），**一個 byte 都不多送**。
  只在能選看板的畫面列（`searchKinds` 含 `board`：主功能表、看板列表、文章列表）；文章裡按 `s` 不是選看板，不列。
- **快捷鍵只用 F 鍵**：F 鍵在 `term_keyboard` 沒有對應、送不到 PTT。Ctrl+K 不行：pttbbs 編輯器（`edit.c` 刪至行尾）、輸入欄（`vtuikit.c`）、pager（`more.c`）都在用。
- 安全模式切換不走 `onPrefSaveImpl`（`fromPrefModal` 會把 localStorage 的帳密填進登入快取），自己走 `writeValues → savePrefs → onValuesPrefChange → switchToEasyReadingMode`。
- 關面板＋開設定頁要在**同一次** `update`（modalOpen 不可 true→false→true）。
- 清單框固定高度（`CommandPalette.css`），項目數變化時輸入框不跳。
- 開關 `enableCommandPalette`（預設開）。只在使用者按下時才動 ⇒ 不在安全模式名單內。

## 測試

unit：`command_palette.test.js`（輸入判讀、排序、能用才列、兩語系標題）、`command_palette_ui.test.jsx`（ContextMenu 整合：接手合約、↑↓／Enter／點擊、各類入口、設定跳轉、安全模式存檔、框高固定）。offline e2e：`command_palette.offline.spec.js`（真鍵盤 F4 擋預設動作、打字零 byte、Esc、跑跳到未讀、pref 關）。
