// Dependabot 警示通知（.github/workflows/dependabot-alerts.yml）。
// 由 workflow 執行：`node scripts/dependabot-alerts-report.mjs [--dry-run]`（env 見 main）。
// workflow 只 sparse-checkout 這一支 ⇒ **不准 import 任何本地檔案**。
//
// 目的：雲端 session 讀不到 Dependabot 警示（API 403），以前每輪摘要都要請人去 Security 頁看。
// 改成每天由 workflow 查一次，**有未處理的警示才**開／更新一個 issue，全部處理完就自動關掉：
//   - 有警示、沒有 open issue ⇒ 新開（body 列出每一則）；
//   - 有警示、已有 open issue ⇒ 警示清單（編號集合）沒變就不寫，變了就改 body＋留一則留言說明增減；
//   - 沒有警示 ⇒ 有 open issue 就留言後關掉，沒有就不做事。
// 讀警示的 token：先試 workflow 的 GITHUB_TOKEN，讀不到（403/404）再試 repo secret
// DEPENDABOT_ALERTS_TOKEN（只讀 Dependabot alerts 的 fine-grained token）。兩個都讀不到 ⇒
// 開（不重複開）一個「Dependabot 警示讀不到」issue 寫明要怎麼補 token；之後讀得到了就把它關掉。
// 標題刻意不含「PTT」「flaky」等字：不可撞到其他 workflow 的 issue／routine 觸發條件。
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ISSUE_TITLE = "Dependabot 警示待處理";
export const UNREADABLE_TITLE = "Dependabot 警示讀不到";
export const ISSUE_LABEL = "dependabot-alerts";

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];
const isOpen = (i) => String(i.state).toLowerCase() === "open";
const MARK_RE = /<!-- dependabot-alerts: ([\d,]*) -->/;

export const marker = (numbers) => `<!-- dependabot-alerts: ${[...numbers].sort((a, b) => a - b).join(",")} -->`;

export function markedNumbers(body) {
  const m = String(body || "").match(MARK_RE);
  if (!m) return null;
  return m[1] ? m[1].split(",").map(Number) : [];
}

// API 回的 alert → 只留 issue 要寫的欄位。
export function summarize(alerts) {
  return (alerts || [])
    .filter((a) => a && a.state === "open")
    .map((a) => ({
      number: a.number,
      severity: a.security_advisory?.severity || a.security_vulnerability?.severity || "unknown",
      pkg: a.dependency?.package?.name || "?",
      ecosystem: a.dependency?.package?.ecosystem || "?",
      manifest: a.dependency?.manifest_path || "?",
      scope: a.dependency?.scope || "",
      summary: a.security_advisory?.summary || "",
      patched: a.security_vulnerability?.first_patched_version?.identifier || "",
      url: a.html_url || "",
    }))
    .sort((a, b) => {
      const sa = SEVERITY_ORDER.indexOf(a.severity);
      const sb = SEVERITY_ORDER.indexOf(b.severity);
      return (sa < 0 ? 9 : sa) - (sb < 0 ? 9 : sb) || a.number - b.number;
    });
}

// readable：讀得到警示嗎。items：summarize() 的結果。issues：兩個標題的 issue（number,title,state,body）。
// 回要做的動作陣列：{ kind: "create"|"update"|"close"|"none", title, number? }。
export function decide({ readable, items, issues }) {
  const openOf = (title) =>
    (issues || []).filter((i) => i.title === title && isOpen(i)).sort((a, b) => a.number - b.number)[0];
  const alertIssue = openOf(ISSUE_TITLE);
  const unreadableIssue = openOf(UNREADABLE_TITLE);
  if (!readable) {
    // 讀不到時不動「待處理」那則：不知道警示是不是處理完了，關掉會誤報。
    return [unreadableIssue ? { kind: "none", title: UNREADABLE_TITLE } : { kind: "create", title: UNREADABLE_TITLE }];
  }
  const actions = [];
  if (unreadableIssue) actions.push({ kind: "close", title: UNREADABLE_TITLE, number: unreadableIssue.number });
  const now = (items || []).map((i) => i.number).sort((a, b) => a - b);
  if (!now.length) {
    actions.push(alertIssue ? { kind: "close", title: ISSUE_TITLE, number: alertIssue.number } : { kind: "none", title: ISSUE_TITLE });
  } else if (!alertIssue) {
    actions.push({ kind: "create", title: ISSUE_TITLE });
  } else {
    const before = markedNumbers(alertIssue.body);
    const same = before && before.length === now.length && before.every((n, k) => n === now[k]);
    actions.push(same ? { kind: "none", title: ISSUE_TITLE, number: alertIssue.number } : { kind: "update", title: ISSUE_TITLE, number: alertIssue.number, before: before || [] });
  }
  return actions;
}

