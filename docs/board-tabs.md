# 看板分頁（`board_tabs.js`）

動 `board_tabs.js`、`components/BoardTabs` 前先讀。

## 是什麼

文章列表上方一排最近去過的看板分頁（pref `enableBoardTabs`，預設開，在安全模式名單內）。點一下切板，右鍵（手機長按）關掉。
常在 2～4 個板之間來回的人，不用每次 `s` 板名⏎、再找回原本看到哪。

## 規則

| 項目 | 規則 | 理由 |
|---|---|---|
| 出現 | 這一幀是文章列表（`articleListBoardOf`：底列文章列表 caption＋標題列有《板名》，搜尋結果也算）且分頁至少兩個。看板列表、文章、信箱、prompt 都不出現 | 認不出 ⇒ 不顯示；只有一個板沒有東西可切 |
| 記錄 | 文章列表 settle 就 `visitBoard`：已有只更新時間（位置不動，像瀏覽器分頁）；沒有接在最後；超過 `BOARD_TABS_MAX`（6）丟最久沒去的（不丟剛到的）。存 localStorage `pttchrome.boardTabs.v1`，不同步、壞掉就從空的開始 | 分頁跳來跳去很難點；只對這台裝置有意義 |
| 切板 | `submitSearch(core, 'board', name)`＝原生 `s<板>⏎`（同首頁儀表板的看板卡片、搜尋彈窗的「前往看板」，閱讀紀錄 `board-search`）。現在這個板點了不送 | 不另開送鍵路 |
| 回到上次看到的位置 | **PTT 自己記**：`read.c#getkeep` 依看板目錄記游標與頂列（整個登入 session，`keeplist`），進板時還原；列表好讀接著在那個游標上 engage。這裡不另記視野 | 閱讀紀錄只記一個列表視野，per-board 視野不必重做一份 |
| 關掉 | 右鍵／長按（`contextmenu`，Android Chrome 長按也是它）；桌機 hover 另有 ×。現在這個板關不掉（下一幀就記回來） | — |
| 位置 | 桌機：疊在終端機第 1 列（文章列表的按鍵提示列「[←]離開 [→]閱讀…」）上，同終端機寬、列高同 `view.chh`，底色同終端機把那一列蓋掉。手機：App Bar 右邊（標題就是現在這個板 ⇒ 只列別的板），橫向可捲 | 不推動終端機（`docs/terminal-size.md` LOCKED）；第 1 列在列表上是靜態提示 |
| 滑鼠 | `App._onUploadLayer` 認 `#boardTabs` 放過；按鈕 mousedown `preventDefault`（不搶 `#t` 焦點）＋ stopPropagation | 同 AidBackButton |

e2e：`installReplay` 預設關（蓋在第 1 列、分頁清單存在 localStorage），只有 `board_tabs.offline.spec.js`／`mobile_board_tabs.offline.spec.js` 以 `opts.boardTabs` 打開。

## 測試

unit `board_tabs.test.js`（認法、分頁清單的順序與上限、存本機與壞資料、出現條件、點現在這個板不送、現在這個板關不掉、安全模式）。
offline e2e `board_tabs.offline.spec.js`（疊在第 1 列不蓋標題列與表頭、真右鍵關掉不送鍵、點別的板線上送 `s\f`、pref 關）、`mobile_board_tabs.offline.spec.js`（App Bar 右邊、只列別的板、tap 送 `s\f`）。
