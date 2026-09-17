// 長推文的草稿暫存：打到一半關掉輸入框（或整個分頁）也不會白打。
//
// 刻意**不放進 pttchrome.pref.v1**（同 upload_history.js 的理由，而且這裡更嚴重）：
//   - 草稿是使用者打的**推文內容**，不是偏好。混進 pref 會被雲端同步與設定匯出
//     一起帶走（pref_sync_logic.js 的 sanitizeForCloud／pref_backup.js 都是整包
//     pttchrome.pref.v1），等於把還沒決定要不要發的話上傳到 Firestore。
//   - 自帶一顆 key ⇒ 那兩條路天然讀不到它，不必維護排除清單。
//
// **單一份、不綁文章**（2026-09-17 使用者定案）：在 A 文章打的草稿，下次在 B 文章
// 按 X 也會看到 ⇒ 輸入框要顯示「這是上次留下來的」並給一顆清除鍵，不可以默默塞進去。
//
// 生命週期：輸入框開啟時讀回、內容變動時寫入、**只有整段成功送完才清**
// （LongPushSession._finish({kind:'done'}) → onSent）。送出失敗／取消都保留，
// 使用者才有機會把沒送出去的那段救回來。
//
// 守護 tests/unit/long_push_draft.test.js。

const DRAFT_KEY = 'pttchrome.longPush.draft.v1';

// 上一次真的寫進去的值。每打一個字就 setItem 一次是可接受的（同步、幾百 bytes），
// 但完全相同的值重複寫沒有意義 ⇒ 擋掉。
// 刻意**不用 debounce**：那會生出「關分頁那一刻還有一筆沒 flush」的新 race，
// 而這個功能存在的理由正是「關掉也不能丟」。
let lastWritten = null;

// 讀不到／被關掉／存到壞東西一律回空字串：這是附屬功能，絕不可以炸掉輸入框。
// （隱私視窗、封鎖 site data、iframe 的 SecurityError 都會讓存取 throw。）
export function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return typeof raw === 'string' ? raw : '';
  } catch (e) {
    return '';
  }
}

export function writeDraft(text) {
  const next = typeof text === 'string' ? text : '';
  if (next === lastWritten) return;
  lastWritten = next;
  try {
    if (next) localStorage.setItem(DRAFT_KEY, next);
    else localStorage.removeItem(DRAFT_KEY);
  } catch (e) {
    /* 寫不進去就算了，輸入框照樣能用 */
  }
}

export function clearDraft() {
  writeDraft('');
}

// 只給測試用：模組層的 lastWritten 是 page-lifetime 快取，跨 case 會互相污染。
export function resetDraftCacheForTests() {
  lastWritten = null;
}
