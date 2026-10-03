// 多 session 並行守門（scripts/worktree.js，規則見 CLAUDE.md「多 session 並行」）。
//
// 鎖三件事：
//   1. linked worktree 判定：`.git` 檔指向 `.git/worktrees/<name>` 才算；submodule
//      （`.git/modules/…`）與主目錄（`.git` 是資料夾）不算 —— 判錯在主目錄會把 e2e 整個擋掉。
//   2. 會搶全機資源的入口都經過守門（Playwright config、integration runner）；
//      這種「多一道擋」最容易被順手刪掉，所以靜態掃描。
//   3. SessionEnd hook 只殺自己 checkout 的 dev server（--own），不殺 8080 上別人的。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALLOW_ENV,
  isLinkedWorktreeGitFile,
  isLinkedWorktree,
  readGitFile,
  isBlocked,
  worktreeBlockMessage,
  unitLimits,
} from "../../scripts/worktree.js";

const ROOT = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("isLinkedWorktreeGitFile", () => {
  test("指向 .git/worktrees/<name> ⇒ 是 worktree（POSIX 與 Windows 路徑）", () => {
    expect(isLinkedWorktreeGitFile("gitdir: /repo/.git/worktrees/feat-a\n")).toBe(true);
    expect(isLinkedWorktreeGitFile("gitdir: C:/repo/.git/worktrees/feat-a")).toBe(true);
    expect(isLinkedWorktreeGitFile("gitdir: C:\\repo\\.git\\worktrees\\feat-a\r\n")).toBe(true);
  });

  test("submodule 的 .git 檔不算", () => {
    expect(isLinkedWorktreeGitFile("gitdir: ../.git/modules/pttbbs\n")).toBe(false);
  });

  test("主目錄（.git 是資料夾 ⇒ 讀不到內容）不算", () => {
    expect(isLinkedWorktreeGitFile(null)).toBe(false);
    expect(isLinkedWorktreeGitFile("")).toBe(false);
  });
});

describe("readGitFile／isLinkedWorktree", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wt-guard-"));

  test("`.git` 是資料夾（主目錄）⇒ null，不是 worktree", () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, ".git"));
    expect(readGitFile(d)).toBe(null);
    expect(isLinkedWorktree(d)).toBe(false);
  });

  test("`.git` 不存在 ⇒ null", () => {
    expect(readGitFile(tmp())).toBe(null);
  });

  test("`.git` 是指向 worktrees 的檔案 ⇒ 是 worktree", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /repo/.git/worktrees/feat-a\n");
    expect(readGitFile(d)).toContain("gitdir:");
    expect(isLinkedWorktree(d)).toBe(true);
  });

  test("不先 stat 再讀（CodeQL js/file-system-race）", () => {
    const src = read("scripts/worktree.js");
    const fn = src.slice(src.indexOf("function readGitFile"), src.indexOf("function isLinkedWorktree("));
    expect(fn).not.toMatch(/statSync|existsSync/);
  });
});

describe("isBlocked", () => {
  test("worktree 預設擋；逃生門 =1 才放行", () => {
    expect(isBlocked({ worktree: true, env: {} })).toBe(true);
    expect(isBlocked({ worktree: true, env: { [ALLOW_ENV]: "0" } })).toBe(true);
    expect(isBlocked({ worktree: true, env: { [ALLOW_ENV]: "1" } })).toBe(false);
  });

  test("主目錄永遠不擋", () => {
    expect(isBlocked({ worktree: false, env: {} })).toBe(false);
  });

  test("訊息要講明不是測試失敗、該怎麼做、逃生門", () => {
    const msg = worktreeBlockMessage("Playwright e2e");
    expect(msg).toContain("exit 2");
    expect(msg).toContain("yarn ci:status");
    expect(msg).toContain(`${ALLOW_ENV}=1`);
  });
});

describe("unitLimits", () => {
  test("worktree 限流且放寬 timeout；主目錄／CI 不動預設", () => {
    const wt = unitLimits(true);
    expect(wt.maxWorkers).toBeLessThanOrEqual(2);
    expect(wt.testTimeout).toBeGreaterThan(5000);
    expect(unitLimits(false)).toEqual({});
  });
});

describe("入口都經過守門（靜態）", () => {
  test("playwright.config.js 在非 vitest 載入時呼叫 assertNotWorktree", () => {
    expect(read("playwright.config.js")).toMatch(/if \(!process\.env\.VITEST\) assertNotWorktree\(/);
  });

  test("run-integration.mjs 在起容器前呼叫 assertNotWorktree", () => {
    const src = read("scripts/run-integration.mjs");
    const guard = src.indexOf("assertNotWorktree(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(src.indexOf("rmContainer();"));
  });

  test("vitest.config.mjs 套用 unitLimits", () => {
    expect(read("vitest.config.mjs")).toMatch(/unitLimits\(worktree\.isLinkedWorktree\(\)\)/);
  });
});

describe("SessionEnd hook 只殺自己的 dev server", () => {
  test("kill-dev-server 帶 --own，且沒有 PostToolUse 旗標檔那套", () => {
    const settings = JSON.parse(read(".claude/settings.json"));
    const cmds = JSON.stringify(settings.hooks.SessionEnd);
    expect(cmds).toContain("kill-dev-server.js\\\" --own");
    expect(settings.hooks.PostToolUse).toBeUndefined();
  });

  test("vite dev server 會寫 pidfile（--own 的依據）", () => {
    expect(read("vite.config.mjs")).toMatch(/plugins: \[[^\]]*devServerPidfile\(\)/);
  });
});
