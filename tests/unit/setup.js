// Render tests run under jsdom + @testing-library/react (vitest.config.mjs
// testEnvironment:"jsdom"). jest-dom adds DOM matchers; testing-library sets
// IS_REACT_ACT_ENVIRONMENT and wraps render in act() itself, so no global React
// or test-renderer shim is needed.
import "@testing-library/jest-dom";

// jsdom 沒有實作 Element.prototype.scrollIntoView（不是回傳假值，是整個不存在）。
// Mantine 的 useCombobox#selectOption 在按方向鍵時**無條件**呼叫它，所以任何
// 走鍵盤操作下拉的測試沒有這個 stub 就會直接丟 TypeError。設定搜尋
// （PrefSearchBox）是第一個會踩到的。
//
// 這個 setup 檔對**整個 unit project** 生效，其中有少數檔案用
// `@vitest-environment node`（純靜態掃描不需要 DOM）⇒ 下面一律先確認全域存在，
// 否則那些檔案會整支掛在 `ReferenceError: Element is not defined`。
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

// jsdom 也沒有 document.fonts（CSS Font Loading API）。Mantine 的 Textarea
// autosize 會無條件 document.fonts.addEventListener("loadingdone", …)，所以只要
// 測試 render 到「增強功能」分頁的黑名單欄位就會炸在那裡。
if (typeof document !== "undefined" && !document.fonts) {
  document.fonts = {
    addEventListener() {},
    removeEventListener() {},
  };
}
