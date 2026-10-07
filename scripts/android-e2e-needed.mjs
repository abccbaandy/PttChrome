// 這次改動需不需要跑 Android 模擬器 e2e（`yarn test:e2e:android --if-changed`）。
// 本機開模擬器要一分鐘起跳，所以只在碰到「長按／選取／手機版面」相關檔案時才跑；
// CI 不看這支，每次都跑。名單由 tests/unit/android_e2e.test.js 守護。
//
// 直接執行：`node scripts/android-e2e-needed.mjs [--base=<ref>]`，印出結論與命中檔案。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ANDROID_E2E_GLOBS = [
  // 被測行為：長按的去留（contextMenuDisposition 等）與選單本身
  "src/js/context_menu_items.js",
  "src/components/ContextMenu/**",
  // 手機版面判斷／底部工具列（選取模式開關在工具列的「更多」裡）
  "src/js/mobile_layout.js",
  "src/components/MobileToolbar/**",
  // -webkit-touch-callout、終端機祖先的 user-select 規則
  "src/css/main.css",
  // 這套測試自己的設施
  "tests/e2e/android/**",
  "scripts/run-android-e2e.mjs",
  "scripts/android-e2e-needed.mjs",
];

// `**` 跨目錄、`*` 不跨 `/`，其餘字面比對。
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// 回傳命中的檔案（空陣列 ＝ 不需要跑）。路徑一律正規化成 `/`。
export function matchAndroidE2e(files, globs = ANDROID_E2E_GLOBS) {
  const res = globs.map(globToRegExp);
  return files.map((f) => String(f).replace(/\\/g, "/")).filter((f) => res.some((r) => r.test(f)));
}

const git = (args) => {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失敗：${r.stderr.trim()}`);
  return r.stdout.split(/\r?\n/).filter(Boolean);
};

// 相對 base 的全部改動：已 commit（base...HEAD）＋未 commit＋未追蹤。
// base 查不到 ⇒ 丟錯，呼叫端當成「需要跑」（寧可多跑，不可漏跑）。
export function changedFiles(base) {
  return [
    ...new Set([
      ...git(["diff", "--name-only", `${base}...HEAD`]),
      ...git(["diff", "--name-only", "HEAD"]),
      ...git(["ls-files", "--others", "--exclude-standard"]),
    ]),
  ];
}

export function androidE2eNeeded(base = "origin/dev") {
  try {
    const matched = matchAndroidE2e(changedFiles(base));
    return { needed: matched.length > 0, matched, reason: null };
  } catch (e) {
    return { needed: true, matched: [], reason: e.message };
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const base = (process.argv.find((a) => a.startsWith("--base=")) || "--base=origin/dev").slice(7);
  const r = androidE2eNeeded(base);
  if (r.reason) console.log(`無法判斷（${r.reason}）⇒ 視為需要`);
  else if (r.needed) console.log(`需要（相對 ${base}）：\n  ${r.matched.join("\n  ")}`);
  else console.log(`略過：相對 ${base} 沒有改到 Android e2e 相關檔案`);
}
