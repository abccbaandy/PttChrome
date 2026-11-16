// @ts-check
// 設定頁關閉時的存檔合併（docs/user-data.md「設定」）。
//
// 設定頁開著的期間，別的分頁、雲端同步（別台裝置）、右鍵加黑名單都可能已經把新的設定寫進
// localStorage。關閉時若把「打開那一刻的整份表單」原封寫回，那些改動就被蓋掉，還會上傳到
// 雲端、把別台裝置也改回去（開了又關、一格都沒動也一樣）。
// ⇒ 只寫回使用者在設定頁裡真的改過的那幾格（跟打開時的快照比），其餘以儲存裡現在的值為準；
//   兩邊改到同一格時，使用者在設定頁按下去的為準。
//
// 守護 tests/unit/pref_merge.test.js。

/** @param {unknown} a @param {unknown} b */
function sameValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 表單跟打開時的快照比，改過的鍵。
 * @param {Record<string, unknown>} snapshot 設定頁打開時儲存裡的值
 * @param {Record<string, unknown>} edited 關閉時的表單
 * @returns {string[]}
 */
export function editedPrefKeys(snapshot, edited) {
  return Object.keys(edited).filter((k) => !sameValue(snapshot[k], edited[k]));
}

/**
 * @param {Record<string, unknown>} fresh 關閉這一刻儲存裡的值
 * @param {Record<string, unknown>} snapshot 設定頁打開時儲存裡的值
 * @param {Record<string, unknown>} edited 關閉時的表單
 * @returns {Record<string, unknown>}
 */
export function mergeEditedPrefs(fresh, snapshot, edited) {
  const out = { ...fresh };
  for (const k of editedPrefKeys(snapshot, edited)) out[k] = edited[k];
  return out;
}
