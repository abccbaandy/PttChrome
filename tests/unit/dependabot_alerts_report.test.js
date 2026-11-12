// Dependabot 警示通知的 issue 決策（scripts/dependabot-alerts-report.mjs）＋workflow 的設定
//（.github/workflows/dependabot-alerts.yml）。
import fs from "node:fs";
import path from "node:path";
import {
  decide,
  summarize,
  marker,
  markedNumbers,
  renderAlertBody,
  renderChangeComment,
  renderUnreadableBody,
  tableCell,
  alertsFirstUrl,
  nextPageUrl,
  ISSUE_TITLE,
  UNREADABLE_TITLE,
} from "../../scripts/dependabot-alerts-report.mjs";
import { ISSUE_TITLE as FLAKY_TITLE } from "../../scripts/flaky-hunt-report.mjs";
import { ISSUE_TITLE as SCREENS_TITLE, CHANGED_TITLE } from "../../scripts/ptt-src-screens-report.mjs";

const alert = (number, severity = "high", extra = {}) => ({
  number,
  state: "open",
  html_url: `https://github.com/o/r/security/dependabot/${number}`,
  dependency: { package: { name: `pkg${number}`, ecosystem: "npm" }, manifest_path: "yarn.lock", scope: "runtime" },
  security_advisory: { severity, summary: `漏洞 ${number}` },
  security_vulnerability: { severity, first_patched_version: { identifier: "1.2.3" } },
  ...extra,
});
const items = (...nums) => summarize(nums.map((n) => alert(n)));
const openIssue = (number, title, body = "") => ({ number, title, state: "OPEN", body });

describe("decide", () => {
  test("有警示、沒有 open issue ⇒ 新開", () => {
    expect(decide({ readable: true, items: items(3), issues: [] })).toEqual([{ kind: "create", title: ISSUE_TITLE }]);
  });

  test("有警示、open issue 的編號集合沒變 ⇒ 不寫（每天跑不洗留言）", () => {
    const issues = [openIssue(7, ISSUE_TITLE, `x\n${marker([5, 3])}`)];
    expect(decide({ readable: true, items: items(3, 5), issues })).toEqual([{ kind: "none", title: ISSUE_TITLE, number: 7 }]);
  });

  test("有警示、集合變了 ⇒ 更新 body，帶上一次的編號給留言用", () => {
    const issues = [openIssue(7, ISSUE_TITLE, marker([3]))];
    expect(decide({ readable: true, items: items(3, 5), issues })).toEqual([
      { kind: "update", title: ISSUE_TITLE, number: 7, before: [3] },
    ]);
  });

  test("沒有警示 ⇒ 關掉 open issue；沒有 open 就不做事", () => {
    expect(decide({ readable: true, items: [], issues: [openIssue(7, ISSUE_TITLE, marker([3]))] })).toEqual([
      { kind: "close", title: ISSUE_TITLE, number: 7 },
    ]);
    expect(decide({ readable: true, items: [], issues: [] })).toEqual([{ kind: "none", title: ISSUE_TITLE }]);
  });

  test("讀不到 ⇒ 開一則「讀不到」，已開就不重開；不動「待處理」那則（不知道是不是處理完了）", () => {
    expect(decide({ readable: false, items: [], issues: [] })).toEqual([{ kind: "create", title: UNREADABLE_TITLE }]);
    const issues = [openIssue(8, UNREADABLE_TITLE), openIssue(7, ISSUE_TITLE, marker([3]))];
    expect(decide({ readable: false, items: [], issues })).toEqual([{ kind: "none", title: UNREADABLE_TITLE }]);
  });

  test("讀得到了 ⇒ 關掉「讀不到」那則", () => {
    const issues = [openIssue(8, UNREADABLE_TITLE)];
    expect(decide({ readable: true, items: [], issues })).toEqual([
      { kind: "close", title: UNREADABLE_TITLE, number: 8 },
      { kind: "none", title: ISSUE_TITLE },
    ]);
  });

  test("別的 workflow 的 issue 不算", () => {
    const issues = [openIssue(1, FLAKY_TITLE), openIssue(2, SCREENS_TITLE)];
    expect(decide({ readable: true, items: items(3), issues })).toEqual([{ kind: "create", title: ISSUE_TITLE }]);
  });
});

