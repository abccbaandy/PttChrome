// 測試框架層的「自動重試」靜態守護：0 flaky 的前提是 flaky 會紅。
//
// vitest `retry`／Playwright `retries`／`describe.configure({ retries })` 會把偶發紅
// 吞成綠，根因永遠不會被修（integration 曾靠 CI `retry: 2` 遮住 emulator 冷啟動逾時，
// 真正的根因是首次寫入的暖機成本落在測試 deadline 裡，見 scripts/run-integration.mjs#warmUp）。
// 偶發紅的處置是找根因，不是重跑；CI 的整個 job 重跑另有判準（docs/ci-troubleshooting.md）。
//
// 純靜態掃描 ⇒ 放 unit（比照 tests/unit/e2e_no_bare_sleep.test.js）。
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// 去掉 // 行註解與 /* */ 區塊註解，註解裡提到 retry 不算。
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/([^:])\/\/.*$/gm, "$1");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "fixtures" ? [] : walk(p);
    return /\.(m?js|jsx)$/.test(e.name) ? [p] : [];
  });
}

describe("測試框架不准自動重試", () => {
  test("vitest.config.mjs 沒有 retry", () => {
    expect(stripComments(read("vitest.config.mjs"))).not.toMatch(/\bretry\s*:/);
  });

  test("playwright.config.js 沒有 retries（或為 0）", () => {
    const src = stripComments(read("playwright.config.js"));
    const hits = [...src.matchAll(/\bretries\s*:\s*([^,\n}]+)/g)].map((m) => m[1].trim());
    expect(hits.filter((v) => v !== "0")).toEqual([]);
  });

  test("測試檔沒有 per-suite／per-test 的 retry 設定", () => {
    const offenders = walk(path.join(ROOT, "tests"))
      .filter((f) => path.basename(f) !== "no_test_retry.test.js")
      .filter((f) => {
        const src = stripComments(fs.readFileSync(f, "utf8"));
        // describe.configure({ retries })、test(name, { retry }, fn)、test.retry(n)
        return /configure\(\s*\{[^}]*\bretries\s*:|\{\s*[^}]*\bretry\s*:\s*[1-9]|\.retry\(\s*[1-9]/.test(src);
      })
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  test("守護本身認得出違規寫法（避免 regex 退化成永遠綠）", () => {
    expect(stripComments("  retry: process.env.CI ? 2 : 0,")).toMatch(/\bretry\s*:/);
    expect(stripComments("  // retry: 2")).not.toMatch(/\bretry\s*:/);
    expect(/configure\(\s*\{[^}]*\bretries\s*:/.test("test.describe.configure({ retries: 2 })")).toBe(true);
    expect(/\{\s*[^}]*\bretry\s*:\s*[1-9]/.test("test('x', { retry: 3 }, () => {})")).toBe(true);
  });
});
