// Flaky Hunt（.github/workflows/flaky-hunt.yml）的 watchdog job：「Nightly flaky hunt 失敗」issue
// 開太久就 @ repo owner 一次。由 watchdog job 執行：`node scripts/flaky-hunt-watchdog.mjs`。
//
// 為什麼要它：issue 新開會觸發 routine 起 Claude session 修；session 中途結束（時間或 context
// 用完、修 3 輪仍紅）時 issue 就一直開著，之後的 nightly 只在上面留言（留言不觸發 routine），
// 沒有任何人知道。`actions/stale` 看的是「多久沒動靜」，nightly 的留言會一直重置計時，不能用；
// 這裡看的是 createdAt。每次 run 都跑（不管紅綠）：flaky 頻率低時 nightly 可能連續幾天綠，
// report job 根本不會跑。用 label `flaky-stalled` 去重，只提醒一次。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gh, listFlakyIssues } from "./flaky-hunt-report.mjs";

export const STALLED_LABEL = "flaky-stalled";
export const STALL_DAYS = 3;

// issues：`gh issue list --json number,title,state,createdAt,labels`。回傳要提醒的 issue number。
export function decideWatchdog({ issues, now, days = STALL_DAYS }) {
  const cutoff = new Date(now).getTime() - days * 24 * 60 * 60 * 1000;
  return (issues || [])
    .filter((i) => String(i.state).toLowerCase() === "open")
    .filter((i) => new Date(i.createdAt).getTime() <= cutoff)
    .filter((i) => !(i.labels || []).some((l) => l.name === STALLED_LABEL))
    .map((i) => i.number)
    .sort((a, b) => a - b);
}

export function renderStalledComment({ owner, days = STALL_DAYS, runUrl }) {
  return [
    `@${owner} 這個 issue 已開超過 ${days} 天：自動修復的 session 可能中途結束了（時間／context 用完，或修了幾輪仍紅）。`,
    "之後的 nightly 只會在這裡留言、不會再觸發 routine，需要人接手：看最後一則狀態留言，決定重開 session 或手動處理。",
    "",
    `- 偵測的 run: ${runUrl}`,
    `- 已加上 label \`${STALLED_LABEL}\`，不會再提醒。`,
  ].join("\n");
}

function main(env) {
  const issues = listFlakyIssues({ state: "open", fields: "number,title,state,createdAt,labels" });
  const stalled = decideWatchdog({ issues, now: new Date() });
  if (!stalled.length) {
    console.log("沒有卡住的 issue。");
    return;
  }
  gh(["label", "create", STALLED_LABEL, "--force", "--color", "b60205", "--description", "Flaky hunt issue 開太久，需要人接手"]);
  for (const number of stalled) {
    gh(["issue", "edit", String(number), "--add-label", STALLED_LABEL]);
    gh(["issue", "comment", String(number), "--body", renderStalledComment({ owner: env.REPO_OWNER, runUrl: env.RUN_URL })]);
    console.log(`#${number} 已標 ${STALLED_LABEL} 並通知 @${env.REPO_OWNER}`);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main(process.env);
