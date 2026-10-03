// unit 測試的環境分流標記：檔案第一行是這行 ⇒ 跑在 unit-browser project（真 Chromium），
// 否則跑 node 的 unit project。vitest.config.mjs 與守護 tests/unit/unit_environment.test.js 共用。
export const BROWSER_MARKER = '// @unit-env browser';

export function isBrowserTestSource(src) {
  return src.startsWith(BROWSER_MARKER + '\n') || src.startsWith(BROWSER_MARKER + '\r\n');
}
