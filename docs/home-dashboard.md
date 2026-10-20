# 首頁儀表板（`home_dashboard.js`）

動 `home_dashboard.js`、`components/HomeDashboard` 前先讀。

## 是什麼

主功能表（`【主功能表】`）上蓋一層面板：我的最愛的看板卡片（有新文章的標「有新文章」）、最近去過的看板、新信提示（`你有新信件`）。點卡片進看板，「原生主選單」收起面板。開關 `enableHomeDashboard`（預設開，在安全模式名單內）。

## 規則

- **不是 modal**：焦點留在 `#t`，鍵盤照常送 PTT。面板開著時打任何鍵（純修飾鍵、F 鍵、⌘R 除外；⌘R 要讓 screen_refresh 認成首頁，面板先收起就變整頁重載）⇒ 面板收起、那個鍵照原生走。這一趟留在主功能表期間不再出現，離開主功能表再回來才出現。
- **認不出 ⇒ 原生**：只在「標題列是主功能表＋畫面上有 `(F)avorite` 選單項＋游標不在輸入欄」時出現（`isHomeScreen`）。
- **抓我的最愛＝原生鍵**（`fetchFavorites`）：`Ctrl+Z f`（menu.c#ZA_Select 的「我的最愛」，任何畫面都能進根目錄、不動主功能表的游標）→ 讀頁 →（進來不在第 1 頁就跳 `1⏎`）→ 一頁滿 20 個就跳 `<最後一號+1>⏎`，被夾回同一頁＝沒有下一頁（stuff.c#search_num）→ 跳回進來時的游標 → `q`。最多 `FAV_MAX_PAGES` 頁。每一步落地不符就停手（`fail`），人留在 PTT 給的畫面上。
- **什麼時候抓**：面板出現後等 `AUTO_FETCH_DELAY_MS`，快取超過 `FAV_TTL_MS` 才抓；中間使用者打字、線路有別人的事（`serializedOpHint`、CommandQueue 不閒、deep link／斷線回到原處還在排程）就不抓。失敗後 TTL 內不重試。
- **手動更新＝重新整理**：面板的「更新」、F5／⌘R、手機工具列「重整」、手機下拉，全部走 `screen_refresh` 的 `home` target（面板畫著才算；收起後的原生主功能表照舊不接，F5 交還瀏覽器），同一道冷卻、同一套忙碌提示，最後落到 `fetchFavorites`。下拉在整片卡片按鈕上也能起手（`pull_refresh.ignoredTarget` 對 `#homeDashboard` 放行）；點一下不會走出 slop，拉過門檻也不會變成點卡片。
- **逛完看板回來的「有新文章」不重抓**（`newestArticleUnread`）：看板的未讀旗標是 `board.c#check_newpost` ＝ `brc_unread_time(lastposttime)`，`lastposttime` 是 `.DIR` 最後一筆（最新一篇、不含置底）的建立時間（`cache.c#setbtotal`）⇒ **只看最新一篇讀了沒**，與讀過其他哪幾篇無關。文章列表 settle 時，最新一篇看得出來（它下面接置底 ★ 或空白列）就讀 cell 8 的已讀標記（`bbs.c#readdoent`）：`+`／`M` 未讀；` `／`m`／`~`／`=`／`s`／`*` 已讀（`check_newpost` 傳 modified 0，有新推文不算）；`S`／`#`（分不出 1／2）、`!`／`D`（蓋掉未讀資訊）、刪除文、最新一篇剛好在條目區最後一列、搜尋結果／文摘 ⇒ 看不出來，不動。只在那個板是我的最愛時才讀滿整頁（每次 settle 都跑）。使用者自己開原生我的最愛時照抄那一頁的 ˇ（`withFavPageUnread`，只改已有的板）。兩者都寫回快取、一個 byte 都不送。
- **列的讀法**（`parseFavRow`，board.c#brdlist_renderer）：編號（`%6d`／舊版 `%7d`）→ 未讀「ˇ」→ 板名 → 類別 → `◎Σ☆` → 中文敘述 34 格。未讀看「編號與板名之間有沒有 ˇ」，不靠欄位位置。分隔線、目錄、禁入不收。按 `y` 列全部看板（variant `all`）不收；按 `c` 的新文章模式（row2「總數」）只收那一頁、不翻。
- **進看板**＝搜尋彈窗的「前往看板」同一條（`submitSearch(core, 'board', name)`，`s<板>⏎`，閱讀紀錄 `board-search`）。**開信箱**＝`Ctrl+Z m`。
- 閱讀紀錄：面板的捲動位置是 `home` 紀錄（`readingPosition`：面板頂端那張卡片＋離上緣幾 px，只存身分不存像素）。從面板出發的交易——點看板／最近看板（`board-search`）、抓最愛（`home-favorites`）、開信箱（`home-mail`）——不論結果都交回待還原錨，面板下一次畫出來（或更新完重畫）時由外殼的 `useLayoutEffect` 呼叫 `applyPendingViewport` 套用；那張卡片不在了就不動。按「原生主選單」或打字收起面板 ⇒ 作廢。debug 錄製檔 `homeDashboard.viewportRestore`（saved／applied／dropped）。
- 快取：`pttchrome.homeFavorites.v1`（清單＋時間，跨重整保留只為了先畫出來；已讀標記只對這次登入有意義，所以「新鮮」只算這一頁抓過的）、`pttchrome.homeRecentBoards.v1`（最近看板，文章列表 settle 時記）。
- 滑鼠：面板在 `#BBSWindow` 外。App 的滑鼠入口在 window（滾輪是 capture），`_onUploadLayer` 認 `#homeDashboard` 放過；按鈕 mousedown `preventDefault`（不搶 `#t` 焦點）＋ stopPropagation。
- e2e：`installReplay` 預設把 `enableHomeDashboard` 關掉（畫主功能表的 spec 不能被面板擋住、多送 byte），live 的自動登入 prefs 也關掉；只有 `home_dashboard.offline.spec.js` 以 `bootOffline(page, ptt, { homeDashboard: true })` 打開。

## 測試

unit：`home_dashboard.test.js`（主功能表指紋、列的讀法、最新一篇的已讀標記、送鍵序列與翻頁／夾回、收起與自動抓時機、逛完看板更新未讀、更新鈕接 screen_refresh）、`home_dashboard_ui.test.jsx`（外殼照 state 畫、按鈕接到控制器、不搶焦點、滑鼠不外洩、真版面的捲動位置還原）、`screen_refresh.test.js`／`mobile_toolbar.test.js`（`home` target）、`reading_record.test.js`（`home` 欄）。offline e2e：`home_dashboard.offline.spec.js`（自動抓 → 卡片、點卡片送 `s`、真鍵盤打字收起且鍵照送、原生主選單、pref 關、逛完看板不再標有新文章、F5 重抓）、`mobile_home_dashboard.offline.spec.js`（在卡片上下拉重抓、工具列重整、捲到中段點看板回來捲回原處）。
