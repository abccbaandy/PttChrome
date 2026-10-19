// Flaky Hunt（.github/workflows/flaky-hunt.yml）的 gate job：今天的 nightly 已經跑過就跳過這一輪。
// 由 gate job 執行：`node scripts/flaky-hunt-gate.mjs`，把 `skip=true|false` 寫進 $GITHUB_OUTPUT。
//
// 為什麼要它：GitHub 的 schedule 高負載時會延遲（實測天天晚 ~3h、最多 +5h）也可能直接丟，
// 所以 workflow 掛了三個 cron（UTC 21:17／03:17／09:17）當備援。三個都觸發時只要第一個真的跑，
// 其餘只跑這個 gate 就結束。
//
// 「今天」＝自最近一次 UTC 21:00（原本 nightly 的時刻，台灣 05:00）起的 24 小時窗。
// 算「已經跑過」的 run：本 workflow、dev 上、在窗內建立、**id 比自己小**（較早建立），且
//   - conclusion ∈ {success, failure}（gate 跳過的 run conclusion 也是 success：它跳過是因為更早
//     的 run 算數，遞推回去窗內最早那輪是真的跑過的），或
//   - 還沒結束（in_progress／queued／…）。
// cancelled／timed_out 等不算（沒產生結論）。只看比自己早的：兩個觸發幾乎同時建立時，若互看
// 對方 queued 就會兩邊都跳過、那天一輪都沒跑。
// workflow_dispatch 永不跳過（手動就是要跑；在工作分支驗修正也要能跑）。
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOW_HOUR_UTC = 21;

const COUNTED_CONCLUSIONS = new Set(["success", "failure"]);
const UNFINISHED = new Set(["in_progress", "queued", "waiting", "pending", "requested"]);

// now 之前（含）最近一次 UTC WINDOW_HOUR_UTC:00。
export function windowStart(now) {
  const d = new Date(now);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), WINDOW_HOUR_UTC));
  if (start > d) start.setUTCDate(start.getUTCDate() - 1);
  return start;
}

// runs：runs API 的 workflow_runs（id、head_branch、created_at、status、conclusion）。
// 回傳 { skip, reason }。
export function decideGate({ event, runId, now, runs }) {
  if (event === "workflow_dispatch") return { skip: false, reason: "workflow_dispatch 永不跳過" };
  const since = windowStart(now);
  const self = Number(runId);
  const done = (runs || []).find(
    (r) =>
      Number(r.id) < self &&
      r.head_branch === "dev" &&
      new Date(r.created_at) >= since &&
      (COUNTED_CONCLUSIONS.has(r.conclusion) || UNFINISHED.has(r.status)),
  );
  if (done) {
    return { skip: true, reason: `run ${done.id}（${done.status}/${done.conclusion || "-"}）已涵蓋自 ${since.toISOString()} 起的這一輪` };
  }
  return { skip: false, reason: `自 ${since.toISOString()} 起 dev 上還沒有算數的 run` };
}

// Android 模擬器那條（android-repeat job）每週只跑一次：模擬器開機＋每輪成本高，每晚跑太貴；
// 但 test.yml 每個 PR 只跑一輪，低機率 flaky 永遠抓不到。窗起點（UTC 21:00）落在週六 ⇒
// 台灣週日 05:00 那一輪帶上 android。看的是窗起點而不是 now：三個備援 cron 不管哪個先跑，
// 判定都一樣。workflow_dispatch 只有明確選 suite=android 才跑。
export const ANDROID_WEEKDAY_UTC = 6;

export function decideAndroid({ event, now, suite }) {
  if (event === "workflow_dispatch") return suite === "android";
  return windowStart(now).getUTCDay() === ANDROID_WEEKDAY_UTC;
}

function main(env) {
  const now = new Date();
  let result;
  try {
    const since = windowStart(now).toISOString();
    const runs = JSON.parse(
      execFileSync(
        "gh",
        [
          "api",
          `repos/${env.GH_REPO}/actions/workflows/flaky-hunt.yml/runs?branch=dev&per_page=100&created=>=${since}`,
          "--jq",
          ".workflow_runs",
        ],
        { encoding: "utf8" },
      ),
    );
    result = decideGate({ event: env.GITHUB_EVENT_NAME, runId: env.GITHUB_RUN_ID, now, runs });
  } catch (e) {
    // 查不到就照跑：多跑一輪只花 runner 時間，少跑一輪那天就沒有 nightly。
    console.log(`::warning::gate 查詢失敗，照常執行：${e.message}`);
    result = { skip: false, reason: "查詢失敗（fail-open）" };
  }
  const android = decideAndroid({ event: env.GITHUB_EVENT_NAME, now, suite: env.SUITE });
  console.log(`skip=${result.skip}：${result.reason}`);
  console.log(`android=${android}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `skip=${result.skip}\nandroid=${android}\n`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main(process.env);
