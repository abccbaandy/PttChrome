// 查 GitHub Actions 狀態（push 後必做，見 CLAUDE.md）。等 run 跑完、印每個 job
// 的結果，失敗時直接把失敗 step 的 log 尾巴撈出來。
//
// **為什麼是 Node 腳本而不是一行 curl|jq**：本機（Git Bash / PowerShell）**沒有
// jq 也沒有 gh**。過去多次用 `curl … | jq` 拼輪詢迴圈，jq 不存在 → 解析結果永遠
// 是空字串 → 迴圈判不出「跑完了沒」而空轉到逾時，而且錯誤常被 `2>/dev/null`
// 吞掉，看起來像 CI 卡住（其實 CI 早就綠了）。Node 是專案硬需求（>=20.19），
// 兩種 shell 都跑得動，故一律走這裡。
//
// 用法：
//   yarn ci:status                 等目前分支最新 run 跑完並回報
//   yarn ci:status --branch dev    指定分支
//   yarn ci:status --sha <sha>     只看某個 commit 的 run（短 sha / HEAD 也吃，會自動展開）
//   yarn ci:status --no-wait       只看當下狀態，不等
//   yarn ci:status --rerun-failed  跑完若失敗，自動重跑失敗 job（僅限已知 flaky）
//
// 需要環境變數 GH_TOKEN。exit code：0 全綠 / 1 有失敗 / 2 工具或設定問題
// （**刻意分開**，這樣「查不到」不會被誤讀成「沒問題」）。
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const API = "https://api.github.com";
const POLL_MS = 20000;
const DEFAULT_DEADLINE_MS = 15 * 60 * 1000;
// 剛 push 完 GitHub 建立 workflow run 有延遲（實測數秒~數十秒）。這段寬限期內
// 「查無 run」只當成「還沒建立」繼續等，不可直接 exit 2 —— 那會看起來像工具壞了
// 或 CI 沒被觸發，實際上再等幾秒就有了。
const RUN_APPEAR_GRACE_MS = 90000;
// 「runs API 已經回得到東西，但裡面**沒有本專案的 workflow run**」是另一種狀況，
// 需要遠比上面長的寬限期：2026-08-27 實測 push 事件到 `Deploy to GitHub Pages`
// run 被建立中間隔了 **11 分鐘**，這段期間 API 只回得到 CodeQL default setup 那顆
// （早已 completed/success）⇒ allSettled 成立 ⇒ 舊版直接印「CI 全綠」exit 0。
// 「本專案 CI 還沒開始跑」被回報成「全綠」，正是這支腳本刻意分三種 exit code 要
// 防的事。寧可在真的沒觸發時多等一會兒再 exit 2，也不可誤報綠。
const PROJECT_RUN_APPEAR_GRACE_MS = 12 * 60 * 1000;

// ---- 純函式（unit 守護：tests/unit/ci_status_parse.test.js）----

