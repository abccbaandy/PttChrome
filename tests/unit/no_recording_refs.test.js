// doc／註解／測試名不寫後續 session 拿不到的出處（CLAUDE.md「慣例」）：使用者給的 Debug
// 錄製檔（ptt-debug-<日期>-<時間>.json）不入 repo，檔名與其中的 #t= 時間點只是死 pointer。
// 要寫的是事實本身；要能重放就轉成 tests/e2e/cassettes/ 的卷，指那個路徑。
//
// 純靜態掃描 ⇒ 放 unit（比照 tests/unit/no_test_retry.test.js）。
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..");
const DIRS = ["src", "tests", "docs", "scripts", "tools", "android", "proxy"];
const TOP = ["CLAUDE.md", "README.md"];
const SKIP_DIR = new Set(["node_modules", "build", ".gradle", "__recordings__", "cassettes", "3rd_script"]);
const TEXT = /\.(m?[jt]sx?|cjs|md|css|html|kt|java|sh|ya?ml)$/;
// 測的就是下載檔名格式本身。
const ALLOW = new Set([
  "android/app/src/test/java/io/github/abccbaandy/pttchrome/FileSaveTest.kt",
  "tests/unit/debug_record_control.test.js",
]);
const REF = /ptt-debug-\d{8}-\d{6}/;

function walk(rel, out) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return out;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel + "/" + ent.name;
    if (ent.isDirectory()) {
      if (!SKIP_DIR.has(ent.name)) walk(r, out);
    } else if (TEXT.test(ent.name)) out.push(r);
  }
  return out;
}

test("repo 裡不引用使用者錄製檔名", () => {
  const files = [...DIRS.flatMap((d) => walk(d, [])), ...TOP.filter((f) => fs.existsSync(path.join(ROOT, f)))];
  expect(files.length).toBeGreaterThan(100);
  const hits = [];
  for (const f of files) {
    if (ALLOW.has(f)) continue;
    fs.readFileSync(path.join(ROOT, f), "utf8")
      .split("\n")
      .forEach((line, i) => REF.test(line) && hits.push(`${f}:${i + 1}: ${line.trim()}`));
  }
  expect(hits).toEqual([]);
});

test("守護本身抓得到", () => {
  // 拆開寫，免得被上面那條掃到。
  expect(REF.test("// 錄製檔 ptt-" + "debug-20261021-190835：卡片跑到中間")).toBe(true);
  expect(REF.test("錄製檔名（`ptt-debug-*`，不入 repo）")).toBe(false);
});
