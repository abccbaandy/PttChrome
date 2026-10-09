// CodeQL 誤判自動 dismiss（scripts/dismiss-code-scanning.mjs）：清單格式與比對規則。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planDismissals, validateDismissals } from "../../scripts/dismiss-code-scanning.mjs";

const root = join(__dirname, "../..");
const { dismissals } = JSON.parse(readFileSync(join(root, ".github/code-scanning-dismissals.json"), "utf8"));

const alert = (number, rule, path, state = "open") => ({
  number,
  state,
  rule: { id: rule },
  most_recent_instance: { location: { path, start_line: 1 } },
});

test("repo 裡的清單格式正確（reason 合法、comment ≤ 280 字元）", () => {
  expect(validateDismissals(dismissals)).toEqual([]);
  expect(dismissals.length).toBeGreaterThan(0);
});

test("清單裡的 path 都存在（檔案搬家後清單要跟著改，否則靜默失效）", () => {
  const missing = dismissals.filter(d => {
    try {
      readFileSync(join(root, d.path));
      return false;
    } catch {
      return true;
    }
  });
  expect(missing.map(d => d.path)).toEqual([]);
});

test("validateDismissals 擋下不合法的 reason 與過長留言", () => {
  const errs = validateDismissals([
    { rule: "js/x", path: "a.js", reason: "nope", comment: "ok" },
    { rule: "js/x", path: "a.js", reason: "false positive", comment: "字".repeat(281) },
  ]);
  expect(errs).toHaveLength(2);
});

test("以 rule＋path 比對、忽略行號，只處理 open", () => {
  const list = [{ rule: "js/a", path: "src/a.js", reason: "false positive", comment: "c" }];
  const plan = planDismissals(
    [
      alert(1, "js/a", "src/a.js"),
      alert(2, "js/a", "src/b.js"),
      alert(3, "js/b", "src/a.js"),
      alert(4, "js/a", "src/a.js", "dismissed"),
    ],
    list,
  );
  expect(plan.map(p => p.number)).toEqual([1]);
  expect(plan[0]).toMatchObject({ reason: "false positive", comment: "c" });
});
