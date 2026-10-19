// PTT Source Screens（.github/workflows/ptt-src-screens.yml）之後要在 issue 上做什麼。
// 由 workflow 執行：`node scripts/ptt-src-screens-report.mjs [failure|changed]`（env 見 main）。
// report job 只 sparse-checkout 這一支 ⇒ **不准 import 任何本地檔案**。
//
// 兩種 issue，標題／label 刻意互不包含（routine 的 trigger 用標題篩）：
//
// 1. failure ─「PTT 原始碼畫面檢查失敗」（label ptt-src-screens）：generate 或 check 紅。
//    **新開會觸發 Claude routine** 起 session 修（docs/ptt-src-screens.md「routine」）。去重照 flaky hunt：
//      - 已有 open 的 ⇒ 只留言（修復期間每天再紅不重開 session；留言不觸發 routine）；
//      - 新開只在「schedule＋沒有 open＋這輪跑的 commit 仍是 dev HEAD」：
//        · workflow_dispatch 不新開：session 修完會 dispatch 驗證，它的 PR 帶 `Fixes #N` 時 merge 就
//          已把 issue 關了，驗證若還紅又新開 ⇒ 再 fire 一個 session ⇒ 連鎖；
//        · 過時紅不新開：nightly 晚開跑、跑的期間修正已 merge 並關掉 issue，新開只會重修已修好的東西；
//      - 不新開時留言在最近一個 closed 的（**不 reopen**），一個都沒有就不寫，看 run 本身。
//    紅分兩種（body 寫清楚）：generate 紅＝upstream build／driver 壞了（環境，修 tools/ptt-src-screens/），
//    check 紅＝upstream 的畫面讓本專案的解析器判錯（真的不相容）。
//
// 2. changed ─「PTT 原始碼畫面有變動」（label ptt-src-screens-changed）：全綠，但 upstream 產的畫面
//    跟 repo 裡的 fixture 不同＝upstream 改了畫面、解析器仍認得。低優先、**不接 routine**，只讓人知道
//    要更新 fixture。以畫面雜湊（body 裡的 marker）去重：同一份畫面只講一次（open 的或最近關掉的
//    已經講過就不寫），畫面又變了才在 open 的上留言／沒有 open 就新開。
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ISSUE_TITLE = "PTT 原始碼畫面檢查失敗";
export const ISSUE_LABEL = "ptt-src-screens";
export const CHANGED_TITLE = "PTT 原始碼畫面有變動";
export const CHANGED_LABEL = "ptt-src-screens-changed";

const isOpen = (i) => String(i.state).toLowerCase() === "open";
const isClosed = (i) => String(i.state).toLowerCase() === "closed";

function latestClosed(issues) {
  return issues
    .filter(isClosed)
    .sort((a, b) => String(b.closedAt || "").localeCompare(String(a.closedAt || "")) || b.number - a.number)[0];
}

export function isStale({ sha, headSha }) {
  return Boolean(sha && headSha && sha !== headSha);
}

// issues：`gh issue list --json number,title,state,closedAt`。sha／headSha：這輪跑的 commit 與 dev HEAD。
// 回 { kind: "create" } ／ { kind: "comment", number } ／ { kind: "none" }。
export function decideReport({ event, issues, sha, headSha }) {
  const same = (issues || []).filter((i) => i.title === ISSUE_TITLE);
  const open = same.filter(isOpen).sort((a, b) => a.number - b.number);
  if (open.length) return { kind: "comment", number: open[0].number };
  if (event === "schedule" && !isStale({ sha, headSha })) return { kind: "create" };
  const closed = latestClosed(same);
  if (closed) return { kind: "comment", number: closed.number };
  return { kind: "none" };
}

// generate／check：job result（success／failure／cancelled／skipped）。
export function failedStage({ generate, check }) {
  if (generate !== "success") return "generate";
  if (check !== "success") return "check";
  return null;
}

