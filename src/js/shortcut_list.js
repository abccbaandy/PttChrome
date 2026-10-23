// 設定頁「快捷鍵」分頁（P35）：列出**本站自己加的**按鍵（不是 PTT 的 h 說明）。
// 可自訂的鍵直接讀目前的設定值；功能開關關掉的不列（按了沒作用，列出來只會誤導）。
// 純函式，tests/unit/shortcut_list.test.js 守：新增可自訂快捷鍵時要在這裡補一列，
// 守護會掃 pref_storage 的 *Key 預設值，漏了就紅。
//
// p：設定值（readValuesWithDefault 同形）；mac：是否 macOS（⌘R、Option）。
// 回傳 [{ keys: 顯示用字串陣列, labelKey: i18n key, pref?: 對應的設定 key }]。
export const CUSTOM_KEY_PREFS = [
  'easyReadingEndSwitchKey',
  'aidNavBackKey',
  'deepLinkCopyKey',
  'unreadJumpKey',
  'commandPaletteKey',
];

export function shortcutList(p, mac) {
  const v = p || {};
  const out = [];
  const add = (keys, labelKey, pref) => {
    const ks = keys.filter(Boolean);
    if (ks.length) out.push({ keys: ks, labelKey, pref });
  };
  if (v.enableCommandPalette) add([v.commandPaletteKey], 'shortcut_commandPalette', 'commandPaletteKey');
  if (v.refreshKeyIntercept) add(['F5', mac ? '⌘R' : null], 'shortcut_refresh');
  add([v.unreadJumpKey], 'shortcut_unreadJump', 'unreadJumpKey');
  add([v.deepLinkCopyKey], 'shortcut_deepLinkCopy', 'deepLinkCopyKey');
  add([v.aidNavBackKey], 'shortcut_aidNavBack', 'aidNavBackKey');
  add(['End'], 'shortcut_easyReadingEnd');
  if (v.easyReadingEndSwitchNative)
    add([v.easyReadingEndSwitchKey], 'shortcut_easyReadingEndSwitch', 'easyReadingEndSwitchKey');
  if (v.easyReadingBrowserFind) add([mac ? '⌘F' : 'Ctrl+F'], 'shortcut_browserFind');
  if (Number(v.mouseBackNav) === 1) add([mac ? '⌘[' : 'Alt+←'], 'shortcut_backNav');
  add([mac ? 'Option+…' : 'Alt+…'], 'shortcut_altAsCtrl');
  return out;
}

export function isMacPlatform(nav) {
  const n = nav || (typeof navigator !== 'undefined' ? navigator : null);
  if (!n) return false;
  const plat = (n.userAgentData && n.userAgentData.platform) || n.platform || '';
  return /mac/i.test(plat);
}
