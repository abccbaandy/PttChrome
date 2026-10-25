// @unit-env browser
// unit-browser 的真 Chromium 是中文語系（vitest.config.mjs 的 contextOptions.locale）：
// app 依 navigator.languages 選語系，headless 預設 en-US 會讓 DOM 測試全跑在英文介面。
// 靜態那半在 e2e_locale.test.js。
import { getLang } from "../../src/js/i18n";

test("navigator.languages 第一個是 zh-TW，app 選中文", () => {
  expect(navigator.languages[0]).toBe("zh-TW");
  expect(getLang()).toBe("zh_tw");
});
