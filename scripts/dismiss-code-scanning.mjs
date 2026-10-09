// 依 .github/code-scanning-dismissals.json 把 open 的 CodeQL 誤判 alert 自動 dismiss。
// 由 .github/workflows/code-scanning-dismiss.yml 在 GitHub Actions 上跑（GITHUB_TOKEN 給
// security-events: write 就夠，不需要 PAT）。雲端 Claude session 打不到 code scanning API
//（agent proxy 會換成 Claude App 的 token，沒有 security_events 權限），所以才放在 Actions。
//
// 用法：
//   node scripts/dismiss-code-scanning.mjs --dry-run   只印計畫，不寫入
//   node scripts/dismiss-code-scanning.mjs             真的 dismiss
//   --repo owner/name                                  預設取 env GITHUB_REPOSITORY
//
// exit code：0 正常／1 API 失敗／2 設定問題（缺 token／repo、清單格式錯）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const REASONS = ["false positive", "won't fix", "used in tests"];
export const COMMENT_MAX = 280;

class ConfigError extends Error {}

// 清單格式錯就整個不跑：寧可紅，也不要半套套用。
export function validateDismissals(list) {
  const errors = [];
  if (!Array.isArray(list)) return ["dismissals 必須是陣列"];
  list.forEach((d, i) => {
    const at = `dismissals[${i}]`;
    if (!d || typeof d.rule !== "string" || !d.rule) errors.push(`${at}.rule 缺漏`);
    if (!d || typeof d.path !== "string" || !d.path) errors.push(`${at}.path 缺漏`);
    if (!REASONS.includes(d?.reason)) errors.push(`${at}.reason 必須是 ${REASONS.join("／")}`);
    if (typeof d?.comment !== "string" || !d.comment) errors.push(`${at}.comment 缺漏`);
    else if ([...d.comment].length > COMMENT_MAX)
      errors.push(`${at}.comment 超過 ${COMMENT_MAX} 字元`);
  });
  return errors;
}

// 以 rule＋path 比對（行號會隨改動位移）。只回傳 open 且有對到清單的 alert。
export function planDismissals(alerts, list) {
  const plan = [];
  for (const a of alerts || []) {
    if (a.state !== "open") continue;
    const rule = a.rule?.id;
    const file = a.most_recent_instance?.location?.path;
    const hit = list.find(d => d.rule === rule && d.path === file);
    if (hit) plan.push({ number: a.number, rule, path: file, reason: hit.reason, comment: hit.comment });
  }
  return plan;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}

async function api(token, method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const repo = arg("repo") || process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const dryRun = process.argv.includes("--dry-run");
  if (!repo) throw new ConfigError("找不到 repo，請用 --repo owner/name 或設 GITHUB_REPOSITORY。");
  if (!token) throw new ConfigError("缺 GH_TOKEN／GITHUB_TOKEN。");

  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../.github/code-scanning-dismissals.json");
  const { dismissals } = JSON.parse(readFileSync(file, "utf8"));
  const errors = validateDismissals(dismissals);
  if (errors.length) throw new ConfigError(errors.join("\n"));

  const alerts = [];
  for (let page = 1; ; page++) {
    const batch = await api(token, "GET", `/repos/${repo}/code-scanning/alerts?state=open&per_page=100&page=${page}`);
    alerts.push(...batch);
    if (batch.length < 100) break;
  }
  const plan = planDismissals(alerts, dismissals);
  console.log(`open alert ${alerts.length} 則，清單對到 ${plan.length} 則${dryRun ? "（dry-run，不寫入）" : ""}`);
  for (const p of plan) {
    console.log(`#${p.number} ${p.rule} ${p.path} → ${p.reason}`);
    if (!dryRun) {
      await api(token, "PATCH", `/repos/${repo}/code-scanning/alerts/${p.number}`, {
        state: "dismissed",
        dismissed_reason: p.reason,
        dismissed_comment: p.comment,
      });
    }
  }
  for (const a of alerts) {
    if (!plan.some(p => p.number === a.number)) {
      console.log(`未在清單：#${a.number} ${a.rule?.id} ${a.most_recent_instance?.location?.path}`);
    }
  }
  return 0;
}

// 收尾不用 process.exit()，理由同 ci-status.mjs#finish。
async function finish(code) {
  process.exitCode = code;
  try {
    await globalThis[Symbol.for("undici.globalDispatcher.1")]?.close?.();
  } catch {
    /* exitCode 已經設好 */
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then(finish, e => {
    console.error(e.message);
    return finish(e instanceof ConfigError ? 2 : 1);
  });
}
