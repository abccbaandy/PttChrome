// Flaky Hunt 的排程保證＋自動修復去重（.github/workflows/flaky-hunt.yml）。
//
// GitHub schedule 會延遲也可能被丟 ⇒ 掛多個 cron，由 gate job 去重（scripts/flaky-hunt-gate.mjs）；
// issue 卡住沒人修 ⇒ watchdog 通知（scripts/flaky-hunt-watchdog.mjs）。下面的靜態守護鎖的都是
// 「看起來多餘、容易被順手改回」的設定：
//   - cron ≥2 條且分鐘 ≠ 0：只剩一條＝被丟那天就沒有 nightly；整點＝全站排程尖峰，最容易延遲／被丟。
//   - cancel-in-progress: false：多個觸發同時在 dev 上時，true 會讓後到的砍掉先跑的，兩輪都跑不完。
//   - concurrency group 含 github.ref：不分 ref 時，session 在 PR branch dispatch 驗證會取消 dev 的
//     nightly（cancelled 不算 failure()，不開 issue，沒人知道），反之亦然。
//   - gate 存在且其他 job 都 needs 它：少一個 needs 就是那個 job 每天跑三次。
//   - watchdog 每次 run 都跑：放進 report（只在紅時跑）的話，連續幾天綠就永遠不提醒。
import fs from "node:fs";
import path from "node:path";
import { decideGate, windowStart } from "../../scripts/flaky-hunt-gate.mjs";
import { decideWatchdog, renderStalledComment, STALLED_LABEL } from "../../scripts/flaky-hunt-watchdog.mjs";
import { ISSUE_TITLE } from "../../scripts/flaky-hunt-report.mjs";

const yaml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "flaky-hunt.yml"), "utf8");

// 頂層 jobs: 底下每個 job 的區塊（兩格縮排的 key 到下一個同層 key）。
function jobs() {
  const body = yaml.slice(yaml.indexOf("\njobs:\n") + "\njobs:\n".length);
  const out = {};
  const re = /^  ([a-z0-9-]+):\n/gm;
  const marks = [...body.matchAll(re)];
  marks.forEach((m, i) => {
    out[m[1]] = body.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : undefined);
  });
  return out;
}

