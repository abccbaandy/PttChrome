// 「現在可以替使用者送一個方向鍵嗎？」——觸控板水平手勢（swipe_gesture.js）與
// 瀏覽器「上一頁」攔截（history_back_guard.js）共用的守門。
//
// 純函式吃 App-ish 物件（同 serialized_op_gate.js 的慣例）：兩條入口一個在 App
// 上、一個在 window listener 裡，共用同一份判斷才不會分岔，unit 也不必造 App。
//
// **刻意不含 serializedOpHint**：那道守門在 term_view.onKeyDown 開頭就有，而且會
// 自己 flashListHint；在這裡再擋一次只會讓提示閃兩次、或讓呼叫端誤以為「沒送出
// 去而且沒人告訴使用者」。
//
// pageState 的可送範圍與 mouse_regions.resolveMouseRegion 的動作集合一致：
//   0 NORMAL（未登入／雜訊畫面）／5 PASS／6 編輯器 → 不送
//   1 MENU / 2 LIST / 3 READING / 4 LIST 變體      → 送
//
// **pageState 會黏**：term_buf.setPageState 刻意沒有 reset 分支（判不出的畫面沿用前一
// 幀，見 docs/pttbbs-screen-protocol.md「列表上叫出的 prompt 不改變 pageState」）。
// pressanykey(5) 之後落在判不出的畫面 ⇒ 黏在 5 ⇒ 返回手勢被擋、閃離站提示，直到進
// 一篇文章（每幀判得出 3）才恢復。所以 5 要再問 buf.isPassScreenNow()：本幀已不是
// pass 畫面 ⇒ 5 是殘留，不擋。真的 pass 畫面照舊擋（逃生門語意不變）。
//
// 回傳擋下的原因（null＝可送）；history_back_guard 擋下時寫進 debugRecorder，
// 下一次「有時失效」的錄製檔可以直接看出是哪一道。
export function navKeyBlockReason(core) {
  if (!core) return 'noCore';
  if (core.modalShown) return 'modal';
  if (!core.conn || !core.conn.isConnected) return 'disconnected';
  const buf = core.buf;
  if (!buf) return 'noBuf';
  const st = buf.pageState;
  const staleFive = st === 5 &&
    typeof buf.isPassScreenNow === 'function' && !buf.isPassScreenNow();
  if (!(st === 1 || st === 2 || st === 3 || st === 4 || staleFive))
    return 'pageState:' + st;
  // PTT 正開著輸入框（vgetstring 的反白輸入欄）：左方向鍵只會被輸入框吃掉，
  // 使用者的手勢等於石沉大海。同一個事實也關掉滑鼠的可點區（見 docs/mouse.md）。
  if (buf.isCursorOnInputField && buf.isCursorOnInputField()) return 'inputField';
  return null;
}

export function navKeyAllowed(core) {
  return navKeyBlockReason(core) === null;
}
