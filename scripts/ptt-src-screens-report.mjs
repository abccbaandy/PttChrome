// PTT Source Screens（.github/workflows/ptt-src-screens.yml）紅了之後，要在 issue
// 「PTT 原始碼畫面檢查失敗」上做什麼。由 report job 執行：`node scripts/ptt-src-screens-report.mjs`。
//
// MVP：只開 issue 讓人看到，**不接 Claude routine**（標題／label 刻意和 flaky hunt 不同，
// 不會命中那邊的 trigger）。去重規則照 flaky hunt：
//   - 已有 open 的同名 issue ⇒ 只留言（upstream 沒修好前每天紅一次，不洗出一排 issue）；
//   - 沒有 open 的、且是 schedule ⇒ 新開；
//   - workflow_dispatch（驗證 run）且沒有 open 的 ⇒ 不寫，看 run 本身。
// 紅分兩種（body 會寫清楚）：generate 紅＝upstream build／driver 壞了（環境問題，修
// tools/ptt-src-screens/），check 紅＝upstream 的畫面讓本專案的解析器判錯（真的不相容）。
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ISSUE_TITLE = "PTT 原始碼畫面檢查失敗";
export const ISSUE_LABEL = "ptt-src-screens";

export function decideReport({ event, issues }) {
  const open = (issues || [])
    .filter((i) => i.title === ISSUE_TITLE && String(i.state).toLowerCase() === "open")
    .sort((a, b) => a.number - b.number);
  if (open.length) return { kind: "comment", number: open[0].number };
  if (event === "schedule") return { kind: "create" };
  return { kind: "none" };
}

// generate／check：job result（success／failure／cancelled／skipped）。
export function failedStage({ generate, check }) {
  if (generate !== "success") return "generate";
  if (check !== "success") return "check";
  return null;
}

export function renderBody({ event, date, runUrl, sha, pttbbsSha, generate, check }) {
  const stage = failedStage({ generate, check });
  const lines = [
    `${date}（${event}）用 upstream pttbbs ${pttbbsSha || "（未取得）"} 產生畫面並檢查，結果紅。`,
    "",
  ];
  if (stage === "generate") {
    lines.push(
      "**紅在 generate**：upstream 原始碼 build 不過或 driver 跑不起來（環境問題，還沒檢查到本專案的解析器）。",
      "修 `tools/ptt-src-screens/`（generate.sh／driver.c），本機重現：`sh tools/ptt-src-screens/generate.sh`。",
    );
  } else {
    lines.push(
      "**紅在 check**：upstream 產的畫面讓本專案的畫面判定／列表解析判錯（可能是真的不相容）。",
      "重現：`sh tools/ptt-src-screens/generate.sh && yarn vitest run tests/unit/ptt_src_screens.test.js`；",
      "先讀 upstream 對應的 commit 確認畫面怎麼變，再改解析器（新舊格式都要吃）並更新 repo 裡的 fixture。",
    );
  }
  lines.push(
    "",
    `- run: ${runUrl}`,
    `- 本專案 commit: ${sha}`,
    `- upstream pttbbs: ${pttbbsSha ? `https://github.com/ptt/pttbbs/commit/${pttbbsSha}` : "（未取得）"}`,
    `- 結果: generate=${generate} check=${check}`,
  );
  return lines.join("\n");
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

// label 與標題搜尋兩路結果依 number 去重：搜尋走索引，剛開的 issue 可能還查不到。
function mergeIssues(...lists) {
  const byNumber = new Map();
  for (const list of lists) for (const i of list || []) byNumber.set(i.number, i);
  return [...byNumber.values()];
}

function main(env) {
  const event = env.GITHUB_EVENT_NAME;
  const base = ["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title,state"];
  const issues = mergeIssues(
    JSON.parse(gh([...base, "--label", ISSUE_LABEL])),
    JSON.parse(gh([...base, "--search", `in:title "${ISSUE_TITLE}"`])),
  );
  const action = decideReport({ event, issues });
  const body = renderBody({
    event,
    date: new Date().toISOString().slice(0, 10),
    runUrl: env.RUN_URL,
    sha: env.GITHUB_SHA,
    pttbbsSha: env.PTTBBS_SHA,
    generate: env.GENERATE_RESULT,
    check: env.CHECK_RESULT,
  });
  if (action.kind === "create") {
    gh(["label", "create", ISSUE_LABEL, "--force", "--color", "5319e7", "--description", "PTT Source Screens 自動開的 issue"]);
    gh(["issue", "create", "--title", ISSUE_TITLE, "--label", ISSUE_LABEL, "--body", body]);
    console.log("開新 issue");
  } else if (action.kind === "comment") {
    gh(["issue", "comment", String(action.number), "--body", body]);
    console.log(`在 #${action.number} 留言`);
  } else {
    console.log(`${event} 觸發且沒有 open 的 issue：不開新的，結果看 run 本身。`);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main(process.env);
