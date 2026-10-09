// offline e2e 的「不准拿 sleep 當等待」靜態守護。
//
// 「動作 → waitForTimeout → 單次讀值斷言」兩種壞法：
//   * 肯定斷言：renderer 一忙 sleep 就不夠 ⇒ 偶發紅（單獨重跑又綠）；
//   * 否定斷言（證明「沒送／沒發生」）：慢機器上「還沒發生」也算通過 ⇒ 假綠，而且
//     capture 根本沒接上時一樣綠。
// 替代品：餵畫面後 helpers/replay.js#waitScreenSettled；動作後讀值 expect.poll／
// toPass；否定斷言補一個「必定會發生」的柵欄再斷言（helpers/capture.js#expectOnlyFence、
// 等 `__app.dblclickTimer` 清空）；hover 後 helpers/real_input.js#nextFrames；存活型
// helpers/real_input.js#waitClickSettled；AI 推論 helpers/replay.js#aiTaskStats；
// 時間語意用 page.clock。對照表在 tests/e2e/README.md。
//
// 真的需要固定時間的（按鍵節奏、證明「沒發生」又找不到 idle 訊號的觀察窗、刻意抽樣
// 中間態）＝**具名豁免**：同一行或緊鄰的上方註解寫 `sleep-ok: <理由>`。
//
// 純靜態掃描 ⇒ 放 unit（比照 tests/unit/e2e_layout_settle.test.js）。
import fs from "fs";
import path from "path";
import { offlineSpecFiles } from "../../scripts/e2e-project-files.mjs";

const ROOT = path.join(__dirname, "..", "..");
const OFFLINE_DIR = path.join(ROOT, "tests", "e2e", "offline");

// 範圍取自 playwright.config.js 的 offline* project（遞迴），見 scripts/e2e-project-files.mjs。
const offlineSpecs = offlineSpecFiles();

// 固定時間等待的三種寫法：Playwright 的 waitForTimeout、page.evaluate 裡自己包的
// setTimeout Promise、自訂 sleep() 的定義（定義處標一次即可，呼叫處不再掃）。
// setTimeout 包 Promise 的寫法很多（`setTimeout(r, ms)`、`setTimeout(() => r(), ms)`、
// `setTimeout(done, ms)`）：只要回呼是 resolve 類名字就算。
const SLEEP =
  /\bwaitForTimeout\(|setTimeout\(\s*(\(\)\s*=>\s*)?(r|res|resolve|done|ok)\b\s*(\(\s*\))?\s*,|\bconst sleep\s*=/;

// 回傳沒有 `sleep-ok:` 標記的固定時間等待（1-based 行號）。
// 標記可在同一行，或在緊鄰上方、連續的 `//` 註解區塊裡。
function bareSleeps(src) {
  const lines = src.split("\n");
  const out = [];
  lines.forEach((line, i) => {
    if (!SLEEP.test(line)) return;
    if (line.trim().startsWith("//")) return; // 註解裡提到它不算
    if (/sleep-ok:\s*\S/.test(line)) return;
    for (let j = i - 1; j >= 0; j--) {
      const t = lines[j].trim();
      if (!t.startsWith("//")) break;
      if (/sleep-ok:\s*\S/.test(t)) return;
    }
    out.push(i + 1);
  });
  return out;
}

describe("offline e2e 不拿 sleep 當等待", () => {
  test("掃描範圍不是空的（檔名規則改了要在這裡發現，不能靜默通過）", () => {
    expect(offlineSpecs.length).toBeGreaterThanOrEqual(25);
  });

  test("掃描器本身：認得同行／上方註解的豁免，不認隔行與空理由", () => {
    expect(bareSleeps("await page.waitForTimeout(50); // sleep-ok: 按鍵節奏")).toEqual([]);
    expect(
      bareSleeps("// sleep-ok: 觀察窗\n// 第二行說明\nawait page.waitForTimeout(1);"),
    ).toEqual([]);
    expect(bareSleeps("await page.waitForTimeout(200);")).toEqual([1]);
    expect(
      bareSleeps("// sleep-ok: 觀察窗\nfoo();\nawait page.waitForTimeout(1);"),
    ).toEqual([3]);
    expect(bareSleeps("// sleep-ok:\nawait page.waitForTimeout(1);")).toEqual([2]);
    expect(bareSleeps("// 不用 waitForTimeout(…)")).toEqual([]);
    // page.evaluate 裡的自製 sleep 也算。
    expect(bareSleeps("await new Promise((r) => setTimeout(r, 100));")).toEqual([1]);
    expect(
      bareSleeps("const sleep = (ms) => new Promise((r) => setTimeout(r, ms));"),
    ).toEqual([1]);
  });

  test("每一個固定時間等待都要有 sleep-ok 理由", () => {
    const offenders = [];
    for (const f of offlineSpecs) {
      const src = fs.readFileSync(path.join(OFFLINE_DIR, f), "utf8");
      for (const n of bareSleeps(src)) offenders.push(`${f}:${n}`);
    }
    expect(offenders).toEqual([]);
  });
});
