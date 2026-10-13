// Flaky Hunt 紅了之後對 issue 的決策（scripts/flaky-hunt-report.mjs）。
//
// routine「fix Nightly flaky hunt 失敗」的 trigger 是「Issue opened、標題＝ISSUE_TITLE、作者
// github-actions[bot]」⇒ 每新開一個 issue 就起一個 Claude session。session 修完會手動 dispatch
// Flaky Hunt 驗證；PR 帶 `Fixes #N` 的話 merge 時 issue 已被關。舊版 report「沒有 open 的就新開」
// ⇒ 驗證 run 還紅就再 fire 一個 session，一路連鎖。這裡鎖住：只有 schedule 能新開。
import fs from "node:fs";
import path from "node:path";
import { decideReport, renderBody, ISSUE_TITLE } from "../../scripts/flaky-hunt-report.mjs";

const open = (number) => ({ number, title: ISSUE_TITLE, state: "OPEN", closedAt: null });
const closed = (number, closedAt) => ({ number, title: ISSUE_TITLE, state: "CLOSED", closedAt });

describe("decideReport", () => {
  test("schedule、沒有 open issue ⇒ 新開（觸發 routine）", () => {
    expect(decideReport({ event: "schedule", issues: [] })).toEqual({ kind: "create" });
    expect(decideReport({ event: "schedule", issues: [closed(7, "2026-10-12T00:00:00Z")] })).toEqual({
      kind: "create",
    });
  });

  test("已有 open issue ⇒ 只留言（schedule／dispatch 皆同）", () => {
    for (const event of ["schedule", "workflow_dispatch"]) {
      expect(decideReport({ event, issues: [open(9), closed(7, "2026-10-12T00:00:00Z")] })).toEqual({
        kind: "comment",
        number: 9,
      });
    }
  });

  test("連鎖情境：issue 已被 Fixes #N 關掉，驗證 dispatch 仍紅 ⇒ 留言在最近關的那個，不新開", () => {
    const issues = [closed(3, "2026-10-01T00:00:00Z"), closed(9, "2026-10-13T04:00:00Z")];
    expect(decideReport({ event: "workflow_dispatch", issues })).toEqual({ kind: "comment", number: 9 });
  });

  test("dispatch 且從沒有過 issue ⇒ 什麼都不寫", () => {
    expect(decideReport({ event: "workflow_dispatch", issues: [] })).toEqual({ kind: "none" });
  });

  test("搜尋是模糊比對：標題不完全相同的不算", () => {
    const other = { number: 5, title: `${ISSUE_TITLE}（舊）`, state: "OPEN", closedAt: null };
    expect(decideReport({ event: "workflow_dispatch", issues: [other] })).toEqual({ kind: "none" });
    expect(decideReport({ event: "schedule", issues: [other] })).toEqual({ kind: "create" });
  });
});

test("dispatch 的留言講明沒開新 issue 的理由", () => {
  const body = renderBody({ event: "workflow_dispatch", date: "2026-10-13", runUrl: "u", sha: "s", results: "r", repeat: "10" });
  expect(body).toContain("不開新 issue");
  expect(body).toContain("- run: u");
});

test("workflow 的 report job 交給 scripts/flaky-hunt-report.mjs，不再自己 gh issue create", () => {
  const yaml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "flaky-hunt.yml"), "utf8");
  const report = yaml.slice(yaml.indexOf("\n  report:"));
  expect(report).toContain("node scripts/flaky-hunt-report.mjs");
  expect(report).toContain("sparse-checkout: scripts/flaky-hunt-report.mjs");
  expect(yaml).not.toContain("gh issue create");
});
