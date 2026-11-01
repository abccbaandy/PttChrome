# 寬螢幕雙欄閱讀（`split_reader.js`）

動 `split_reader.js`、`components/SplitReader` 前先讀。

## 是什麼

讀文章時，終端機左邊的空白處列出剛才那份文章列表，標出正在讀的那篇（未讀標點、推文數照列表）。點另一篇就直接換過去讀，不用先退回列表。開關 `enableSplitReading`（預設開，在安全模式名單內）；左欄可以收起成左緣的把手（`pttchrome.splitReader.collapsed.v1`，只記在這個瀏覽器）。

## 規則

- **PTT 同一時間只有一個畫面**：左欄是快照，不是活的列表。每次文章列表 settle 就把那一頁併進來（同板累積，換板整份換掉，最多 `SPLIT_SNAPSHOT_LIMIT` 篇，超過丟離游標最遠的）。列表好讀自己補頁時經過的真實畫面也會併進來。
- **換文＝原生鍵**：點一篇走 `aid_navigation.startNum(板, 編號)`，與 agent 工具同一條。從文章出發是文章內 `s<板>⏎`（`_enqueueBoardJump`）→ `<編號>⏎`（`numJumpLanded` 驗游標）→ 游標那一列是左欄那篇（`snapshotCursorVerify`：同編號、沒刪、作者＋主題、發文日期，同頁兩列以上同身分時再比 ±1 的鄰居；左欄是快照，之後有人刪文同編號就是別篇）才 `⏎`（驗落在文章）。dir `goto`：不碰返回堆疊。每步落地不符就停手，人留在 PTT 給的畫面。閱讀紀錄 `split-open` 一律不還原。
- **認不出 ⇒ 原生**：只在「pageState 3＋`view._articleBoard` 有值＋上一次看到的文章列表是同一板的完整列表」時出現。搜尋結果與文摘（底列「系列文章」／「文摘列表」，read.c MODE_SELECT／MODE_DIGEST）是另一個編號空間，拿那裡的編號去 `startNum` 會開錯篇 ⇒ 從那裡進的文章不出現。從沒看過列表（deep link、斷線回到原處直接開文）也不出現。
- **這篇是哪一篇**：作者＋主題（`long_push_anchor.listRowIdentity`／`subjectMatches`，列表主題被截成 `…` 也認得）。同一串的回文很多，所以先信開文前的游標（`curY` 那一列），再信唯一的符合者，都不成就不標，左欄照樣出現。改過標題的文章（`T`＝bbs.c `edit_title` 只改 `.DIR`、不改檔頭）主題永遠比不上 ⇒ 游標可信（`cursorHintFresh`：看過列表後的第一篇）時作者對得上就信游標。
- **列的讀法**：`agent_parse.parseListEntry`（bbs.c#readdoent 欄位）；第 8 格是未讀欄（`+ ~ M = S #`）。游標列看終端機游標的 `curY`；STR_CURSOR2「●」（全形，蓋掉序號前兩格）讀不出嚴格的編號，退回 `parseListArticleNumLoose`。置底文沒有編號，`startNum` 跳不到，不收。
- **黑名單**：命中黑名單（作者／標題，`list_row_filter#blacklistHit`，見 `docs/list-row-filter.md`）的列不顯示，跟列表上看到的一致；正在讀的那篇就算命中也留著。快照存的是全部的列（含列原文 `text`），只在顯示時過濾（`shownEntries`），黑名單取當下的設定。刪除文照舊列出、不能點。
- **只用空白處**：終端機恆 80 欄、`align=center` 置中（`docs/terminal-size.md` LOCKED），左欄只放在 `view.mainDisplay` 左緣到視窗左緣之間，`paneWidthFor` 放不下就不出現，不推動、不縮小終端機。預設「固定終端機大小」把字放大到撐滿高度，實測常見視窗左邊只剩約 150～200px（數字在 `SPLIT_MIN_PANE_PX` 的註解），所以標題折兩行。手機不出現。
- **不是 modal**：焦點留在 `#t`，鍵盤照常操作文章。滑鼠：左欄在 `#BBSWindow` 外，`_onUploadLayer` 認 `#splitReader` 放過（滾輪捲左欄，不變成文章翻頁）；按鈕 mousedown `preventDefault`＋stopPropagation。
- **線路忙就不送**：`serializedOpHint` 有值或 CommandQueue 不閒 ⇒ 不送，給提示。換文途中左欄留著，那一篇顯示「開啟中」；`startNum` 的結束回呼每輪恰好一次，另有 45 秒看門狗。
- e2e：`installReplay` 預設把 `enableSplitReading` 關掉（寬視窗的文章畫面左邊多一欄浮層，會擋掉落在那裡的滑鼠），live 的自動登入 prefs 也關掉；只有 `split_reader.offline.spec.js` 以 `bootOffline(page, ptt, { splitReader: true })` 打開。

## 測試

unit：`split_reader.test.js`（列的讀法、快照合併、認這篇、何時出現、換文與失敗、忙碌、看門狗）、`split_reader_ui.test.jsx`（外殼照 state 畫、按鈕接到控制器、不搶焦點、滑鼠不外洩、目前這篇捲進視野）。offline e2e：`split_reader.offline.spec.js`（1920×960 真的放得下且不蓋終端機、點一篇送 `s<板>⏎`、滾輪捲左欄不送鍵、收起與展開、窄視窗與 pref 關不出現）。
