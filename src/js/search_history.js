// 搜尋彈窗的關鍵字記憶（本機）。取代 PTT 原生的輸入記憶 —— 那份會被列表好讀的
// 跳號污染（article_search.js 檔頭）。
//
// 刻意**不放進 pttchrome.pref.v1**（同 upload_history.js）：它是使用歷史不是偏好，
// 混進去會被雲端同步與設定匯出帶走；使用者也明確要求只存本機。
// 守護 tests/unit/search_history.test.js。

const HISTORY_KEY = 'pttchrome.searchHistory.v1';
export const MAX_SEARCH_HISTORY = 20;
const KINDS = ['title', 'author', 'push', 'board'];

function emptyHistory() {
  return { title: [], author: [], push: [], board: [] };
}

// 最新的在最前面（index 0 ＝ ↑ 第一下叫回的那筆，比照 PTT）；重複的往前提。
export function addSearchEntry(history, kind, text) {
  const base = history && typeof history === 'object' ? history : emptyHistory();
  const next = {};
  KINDS.forEach((k) => {
    next[k] = Array.isArray(base[k]) ? base[k].slice() : [];
  });
  const t = String(text == null ? '' : text).trim();
  if (KINDS.indexOf(kind) < 0 || !t) return next;
  next[kind] = [t, ...next[kind].filter((it) => it !== t)].slice(0, MAX_SEARCH_HISTORY);
  return next;
}

// 讀壞掉的 JSON／localStorage 被關掉都只回空記憶：附屬功能不可以炸掉呼叫端。
export function readSearchHistory() {
  const out = emptyHistory();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HISTORY_KEY));
    if (!parsed || typeof parsed !== 'object') return out;
    KINDS.forEach((k) => {
      if (Array.isArray(parsed[k]))
        out[k] = parsed[k].filter((it) => typeof it === 'string' && it).slice(0, MAX_SEARCH_HISTORY);
    });
  } catch (e) {}
  return out;
}

export function writeSearchHistory(history) {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (e) {}
  return history;
}

export function rememberSearch(kind, text) {
  return writeSearchHistory(addSearchEntry(readSearchHistory(), kind, text));
}

// 刪一筆（彈窗裡每筆旁邊的 ×）。
export function removeSearchEntry(history, kind, text) {
  const next = addSearchEntry(history, null, null); // 複製一份、補齊四類
  if (KINDS.indexOf(kind) < 0) return next;
  next[kind] = next[kind].filter((it) => it !== text);
  return next;
}

// 清掉一類（彈窗的「全部清除」只清目前顯示的那一類，其他種類的紀錄不受影響）。
export function clearSearchKind(history, kind) {
  const next = addSearchEntry(history, null, null);
  if (KINDS.indexOf(kind) >= 0) next[kind] = [];
  return next;
}

export function forgetSearch(kind, text) {
  return writeSearchHistory(removeSearchEntry(readSearchHistory(), kind, text));
}

export function forgetSearchKind(kind) {
  return writeSearchHistory(clearSearchKind(readSearchHistory(), kind));
}

export const SEARCH_HISTORY_KEY = HISTORY_KEY;
