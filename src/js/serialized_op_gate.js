// 「線路上正在跑一段序列化操作嗎？」——送 bytes 給 PTT 的使用者入口共用的述詞：鍵盤、輸入法、
// 貼上、功能鍵四條，加上滑鼠（左鍵動作、滾輪翻頁、中鍵 ←、回報給 server；App._mouseSendBlocked，
// 守護 tests/unit/mouse_serialized_gate.test.js）。
//
// AID 跳文與長推文都是**程式化按鍵的序列**（前者 s → 板名 → # → AID → Enter，後者
// X → 型別 → 內容 → y）。中間插進任何一個使用者 byte 都會與它競態：pttbbs 的
// typeahead 會把中間那一幀吞掉（docs/pttbbs-screen-protocol.md §2），長推文更會直接
// 打亂「哪個 byte 對應哪個 prompt」的配對（docs/long-push.md）。
//
// 抽成模組而不是 App 方法：四條入口有兩層（term_view 是舊式 prototype 物件、
// pttchrome 是 App），純函式吃 App-ish 物件兩邊都能直接呼叫，unit 也不必造 App
// 實例。同一慣例見 mouse_gates.js / function_key_plan.js / notification_gate.js。
//
// 回 null ＝ 線路可用；回字串 ＝ 提示文字。**呼叫端負責吞掉輸入並把字串交給
// flashListHint**——吞掉使用者的輸入不得無聲（docs/easy-reading-list.md 不變量 12b/12d）。
//
// 刻意不含 commandQueue.inFlightKind：那道在 App.onFunctionKey 裡排在
// functionKeyClickPlan **之後**（_enterFunctionMode / stopEasyReading 要先跑），位置
// 本身有語意，搬進來會改行為。
import { wireLeaseHint } from './wire_lease';

export function serializedOpHint(core) {
  if (!core) return null;
  // 誰佔著線路、提示字是什麼，都由功能自己告訴 wire_lease：自己有 session 的（AID 跳文、
  // 長推文、登出、略過進板畫面）建構時登記 holdWireWhile，名次固定、AID 最前；其餘替使用者送
  // 多步序列的（搜尋、重新整理、跳到第一篇未讀…）跑的時候 acquireWire。這裡不必認識任何
  // 一個功能，新功能也不必回來改這個閘門。
  return wireLeaseHint(core);
}

// PTT 正等著一個 prompt（輸入欄、推文型別選單；term_buf.isPromptPending，本幀事實）。
// 跟上面的序列閘門不同：這是**使用者自己**按出來的 prompt，使用者的鍵照常送；只有替使用者
// 送多步序列的入口（submitSearch／submitSerializedSteps、AID 連結跳文）要在這裡停手——
// 第一個鍵會被打進輸入欄，或被一鍵 prompt／型別選單當成答案。
export const PROMPT_PENDING_HINT = '請先完成或取消目前的輸入，再操作';
export function promptPendingNow(core) {
  const buf = core && core.buf;
  return !!(buf && typeof buf.isPromptPending === 'function' && buf.isPromptPending());
}
