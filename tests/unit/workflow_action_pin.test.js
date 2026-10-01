// 第三方 GitHub Action 一律釘 commit SHA（CodeQL actions/unpinned-tag）。
// tag 可被作者（或搶走帳號的人）改指到別的 commit，而 workflow 拿得到 secrets（Android 簽章金鑰）。
// GitHub 官方的 actions/*、github/* 與本 repo 的 reusable workflow 不在此限。
// 釘法：`uses: owner/repo@<40 字元 sha> # vX.Y.Z`，Dependabot（github-actions）會連註解一起更新。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../.github/workflows");
const files = readdirSync(dir).filter(f => /\.ya?ml$/.test(f));

function usesLines(text) {
  return text
    .split("\n")
    .map((line, i) => ({ line: i + 1, m: line.match(/^\s*(?:-\s*)?uses:\s*(\S+)/) }))
    .filter(x => x.m)
    .map(x => ({ line: x.line, ref: x.m[1] }));
}

test("第三方 action 都釘 commit SHA", () => {
  const bad = [];
  for (const f of files) {
    for (const { line, ref } of usesLines(readFileSync(join(dir, f), "utf8"))) {
      if (ref.startsWith("./") || /^(actions|github)\//.test(ref)) continue;
      if (!/@[0-9a-f]{40}$/.test(ref)) bad.push(`${f}:${line} ${ref}`);
    }
  }
  expect(bad).toEqual([]);
});

test("掃描本身有掃到東西（防 regex 失效變成恆綠）", () => {
  const all = files.flatMap(f => usesLines(readFileSync(join(dir, f), "utf8")));
  expect(all.some(x => x.ref.startsWith("gradle/actions/setup-gradle@"))).toBe(true);
});
