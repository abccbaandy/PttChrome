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
export function navKeyAllowed(core) {
  if (!core) return false;
  if (core.modalShown) return false;
  if (!core.conn || !core.conn.isConnected) return false;
  const buf = core.buf;
  if (!buf) return false;
  const st = buf.pageState;
  if (!(st === 1 || st === 2 || st === 3 || st === 4)) return false;
  // PTT 正開著輸入框（vgetstring 的反白輸入欄）：左方向鍵只會被輸入框吃掉，
  // 使用者的手勢等於石沉大海。同一個事實也關掉滑鼠的可點區（見 docs/mouse.md）。
  if (buf.isCursorOnInputField && buf.isCursorOnInputField()) return false;
  return true;
}
