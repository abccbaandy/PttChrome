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
  要拿原文字串當快取鍵的（每一幀都問、原文沒變就沿用解析結果）用 `readRaw`，目前只有新推文標記的列表徽章。
  已搬：全部旗標、上傳紀錄、搜尋紀錄、新功能看過清單、看板分頁、首頁兩份（我的最愛快取、最近去過的板）、斷線回原處快照、新推文標記。守護 `tests/unit/user_data.test.js`
  （含「已搬的擁有者不再自己 getItem／setItem」）。其餘紀錄、快取類見「還沒做」。
- 要不要上雲、要不要進設定備份，**每一種都另外提案**（Firestore 額度與隱私），不跟著重構順手打開。

## 現況總表

性質：設定／紀錄（使用者累積、掉了會心疼）／快取（可以重抓）／草稿／介面（收合、位置這類小狀態）。

| 鍵名 | 擁有者 | 性質 | 上雲 | 設定備份 | 上限 |
|---|---|---|---|---|---|
| `pttchrome.pref.v1` | `pref_storage.js` | 設定 | 設定同步（帳密等本機專用欄位除外） | 有 | 固定欄位 |
| `pttchrome.prefsync.enabled` | `pref_sync.js` | 介面 | 否 | 否 | 一個旗標 |
| `pttchrome.recentArticles.v1` | `recent_articles.js` | 紀錄 | 否 | 否 | `RECENT_ARTICLES_LIMIT` 篇 |
| `pttchrome.readLater.v2` | `recent_articles.js` | 紀錄 | 稍後閱讀同步（`read_later_sync.js`） | 否 | `READ_LATER_LIMIT` 篇 |
| `pttchrome.newComments.v1` | `new_comments.js` | 紀錄 | 否 | 否 | `NEW_COMMENTS_LIMIT` 篇 |
| `pttchrome.boardTabs.v1` | `board_tabs.js` | 紀錄 | 否 | 否 | `BOARD_TABS_MAX` 個 |
| `pttchrome.homeFavorites.v1` | `home_dashboard.js` | 快取 | 否 | 否 | `FAV_MAX_PAGES` 頁 |
| `pttchrome.homeRecentBoards.v1` | `home_dashboard.js` | 紀錄 | 否 | 否 | `RECENT_LIMIT` 個看板 |
| `pttchrome.searchHistory.v1` | `search_history.js` | 紀錄 | 否 | 否 | 每種 `MAX_SEARCH_HISTORY` 筆 |
| `pttchrome.upload.v1` | `upload_history.js` | 紀錄 | 否 | 否 | `MAX_HISTORY` 筆 |
| `pttchrome.longPush.draft.v1` | `long_push_draft.js` | 草稿 | 否 | 否 | 一份 |
| `pttchrome.whatsNew.seen.v1` | `whats_new.js` | 介面 | 否 | 否 | 功能名稱清單 |
| `pttchrome.rendererResume.v1` | `reconnect_resume.js` | 快取 | 否 | 否 | 一份，開機讀完就刪 |
| `pttchrome.followOnly` | `follow_only.js` | 介面 | 否 | 否 | 一個旗標 |
| `pttchrome.menuBannerExpanded` | `menu_banner.js` | 介面 | 否 | 否 | 一個旗標 |
| `pttchrome.articleTools.collapsed.v1` | `article_tools.js` | 介面 | 否 | 否 | 一個旗標 |
| `pttchrome.splitReader.collapsed.v1` | `split_reader.js` | 介面 | 否 | 否 | 一個旗標 |
| `pttchrome.floatToolsPos` | `mobile_layout.js` | 介面 | 否 | 否 | 一組座標 |
| `pttchrome-saved-articles`（IndexedDB） | `saved_articles_store.js` | 紀錄 | 否 | 否 | `SAVED_ARTICLES_LIMIT` 篇 |

不算使用者資料、不在總表的：開站快取的 Service Worker cache（`open_cache.js` 的 `OPEN_CACHE_PREFIX`，
可以整個丟掉重抓）、deep link 的 BroadcastChannel 名（`deep_link_channel.js`，不落地）、
Mantine 自己的色彩模式鍵、Firebase SDK 自己的登入狀態（IndexedDB）。

## 還沒做（A10 後續步驟，一次一步、舊資料不能掉）

1. **共用讀寫搬完**：還沒搬的是最近讀過／稍後閱讀、長推文草稿、
   浮動鈕位置、設定本身。這幾個有注入 storage、跨分頁重讀或遷移邏輯，一個一個搬、各自跑它的測試。
   浮動鈕位置的讀寫函式吃鍵名參數（render/merge_buttons.js 在用），搬的時候要一起改。
2. **容量滿的處理**：現在寫入失敗多半靜默忽略。寫入失敗要能分出 QuotaExceeded，先清快取類再重試，
   仍失敗才放棄並記進 debug 錄製。
3. **跨分頁同步**：目前沒有任何模組聽 `storage` 事件；只有長推文草稿在寫入前重讀一次（別的分頁清掉時
   不寫回）。紀錄類（最近讀過、看板分頁、新推文標記）在兩個分頁同時開著時後寫的蓋掉先寫的。
4. **設定備份涵蓋全部**：備份現在只有設定。紀錄類要不要一起匯出，先問 L。
