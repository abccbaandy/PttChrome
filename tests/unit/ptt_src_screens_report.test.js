// PTT Source Screens 之後的 issue 決策（scripts/ptt-src-screens-report.mjs）＋workflow 的
// 幾個「看起來多餘」的設定（.github/workflows/ptt-src-screens.yml）。
import fs from "node:fs";
import path from "node:path";
import {
  decideReport,
  decideChanged,
  failedStage,
  renderBody,
  renderChangedBody,
  ISSUE_TITLE,
  ISSUE_LABEL,
  CHANGED_TITLE,
  CHANGED_LABEL,
} from "../../scripts/ptt-src-screens-report.mjs";
import { ISSUE_TITLE as FLAKY_TITLE, ISSUE_LABEL as FLAKY_LABEL } from "../../scripts/flaky-hunt-report.mjs";

const open = (number, title = ISSUE_TITLE) => ({ number, title, state: "OPEN" });
const closed = (number, closedAt, title = ISSUE_TITLE) => ({ number, title, state: "CLOSED", closedAt });

describe("decideReport（失敗 issue：新開會觸發 routine）", () => {
  test("schedule、沒有 open issue、跑的是 dev HEAD ⇒ 新開", () => {
    expect(decideReport({ event: "schedule", issues: [], sha: "a", headSha: "a" })).toEqual({ kind: "create" });
  });

  test("已有 open issue ⇒ 只留言（upstream 沒修好前每天紅，不洗出一排 issue／session）", () => {
    for (const event of ["schedule", "workflow_dispatch"]) {
      expect(decideReport({ event, issues: [open(12), open(9)] })).toEqual({ kind: "comment", number: 9 });
    }
  });

  test("別的標題的 open issue 不算", () => {
    expect(decideReport({ event: "schedule", issues: [open(3, FLAKY_TITLE)] })).toEqual({ kind: "create" });
  });

  test("dispatch 不新開：修復 PR 的 Fixes #N 已關 issue、驗證又紅 ⇒ 留言在最近關掉的，不連鎖再起 session", () => {
    const issues = [closed(5, "2026-10-01T00:00:00Z"), closed(8, "2026-10-10T00:00:00Z")];
    expect(decideReport({ event: "workflow_dispatch", issues })).toEqual({ kind: "comment", number: 8 });
    expect(decideReport({ event: "workflow_dispatch", issues: [] })).toEqual({ kind: "none" });
  });

  test("過時紅（跑的 commit 已非 dev HEAD）不新開", () => {
    expect(decideReport({ event: "schedule", issues: [], sha: "old", headSha: "new" })).toEqual({ kind: "none" });
    expect(
      decideReport({ event: "schedule", issues: [closed(4, "2026-10-01T00:00:00Z")], sha: "old", headSha: "new" }),
    ).toEqual({ kind: "comment", number: 4 });
  });
});

describe("decideChanged（畫面有變動：同一份畫面只講一次）", () => {
  const mark = (h) => `<!-- ptt-src-screens-hash: ${h} -->`;
  const ch = (i) => ({ ...i, title: CHANGED_TITLE });

  test("沒有任何 issue ⇒ 新開", () => {
    expect(decideChanged({ issues: [], hash: "h1" })).toEqual({ kind: "create" });
  });

  test("open 的已講過這份畫面 ⇒ 不寫；畫面又變了 ⇒ 留言", () => {
    const issue = ch({ ...open(7), texts: ["body " + mark("h1")] });
    expect(decideChanged({ issues: [issue], hash: "h1" })).toEqual({ kind: "none" });
    expect(decideChanged({ issues: [issue], hash: "h2" })).toEqual({ kind: "comment", number: 7 });
  });

  test("留言裡講過也算", () => {
    const issue = ch({ ...open(7), texts: ["body " + mark("h1"), "comment " + mark("h2")] });
    expect(decideChanged({ issues: [issue], hash: "h2" })).toEqual({ kind: "none" });
  });

  test("最近關掉的講過這份畫面（人看過、決定不更新）⇒ 不再開", () => {
    const issue = ch({ ...closed(3, "2026-10-01T00:00:00Z"), texts: [mark("h1")] });
    expect(decideChanged({ issues: [issue], hash: "h1" })).toEqual({ kind: "none" });
    expect(decideChanged({ issues: [issue], hash: "h2" })).toEqual({ kind: "create" });
  });

  test("失敗 issue 不算", () => {
    expect(decideChanged({ issues: [{ ...open(1), texts: [mark("h1")] }], hash: "h1" })).toEqual({ kind: "create" });
  });

  test("body 帶 marker、變動場景與處置", () => {
    const body = renderChangedBody({ event: "schedule", date: "2026-10-20", runUrl: "u", pttbbsSha: "abc", changed: "help_menu", hash: "h9" });
    expect(body).toContain(mark("h9"));
    expect(body).toContain("help_menu");
    expect(body).toContain("generate.sh");
  });
});

