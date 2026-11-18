# 使用者資料（存在這台機器上的東西）

> 動到任何 localStorage／IndexedDB 讀寫、加一種要記住的資料、改設定備份或雲端同步的涵蓋範圍之前先讀這份。
> 架構 review A10「使用者資料層」的現況盤點與後續步驟。

## 規則

- **鍵名只寫在 `src/js/user_data_keys.js`**：`STORAGE_KEYS`（localStorage）、`INDEXED_DB_NAMES`（IndexedDB）。
  其他檔案寫 `'pttchrome.xxx'` 字串會被 lint 規則 `pttchrome/no-storage-key-literal` 擋（檔名 `pttchrome.jsx` 放行）。
- 加一種資料＝總表加一個鍵＋`USER_DATA` 補一列＋下面的表補一行，守護 `tests/unit/user_data_keys.test.js`
  三邊對得起來（擁有者檔案也要真的用 `STORAGE_KEYS.<id>`）。
- **上線過的鍵名不能改字**：改字＝使用者的舊資料全部消失。格式要變就升版號（`.v1` → `.v2`），
  遷移寫在擁有者模組（例：`readLater.v2`）。
- **共用讀寫 `src/js/user_data.js`**：以 id（不是鍵名字串）讀寫；契約是讀不到回預設、寫不進去安靜放棄。
  旗標類用 `readFlag`／`writeFlag`（開＝`'1'`、關＝整個移除，跟舊資料同形狀）；JSON 類用
  `readJson`（沒有／壞掉／拿不到都回 null，**形狀檢查留給擁有者**）／`writeJson`（回傳有沒有寫進去）／`removeData`。
  要拿原文字串當快取鍵的（每一幀都問、原文沒變就沿用解析結果）用 `readRaw`：新推文標記的列表徽章、最近讀過／稍後閱讀（後者連寫入也用 `writeRaw`，寫的就是當快取鍵的那份原文）。
  本來就存純文字（舊資料不是 JSON）的用 `readRaw`／`writeRaw`，目前只有長推文草稿。
  已搬：全部旗標、上傳紀錄、搜尋紀錄、新功能看過清單、看板分頁、首頁兩份（我的最愛快取、最近去過的板）、斷線回原處快照、新推文標記、浮動鈕位置、長推文草稿、最近讀過／稍後閱讀、設定本身（`pref_storage.js`，形狀 `{ values }` 不變）。至此總表的 localStorage 鍵都走共用讀寫。守護 `tests/unit/user_data.test.js`
  （含「已搬的擁有者不再自己 getItem／setItem」）。
- 要不要上雲、要不要進設定備份，**每一種都另外提案**（Firestore 額度與隱私），不跟著重構順手打開。

## 現況總表

性質：設定／紀錄（使用者累積、掉了會心疼）／快取（可以重抓）／草稿／介面（收合、位置這類小狀態）。

| 鍵名 | 擁有者 | 性質 | 上雲 | 設定備份 | 上限 |
|---|---|---|---|---|---|
| `pttchrome.pref.v1` | `pref_storage.js` | 設定 | 設定同步（帳密等本機專用欄位除外） | 有 | 固定欄位 |
| `pttchrome.prefsync.enabled` | `pref_sync.js` | 介面 | 否 | 否 | 一個旗標 |
| `pttchrome.recentArticles.v1` | `recent_articles.js` | 紀錄 | 否 | 有（閱讀紀錄一區） | `RECENT_ARTICLES_LIMIT` 篇 |
| `pttchrome.readLater.v2` | `recent_articles.js` | 紀錄 | 稍後閱讀同步（`read_later_sync.js`） | 有（閱讀紀錄一區） | `READ_LATER_LIMIT` 篇 |
| `pttchrome.newComments.v1` | `new_comments.js` | 紀錄 | 否 | 有（閱讀紀錄一區） | `NEW_COMMENTS_LIMIT` 篇 |
| `pttchrome.boardTabs.v1` | `board_tabs.js` | 紀錄 | 否 | 有（閱讀紀錄一區） | `BOARD_TABS_MAX` 個 |
| `pttchrome.homeFavorites.v1` | `home_dashboard.js` | 快取 | 否 | 否 | `FAV_MAX_PAGES` 頁 |
| `pttchrome.homeRecentBoards.v1` | `home_dashboard.js` | 紀錄 | 否 | 有（閱讀紀錄一區） | `RECENT_LIMIT` 個看板 |
| `pttchrome.searchHistory.v1` | `search_history.js` | 紀錄 | 否 | 有（閱讀紀錄一區） | 每種 `MAX_SEARCH_HISTORY` 筆 |
| `pttchrome.upload.v1` | `upload_history.js` | 紀錄 | 否 | 有（閱讀紀錄一區） | `MAX_HISTORY` 筆 |
| `pttchrome.longPush.draft.v1` | `long_push_draft.js` | 草稿 | 否 | 否 | 一份 |
| `pttchrome.whatsNew.seen.v1` | `whats_new.js` | 介面 | 否 | 否 | 功能名稱清單 |
| `pttchrome.rendererResume.v1` | `reconnect_resume.js` | 快取 | 否 | 否 | 一份，開機讀完就刪 |
| `pttchrome.followOnly` | `follow_only.js` | 介面 | 否 | 否 | 一個旗標 |
| `pttchrome.menuBannerExpanded` | `menu_banner.js` | 介面 | 否 | 否 | 一個旗標 |
| `pttchrome.articleTools.collapsed.v1` | `article_tools.js` | 介面 | 否 | 否 | 一個旗標 |
| `pttchrome.splitReader.collapsed.v1` | `split_reader.js` | 介面 | 否 | 否 | 一個旗標 |
| `pttchrome.floatToolsPos` | `mobile_layout.js` | 介面 | 否 | 否 | 一組座標 |
| `pttchrome-saved-articles`（IndexedDB） | `saved_articles_store.js` | 紀錄 | 否 | 有（離線文章一區） | `SAVED_ARTICLES_LIMIT` 篇 |