// changed：有變動的 fixture 名稱（空白分隔，generate job 的輸出）。
export function renderBody({ event, date, runUrl, sha, headSha, pttbbsSha, generate, check, changed }) {
  const stage = failedStage({ generate, check });
  const lines = [
    `${date}（${event}）用 upstream pttbbs ${pttbbsSha || "（未取得）"} 產生畫面並檢查，結果紅。`,
    "",
  ];
  if (stage === "generate") {
    lines.push(
      "**紅在 generate**：upstream 原始碼 build 不過或 driver 跑不起來（環境問題，還沒檢查到本專案的解析器）。",
      "修 `tools/ptt-src-screens/`（generate.sh／driver.c／capture.mjs），本機重現：`sh tools/ptt-src-screens/generate.sh`。",
    );
  } else {
    lines.push(
      "**紅在 check**：upstream 產的畫面讓本專案的畫面判定／解析器判錯（可能是真的不相容）。",
      "重現：`sh tools/ptt-src-screens/generate.sh && yarn vitest run tests/unit/ptt_src_screens.test.js`；",
      "先讀 upstream 對應的 commit 確認畫面怎麼變，再改解析器（新舊格式都要吃）並更新 repo 裡的 fixture。",
    );
  }
  if (changed) lines.push("", `畫面與 repo 裡的 fixture 不同的場景：${changed}`);
  if (isStale({ sha, headSha })) {
    lines.push(
      "",
      `**此 run 的 commit 已非 dev HEAD**（HEAD 現為 ${headSha}）：可能是修正 merge 前的過時紅，依規則不開新 issue；之後若再紅，回頭參考這則。`,
    );
  } else if (event !== "schedule") {
    lines.push("", "手動觸發的 run（多半是修正後的驗證）：依規則不開新 issue，以免再觸發一個 routine session。");
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

const HASH_MARK = (hash) => `<!-- ptt-src-screens-hash: ${hash} -->`;

// issues：changed 標題的 issue，各帶 texts（body＋所有留言）。hash：這輪產出的畫面雜湊。
export function decideChanged({ issues, hash }) {
  const same = (issues || []).filter((i) => i.title === CHANGED_TITLE);
  const seen = (i) => !!i && (i.texts || []).some((t) => String(t).includes(HASH_MARK(hash)));
  const open = same.filter(isOpen).sort((a, b) => a.number - b.number);
  if (open.length) return seen(open[0]) ? { kind: "none" } : { kind: "comment", number: open[0].number };
  if (seen(latestClosed(same))) return { kind: "none" };
  return { kind: "create" };
}

export function renderChangedBody({ event, date, runUrl, pttbbsSha, changed, hash }) {
  return [
    `${date}（${event}）用 upstream pttbbs ${pttbbsSha || "（未取得）"} 產生的畫面**全部檢查通過**，但跟 repo 裡的 fixture 不同：`,
    "upstream 改了這些畫面，本專案的解析器目前仍認得。",
    "",
    `- 有變動的場景：${changed}`,
    "- 處置：`sh tools/ptt-src-screens/generate.sh`（或下載 run 的 artifact `ptt-src-screens-fixtures`）→ 看 `git diff` 確認",
    "  upstream 改了什麼（讀 upstream 對應的 commit）→ 開 PR 更新 `tests/unit/fixtures/ptt_src_screens/`；",
    "  變動若是本專案還沒用到的新元素，順手在 `tests/unit/ptt_src_screens.test.js` 補斷言。",
    `- run: ${runUrl}`,
    `- upstream pttbbs: ${pttbbsSha ? `https://github.com/ptt/pttbbs/commit/${pttbbsSha}` : "（未取得）"}`,
    "",
    HASH_MARK(hash),
  ].join("\n");
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

// label 與標題搜尋兩路結果依 number 去重：搜尋走索引，剛開的 issue 可能還查不到。
function listIssues({ title, label, fields }) {
  const base = ["issue", "list", "--state", "all", "--limit", "100", "--json", fields];
  const byNumber = new Map();
  for (const list of [
    JSON.parse(gh([...base, "--label", label])),
    JSON.parse(gh([...base, "--search", `in:title "${title}"`])),
  ])
    for (const i of list || []) byNumber.set(i.number, i);
  return [...byNumber.values()].filter((i) => i.title === title);
}

function post({ action, title, label, color, description, body }) {
  if (action.kind === "create") {
    gh(["label", "create", label, "--force", "--color", color, "--description", description]);
    gh(["issue", "create", "--title", title, "--label", label, "--body", body]);
    console.log(`開新 issue「${title}」`);
  } else if (action.kind === "comment") {
    gh(["issue", "comment", String(action.number), "--body", body]);
    console.log(`在 #${action.number} 留言`);
  }
}

function mainFailure(env, common) {
  const headSha = gh(["api", `repos/${env.GH_REPO}/commits/dev`, "--jq", ".sha"]).trim();
  const issues = listIssues({ title: ISSUE_TITLE, label: ISSUE_LABEL, fields: "number,title,state,closedAt" });
  const action = decideReport({ event: common.event, issues, sha: env.GITHUB_SHA, headSha });
  const body = renderBody({
    ...common,
    sha: env.GITHUB_SHA,
    headSha,
    generate: env.GENERATE_RESULT,
    check: env.CHECK_RESULT,
  });
  post({ action, title: ISSUE_TITLE, label: ISSUE_LABEL, color: "5319e7", description: "PTT Source Screens 自動開的 issue（觸發 routine）", body });
  if (action.kind === "none")
    console.log(`${common.event} 觸發（或過時紅）且沒有既有 issue：不開新的（避免觸發 routine），結果看 run 本身。`);
}

function mainChanged(env, common) {
  const hash = env.SCREENS_HASH;
  if (!hash || !common.changed) throw new Error("changed 模式需要 SCREENS_HASH 與 CHANGED");
  const issues = listIssues({ title: CHANGED_TITLE, label: CHANGED_LABEL, fields: "number,title,state,closedAt" });
  // 只有 open 的與最近關掉的需要比對 marker（decideChanged 只看這兩個）。
  const wanted = new Set([
    ...issues.filter(isOpen).map((i) => i.number),
    ...[latestClosed(issues)].filter(Boolean).map((i) => i.number),
  ]);
  for (const i of issues) {
    if (!wanted.has(i.number)) continue;
    const v = JSON.parse(gh(["issue", "view", String(i.number), "--json", "body,comments"]));
    i.texts = [v.body, ...(v.comments || []).map((c) => c.body)];
  }
  const action = decideChanged({ issues, hash });
  const body = renderChangedBody({ ...common, hash });
  post({ action, title: CHANGED_TITLE, label: CHANGED_LABEL, color: "c5def5", description: "upstream 改了畫面、解析器仍認得（低優先，更新 fixture）", body });
  if (action.kind === "none") console.log("這份畫面已經通知過：不寫。");
}

function main(argv, env) {
  const mode = argv[0] || "failure";
  const common = {
    event: env.GITHUB_EVENT_NAME,
    date: new Date().toISOString().slice(0, 10),
    runUrl: env.RUN_URL,
    pttbbsSha: env.PTTBBS_SHA,
    changed: (env.CHANGED || "").trim(),
  };
  if (mode === "failure") mainFailure(env, common);
  else if (mode === "changed") mainChanged(env, common);
  else throw new Error(`未知模式 ${mode}`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main(process.argv.slice(2), process.env);
