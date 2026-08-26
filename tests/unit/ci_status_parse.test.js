// scripts/ci-status.mjs 的純函式守護（無網路）。
// 背景：本機沒有 jq / gh，過去用 `curl | jq` 拼輪詢會靜默失敗（解析永遠空字串
// → 判不出「跑完了沒」→ 空轉到逾時，看起來像 CI 卡住）。改成 Node 腳本後，
// 解析邏輯就能在這裡鎖住。
//
// 這支 import 本身也是守門：腳本必須「只有直接執行才跑 main」，import 時不得
// 連網或 process.exit（否則 unit 會被它拖去打 GitHub API 甚至中止整批測試）。
import {
  parseRepoFromRemote,
  summarizeRuns,
  pickFailures,
  isKnownFlaky,
  allSettled,
  isFullSha,
  isProjectRun,
  projectRuns,
} from "../../scripts/ci-status.mjs";

test("import 純函式不得觸發網路（fetch 未被呼叫）", async () => {
  const spy = vi.spyOn(globalThis, "fetch");
  const mod = await import("../../scripts/ci-status.mjs");
  expect(typeof mod.parseRepoFromRemote).toBe("function");
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

describe("parseRepoFromRemote", () => {
  test("https / ssh / 帶不帶 .git 都解得出 owner/repo", () => {
    const want = "someowner/SomeRepo";
    expect(parseRepoFromRemote("https://github.com/someowner/SomeRepo.git")).toBe(want);
    expect(parseRepoFromRemote("https://github.com/someowner/SomeRepo")).toBe(want);
    expect(parseRepoFromRemote("git@github.com:someowner/SomeRepo.git")).toBe(want);
    expect(parseRepoFromRemote("  https://github.com/someowner/SomeRepo\n")).toBe(want);
  });

  test("非 GitHub / 空值 → null（讓 caller 明確報錯，不要瞎猜）", () => {
    expect(parseRepoFromRemote("https://gitlab.com/a/b.git")).toBeNull();
    expect(parseRepoFromRemote("")).toBeNull();
    expect(parseRepoFromRemote(undefined)).toBeNull();
  });
});

describe("isFullSha", () => {
  // 迴歸：`yarn ci:status --sha 398321f`（短 sha）回「查無 run」exit 2，看起來像
  // 工具壞了／CI 沒跑，實際上 CI 早就在跑 —— GitHub runs API 的 head_sha 參數
  // **只吃完整 40 字元 SHA**，短 sha 一律回空陣列。故 caller 必須先展開再查。
  test("完整 40 字元 hex 才算完整 SHA", () => {
    expect(isFullSha("398321f6e18eb5fb5d2dddb96f6f5787a7e2257e")).toBe(true);
    expect(isFullSha("398321F6E18EB5FB5D2DDDB96F6F5787A7E2257E")).toBe(true);
  });

  test("短 sha / 分支名 / 空值都不算（要先 git rev-parse 展開）", () => {
    expect(isFullSha("398321f")).toBe(false);
    expect(isFullSha("398321f6e18eb5fb5d2dddb96f6f5787a7e2257")).toBe(false); // 39 字元
    expect(isFullSha("398321f6e18eb5fb5d2dddb96f6f5787a7e2257ee")).toBe(false); // 41 字元
    expect(isFullSha("HEAD")).toBe(false);
    expect(isFullSha("dev")).toBe(false);
    expect(isFullSha("")).toBe(false);
    expect(isFullSha(undefined)).toBe(false);
  });

  test("含非 hex 字元不算（避免把 tag 名當 sha 送進 API）", () => {
    expect(isFullSha("z98321f6e18eb5fb5d2dddb96f6f5787a7e2257e")).toBe(false);
  });
});

describe("allSettled", () => {
  test("全部 completed 才算跑完", () => {
    expect(allSettled([{ status: "completed" }, { status: "completed" }])).toBe(true);
    expect(allSettled([{ status: "completed" }, { status: "in_progress" }])).toBe(false);
    expect(allSettled([{ status: "queued" }])).toBe(false);
  });

  test("空清單不算跑完（查無 run ≠ 全綠——舊 bug 的核心誤判）", () => {
    expect(allSettled([])).toBe(false);
    expect(allSettled(undefined)).toBe(false);
  });
});

describe("summarizeRuns", () => {
  test("取名稱／短 sha／狀態", () => {
    const rows = summarizeRuns([
      {
        name: "Deploy to GitHub Pages",
        head_sha: "8af0106019ec37c88a184f2aa1601a62280a36b2",
        status: "completed",
        conclusion: "success",
        id: 1,
        html_url: "u",
      },
    ]);
    expect(rows).toEqual([
      {
        name: "Deploy to GitHub Pages",
        sha: "8af0106",
        status: "completed",
        conclusion: "success",
        id: 1,
        url: "u",
      },
    ]);
  });

  test("空輸入不炸", () => {
    expect(summarizeRuns(undefined)).toEqual([]);
  });
});

describe("pickFailures", () => {
  const jobs = [
    { id: 1, name: "test / test-unit", status: "completed", conclusion: "success", steps: [] },
    { id: 2, name: "test / test-integration", status: "completed", conclusion: "skipped", steps: [] },
    {
      id: 3,
      name: "test / test-e2e-offline",
      status: "completed",
      conclusion: "failure",
      steps: [
        { name: "Install", conclusion: "success" },
        { name: "Run offline e2e", conclusion: "failure" },
      ],
    },
    { id: 4, name: "build", status: "in_progress", conclusion: null, steps: [] },
  ];

  test("只挑已完成且非 success/skipped 的 job，並指出失敗的 step", () => {
    expect(pickFailures(jobs)).toEqual([
      {
        id: 3,
        name: "test / test-e2e-offline",
        conclusion: "failure",
        step: "Run offline e2e",
      },
    ]);
  });

  test("沒有 steps 也不炸（step 為 undefined）", () => {
    const out = pickFailures([
      { id: 9, name: "x", status: "completed", conclusion: "cancelled" },
    ]);
    expect(out).toEqual([{ id: 9, name: "x", conclusion: "cancelled", step: undefined }]);
  });
});

describe("isKnownFlaky", () => {
  test("integration job 的 emulator 冷啟動逾時 → 已知 flaky", () => {
    expect(isKnownFlaky("test / test-integration", "Error: waitForCloud timeout: upload")).toBe(
      true,
    );
    expect(isKnownFlaky("test / test-integration", "firestore emulator not ready in 60000ms")).toBe(
      true,
    );
  });

  test("同樣訊息但不是 integration job → 不算（不可亂重跑）", () => {
    expect(isKnownFlaky("test / test-unit", "waitForCloud timeout: upload")).toBe(false);
  });

  test("integration job 的真錯（斷言失敗）→ 不算 flaky", () => {
    expect(
      isKnownFlaky("test / test-integration", "AssertionError: expected 1 to be 2"),
    ).toBe(false);
  });
});

// GitHub 的 default setup（CodeQL / Dependabot）跑的是 `dynamic/...` workflow，
// 不是 repo 裡的 .github/workflows/*.yml。CLAUDE.md 明寫「只有 `Push on dev` 那個
// `dynamic` run 是 CodeQL default setup，不算」。
//
// REGRESSION（2026-08-27 實際踩到）：push 事件到 `Deploy to GitHub Pages` run 被
// 建立之間**延遲了 11 分鐘**。這段空窗期裡 runs API 只回得到 CodeQL 那一顆，而它
// 早就 completed/success ⇒ allSettled 成立 ⇒ ci:status 印「CI 全綠」並 exit 0。
// 也就是「本專案的 CI 根本還沒開始跑」被回報成「全綠」——正是這支腳本刻意分三種
// exit code 要防的那件事。
describe("isProjectRun / projectRuns", () => {
  const codeql = {
    name: "Push on dev",
    event: "dynamic",
    path: "dynamic/github-code-scanning/codeql",
    status: "completed",
    conclusion: "success",
  };
  const dependabot = {
    name: "Dependabot Updates",
    event: "dynamic",
    path: "dynamic/dependabot/dependabot-updates",
    status: "completed",
    conclusion: "success",
  };
  const deploy = {
    name: "Deploy to GitHub Pages",
    event: "push",
    path: ".github/workflows/deploy.yml",
    status: "in_progress",
    conclusion: null,
  };

  test("CodeQL / Dependabot 的 default setup run 不算本專案 CI", () => {
    expect(isProjectRun(codeql)).toBe(false);
    expect(isProjectRun(dependabot)).toBe(false);
  });

  test("repo 自己的 workflow 算（push / workflow_dispatch 都是）", () => {
    expect(isProjectRun(deploy)).toBe(true);
    expect(
      isProjectRun({ ...deploy, event: "workflow_dispatch" })
    ).toBe(true);
  });

  test("只有 CodeQL run 時 projectRuns 為空（REGRESSION：曾被當成全綠）", () => {
    expect(projectRuns([codeql])).toEqual([]);
    // 這正是誤判的現場：allSettled 對「只有 CodeQL」是成立的，所以不能只靠它。
    expect(allSettled([codeql])).toBe(true);
    expect(projectRuns([codeql]).length).toBe(0);
  });

  test("混合時只留本專案的 run", () => {
    expect(projectRuns([codeql, deploy])).toEqual([deploy]);
  });

  test("空值 / 缺欄位不炸", () => {
    expect(isProjectRun(null)).toBe(false);
    expect(isProjectRun(undefined)).toBe(false);
    expect(projectRuns(undefined)).toEqual([]);
    // path 欄位缺席時只能靠 event 判斷。
    expect(isProjectRun({ name: "x", event: "push" })).toBe(true);
    expect(isProjectRun({ name: "x", event: "dynamic" })).toBe(false);
  });
});
