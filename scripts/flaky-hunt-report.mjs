// Flaky Hunt（.github/workflows/flaky-hunt.yml）紅了之後，要在 issue「Nightly flaky hunt 失敗」
// 上做什麼。由 report job 執行：`node scripts/flaky-hunt-report.mjs`（env 見 main）。
//
// 「新開 issue」會觸發 routine「fix Nightly flaky hunt 失敗」起一個 Claude session。新開的條件
// 是同時成立：
//   1. 沒有 open 的同名 issue（有就只留言：修復期間再紅不重開 session）；
//   2. event 是 schedule。那個 session 修完會手動 dispatch Flaky Hunt 驗證；它的 PR 帶 `Fixes #N`
//      時，merge 進 dev 就已經把 issue 關了，驗證若還紅又照常新開 ⇒ 再 fire 一個 session ⇒ 連鎖；
//   3. 這輪跑的 commit 仍是 dev 的 HEAD。nightly 可能晚 3～5h 才開跑，跑的期間 session 已 merge
//      修正並關掉 issue ⇒ 這輪的紅是「過時紅」，新開只會讓下一個 session 重修已修好的東西。
// 不新開時：留言在 open 的那個，否則最近一個 closed 的（**不 reopen**），一個都沒有就不寫，看 run 本身。
//
// 找 issue 用 label `flaky-hunt`（建立時就掛上）：`gh issue list --search` 走搜尋索引，剛建立的
// issue 可能查不到，多個 cron 下兩個 run 會各開一個。搜尋結果仍併進來，涵蓋掛 label 前的舊 issue。
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ISSUE_TITLE = "Nightly flaky hunt 失敗";
export const ISSUE_LABEL = "flaky-hunt";

// issues：`gh issue list --json number,title,state,closedAt` 的結果（再比全標題）。
// sha／headSha：這輪跑的 commit 與 dev 目前的 HEAD。
// 回傳 { kind: "create" } ／ { kind: "comment", number } ／ { kind: "none" }。
export function decideReport({ event, issues, sha, headSha }) {
  const same = (issues || []).filter((i) => i.title === ISSUE_TITLE);
  const open = same.filter((i) => String(i.state).toLowerCase() === "open").sort((a, b) => a.number - b.number);
  if (open.length) return { kind: "comment", number: open[0].number };
  if (event === "schedule" && !isStale({ sha, headSha })) return { kind: "create" };
  const closed = same
    .filter((i) => String(i.state).toLowerCase() === "closed")
    .sort((a, b) => String(b.closedAt || "").localeCompare(String(a.closedAt || "")) || b.number - a.number);
  if (closed.length) return { kind: "comment", number: closed[0].number };
  return { kind: "none" };
}

export function isStale({ sha, headSha }) {
  return Boolean(sha && headSha && sha !== headSha);
}

export function renderBody({ event, date, runUrl, sha, headSha, ref, results, repeat }) {
  const lines = [
    event === "schedule"
      ? `${date} 的 nightly 重複測試抓到偶發紅。`
      : `${date} 手動觸發（${event}）的 Flaky Hunt 仍然紅（多半是修正後的驗證 run）。依規則不開新 issue，以免再觸發一個 routine session。`,
  ];
  if (isStale({ sha, headSha })) {
    lines.push(
      "",
      `**此 run 的 commit 已非 dev HEAD**（HEAD 現為 ${headSha}）：可能是修正 merge 前的過時紅，依規則不開新 issue；之後若再紅，回頭參考這則。`,
    );
  }
  lines.push(
    "",
    `- run: ${runUrl}`,
    `- ref: ${ref}`,
    `- commit: ${sha}`,
    `- 結果: ${results}`,
    `- 每個套件重複 ${repeat} 輪；測試框架不 retry，任一輪紅即為 flaky。`,
  );
  return lines.join("\n");
}

// 合併 label 與搜尋兩路結果、依 number 去重。
export function mergeIssues(...lists) {
  const byNumber = new Map();
  for (const list of lists) for (const i of list || []) byNumber.set(i.number, i);
  return [...byNumber.values()];
}

export function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

export function listFlakyIssues({ state, fields }) {
  const base = ["issue", "list", "--state", state, "--limit", "100", "--json", fields];
  return mergeIssues(
    JSON.parse(gh([...base, "--label", ISSUE_LABEL])),
    JSON.parse(gh([...base, "--search", `in:title "${ISSUE_TITLE}"`])),
  ).filter((i) => i.title === ISSUE_TITLE);
}

function main(env) {
  const event = env.GITHUB_EVENT_NAME;
  const sha = env.GITHUB_SHA;
  const headSha = gh(["api", `repos/${env.GH_REPO}/commits/dev`, "--jq", ".sha"]).trim();
  const issues = listFlakyIssues({ state: "all", fields: "number,title,state,closedAt" });
  const action = decideReport({ event, issues, sha, headSha });
  const body = renderBody({
    event,
    date: new Date().toISOString().slice(0, 10),
    runUrl: env.RUN_URL,
    sha,
    headSha,
    ref: env.GITHUB_REF,
    results: env.RESULTS,
    repeat: env.REPEAT,
  });
  if (action.kind === "create") {
    gh(["label", "create", ISSUE_LABEL, "--force", "--color", "d93f0b", "--description", "Nightly flaky hunt 自動開的 issue"]);
    gh(["issue", "create", "--title", ISSUE_TITLE, "--label", ISSUE_LABEL, "--body", body]);
    console.log("開新 issue");
  } else if (action.kind === "comment") {
    gh(["issue", "comment", String(action.number), "--body", body]);
    console.log(`在 #${action.number} 留言`);
  } else {
    console.log(`${event} 觸發（或過時紅）且沒有既有 issue：不開新的（避免觸發 routine），結果看 run 本身。`);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main(process.env);
