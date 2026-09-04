// 「這一次 history 導航是本站自己造成的」的共用旗標。
//
// 為什麼需要它：`history_back_guard` 接住返回之後會用 `history.forward()` 走回
// 自己的 sentinel（traversal 不建立 entry，才不會被 Chrome 的 History
// Manipulation Intervention 標成可跳過，見 history_back_guard.js 坑 3）。而
// 「網址列跟著現在在讀哪一篇走」（deep_link_controller._syncAddressBar）用
// replaceState 改的正是**我們站著的那一層**＝sentinel ⇒ sentinel 這一格帶著
// `#Board/AID`。兩件事湊在一起，traversal 會讓 fragment 變動 ⇒ 派發
// **hashchange** ⇒ deep_link_entry 把它當成「使用者又貼了一條連結」⇒ 畫面被拉
// 回剛剛那篇文章（2026-09-05 實機回報：按側鍵／Alt+← 都會被導回文章裡）。
//
// `deep_link_entry` 的 consume 合約是「**使用者**給了一條連結」。我們自己走回
// 去產生的 hashchange 是回音，不是使用者意圖 ⇒ 這段期間不消費。
//
// 為什麼是「時間窗」而不是 begin/end 配對：same-document traversal 會派發
// popstate **與** hashchange 兩個事件，規範沒保證我們讀得到的順序，在其中一個
// handler 裡關掉旗標就可能剛好漏掉另一個。時間窗與順序無關。窗口長度＝
// history_back_guard 的 RESTORE_CHECK_MS（120ms）：traversal 的事件是同一批
// task，遠在窗內；而使用者要貼一條新連結至少得先點到網址列，不可能落在窗內。
let depth = 0;

// 進入自造導航。回傳「結束」函式——呼叫端負責在時間窗到期時呼叫它。
// 用計數而不是布林：窗口可能重疊（連續快速返回），先到期的那個不可以把後來
// 那個的旗標一起關掉。
export function beginSelfNavigation() {
  depth += 1;
  let done = false;
  return function endSelfNavigation() {
    if (done) return;
    done = true;
    depth = Math.max(0, depth - 1);
  };
}

export function isSelfNavigating() {
  return depth > 0;
}

// 測試用：把狀態歸零（模組層級狀態是 page-lifetime 的，跨 test 會殘留）。
export function resetSelfNavigation() {
  depth = 0;
}
