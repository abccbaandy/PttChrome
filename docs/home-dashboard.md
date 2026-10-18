# 首頁儀表板（`home_dashboard.js`）

動 `home_dashboard.js`、`components/HomeDashboard` 前先讀。

## 是什麼

主功能表（`【主功能表】`）上蓋一層面板：我的最愛的看板卡片（有新文章的標「有新文章」）、最近去過的看板、新信提示（`你有新信件`）。點卡片進看板，「原生主選單」收起面板。開關 `enableHomeDashboard`（預設開，在安全模式名單內）。

## 規則

- **不是 modal**：焦點留在 `#t`，鍵盤照常送 PTT。面板開著時打任何鍵（純修飾鍵、F 鍵除外）⇒ 面板收起、那個鍵照原生走。這一趟留在主功能表期間不再出現，離開主功能表再回來才出現。
- **認不出 ⇒ 原生**：只在「標題列是主功能表＋畫面上有 `(F)avorite` 選單項＋游標不在輸入欄」時出現（`isHomeScreen`）。
- **抓我的最愛＝原生鍵**（`fetchFavorites`）：`Ctrl+Z f`（menu.c#ZA_Select 的「我的最愛」，任何畫面都能進根目錄、不動主功能表的游標）→ 讀頁 →（進來不在第 1 頁就跳 `1⏎`）→ 一頁滿 20 個就跳 `<最後一號+1>⏎`，被夾回同一頁＝沒有下一頁（stuff.c#search_num）→ 跳回進來時的游標 → `q`。最多 `FAV_MAX_PAGES` 頁。每一步落地不符就停手（`fail`），人留在 PTT 給的畫面上。
- **什麼時候抓**：面板出現後等 `AUTO_FETCH_DELAY_MS`，快取超過 `FAV_TTL_MS` 才抓；中間使用者打字、線路有別人的事（`serializedOpHint`、CommandQueue 不閒、deep link／斷線回到原處還在排程）就不抓。失敗後 TTL 內不重試。面板上的「更新」隨時可以手動抓。
- **列的讀法**（`parseFavRow`，board.c#brdlist_renderer）：編號（`%6d`／舊版 `%7d`）→ 未讀「ˇ」→ 板名 → 類別 → `◎Σ☆` → 中文敘述 34 格。未讀看「編號與板名之間有沒有 ˇ」，不靠欄位位置。分隔線、目錄、禁入不收。按 `y` 列全部看板（variant `all`）不收；按 `c` 的新文章模式（row2「總數」）只收那一頁、不翻。
- **進看板**＝搜尋彈窗的「前往看板」同一條（`submitSearch(core, 'board', name)`，`s<板>⏎`，閱讀紀錄 `board-search`）。**開信箱**＝`Ctrl+Z m`。
- 閱讀紀錄：`home-favorites`、`home-mail` 都是不還原（主功能表不是三種紀錄之一）。
- 快取：`pttchrome.homeFavorites.v1`（清單＋時間，跨重整保留只為了先畫出來；已讀標記只對這次登入有意義，所以「新鮮」只算這一頁抓過的）、`pttchrome.homeRecentBoards.v1`（最近看板，文章列表 settle 時記）。
- 滑鼠：面板在 `#BBSWindow` 外。App 的滑鼠入口在 window（滾輪是 capture），`_onUploadLayer` 認 `#homeDashboard` 放過；按鈕 mousedown `preventDefault`（不搶 `#t` 焦點）＋ stopPropagation。
- e2e：`installReplay` 預設把 `enableHomeDashboard` 關掉（畫主功能表的 spec 不能被面板擋住、多送 byte），live 的自動登入 prefs 也關掉；只有 `home_dashboard.offline.spec.js` 以 `bootOffline(page, ptt, { homeDashboard: true })` 打開。

## 測試

unit：`home_dashboard.test.js`（主功能表指紋、列的讀法、送鍵序列與翻頁／夾回、收起與自動抓時機）、`home_dashboard_ui.test.jsx`（外殼照 state 畫、按鈕接到控制器、不搶焦點、滑鼠不外洩）。offline e2e：`home_dashboard.offline.spec.js`（自動抓 → 卡片、點卡片送 `s`、真鍵盤打字收起且鍵照送、原生主選單、pref 關）。