// 表格儲存格：反斜線先跳脫（不然 "\\|" 會變成跳脫掉的反斜線＋真的分隔線）、| 跳脫、換行壓成空白。
export function tableCell(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

export function renderAlertBody({ items, date, runUrl, repo }) {
  const lines = [
    `${date} 查到 ${items.length} 則未處理的 Dependabot 警示（每天自動更新這則；全部處理完會自動關閉）。`,
    "",
    "| # | 嚴重度 | 套件 | 檔案 | 修正版 | 說明 |",
    "|---|---|---|---|---|---|",
    ...items.map(
      (i) =>
        `| [${i.number}](${i.url}) | ${i.severity} | ${i.pkg}（${i.ecosystem}${i.scope === "development" ? "，dev" : ""}） | \`${i.manifest}\` | ${i.patched || "（尚無）"} | ${tableCell(i.summary)} |`,
    ),
    "",
    "處置：傳遞相依在範圍內就 `yarn up -R <套件>`；`proxy/*/` 各自 `npm audit --package-lock-only`。",
    "確定不受影響的，在 Security 頁 dismiss 並寫理由。",
    "",
    `- 全部警示：https://github.com/${repo}/security/dependabot`,
    `- run: ${runUrl}`,
    "",
    marker(items.map((i) => i.number)),
  ];
  return lines.join("\n");
}

export function renderChangeComment({ before, items, runUrl }) {
  const now = new Set(items.map((i) => i.number));
  const was = new Set(before);
  const added = [...now].filter((n) => !was.has(n)).sort((a, b) => a - b);
  const gone = [...was].filter((n) => !now.has(n)).sort((a, b) => a - b);
  const parts = [];
  if (added.length) parts.push(`新增 ${added.map((n) => `#${n}`).join("、")}`);
  if (gone.length) parts.push(`已處理 ${gone.map((n) => `#${n}`).join("、")}`);
  return `警示有變動：${parts.join("；") || "清單更新"}（現在共 ${items.length} 則，表格已更新）。\n\nrun: ${runUrl}`;
}

export function renderUnreadableBody({ status, runUrl, repo }) {
  return [
    `Dependabot 警示 workflow 讀不到 \`repos/${repo}/dependabot/alerts\`（HTTP ${status}）。`,
    "",
    "workflow 的 GITHUB_TOKEN 讀不到時，要補一個只讀的 token：",
    "1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token；",
    `   Repository access 只選 \`${repo}\`，Permissions 只開 **Dependabot alerts: Read-only**。`,
    "2. repo → Settings → Secrets and variables → Actions → New repository secret，名稱 `DEPENDABOT_ALERTS_TOKEN`。",
    "3. Actions → Dependabot alerts → Run workflow 驗證；讀得到之後這則會自動關閉。",
    "",
    `- run: ${runUrl}`,
  ].join("\n");
}

// Dependabot alerts API 不吃 `page` 參數（帶了回 HTTP 400，token 對也一樣），只能照 Link header 的
// cursor（after）翻頁。
export function alertsFirstUrl(repo) {
  return `https://api.github.com/repos/${repo}/dependabot/alerts?state=open&per_page=100`;
}

export function nextPageUrl(link) {
  for (const part of String(link || "").split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

// ---- 以下只在 workflow 裡跑 ----

async function fetchAlerts(repo, token) {
  const all = [];
  let url = alertsFirstUrl(repo);
  for (let n = 0; url && n < 10; n++) {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    if (!res.ok) {
      let message = "";
      try {
        message = String((await res.json()).message || "");
      } catch {
        // 不是 JSON
      }
      return { ok: false, status: res.status, message };
    }
    all.push(...(await res.json()));
    url = nextPageUrl(res.headers.get("link"));
  }
  return { ok: true, alerts: all };
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

function listIssues() {
  const byNumber = new Map();
  for (const title of [ISSUE_TITLE, UNREADABLE_TITLE]) {
    const list = JSON.parse(
      gh(["issue", "list", "--state", "open", "--limit", "50", "--json", "number,title,state,body", "--search", `in:title "${title}"`]),
    );
    for (const i of list || []) if (i.title === title) byNumber.set(i.number, i);
  }
  for (const i of JSON.parse(gh(["issue", "list", "--state", "open", "--limit", "50", "--label", ISSUE_LABEL, "--json", "number,title,state,body"])) || [])
    byNumber.set(i.number, i);
  return [...byNumber.values()];
}

async function main(argv, env) {
  const dryRun = argv.includes("--dry-run");
  const repo = env.GH_REPO;
  const runUrl = env.RUN_URL;
  const date = new Date().toISOString().slice(0, 10);

  let read = { ok: false, status: "（沒有 token）" };
  for (const [name, token] of [
    ["GITHUB_TOKEN", env.GH_TOKEN],
    ["DEPENDABOT_ALERTS_TOKEN", env.DEPENDABOT_ALERTS_TOKEN],
  ]) {
    if (!token) continue;
    read = await fetchAlerts(repo, token);
    console.log(`${name}: ${read.ok ? `讀到 ${read.alerts.length} 則 open 警示` : `HTTP ${read.status} ${read.message || ""}`}`);
    if (read.ok) break;
  }
  const items = read.ok ? summarize(read.alerts) : [];
  const issues = listIssues();
  const actions = decide({ readable: read.ok, items, issues });
  for (const a of actions) console.log(`${dryRun ? "[dry-run] " : ""}${a.title}: ${a.kind}${a.number ? ` #${a.number}` : ""}`);
  if (dryRun) return;

  for (const a of actions) {
    if (a.kind === "create") {
      gh(["label", "create", ISSUE_LABEL, "--force", "--color", "d93f0b", "--description", "Dependabot 警示 workflow 自動開的 issue"]);
      const body = a.title === ISSUE_TITLE ? renderAlertBody({ items, date, runUrl, repo }) : renderUnreadableBody({ status: read.status, runUrl, repo });
      gh(["issue", "create", "--title", a.title, "--label", ISSUE_LABEL, "--body", body]);
    } else if (a.kind === "update") {
      gh(["issue", "edit", String(a.number), "--body", renderAlertBody({ items, date, runUrl, repo })]);
      gh(["issue", "comment", String(a.number), "--body", renderChangeComment({ before: a.before, items, runUrl })]);
    } else if (a.kind === "close") {
      const comment = a.title === ISSUE_TITLE ? `${date} 已沒有未處理的 Dependabot 警示，自動關閉。\n\nrun: ${runUrl}` : `${date} 已經讀得到警示，自動關閉。\n\nrun: ${runUrl}`;
      gh(["issue", "close", String(a.number), "--reason", "completed", "--comment", comment]);
    }
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2), process.env).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
