// PTT Source Screens 紅了之後的 issue 決策（scripts/ptt-src-screens-report.mjs）＋workflow 的
// 幾個「看起來多餘」的設定（.github/workflows/ptt-src-screens.yml）。
import fs from "node:fs";
import path from "node:path";
import {
  decideReport,
  failedStage,
  renderBody,
  ISSUE_TITLE,
  ISSUE_LABEL,
} from "../../scripts/ptt-src-screens-report.mjs";
import { ISSUE_TITLE as FLAKY_TITLE, ISSUE_LABEL as FLAKY_LABEL } from "../../scripts/flaky-hunt-report.mjs";

const open = (number, title = ISSUE_TITLE) => ({ number, title, state: "OPEN" });

describe("decideReport", () => {
  test("schedule、沒有 open issue ⇒ 新開", () => {
    expect(decideReport({ event: "schedule", issues: [] })).toEqual({ kind: "create" });
  });

  test("已有 open issue ⇒ 只留言（upstream 沒修好前每天紅，不洗出一排 issue）", () => {
    for (const event of ["schedule", "workflow_dispatch"]) {
      expect(decideReport({ event, issues: [open(12), open(9)] })).toEqual({ kind: "comment", number: 9 });
    }
  });

  test("別的標題的 open issue 不算", () => {
    expect(decideReport({ event: "schedule", issues: [open(3, FLAKY_TITLE)] })).toEqual({ kind: "create" });
  });

  test("dispatch 且沒有 open issue ⇒ 不寫", () => {
    expect(decideReport({ event: "workflow_dispatch", issues: [] })).toEqual({ kind: "none" });
  });
});

test("MVP 不接 Claude routine：標題與 label 都和 flaky hunt（有 routine trigger）不同", () => {
  expect(ISSUE_TITLE).not.toBe(FLAKY_TITLE);
  expect(ISSUE_LABEL).not.toBe(FLAKY_LABEL);
});

describe("failedStage／renderBody：分清楚是環境紅還是解析器紅", () => {
  test("generate 沒成功 ⇒ generate（check 會是 skipped）", () => {
    expect(failedStage({ generate: "failure", check: "skipped" })).toBe("generate");
    expect(failedStage({ generate: "success", check: "failure" })).toBe("check");
    expect(failedStage({ generate: "success", check: "success" })).toBe(null);
  });

  test("body 帶 run、upstream commit 與紅在哪一段", () => {
    const body = renderBody({
      event: "schedule",
      date: "2026-10-20",
      runUrl: "https://example.test/run/1",
      sha: "abc",
      pttbbsSha: "3b8596b950c1e0421f24e2e38078837095a9e543",
      generate: "success",
      check: "failure",
    });
    expect(body).toContain("紅在 check");
    expect(body).toContain("https://example.test/run/1");
    expect(body).toContain("https://github.com/ptt/pttbbs/commit/3b8596b950c1e0421f24e2e38078837095a9e543");
    expect(renderBody({ event: "schedule", generate: "failure", check: "skipped" })).toContain("紅在 generate");
  });
});

describe("ptt-src-screens.yml", () => {
  const yml = fs.readFileSync(path.join(__dirname, "../../.github/workflows/ptt-src-screens.yml"), "utf8");

  test("有排程與手動觸發", () => {
    expect(yml).toMatch(/^\s+schedule:\s*\n\s+- cron: "\d+ \d+ \* \* \*"/m);
    expect(yml).toMatch(/^\s+workflow_dispatch:/m);
  });

  test("report 只在 dev 上的紅執行（PR 驗證紅不開 issue）", () => {
    expect(yml).toMatch(/if: failure\(\) && github\.ref == 'refs\/heads\/dev'/);
  });

  test("PR 的 paths 涵蓋這套東西的每個檔案（改它的 PR 一定會自動驗到）", () => {
    for (const p of [
      ".github/workflows/ptt-src-screens.yml",
      "tools/ptt-src-screens/**",
      "scripts/ptt-src-screens-report.mjs",
      "tests/unit/ptt_src_screens.test.js",
    ]) {
      expect(yml).toContain(`"${p}"`);
    }
  });
});