describe("workflow 靜態守護", () => {
  test("cron ≥2 條且分鐘都不是 0", () => {
    const crons = [...yaml.matchAll(/-\s*cron:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(crons.length).toBeGreaterThanOrEqual(2);
    for (const c of crons) expect(c.split(/\s+/)[0]).not.toBe("0");
  });

  test("concurrency 按 ref 分組且不 cancel-in-progress", () => {
    const conc = yaml.slice(yaml.indexOf("\nconcurrency:"), yaml.indexOf("\nenv:"));
    expect(conc).toMatch(/group:\s*\S*\$\{\{\s*github\.ref\s*\}\}/);
    expect(conc).toMatch(/cancel-in-progress:\s*false/);
  });

  test("gate job 存在，其餘 job（watchdog 以外）都 needs 它並在 skip 時跳過", () => {
    const all = jobs();
    expect(all.gate).toBeDefined();
    expect(all.gate).toMatch(/actions:\s*read/);
    expect(all.gate).toContain("node scripts/flaky-hunt-gate.mjs");
    // report 透過 needs 的三個測試 job 間接依賴 gate（gate 跳過 ⇒ 全 skipped ⇒ failure() 不成立）。
    for (const [name, block] of Object.entries(all)) {
      if (name === "gate" || name === "report") continue;
      expect(block, name).toMatch(/needs:\s*(\[[^\]]*\bgate\b[^\]]*\]|gate\b)/);
      if (name !== "watchdog") expect(block, name).toContain("needs.gate.outputs.skip != 'true'");
    }
    expect(all.report).toMatch(/needs:\s*\[unit-repeat, integration-repeat, e2e-offline-repeat\]/);
  });

  test("watchdog 不管紅綠都跑（always()），只在 dev", () => {
    const w = jobs().watchdog;
    expect(w).toBeDefined();
    expect(w).toMatch(/if:\s*always\(\) && github\.ref == 'refs\/heads\/dev'/);
    expect(w).toContain("node scripts/flaky-hunt-watchdog.mjs");
    expect(w).toMatch(/issues:\s*write/);
  });

  test("dispatch 可只跑單一 suite＋grep，grep 經 env 傳（不內插進 shell）", () => {
    expect(yaml).toMatch(/suite:\n(?:\s+.*\n)*?\s+options: \[all, unit, integration, e2e-offline\]/);
    expect(yaml).toMatch(/\n\s+grep:\n/);
    expect(yaml).not.toMatch(/run:[^\n]*\$\{\{\s*(github\.event\.)?inputs\.grep/);
    const j = jobs();
    expect(j["unit-repeat"]).toContain('"all","unit"');
    expect(j["integration-repeat"]).toContain('"all","integration"');
    expect(j["e2e-offline-repeat"]).toContain('"all","e2e-offline"');
  });
});

describe("windowStart（最近一次 UTC 21:00）", () => {
  test("21:00 之後 ⇒ 當天 21:00；之前 ⇒ 前一天 21:00", () => {
    expect(windowStart(new Date("2026-10-13T22:30:00Z")).toISOString()).toBe("2026-10-13T21:00:00.000Z");
    expect(windowStart(new Date("2026-10-13T21:00:00Z")).toISOString()).toBe("2026-10-13T21:00:00.000Z");
    expect(windowStart(new Date("2026-10-14T03:20:00Z")).toISOString()).toBe("2026-10-13T21:00:00.000Z");
    expect(windowStart(new Date("2026-11-01T09:17:00Z")).toISOString()).toBe("2026-10-31T21:00:00.000Z");
  });
});

describe("decideGate", () => {
  const now = new Date("2026-10-14T03:20:00Z"); // 窗起點 2026-10-13T21:00Z
  const run = (id, over = {}) => ({
    id,
    head_branch: "dev",
    created_at: "2026-10-13T21:30:00Z",
    status: "completed",
    conclusion: "success",
    ...over,
  });

  test("workflow_dispatch 永不跳過", () => {
    expect(decideGate({ event: "workflow_dispatch", runId: 100, now, runs: [run(50)] }).skip).toBe(false);
  });

  test("窗內有較早的 success／failure ⇒ 跳過", () => {
    expect(decideGate({ event: "schedule", runId: 100, now, runs: [run(50)] }).skip).toBe(true);
    expect(decideGate({ event: "schedule", runId: 100, now, runs: [run(50, { conclusion: "failure" })] }).skip).toBe(true);
  });

  test("較早的還在跑／排隊 ⇒ 跳過", () => {
    for (const status of ["in_progress", "queued"]) {
      expect(decideGate({ event: "schedule", runId: 100, now, runs: [run(50, { status, conclusion: null })] }).skip).toBe(true);
    }
  });

  test("cancelled 不算跑過", () => {
    expect(decideGate({ event: "schedule", runId: 100, now, runs: [run(50, { conclusion: "cancelled" })] }).skip).toBe(false);
  });

  test("排除自己、只看比自己早的：兩個觸發同時建立時不會互相跳過", () => {
    // 100 先、101 後，兩個同時 queued：100 看到 101 不能跳過，否則兩邊都跳過、那天一輪都沒跑。
    const runs = [run(100, { status: "in_progress", conclusion: null }), run(101, { status: "queued", conclusion: null })];
    expect(decideGate({ event: "schedule", runId: 100, now, runs }).skip).toBe(false);
    expect(decideGate({ event: "schedule", runId: 101, now, runs }).skip).toBe(true);
  });

  test("窗外（昨天）或非 dev 的 run 不算", () => {
    expect(decideGate({ event: "schedule", runId: 100, now, runs: [run(50, { created_at: "2026-10-13T20:59:59Z" })] }).skip).toBe(false);
    expect(decideGate({ event: "schedule", runId: 100, now, runs: [run(50, { head_branch: "claude/x" })] }).skip).toBe(false);
  });

  test("沒有任何 run ⇒ 照跑", () => {
    expect(decideGate({ event: "schedule", runId: 100, now, runs: [] }).skip).toBe(false);
  });
});

describe("decideWatchdog", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  const issue = (number, createdAt, labels = []) => ({
    number,
    title: ISSUE_TITLE,
    state: "OPEN",
    createdAt,
    labels: labels.map((name) => ({ name })),
  });

  test("open 超過 3 天、尚未標 flaky-stalled ⇒ 提醒", () => {
    expect(decideWatchdog({ issues: [issue(5, "2026-10-16T00:00:00Z")], now })).toEqual([5]);
  });

  test("未滿 3 天不提醒（看 createdAt，nightly 留言不重置）", () => {
    expect(decideWatchdog({ issues: [issue(5, "2026-10-17T00:00:01Z")], now })).toEqual([]);
  });

  test("已標 flaky-stalled ⇒ 只提醒一次", () => {
    expect(decideWatchdog({ issues: [issue(5, "2026-10-01T00:00:00Z", [STALLED_LABEL, "flaky-hunt"])], now })).toEqual([]);
  });

  test("closed 的不管", () => {
    expect(decideWatchdog({ issues: [{ ...issue(5, "2026-10-01T00:00:00Z"), state: "CLOSED" }], now })).toEqual([]);
  });

  test("留言 @ owner", () => {
    expect(renderStalledComment({ owner: "someone", runUrl: "u" })).toMatch(/^@someone /);
  });
});
