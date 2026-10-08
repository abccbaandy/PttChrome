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
  // 提示字隨階段不同（探路／送出），由 session 自己給——active 為真時一定有值。
  if (core.longPush && core.longPush.active)
    return core.longPush.opHint || '長推文送出中，請稍候…';
  if (core.logout && core.logout.active)
    return core.logout.opHint || '登出中，請稍候…';
  // 跳過進板畫面：代按的那一鍵在線上。使用者此時自己按鍵會先收掉畫面，我們的鍵
  // 就落進文章列表（← 會直接離板）。只擋 in-flight 這一個來回，arm 等待期不擋。
  if (core.boardNoteSkip && core.boardNoteSkip.busy) return '略過進板畫面中，請稍候…';
  // 搜尋彈窗送出的兩步（搜尋鍵 → 等 prompt → 關鍵字），見 article_search.js。
  if (core.searchInFlight) return '搜尋中，請稍候…';
  return null;
}

