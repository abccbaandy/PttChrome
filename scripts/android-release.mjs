// Android APK 自動發版：算下一個版號＋寫給一般使用者看的 release note（docs/android-app.md「發佈」）。
// android.yml 在 dev 每次 build 完 APK 就跑這支，有新改動才發 Release。
//
// 來源＝上一個 `android-v*` tag 之後碰到 android/ 的 commit（不含 merge、不含只改 JVM test 的）：
//   - 標題照 Conventional Commits：feat ⇒「新功能」、fix／perf ⇒「修正與改進」，其餘（chore／test／docs／ci／
//     build／refactor…）不列；沒照格式的標題當「修正與改進」
//   - commit 內文的 `Release-Note: <一句話>` 取代標題文字（標題太技術時用）；`Release-Note: -` ＝不列
//   - 有列出新功能 ⇒ minor+1，否則 patch+1；還沒有 tag ⇒ 1.0.0
//
// 直接執行：`node scripts/android-release.mjs [--force] [--notes-file=<path>]`
//   stdout 印 `release=true|false`、`version=<x.y.z>`、`tag=android-v<x.y.z>`（給 $GITHUB_OUTPUT）。
//   --force：沒有新 commit 也發（workflow_dispatch 手動補發）。exit 0 成功、2 工具問題。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TAG_PREFIX = "android-v";
// 不進 APK 的路徑：只改這些的 commit 不算新版。
export const LOG_PATHSPEC = ["android/", ":(exclude)android/app/src/test"];

const FEATURE_TYPES = new Set(["feat"]);
const FIX_TYPES = new Set(["fix", "perf"]);

export function parseVersion(tag) {
  const m = new RegExp(`^${TAG_PREFIX}(\\d+)\\.(\\d+)\\.(\\d+)$`).exec(tag.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// 不是 x.y.z 的 tag（例如手動推的 android-v1.2.0-test）一律忽略。
export function latestReleaseTag(tags) {
  let best = null;
  for (const tag of tags) {
    const v = parseVersion(tag);
    if (v && (!best || compareVersion(v, best.version) > 0)) best = { tag: tag.trim(), version: v };
  }
  return best;
}

// { subject, body } → { kind: 'feature'|'fix'|null, text }；kind null ＝不列。
export function classifyCommit({ subject, body = "" }) {
  const m = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(subject.trim());
  const type = m ? m[1].toLowerCase() : null;
  let kind = !m ? "fix" : FEATURE_TYPES.has(type) ? "feature" : FIX_TYPES.has(type) ? "fix" : null;
  let text = m ? m[2].trim() : subject.trim();
  const note = /^release-note:[ \t]*(.*)$/im.exec(body);
  if (note) {
    const value = note[1].trim();
    if (!value || value === "-") return { kind: null, text: "" };
    text = value;
    if (!kind) kind = "fix";
  }
  return { kind, text };
}

export function nextVersion(prev, entries) {
  if (!prev) return [1, 0, 0];
  const [major, minor, patch] = prev;
  return entries.some((e) => e.kind === "feature") ? [major, minor + 1, 0] : [major, minor, patch + 1];
}

export const INSTALL_SECTION = [
  "## 安裝／更新",
  "1. 用 Android 手機下載下面的 `pttchrome.apk`。",
  "2. 開啟下載好的檔案。第一次安裝時，系統會要你允許瀏覽器（或檔案管理員）「安裝不明應用程式」，允許後再按一次安裝。",
  "3. 已經裝過的直接安裝就會覆蓋更新，設定和登入資料都會保留。",
  "",
  "看板、文章、推文這些功能跟網頁版是同一份，會自動更新，不用等新版 App；這裡列的是 App 本身的改動。",
].join("\n");

export function buildReleaseNotes(entries) {
  const seen = new Set();
  const groups = { feature: [], fix: [] };
  for (const e of entries) {
    if (!e.kind || seen.has(e.text)) continue;
    seen.add(e.text);
    groups[e.kind].push(`- ${e.text}`);
  }
  const parts = [];
  if (groups.feature.length) parts.push("## 新功能", ...groups.feature, "");
  if (groups.fix.length) parts.push("## 修正與改進", ...groups.fix, "");
  if (!parts.length) parts.push("這一版是內部維護更新，用起來沒有差別。", "");
  parts.push(INSTALL_SECTION);
  return parts.join("\n") + "\n";
}

// git log --format 的輸出：每筆 `<subject>\x1f<body>\x1e`（新的在前）。
export function parseGitLog(out) {
  return out
    .split("\x1e")
    .map((rec) => rec.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [subject, body = ""] = rec.split("\x1f");
      return { subject, body };
    });
}

// 純決策：commits 是 tag 之後的（新的在前）。條列改成舊的在前，跟著時間讀。
export function planRelease({ tags, commits, force = false }) {
  const latest = latestReleaseTag(tags);
  const entries = commits.map(classifyCommit).reverse();
  const version = nextVersion(latest && latest.version, entries).join(".");
  return {
    release: force || commits.length > 0,
    version,
    tag: `${TAG_PREFIX}${version}`,
    previousTag: latest ? latest.tag : null,
    notes: buildReleaseNotes(entries),
  };
}

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失敗：${r.stderr || r.error}`);
  return r.stdout;
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const notesArg = args.find((a) => a.startsWith("--notes-file="));
  const tags = git(["tag", "-l", `${TAG_PREFIX}*`]).split("\n").filter(Boolean);
  const latest = latestReleaseTag(tags);
  const range = latest ? [`${latest.tag}..HEAD`] : ["HEAD"];
  const log = git(["log", "--no-merges", "--format=%s%x1f%b%x1e", ...range, "--", ...LOG_PATHSPEC]);
  const plan = planRelease({ tags, commits: parseGitLog(log), force });
  if (notesArg) fs.writeFileSync(notesArg.slice("--notes-file=".length), plan.notes);
  else console.error(plan.notes);
  console.log(`release=${plan.release}`);
  console.log(`version=${plan.version}`);
  console.log(`tag=${plan.tag}`);
}

// 只有「直接執行」才跑 main——unit test import 純函式時不可呼叫 git。
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