test("標題不撞到其他自動 issue（routine 用標題篩觸發條件）", () => {
  for (const mine of [ISSUE_TITLE, UNREADABLE_TITLE]) {
    for (const other of [FLAKY_TITLE, SCREENS_TITLE, CHANGED_TITLE]) {
      expect(mine.includes(other) || other.includes(mine)).toBe(false);
    }
    expect(mine).not.toMatch(/PTT|flaky/i);
  }
});

test("summarize：只留 open、依嚴重度排序", () => {
  const out = summarize([alert(1, "low"), alert(2, "critical"), { ...alert(3), state: "dismissed" }, alert(4, "medium")]);
  expect(out.map((i) => [i.number, i.severity])).toEqual([
    [2, "critical"],
    [4, "medium"],
    [1, "low"],
  ]);
  expect(out[0]).toMatchObject({ pkg: "pkg2", ecosystem: "npm", manifest: "yarn.lock", patched: "1.2.3" });
});

test("body 帶 marker，讀回來是同一組編號；說明裡的 | 不弄壞表格", () => {
  const list = summarize([alert(9), alert(4, "high", { security_advisory: { severity: "high", summary: "a | b" } })]);
  const body = renderAlertBody({ items: list, date: "2026-11-12", runUrl: "u", repo: "o/r" });
  expect(markedNumbers(body)).toEqual([4, 9]);
  expect(body).toContain("a \\| b");
  expect(markedNumbers("沒有 marker")).toBeNull();
  expect(markedNumbers(marker([]))).toEqual([]);
});

test("tableCell：反斜線、|、換行都不弄壞表格", () => {
  expect(tableCell("a\\|b")).toBe("a\\\\\\|b");
  expect(tableCell("x\ny")).toBe("x y");
  expect(tableCell(undefined)).toBe("");
});

test("變動留言寫出新增與已處理", () => {
  const text = renderChangeComment({ before: [3, 4], items: items(4, 5), runUrl: "u" });
  expect(text).toContain("新增 #5");
  expect(text).toContain("已處理 #3");
});

test("讀不到的 body 寫明 secret 名稱與權限", () => {
  const body = renderUnreadableBody({ status: 403, runUrl: "u", repo: "o/r" });
  expect(body).toContain("DEPENDABOT_ALERTS_TOKEN");
  expect(body).toContain("Dependabot alerts: Read-only");
});

describe("dependabot-alerts.yml", () => {
  const yml = fs.readFileSync(path.join(__dirname, "../../.github/workflows/dependabot-alerts.yml"), "utf8");
  const workflow = fs.readFileSync(path.join(__dirname, "../../scripts/dependabot-alerts-report.mjs"), "utf8");

  test("PR 只 dry-run（PR 上不准開／關 issue）", () => {
    expect(yml).toMatch(/github\.event_name == 'pull_request' && '--dry-run'/);
  });

  test("兩個 token 都傳進去，secret 名稱與腳本一致", () => {
    expect(yml).toContain("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(yml).toContain("DEPENDABOT_ALERTS_TOKEN: ${{ secrets.DEPENDABOT_ALERTS_TOKEN }}");
    expect(workflow).toContain("env.DEPENDABOT_ALERTS_TOKEN");
  });

  test("腳本只 sparse-checkout 自己 ⇒ 不准 import 本地檔案", () => {
    expect(yml).toContain("sparse-checkout: scripts/dependabot-alerts-report.mjs");
    expect(workflow).not.toMatch(/from\s+["']\.{1,2}\//);
  });
});

// Dependabot alerts API 不吃 `page` 參數（帶了回 HTTP 400，token 對也一樣），只能照 Link header 的 cursor 翻頁。
describe("分頁", () => {
  test("第一頁網址不帶 page", () => {
    const u = new URL(alertsFirstUrl("o/r"));
    expect(u.pathname).toBe("/repos/o/r/dependabot/alerts");
    expect(u.searchParams.get("state")).toBe("open");
    expect(u.searchParams.get("per_page")).toBe("100");
    expect(u.searchParams.has("page")).toBe(false);
  });

  test("下一頁取 Link 的 rel=next；沒有就 null", () => {
    const link =
      '<https://api.github.com/repositories/1/dependabot/alerts?per_page=100&after=Y3Vy>; rel="next", ' +
      '<https://api.github.com/repositories/1/dependabot/alerts?per_page=100&before=Zm9v>; rel="prev"';
    expect(nextPageUrl(link)).toBe("https://api.github.com/repositories/1/dependabot/alerts?per_page=100&after=Y3Vy");
    expect(nextPageUrl('<https://x/a>; rel="prev"')).toBeNull();
    expect(nextPageUrl(null)).toBeNull();
  });
});
