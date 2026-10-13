// Flaky Hunt（.github/workflows/flaky-hunt.yml）紅了之後，要在 issue「Nightly flaky hunt 失敗」
// 上做什麼。由 report job 執行：`node scripts/flaky-hunt-report.mjs`（env 見 main）。
//
// 「新開 issue」會觸發 routine「fix Nightly flaky hunt 失敗」起一個 Claude session。那個 session
// 修完會手動 dispatch Flaky Hunt 驗證；它的 PR 帶 `Fixes #N` 時，merge 進 dev 就已經把 issue 關了。
// 驗證若還紅、這裡又照常「沒有 open 的就開新的」⇒ 再 fire 一個 session ⇒ 連鎖。
// 所以只有排程（schedule）的紅能開新 issue；workflow_dispatch 只在既有 issue 上留言
// （open 的優先，否則最近一個 closed 的，**不 reopen**），一個都沒有就不寫，看 run 本身。
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ISSUE_TITLE = "Nightly flaky hunt 失敗";

// issues：`gh issue list --json number,title,state,closedAt` 的結果（搜尋是模糊比對，這裡再比全標題）。
// 回傳 { kind: "create" } ／ { kind: "comment", number } ／ { kind: "none" }。
export function decideReport({ event, issues }) {
  const same = (issues || []).filter((i) => i.title === ISSUE_TITLE);
  const open = same.filter((i) => String(i.state).toLowerCase() === "open").sort((a, b) => a.number - b.number);
  if (open.length) return { kind: "comment", number: open[0].number };
  if (event === "schedule") return { kind: "create" };
  const closed = same
    .filter((i) => String(i.state).toLowerCase() === "closed")
    .sort((a, b) => String(b.closedAt || "").localeCompare(String(a.closedAt || "")) || b.number - a.number);
  if (closed.length) return { kind: "comment", number: closed[0].number };
  return { kind: "none" };
}

export function renderBody({ event, date, runUrl, sha, results, repeat }) {
  const head =
    event === "schedule"
      ? `${date} 的 nightly 重複測試抓到偶發紅。`
      : `${date} 手動觸發（${event}）的 Flaky Hunt 仍然紅（多半是修正後的驗證 run）。依規則不開新 issue，以免再觸發一個 routine session。`;
  return [
    head,
    "",
    `- run: ${runUrl}`,
    `- commit: ${sha}`,
    `- 結果: ${results}`,
    `- 每個套件重複 ${repeat} 輪；測試框架不 retry，任一輪紅即為 flaky。`,
  ].join("\n");
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

function main(env) {
  const event = env.GITHUB_EVENT_NAME;
  const issues = JSON.parse(
    gh([
      "issue", "list", "--state", "all", "--limit", "100",
      "--search", `in:title "${ISSUE_TITLE}"`,
      "--json", "number,title,state,closedAt",
    ]),
  );
  const action = decideReport({ event, issues });
  const body = renderBody({
    event,
    date: new Date().toISOString().slice(0, 10),
    runUrl: env.RUN_URL,
    sha: env.GITHUB_SHA,
    results: env.RESULTS,
    repeat: env.REPEAT,
  });
  if (action.kind === "create") {
    gh(["issue", "create", "--title", ISSUE_TITLE, "--body", body]);
    console.log("開新 issue");
  } else if (action.kind === "comment") {
    gh(["issue", "comment", String(action.number), "--body", body]);
    console.log(`在 #${action.number} 留言`);
  } else {
    console.log(`${event} 觸發且沒有既有 issue：不開新的（避免觸發 routine），結果看 run 本身。`);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main(process.env);
