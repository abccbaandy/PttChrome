'use strict';

// e2e 的介面語系一律中文（i18n 以中文為準，見 CLAUDE.md 測試段）。
//
// headless Chromium 預設 en-US，app 依 `navigator.languages` 選語系（i18n.js#getLang）
// ⇒ 不設 locale 跑出來、截出來的都是英文介面：中文字比較寬才會出現的換行／截斷／
// 疊字，整輪 e2e 都看不到。playwright.config.js 的 `use.locale` 管所有 project 的
// 預設 context；自己 `browser.newContext()` 開的 context **不吃** project 的 use，
// 要明確帶上這個值。守護 tests/unit/e2e_locale.test.js。
const E2E_LOCALE = 'zh-TW';

module.exports = { E2E_LOCALE };