// git remote URL → "owner/repo"。https / ssh / 帶不帶 .git 都要吃。
export function parseRepoFromRemote(url) {
  if (!url) return null;
  const m = String(url)
    .trim()
    .match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

// runs API → 精簡列（給人看的一行）。
export function summarizeRuns(runs) {
  return (runs || []).map((r) => ({
    name: r.name,
    sha: String(r.head_sha || "").slice(0, 7),
    status: r.status,
    conclusion: r.conclusion,
    id: r.id,
    url: r.html_url,
  }));
}

// jobs API → 失敗的 job 與它失敗在哪個 step。
export function pickFailures(jobs) {
  const out = [];
  for (const j of jobs || []) {
    if (j.conclusion === "success" || j.conclusion === "skipped") continue;
    if (j.status !== "completed") continue;
    const step = (j.steps || []).find(
      (s) => s.conclusion && s.conclusion !== "success" && s.conclusion !== "skipped",
    );
    out.push({ id: j.id, name: j.name, conclusion: j.conclusion, step: step && step.name });
  }
  return out;
}

// 已知 flaky：integration job 的 Firebase Emulator 冷啟動逾時（CLAUDE.md 有記）。
// 認得出來才敢建議 rerun——其他失敗一律當真錯，不可自動重跑。
export function isKnownFlaky(jobName, log) {
  if (!/integration/i.test(String(jobName))) return false;
  return /waitForCloud timeout|not ready in \d+ms|emulator/i.test(String(log || ""));
}

// GitHub runs API 的 `head_sha` 參數**只吃完整 40 字元 SHA**：短 sha 一律回空陣列，
// 於是被誤報成「查無 run」exit 2（實際踩過：push 後 `--sha 398321f` 查不到，看起來
// 像 CI 沒被觸發，其實早就在跑）。caller 要先用 git rev-parse 展開再送 API。
export function isFullSha(s) {
  return /^[0-9a-f]{40}$/i.test(String(s || ""));
}

// 這顆 run 是不是「本專案 .github/workflows 底下的 workflow」。
//
// GitHub 的 default setup（CodeQL、Dependabot）會用 `dynamic/...` 這種虛擬 workflow
// 路徑、event 記成 `dynamic` —— 在 dev 上它叫「Push on dev」，很容易被誤認成本專案
// 的 CI。CLAUDE.md 已明寫它不算。判定「有沒有 CI 在跑」只能看本專案的 run，否則就
// 會像 2026-08-27 那次：deploy run 還沒建立，卻因為 CodeQL 那顆已完成而回報全綠。
// 兩個判準都用（event 與 path），任一命中就排除。
export function isProjectRun(run) {
  if (!run) return false;
  if (run.event === "dynamic") return false;
  if (/^dynamic\//.test(String(run.path || ""))) return false;
  return true;
}

export function projectRuns(runs) {
  return (runs || []).filter(isProjectRun);
}

// 全部 run 都完成才算完成（有 run 還在跑就要繼續等）。
export function allSettled(runs) {
  return (runs || []).length > 0 && runs.every((r) => r.status === "completed");
}

// ---- I/O ----

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

async function api(p, { raw = false, method = "GET" } = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok && !(raw && res.status === 404)) {
    throw new Error(`${method} ${p} → ${res.status} ${res.statusText}`);
  }
  return raw ? res.text() : res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 失敗 step 的 log 尾巴。整包 log 可能很大，只留最後 N 行——失敗訊息幾乎都在尾端。
async function tailJobLog(repo, jobId, lines = 40) {
  try {
    const text = await api(`/repos/${repo}/actions/jobs/${jobId}/logs`, { raw: true });
    return text.split(/\r?\n/).slice(-lines).join("\n");
  } catch (e) {
    return `（抓不到 log：${e.message}）`;
  }
}

async function main() {
  if (!process.env.GH_TOKEN) {
    console.error("GH_TOKEN 未設定——無法查 GitHub Actions。");
    return 2;
  }
  const repo =
    arg("repo") || parseRepoFromRemote(sh("git", ["remote", "get-url", "origin"]));
  if (!repo) {
    console.error("找不到 GitHub repo（git remote origin 解析失敗），請用 --repo owner/name。");
    return 2;
  }
  // 短 sha / HEAD / tag 名都先用本機 git 展開成完整 40 字元（見 isFullSha 的註解）。
  let sha = arg("sha");
  if (sha && !isFullSha(sha)) {
    const full = sh("git", ["rev-parse", sha]);
    if (!isFullSha(full)) {
      console.error(
        `--sha ${sha} 不是完整 40 字元 SHA，本機 git rev-parse 也解不出。\n` +
          "GitHub runs API 只吃完整 SHA，請給完整值（或先 git fetch 取得該 commit）。",
      );
      return 2;
    }
    console.log(`  --sha ${sha} → ${full}（GitHub API 只吃完整 SHA，已自動展開）`);
    sha = full;
  }
  const branch = arg("branch") || sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]) || "dev";
  const wait = !flag("no-wait");

  console.log(`repo=${repo} ${sha ? `sha=${sha.slice(0, 7)}` : `branch=${branch}`}`);

  let runs = [];
  const appearDeadline = Date.now() + RUN_APPEAR_GRACE_MS;
  const projectAppearDeadline = Date.now() + PROJECT_RUN_APPEAR_GRACE_MS;
  // CI 本身的逾時要從「本專案 run 真的出現」那一刻起算，不能把等 run 建立的時間
  // 也算進去 —— 2026-08-27 那次光等 run 建立就吃掉 11 分鐘，預設 15 分鐘的
  // deadline 只剩 4 分鐘，於是 run 一出現就馬上被判「等 CI 逾時」。
  let deadline = Date.now() + Number(arg("timeout-ms", DEFAULT_DEADLINE_MS));
  let sawProjectRun = false;
  for (;;) {
    // 指定 sha 一定要走 API 的 head_sha 參數：只抓最新 N 筆再自己過濾的話，
    // 稍舊的 commit 永遠落在頁外 → 誤報「查無 run」。
    const query = sha
      ? `head_sha=${encodeURIComponent(sha)}`
      : `branch=${encodeURIComponent(branch)}&per_page=10`;
    const data = await api(`/repos/${repo}/actions/runs?${query}`);
    const all = data.workflow_runs || [];
    // 同一個 commit 可能觸發多個 workflow（deploy + CodeQL）→ 全部都要看。
    const head = sha || (all[0] && all[0].head_sha);
    runs = all.filter((r) => r.head_sha === head);
    if (!runs.length) {
      // 剛 push 完 run 還沒建立 → 寬限期內繼續等，別把「還沒出現」當成「查不到」。
      if (wait && Date.now() < appearDeadline) {
        console.log(`  …run 尚未建立，等待中（${sha ? sha.slice(0, 7) : branch}）`);
        await sleep(POLL_MS);
        continue;
      }
      console.error(
        `查無 run（${sha ? sha : branch}）。` +
          (wait
            ? `已等 ${Math.round(RUN_APPEAR_GRACE_MS / 1000)}s 仍未建立。`
            : "（--no-wait：只看當下，未等待建立。）") +
          "\n可能原因：該 commit 未 push、workflow 未被觸發（例如由 GITHUB_TOKEN 產生的 push 不會遞迴觸發），或分支名有誤。",
      );
      return 2;
    }
    // runs 非空、但裡面沒有本專案的 workflow run（只有 CodeQL / Dependabot 的
    // default setup）＝本專案 CI 還沒被建立。**絕不可**因為那些 run 已完成就判全綠。
    const mine = projectRuns(runs);
    if (!mine.length) {
      if (wait && Date.now() < projectAppearDeadline) {
        console.log(
          `  …只查到 default setup 的 run（${runs.map((r) => r.name).join(", ")}），` +
            "本專案 workflow run 尚未建立，等待中",
        );
        await sleep(POLL_MS);
        continue;
      }
      console.error(
        `查無**本專案**的 workflow run（${sha ? sha : branch}）。` +
          `只有 GitHub default setup 的 run：${runs.map((r) => r.name).join(", ")}。` +
          (wait
            ? `已等 ${Math.round(PROJECT_RUN_APPEAR_GRACE_MS / 60000)} 分鐘仍未建立。`
            : "（--no-wait：只看當下，未等待建立。）") +
          "\n可能原因：workflow 未被觸發（例如由 GITHUB_TOKEN 產生的 push 不會遞迴觸發）、" +
          "workflow 被停用，或 GitHub 端事件延遲（實測可達 11 分鐘）。",
      );
      return 2;
    }
    if (!sawProjectRun) {
      // 本專案 run 首次出現 → CI 逾時從現在起算。
      sawProjectRun = true;
      deadline = Date.now() + Number(arg("timeout-ms", DEFAULT_DEADLINE_MS));
    }
    if (!wait || allSettled(runs)) break;
    if (Date.now() > deadline) {
      console.error("等 CI 逾時，以下是當下狀態：");
      break;
    }
    const pending = runs.filter((r) => r.status !== "completed").map((r) => r.name);
    console.log(`  …等待中：${pending.join(", ")}`);
    await sleep(POLL_MS);
  }

  let failed = false;
  for (const r of summarizeRuns(runs)) {
    const mark = r.conclusion === "success" ? "OK  " : r.status !== "completed" ? "... " : "FAIL";
    console.log(`${mark} ${r.name} [${r.sha}] ${r.conclusion || r.status}`);
    if (r.conclusion && r.conclusion !== "success") failed = true;
    if (r.status !== "completed") failed = true;
  }

  if (!failed) {
    console.log("CI 全綠。");
    return 0;
  }

  // 失敗 → 逐 run 挖失敗 job / step / log 尾巴。
  const flakyJobs = [];
  for (const r of runs) {
    const { jobs } = await api(`/repos/${repo}/actions/runs/${r.id}/jobs`);
    for (const f of pickFailures(jobs)) {
      console.log(`\n--- ${r.name} / ${f.name} → ${f.conclusion}（step: ${f.step || "?"}）`);
      const log = await tailJobLog(repo, f.id);
      console.log(log);
      if (isKnownFlaky(f.name, log)) flakyJobs.push({ runId: r.id, name: f.name });
    }
  }

  if (flakyJobs.length) {
    console.log(
      `\n偵測到已知 flaky（integration/emulator 冷啟動）：${flakyJobs.map((f) => f.name).join(", ")}`,
    );
    if (flag("rerun-failed")) {
      const ids = [...new Set(flakyJobs.map((f) => f.runId))];
      for (const id of ids) {
        await api(`/repos/${repo}/actions/runs/${id}/rerun-failed-jobs`, { method: "POST" });
        console.log(`已送出 rerun-failed-jobs（run ${id}）。`);
      }
    } else {
      console.log("確認非真錯後可加 --rerun-failed 重跑。");
    }
  }
  return 1;
}

// 收尾：**不可**用 process.exit()。Windows 上 Node 內建 fetch（undici）的 keep-alive
// socket 還開著時強制退出，會撞上 libuv 的
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
// 進程改回 **exit=127** —— 把這支刻意分的 0/1/2 整個蓋掉，「有失敗」和「工具問題」
// 都變成同一個看不懂的碼（實際踩過）。改設 process.exitCode 並主動收掉連線池，
// 讓 event loop 自然排空後以正確的碼退出。
async function finish(code) {
  process.exitCode = code;
  try {
    // Node 內部 symbol；版本改名時 optional chaining 讓它變 no-op，最多多等
    // keep-alive timeout，不會壞掉。
    await globalThis[Symbol.for("undici.globalDispatcher.1")]?.close?.();
  } catch {
    /* 收不掉就算了，exitCode 已經設好 */
  }
}

// 只有「直接執行」才跑 main——unit test import 純函式時**不可**連網或 exit。
const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then(finish, (e) => {
    console.error(e.message);
    return finish(2);
  });
}
