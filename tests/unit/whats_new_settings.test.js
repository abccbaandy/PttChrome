// 新功能介紹每條的「⚙ 設定」對應表（src/js/whats_new_settings.js，P71）。
//
// 鎖的症狀：README 加了新功能卻忘了補對應 ⇒ 那條沒有設定按鈕（靜默）；對應到不存在的設定 ⇒
// 按下去開了設定頁卻停在別處（靜默）。所以：真的 README 每一條都要有一列（key 或明確 null），
// 每個 key 都要真的在設定搜尋索引裡（也就是設定頁上的 data-pref-anchor）。
import fs from "fs";
import path from "path";
import { parseReadmeFeatures } from "../../src/js/whats_new";
import { FEATURE_SETTING, settingKeyFor } from "../../src/js/whats_new_settings";
import { PREF_SEARCH_ITEMS } from "../../src/js/pref_search";

const readme = fs.readFileSync(path.join(__dirname, "../../README.md"), "utf8");
const names = parseReadmeFeatures(readme).map((f) => f.name);
const indexKeys = new Set(PREF_SEARCH_ITEMS.map((it) => it.key));

test("README 每條功能都在對應表裡（沒有開關就寫 null）", () => {
  const missing = names.filter(
    (n) => !Object.prototype.hasOwnProperty.call(FEATURE_SETTING, n),
  );
  expect(missing).toEqual([]);
});

test("對應表沒有 README 已經沒有的名稱（改名、刪功能要跟著改）", () => {
  const known = new Set(names);
  expect(Object.keys(FEATURE_SETTING).filter((n) => !known.has(n))).toEqual([]);
});

test("每個 key 都在設定搜尋索引裡（設定頁跳得到）", () => {
  const bad = Object.entries(FEATURE_SETTING).filter(
    ([, key]) => key !== null && !indexKeys.has(key),
  );
  expect(bad).toEqual([]);
});

test("大部分功能都有開關（防整張表被寫成 null 了事）", () => {
  const withKey = names.filter((n) => FEATURE_SETTING[n]);
  expect(withKey.length / names.length).toBeGreaterThan(0.7);
});

test("settingKeyFor：沒有開關、不認得的名稱 ⇒ null", () => {
  expect(settingKeyFor("好讀模式")).toBe("enableEasyReading");
  expect(settingKeyFor("設為全部已讀")).toBeNull();
  expect(settingKeyFor("沒有這個功能")).toBeNull();
  expect(settingKeyFor("toString")).toBeNull();
});
