// Dependabot 分組契約（.github/dependabot.yml）。
//
// vitest 與 @vitest/browser-playwright（peer 是精確版本）、playwright 與 @playwright/test（CI image tag
// 取自後者）必須同一支 PR 一起升；拆成兩支 PR ⇒ 各自單升都紅、auto-merge 永遠卡住。
// group pattern 寫 `@scope/*` 實測吃不到 scoped 套件（兩次：漏 @playwright/test、漏
// @vitest/browser-playwright），所以一律明列套件名，且 package.json 新增同家族套件時要補進 group。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const YAML = fs.readFileSync(path.join(ROOT, ".github", "dependabot.yml"), "utf8");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const DEPS = Object.keys({ ...PKG.dependencies, ...PKG.devDependencies });

// `<group>:` 之後第一個 `patterns: [...]`。
function groupPatterns(name) {
  const m = YAML.match(new RegExp(`^\\s+${name}:\\s*\\n\\s+patterns:\\s*\\[([^\\]]*)\\]`, "m"));
  if (!m) return null;
  return m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
}

test("group pattern 不准用 @scope/* 萬用字元", () => {
  const all = [...YAML.matchAll(/patterns:\s*\[([^\]]*)\]/g)].map((m) => m[1]);
  expect(all.length).toBeGreaterThan(0);
  for (const list of all) expect(list).not.toMatch(/@[^/"]+\/\*/);
});

test.each([
  ["vitest", (d) => d === "vitest" || d.startsWith("@vitest/")],
  ["playwright", (d) => d === "playwright" || d.startsWith("@playwright/")],
])("package.json 裡 %s 家族的套件全部明列在同名 group", (group, isFamily) => {
  const patterns = groupPatterns(group);
  expect(patterns).not.toBeNull();
  const family = DEPS.filter(isFamily);
  expect(family.length).toBeGreaterThan(1);
  for (const dep of family) expect(patterns).toContain(dep);
});

test("github-actions 也分組（每週一支 PR）", () => {
  const actions = YAML.slice(YAML.indexOf('package-ecosystem: "github-actions"'));
  expect(actions).toMatch(/groups:\s*\n\s+\S+:\s*\n\s+patterns:\s*\["\*"\]/);
});
