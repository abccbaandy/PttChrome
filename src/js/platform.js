// 「使用者的鍵盤上那顆修飾鍵叫什麼名字」——**只給文案用**的平台判斷。
//
// 硬規則：**鍵盤行為不准分平台**。要接 Ctrl 的快捷鍵一律同時收
// `ctrlKey || metaKey`（既有慣例見 long_push_gate.js#isPushKey 的呼叫端、
// list_session.js 的 `!e.metaKey`），Mac 使用者按 ⌘ 或 Ctrl 都要能動。理由與
// term_keyboard.js:236-242 拒絕平台相依按鍵同源：偵測錯的那一小撮人不是「退化成
// 沒有快捷鍵」，而是**按了沒反應且看不出為什麼**。這個模組存在的唯一目的是讓
// 提示字串寫 ⌘ 而不是 Ctrl，誤判的代價只有「提示寫錯一個字」。
//
// 不讀 `navigator.platform`：已 deprecated（本專案 2026-07 已把 deprecated API 清零）。
// Chromium 走 userAgentData.platform（回 'macOS'），Firefox／Safari 沒有該欄位才退回
// userAgent 字串。目標對象是桌機瀏覽器（vite.config.mjs build.target），iPhone 的 UA
// 含 'like Mac OS X' 會被判成 Mac —— 不在守備範圍，不為它加分支。
//
// nav 參數化純粹是為了可測（tests/unit/platform_label.test.js）。

function currentNavigator() {
  return typeof navigator !== 'undefined' ? navigator : undefined;
}

export function isMacPlatform(nav) {
  const n = nav === undefined ? currentNavigator() : nav;
  if (!n) return false;
  const uaData = n.userAgentData;
  if (uaData && typeof uaData.platform === 'string' && uaData.platform)
    return /mac/i.test(uaData.platform);
  return /Macintosh|Mac OS X/.test(n.userAgent || '');
}

// 送出類快捷鍵的提示字串。Mac 的慣例是 ⌘ 直接黏著鍵名、不寫加號。
export function modEnterShortcutLabel(nav) {
  return isMacPlatform(nav) ? '⌘Enter' : 'Ctrl+Enter';
}
