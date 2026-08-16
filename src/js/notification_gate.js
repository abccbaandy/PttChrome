// 通知的兩道閘門：什麼時候該「問權限」、什麼時候該「閉嘴」。
//
// 抽成獨立模組是因為兩邊的呼叫端完全不同層（PrefModal 是 React、term_view 是
// 舊式 prototype 物件），而這兩件事都是純判斷、都必須**絕不 throw**：
// `Notification` 在非 secure context 連建構子都不存在，而 term_view 這條路的頂端
// 是 App.onData（收包路徑），炸出去會把整條連線打斷。

// 需要通知權限、而且還沒問過時，才送出請求。
//
// `enabled`：呼叫端的通知 pref 是否為開（任一個為開就該有權限）。
// `onResult(permission)`：回報最終權限，可省略。
// 回傳「是否真的送出了請求」。
//
// 已經是 granted／denied 的都不再送：前者沒必要，後者送了也叫不出彈窗（瀏覽器
// 直接回 denied），只會白白吃掉一次 user activation。
export function ensureNotifyPermission(enabled, onResult) {
  var report = function(r) {
    if (onResult) onResult(r);
  };
  try {
    if (!enabled || typeof Notification === 'undefined') return false;
    if (Notification.permission === 'granted' ||
        Notification.permission === 'denied') {
      report(Notification.permission);
      return false;
    }
    var p = Notification.requestPermission();
    // 舊介面是 callback-only（回 undefined），新介面回 Promise。
    if (p && p.then) p.then(report, function() { report('denied'); });
    return true;
  } catch (e) {
    // 非 secure context、企業政策封鎖之類：當作沒有系統通知這一層。
    report('denied');
    return false;
  }
}

// 這個分頁此刻就在使用者眼前嗎？
//
// 「可見」與「有焦點」兩個條件都要：分頁看得見但焦點在另一個視窗（雙視窗並排、
// 連結開在別的視窗）時，使用者的眼睛不在這裡，仍然該出聲。寧可多通知一則，也
// 不要漏掉真的該通知的情況——所以任何判斷不出來的情況（沒有 document、瀏覽器
// 沒有 hasFocus）一律回 false，退回「照發通知」的原行為。
export function isDocumentForeground(doc) {
  try {
    if (!doc || typeof doc.hasFocus !== 'function') return false;
    return doc.visibilityState === 'visible' && doc.hasFocus() === true;
  } catch (e) {
    return false;
  }
}
