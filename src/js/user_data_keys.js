// @ts-check
// 使用者資料的鍵名總表（架構 review A10 第一步，docs/user-data.md）。
//
// 設定以外的使用者資料各自存 localStorage，以前每個功能自己在檔頭寫一個字串常數：
// 要回答「這台機器上存了哪些東西、哪些會上雲、備份涵蓋哪些、哪些有上限」只能 grep。
// 這裡是**唯一**寫出 `pttchrome.` 鍵名字串的地方（lint 規則 pttchrome/no-storage-key-literal
// 擋其他檔案），各功能從這裡拿鍵名；讀寫、格式、上限仍由各功能自己管（下一步才收進共用儲存模組）。
//
// 新增一種要存的資料：在 STORAGE_KEYS 加一個鍵、在 USER_DATA 補一列、在 docs/user-data.md
// 的表補一行（守護 tests/unit/user_data_keys.test.js 三邊對得起來）。鍵名一旦上線就不能改字：
// 改了等於把使用者舊資料丟掉，格式要變就升版號（`.v2`）並在擁有者模組寫遷移。

/** localStorage 鍵名。值是上線過的字串，不可改字。 */
export const STORAGE_KEYS = Object.freeze({
  prefs: 'pttchrome.pref.v1',
  prefSyncEnabled: 'pttchrome.prefsync.enabled',
  recentArticles: 'pttchrome.recentArticles.v1',
  readLater: 'pttchrome.readLater.v2',
  newComments: 'pttchrome.newComments.v1',
  boardTabs: 'pttchrome.boardTabs.v1',
  homeFavorites: 'pttchrome.homeFavorites.v1',
  homeRecentBoards: 'pttchrome.homeRecentBoards.v1',
  searchHistory: 'pttchrome.searchHistory.v1',
  uploadHistory: 'pttchrome.upload.v1',
  longPushDraft: 'pttchrome.longPush.draft.v1',
  whatsNewSeen: 'pttchrome.whatsNew.seen.v1',
  rendererResume: 'pttchrome.rendererResume.v1',
  followOnly: 'pttchrome.followOnly',
  menuBannerExpanded: 'pttchrome.menuBannerExpanded',
  articleToolsCollapsed: 'pttchrome.articleTools.collapsed.v1',
  splitReaderCollapsed: 'pttchrome.splitReader.collapsed.v1',
  floatToolsPos: 'pttchrome.floatToolsPos',
});

/** IndexedDB 資料庫名（存到本機的整篇文章，容量比 localStorage 大）。 */
export const INDEXED_DB_NAMES = Object.freeze({
  savedArticles: 'pttchrome-saved-articles',
});

/**
 * @typedef {'prefs' | 'history' | 'cache' | 'draft' | 'ui'} UserDataKind
 *   prefs＝設定；history＝使用者累積的紀錄（掉了會心疼）；cache＝可以重抓的快取；
 *   draft＝打到一半的字；ui＝版面收合／位置這類小狀態。
 * @typedef {'prefSync' | 'readLaterSync' | 'none'} UserDataCloud
 * @typedef {{
 *   id: string,
 *   store: 'localStorage' | 'indexedDB',
 *   owner: string,
 *   kind: UserDataKind,
 *   cloud: UserDataCloud,
 *   backup: boolean,
 *   limit: string,
 * }} UserDataEntry
 */

/**
 * 每種資料一列：誰擁有（讀寫都在那個檔）、性質、會不會上雲、設定備份有沒有涵蓋、上限。
 * 這是現況的盤點：backup＝設定 → 設定備份有涵蓋（設定 pref_backup.js、閱讀紀錄 history_backup.js、
 * 離線文章 saved_articles.js）。
 * @type {ReadonlyArray<UserDataEntry>}
 */
export const USER_DATA = Object.freeze([
  { id: 'prefs', store: 'localStorage', owner: 'src/js/pref_storage.js', kind: 'prefs', cloud: 'prefSync', backup: true, limit: '固定欄位' },
  { id: 'prefSyncEnabled', store: 'localStorage', owner: 'src/js/pref_sync.js', kind: 'ui', cloud: 'none', backup: false, limit: '一個旗標' },
  { id: 'recentArticles', store: 'localStorage', owner: 'src/js/recent_articles.js', kind: 'history', cloud: 'none', backup: true, limit: 'RECENT_ARTICLES_LIMIT 篇' },
  { id: 'readLater', store: 'localStorage', owner: 'src/js/recent_articles.js', kind: 'history', cloud: 'readLaterSync', backup: true, limit: 'READ_LATER_LIMIT 篇' },
  { id: 'newComments', store: 'localStorage', owner: 'src/js/new_comments.js', kind: 'history', cloud: 'none', backup: true, limit: 'NEW_COMMENTS_LIMIT 篇' },
  { id: 'boardTabs', store: 'localStorage', owner: 'src/js/board_tabs.js', kind: 'history', cloud: 'none', backup: true, limit: 'BOARD_TABS_MAX 個' },
  { id: 'homeFavorites', store: 'localStorage', owner: 'src/js/home_dashboard.js', kind: 'cache', cloud: 'none', backup: false, limit: 'FAV_MAX_PAGES 頁' },
  { id: 'homeRecentBoards', store: 'localStorage', owner: 'src/js/home_dashboard.js', kind: 'history', cloud: 'none', backup: true, limit: 'RECENT_LIMIT 個看板' },
  { id: 'searchHistory', store: 'localStorage', owner: 'src/js/search_history.js', kind: 'history', cloud: 'none', backup: true, limit: '每種 MAX_SEARCH_HISTORY 筆' },
  { id: 'uploadHistory', store: 'localStorage', owner: 'src/js/upload_history.js', kind: 'history', cloud: 'none', backup: true, limit: 'MAX_HISTORY 筆' },
  { id: 'longPushDraft', store: 'localStorage', owner: 'src/js/long_push_draft.js', kind: 'draft', cloud: 'none', backup: false, limit: '一份' },
  { id: 'whatsNewSeen', store: 'localStorage', owner: 'src/js/whats_new.js', kind: 'ui', cloud: 'none', backup: false, limit: '功能名稱清單' },
  { id: 'rendererResume', store: 'localStorage', owner: 'src/js/reconnect_resume.js', kind: 'cache', cloud: 'none', backup: false, limit: '一份、開機讀完就刪' },
  { id: 'followOnly', store: 'localStorage', owner: 'src/js/follow_only.js', kind: 'ui', cloud: 'none', backup: false, limit: '一個旗標' },
  { id: 'menuBannerExpanded', store: 'localStorage', owner: 'src/js/menu_banner.js', kind: 'ui', cloud: 'none', backup: false, limit: '一個旗標' },
  { id: 'articleToolsCollapsed', store: 'localStorage', owner: 'src/js/article_tools.js', kind: 'ui', cloud: 'none', backup: false, limit: '一個旗標' },
  { id: 'splitReaderCollapsed', store: 'localStorage', owner: 'src/js/split_reader.js', kind: 'ui', cloud: 'none', backup: false, limit: '一個旗標' },
  { id: 'floatToolsPos', store: 'localStorage', owner: 'src/js/mobile_layout.js', kind: 'ui', cloud: 'none', backup: false, limit: '一組座標' },
  { id: 'savedArticles', store: 'indexedDB', owner: 'src/js/saved_articles_store.js', kind: 'history', cloud: 'none', backup: true, limit: 'SAVED_ARTICLES_LIMIT 篇' },
]);