test("兩種 issue 的標題互不包含、label 不同，也和 flaky hunt 不同（routine 用標題篩，不能誤觸）", () => {
  expect(ISSUE_TITLE.includes(CHANGED_TITLE) || CHANGED_TITLE.includes(ISSUE_TITLE)).toBe(false);
  expect(new Set([ISSUE_LABEL, CHANGED_LABEL, FLAKY_LABEL]).size).toBe(3);
  expect(new Set([ISSUE_TITLE, CHANGED_TITLE, FLAKY_TITLE]).size).toBe(3);
});

describe("failedStage／renderBody：分清楚是環境紅還是解析器紅", () => {
  test("generate 沒成功 ⇒ generate（check 會是 skipped）", () => {
    expect(failedStage({ generate: "failure", check: "skipped" })).toBe("generate");
    expect(failedStage({ generate: "success", check: "failure" })).toBe("check");
    expect(failedStage({ generate: "success", check: "success" })).toBe(null);
  });

  test("body 帶 run、upstream commit、紅在哪一段與變動場景", () => {
    const body = renderBody({
      event: "schedule",
      date: "2026-10-20",
      runUrl: "https://example.test/run/1",
      sha: "abc",
      headSha: "abc",
      pttbbsSha: "3b8596b950c1e0421f24e2e38078837095a9e543",
      generate: "success",
      check: "failure",
      changed: "article help_menu",
    });
    expect(body).toContain("紅在 check");
    expect(body).toContain("https://example.test/run/1");
    expect(body).toContain("https://github.com/ptt/pttbbs/commit/3b8596b950c1e0421f24e2e38078837095a9e543");
    expect(body).toContain("article help_menu");
    expect(body).not.toContain("已非 dev HEAD");
    expect(renderBody({ event: "schedule", generate: "failure", check: "skipped" })).toContain("紅在 generate");
  });

  test("過時紅／手動觸發在 body 寫明為什麼沒開新 issue", () => {
    expect(renderBody({ event: "schedule", sha: "a", headSha: "b", generate: "success", check: "failure" })).toContain(
      "已非 dev HEAD",
    );
    expect(renderBody({ event: "workflow_dispatch", sha: "a", headSha: "a", generate: "success", check: "failure" })).toContain(
      "不開新 issue",
    );
  });
});

describe("ptt-src-screens.yml", () => {
  const yml = fs.readFileSync(path.join(__dirname, "../../.github/workflows/ptt-src-screens.yml"), "utf8");

  test("有排程與手動觸發", () => {
    expect(yml).toMatch(/^\s+schedule:\s*\n\s+- cron: "\d+ \d+ \* \* \*"/m);
    expect(yml).toMatch(/^\s+workflow_dispatch:/m);
  });

  test("report／changed job 只 sparse-checkout 自己那支，所以它不准 import 任何本地檔案（否則只在真的觸發時才炸）", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../scripts/ptt-src-screens-report.mjs"), "utf8");
    expect(src).not.toMatch(/^\s*import\b[^;]*from\s+["']\.{1,2}\//m);
    expect(yml.match(/sparse-checkout: scripts\/ptt-src-screens-report\.mjs\s*$/gm)).toHaveLength(2);
  });

  test("report 只在 dev 上的紅執行（PR 驗證紅不開 issue），changed 只在 dev 上全綠且有變動時執行", () => {
    expect(yml).toMatch(/if: failure\(\) && github\.ref == 'refs\/heads\/dev'/);
    expect(yml).toContain("node scripts/ptt-src-screens-report.mjs failure");
    expect(yml).toMatch(/if: success\(\) && needs\.generate\.outputs\.changed != '' && github\.ref == 'refs\/heads\/dev'/);
    expect(yml).toContain("node scripts/ptt-src-screens-report.mjs changed");
  });

  test("變動偵測把新產生（未追蹤）的 fixture 也算進去", () => {
    expect(yml).toContain('git add -N "$d"');
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

describe("tools/ptt-src-screens", () => {
  const dir = path.join(__dirname, "../../tools/ptt-src-screens");
  const gen = fs.readFileSync(path.join(dir, "generate.sh"), "utf8");

  test("conf 補上 PTT 實跑的 pfterm 與 pmore（少了 pmore，文章狀態列是 minimore 的「瀏覽 P.1」）", () => {
    expect(gen).toMatch(/#define USE_PFTERM\\n#define USE_PMORE/);
  });

  test("自帶 main 的物件檔自動排除（upstream 新增小程式時 generate 不會紅在重複的 main）", () => {
    expect(gen).toContain("nm \"$o\"");
    expect(gen).toContain("' T main$'");
  });

  test("按鍵等輸出靜止才送（不准固定睡）", () => {
    expect(gen).not.toMatch(/\bsleep\b/);
    expect(gen).toContain("capture.mjs");
  });
});