不算使用者資料、不在總表的：開站快取的 Service Worker cache（`open_cache.js` 的 `OPEN_CACHE_PREFIX`，
可以整個丟掉重抓）、deep link 的 BroadcastChannel 名（`deep_link_channel.js`，不落地）、
Mantine 自己的色彩模式鍵、Firebase SDK 自己的登入狀態（IndexedDB）。

## 還沒做（A10 後續步驟，一次一步、舊資料不能掉）

1. **共用讀寫搬完**：已完成（總表的 localStorage 鍵都走 `user_data.js`）。
2. **容量滿的處理**：已完成。`user_data.js` 的寫入（`writeFlag`／`writeJson`／`writeRaw`）遇到容量滿
   （`isQuotaError`：QuotaExceededError、Firefox 的 NS_ERROR_DOM_QUOTA_REACHED、code 22／1014）先清掉
   `QUOTA_EVICT_ORDER`（只放可以重抓的快取：我的最愛快取；斷線回原處快照重抓不回來，不清）再試一次，
   仍失敗才放棄；兩種結果都記一筆 `userData.quota` 進 debug 錄製（`diag.js`）。隱私模式／被封鎖的
   storage（不是容量滿）照舊安靜放棄、不清任何東西。IndexedDB（存到本機）不在這條路上。
3. **跨分頁同步**：只有看板分頁聽 `storage` 事件（畫面即時跟著別的視窗變），其餘畫面不會即時跟著別的分頁變。寫入時會不會蓋掉
   別的分頁剛寫的，看擁有者是「寫之前從 storage 重讀」還是「拿開機時讀進記憶體的那份寫回」：
   - 寫前重讀（兩個分頁交錯操作也不會掉資料）：最近讀過、稍後閱讀（`recent_articles.js` 每次比對原文）、
     新推文標記（`new_comments.saveSeen`）、搜尋紀錄、上傳紀錄、首頁「最近看板」（`home_dashboard._noteRecent`）、
     長推文草稿（別的分頁清掉時不寫回）、設定（見下）、看板分頁（L 11/17 決定同一台的視窗共用一組，
     `board_tabs.js#_reload`，見 `docs/board-tabs.md`「多個視窗」）。
   - 拿記憶體那份寫回：沒有了。
   - 「現在在哪」這類每一幀都會碰到的紀錄（最近看板、看板分頁）只在**到了**的時候記一次，停著不再記，
     別的分頁寫的也只拿來重畫：否則兩個以上分頁停在不同地方時，會輪流把自己推到最前面、每一幀都寫。
   設定頁關閉時只寫回在設定頁裡改過的格子（`pref_merge.js#mergeEditedPrefs`，跟打開時的快照比），
   開著的期間別的分頁／雲端同步／右鍵加黑名單寫進去的設定不會被蓋掉；其餘寫設定的路徑都是「當下讀→改一格→寫」。
4. **設定備份涵蓋全部**：已完成（P98，L 11/17 同意）。設定 → 設定備份分三區：設定（`pref_backup.js`）、離線文章
   （`saved_articles.js`，IndexedDB）、閱讀紀錄（`history_backup.js`：`USER_DATA` 裡 `backup: true` 的 localStorage 紀錄，
   守護 `tests/unit/history_backup.test.js`）。閱讀紀錄匯入＝**跟這台合併**：有時間欄的同一筆取新的（最近讀過 `at`、
   稍後閱讀照同步規則 `mt`、新推文標記、看板分頁），沒有時間欄的（最近看板、搜尋紀錄、上傳紀錄同網址）這台的優先，
   各自照擁有者的上限截；每筆照擁有者的形狀檢查，網址欄位只收 http(s)。草稿、介面狀態、快取不備份。
   新增一種紀錄要不要進備份：`USER_DATA` 標 `backup: true` 並在 `history_backup.js#HISTORY_BACKUP_IDS` 補 clean／merge。
