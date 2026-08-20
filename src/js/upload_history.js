// 上傳紀錄（本機）：已上傳到 urusai 的圖留一份清單，之後可以從浮動面板挑一張再
// 插入推文／內文，不必重傳。
//
// 刻意**不放進 pttchrome.pref.v1**：
//   - 它是使用歷史不是偏好，混進去會被雲端同步與設定匯出帶走（見 pref_sync_logic.js
//     的 sanitizeForCloud / pref_backup.js），等於把「我傳過哪些圖」上傳到別的地方。
//   - 也不必跟 pref 一起做 schema 遷移。
// 純函式部分守護在 tests/unit/upload_history.test.js。

const HISTORY_KEY = 'pttchrome.upload.v1';
export const MAX_HISTORY = 50;

// entry: { url, deleteUrl, previewUrl, filename, mime, at }
// 只存 urusai 回來的欄位與時間戳，**不存圖片內容**（縮圖直接拿 url 當 <img src>）。
export function addHistoryEntry(list, entry) {
  if (!entry || !entry.url) return Array.isArray(list) ? list.slice() : [];
  const rest = (Array.isArray(list) ? list : []).filter(it => it && it.url !== entry.url);
  return [entry, ...rest].slice(0, MAX_HISTORY);
}

export function removeHistoryEntry(list, url) {
  return (Array.isArray(list) ? list : []).filter(it => it && it.url !== url);
}

// 讀壞掉的 JSON／localStorage 被關掉都只回空陣列：這是附屬功能，不可以炸掉呼叫端。
export function readHistory() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HISTORY_KEY));
    return Array.isArray(parsed) ? parsed.filter(it => it && it.url) : [];
  } catch (e) {
    return [];
  }
}

export function writeHistory(list) {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify((list || []).slice(0, MAX_HISTORY)));
  } catch (e) {}
  return list;
}

export function clearHistory() {
  try {
    window.localStorage.removeItem(HISTORY_KEY);
  } catch (e) {}
  return [];
}
