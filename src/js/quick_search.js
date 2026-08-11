// 快速搜尋（右鍵選單）的純邏輯：內建項目定義、清單合併、適用條件判斷、網址組裝、
// 自訂項目驗證。無 DOM／無網路，全部在 tests/unit/quick_search.test.js 守護。
//
// 內建項目**不進 pref**（見 pref_storage.js#quickSearchDisabled 的註解）：pref 只存
// 「被停用的內建 id」，這樣日後在這裡新增一筆內建項目，既有使用者也拿得到。

import { i18n } from './i18n';

// 適用條件：選取內容要長什麼樣，這個項目才會出現在右鍵選單。
// - "any"    任意非空文字
// - "digits" 純數字（pixiv 的 users/artworks id 是數字，選到中文時給這兩項毫無意義）
export const MATCH_ANY = 'any';
export const MATCH_DIGITS = 'digits';

export const BUILTIN_QUICK_SEARCH = Object.freeze([
  Object.freeze({
    id: 'google',
    nameKey: 'quicksearch_builtin_google',
    urlTemplate: 'https://www.google.com/search?q=%s',
    match: MATCH_ANY
  }),
  Object.freeze({
    id: 'pixiv-user',
    nameKey: 'quicksearch_builtin_pixivUser',
    urlTemplate: 'https://www.pixiv.net/users/%s',
    match: MATCH_DIGITS
  }),
  Object.freeze({
    id: 'pixiv-artwork',
    nameKey: 'quicksearch_builtin_pixivArtwork',
    urlTemplate: 'https://www.pixiv.net/artworks/%s',
    match: MATCH_DIGITS
  })
]);

// 選取字串 → 查詢字串。換行／連續空白（含畫面每格用的 &nbsp; U+00A0，JS 的 \s 有涵蓋）
// 收成一個空白再 trim：跨行選取時 PTT 畫面會夾帶列尾補白，不收乾淨的話「純數字」判斷
// 會整個失效。截字**不在這裡做**——選單靠 CSS 省略號，讓 window.open 拿到完整字串。
export const normalizeQuickSearchQuery = text =>
  String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim();

export const quickSearchMatches = (query, match) => {
  if (!query) return false;
  if (match === MATCH_DIGITS) return /^\d+$/.test(query);
  return true;
};

// %s → 查詢字串。**每個 %s 都換**且一律 encodeURIComponent：舊版 doSearchGoogle 是
// 字串相接、舊版 quick search 是單次 .replace，選到帶 & # + 空白的字就會組出錯的網址。
export const buildQuickSearchUrl = (urlTemplate, query) =>
  String(urlTemplate).replaceAll('%s', encodeURIComponent(query));

// 回傳 i18n key（錯誤訊息）或 null（通過）。
export const validateQuickSearchEntry = entry => {
  const name = entry && entry.name ? String(entry.name).trim() : '';
  const urlTemplate =
    entry && entry.urlTemplate ? String(entry.urlTemplate).trim() : '';
  if (!name) return 'quicksearch_err_name';
  if (!/^https?:\/\//i.test(urlTemplate) || urlTemplate.indexOf('%s') < 0) {
    return 'quicksearch_err_url';
  }
  return null;
};

// 顯示名稱：內建走 i18n（跟著語系走），自訂用使用者填的字面值。
export const quickSearchLabel = item =>
  item.nameKey ? i18n(item.nameKey) : item.name;

// 內建（含停用狀態）＋ 自訂（驗證沒過的直接跳過，設定頁允許存在半填好的列）。
export const resolveQuickSearchItems = values => {
  const v = values || {};
  const disabled = new Set(
    Array.isArray(v.quickSearchDisabled) ? v.quickSearchDisabled : []
  );
  const builtins = BUILTIN_QUICK_SEARCH.map(b => ({
    id: b.id,
    nameKey: b.nameKey,
    name: '',
    urlTemplate: b.urlTemplate,
    match: b.match,
    enabled: !disabled.has(b.id),
    builtin: true
  }));
  const custom = (Array.isArray(v.quickSearchCustom) ? v.quickSearchCustom : [])
    .filter(c => validateQuickSearchEntry(c) === null)
    .map(c => ({
      id: c.id,
      nameKey: '',
      name: String(c.name).trim(),
      urlTemplate: String(c.urlTemplate).trim(),
      match: c.match === MATCH_DIGITS ? MATCH_DIGITS : MATCH_ANY,
      enabled: c.enabled !== false,
      builtin: false
    }));
  return builtins.concat(custom);
};

export const visibleQuickSearchItems = (values, query) =>
  resolveQuickSearchItems(values).filter(
    item => item.enabled && quickSearchMatches(query, item.match)
  );

// 設定頁允許存在「還沒填完」的列（按下新增就先出現一列空的），關閉時把整列空白的
// 丟掉，不讓半成品寫進 localStorage／雲端。
export const pruneQuickSearchEntries = values => {
  const list = Array.isArray(values.quickSearchCustom)
    ? values.quickSearchCustom
    : [];
  const kept = list.filter(
    c =>
      String(c.name == null ? '' : c.name).trim() ||
      String(c.urlTemplate == null ? '' : c.urlTemplate).trim()
  );
  return kept.length === list.length
    ? values
    : { ...values, quickSearchCustom: kept };
};

// 自訂項目的 id：React key 與刪除定位用，必須跨 session 穩定（會被寫進 pref）。
export const makeQuickSearchId = () =>
  'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
