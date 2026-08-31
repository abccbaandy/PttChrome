// 「線路上正在跑一段序列化操作嗎？」——送 bytes 給 PTT 的四條使用者入口共用的述詞。
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
export function serializedOpHint(core) {
  if (!core) return null;
  if (core.aidNavigation && core.aidNavigation.active)
    return 'AID 跳文中，請稍候…';
  if (core.longPush && core.longPush.active)
    return '長推文送出中，請稍候…';
  return null;
}
