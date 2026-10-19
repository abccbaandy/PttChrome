// e2e 的「假時鐘暫停一律走 helpers/clock.js#pauseClockNow」靜態守護。
//
// `page.clock.pauseAt(t)` 只能往未來跳。「讀頁面 Date.now() → pauseAt(now + 固定餘裕)」
// 是兩次往返，CI 滿載時中間就超過餘裕 ⇒ "Cannot fast-forward to the past" 偶發紅
// （blink_cursor.offline.spec.js 在 PR CI 實際紅過，單獨重跑又綠）。pauseClockNow 重讀
// now、放大餘裕直到停得下來。
//
// 純靜態掃描 ⇒ 放 unit（比照 tests/unit/e2e_no_bare_sleep.test.js）。
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..");
const E2E_DIR = path.join(ROOT, "tests", "e2e");
const HELPER = path.join(E2E_DIR, "helpers", "clock.js");

function jsFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name.startsWith("__")) continue;
      out.push(...jsFiles(p));
    } else if (/\.(c|m)?js$/.test(ent.name)) out.push(p);
  }
  return out;
}

const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

describe("e2e 假時鐘暫停", () => {
  test("pauseAt 只准出現在 helpers/clock.js", () => {
    const offenders = jsFiles(E2E_DIR)
      .filter((f) => f !== HELPER)
      .filter((f) => /\.pauseAt\(/.test(stripComments(fs.readFileSync(f, "utf8"))))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  test("helper 本身會在「指向過去」時重讀 now 重試，不是只加大固定餘裕", () => {
    const src = stripComments(fs.readFileSync(HELPER, "utf8"));
    expect(src).toMatch(/for \(/);
    expect(src).toMatch(/Date\.now\(\)/);
    expect(src).toMatch(/fast-forward to the past/);
  });
});
