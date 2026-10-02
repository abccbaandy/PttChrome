// PttCurrent 公告 bot 的 Cloudflare Worker 殼。邏輯全在 core.js；這裡只接 cron 與
// 一個手動入口。設計見 docs/ptt-announcement-bot.md。
//
// - scheduled：wrangler.jsonc 的 cron（每 6 小時）。成敗都交給 reportStatus：
//   失敗開 issue、恢復後自動關（cron 失敗只會進 Cloudflare log，沒人看）。
// - fetch：手動觸發。**沒設 MANUAL_TOKEN 一律 404**；有設時要帶
//   `Authorization: Bearer <MANUAL_TOKEN>`，`?dry_run=1` 只印計畫、`?seed=1` 不 fire。
//   用途是部署後從 Cloudflare 網路驗「抓得到 ptt.cc」，不必等 cron。
import { sync, reportStatus, ConfigError } from "./core.js";

// Workers 免費方案一次執行最多 50 個 subrequest；留 3 個給 reportStatus。
export const SUBREQUEST_LIMIT = 47;

async function run(env, opts, log) {
  try {
    const result = await sync({ fetch, env, log, subrequestLimit: SUBREQUEST_LIMIT, ...opts });
    if (!opts.dryRun) await reportStatus({ fetch, env, log });
    return { ok: true, result };
  } catch (error) {
    log(`失敗：${error.message}`);
    if (!opts.dryRun) await reportStatus({ fetch, env, error, log });
    return { ok: false, error };
  }
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      run(env, {}, (m) => console.log(m)).then((r) => {
        // 讓 Cloudflare 的 cron 紀錄也顯示失敗。
        if (!r.ok) throw r.error;
      }),
    );
  },

  async fetch(request, env) {
    if (!env.MANUAL_TOKEN) return new Response("Not Found", { status: 404 });
    if (request.headers.get("authorization") !== `Bearer ${env.MANUAL_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    const q = new URL(request.url).searchParams;
    const lines = [];
    const r = await run(env, { dryRun: q.get("dry_run") === "1", seed: q.get("seed") === "1" }, (m) => lines.push(m));
    const status = r.ok ? 200 : r.error instanceof ConfigError ? 500 : 502;
    return new Response(lines.join("\n") + "\n", {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
