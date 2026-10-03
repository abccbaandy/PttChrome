// unit 與 unit-browser 兩個 project 共用（vitest.config.mjs）。
// DOM 測試跑在真 Chromium（unit-browser），scrollIntoView／document.fonts 這類 API 都是真的，
// 不需要補；jsdom 時代的補丁已移除。
// jest-dom adds DOM matchers; testing-library sets IS_REACT_ACT_ENVIRONMENT and
// wraps render in act() itself, so no global React or test-renderer shim is needed.
import "@testing-library/jest-dom";
