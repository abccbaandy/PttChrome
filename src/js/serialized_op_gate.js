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
  return null;
}

// Anti-idle 的守門：線路上有程式化序列在跑時**不准**送 anti-idle。
//
// ANTI_IDLE_STR 是 '\x1b\x1b'（pttchrome.js），從 VK_NORMAL 送出時 server 端的
// vtkbd 會把第二個 ESC 吃成 esc_arg ⇒ **實際產生一個 KEY_ESC**（vtkbd.c:145-160，
// KEY_ESC=27）。多數畫面拿它沒轍（no-op），但推文型別選單那一格是
// `type = vkey(); if (!isascii(type) || !isdigit(type)) type = RECTYPE_DEFAULT;`
// （bbs.c:3001-3010）⇒ 那個 KEY_ESC 會被當成「沒選」＝**推**，而畫面照樣推進到
// 內容輸入列，整則就用錯的型別送出去，使用者完全看不出來。
//
// 而且這不是理論風險：長推文送出期間使用者盯著遮罩不動，idleTime 一路累積，
// 正好是最容易觸發 anti-idle 的時候。
//
// 守門在這裡而不是靠 vtkbd 的 ESC 化解：那個 KEY_ESC 不是狀態殘留，是 payload
// 本身就會產生的按鍵事件，守門攔不掉。
//
// 不歸零 idleTime：序列跑完的下一個 tick 就會補送，反而更貼近 anti-idle 的語意。
export function shouldSkipAntiIdle(facts) {
  const f = facts || {};
  return !!(f.inFlightKind || f.longPushBusy || f.aidNavActive);
}
