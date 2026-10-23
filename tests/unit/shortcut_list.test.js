// 設定頁「快捷鍵」分頁的清單（js/shortcut_list.js，P35）。
// 鎖：可自訂的鍵讀目前設定值；功能關掉的不列；新增可自訂快捷鍵（pref_storage 裡值是 F 鍵的
// *Key）時沒補進清單就紅。
import { shortcutList, CUSTOM_KEY_PREFS, isMacPlatform } from "../../src/js/shortcut_list";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { setupI18n, i18n } from "../../src/js/i18n";

const labels = (p, mac) => shortcutList(p, mac).map((s) => s.labelKey);

test("預設設定：每一列都有按鍵與翻譯", () => {
  setupI18n();
  const list = shortcutList(DEFAULT_PREFS, false);
  expect(list.length).toBeGreaterThan(8);
  for (const s of list) {
    expect(s.keys.length).toBeGreaterThan(0);
    expect(i18n(s.labelKey)).not.toBe(s.labelKey);
    expect(i18n(s.labelKey)).toBeTruthy();
  }
});

test("可自訂的鍵讀目前的設定值", () => {
  const list = shortcutList({ ...DEFAULT_PREFS, unreadJumpKey: "F10" }, false);
  expect(list.find((s) => s.pref === "unreadJumpKey").keys).toEqual(["F10"]);
});

test("功能關掉的不列", () => {
  const off = {
    ...DEFAULT_PREFS,
    enableCommandPalette: false,
    refreshKeyIntercept: false,
    easyReadingEndSwitchNative: false,
    easyReadingBrowserFind: false,
    mouseBackNav: 0,
  };
  const l = labels(off, false);
  for (const k of [
    "shortcut_commandPalette",
    "shortcut_refresh",
    "shortcut_easyReadingEndSwitch",
    "shortcut_browserFind",
    "shortcut_backNav",
  ])
    expect(l).not.toContain(k);
});

test("macOS 顯示 ⌘ 版本", () => {
  const keys = (mac) => shortcutList(DEFAULT_PREFS, mac).find((s) => s.labelKey === "shortcut_refresh").keys;
  expect(keys(true)).toEqual(["F5", "⌘R"]);
  expect(keys(false)).toEqual(["F5"]);
  expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
  expect(isMacPlatform({ platform: "Win32" })).toBe(false);
});

test("守護：pref_storage 裡預設值是 F 鍵的 *Key 都在清單裡", () => {
  const fkeys = Object.keys(DEFAULT_PREFS).filter(
    (k) => /Key$/.test(k) && /^F\d+$/.test(String(DEFAULT_PREFS[k])),
  );
  expect(fkeys.sort()).toEqual([...CUSTOM_KEY_PREFS].sort());
  const listed = shortcutList(DEFAULT_PREFS, false).map((s) => s.pref).filter(Boolean);
  expect(listed.sort()).toEqual([...CUSTOM_KEY_PREFS].sort());
});
