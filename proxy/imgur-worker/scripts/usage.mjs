#!/usr/bin/env node
// 查 Worker 今日用量 vs 免費方案額度。
//
//   node scripts/usage.mjs [--days N]
//
// 憑證直接沿用 `wrangler login` 存下的 OAuth token，不需另外辦 API token。
// **本機沒有 jq，也不要用 curl|jq 拼**（見專案 CLAUDE.md 記載的踩坑：jq 不存在時
// 解析永遠是空字串，錯誤又被 2>/dev/null 吞掉，看起來像查不到）。
//
// 重要觀念：**快取命中不算一次 Worker invocation**（命中時 Worker 根本不執行），
// 所以這裡的 requests 是「真正跑了 Worker 的次數」，不是使用者發出的請求數。
// 額度算的就是這個數字。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const FREE_DAILY_LIMIT = 100_000;

const tokenPath = () => {
  const { APPDATA, XDG_CONFIG_HOME, HOME, USERPROFILE } = process.env;
  const bases = [
    XDG_CONFIG_HOME && join(XDG_CONFIG_HOME, ".wrangler"),
    APPDATA && join(APPDATA, "xdg.config", ".wrangler"),
    (HOME || USERPROFILE) && join(HOME || USERPROFILE, ".wrangler"),
  ].filter(Boolean);
  for (const b of bases) {
    const p = join(b, "config", "default.toml");
    try {
      readFileSync(p, "utf8");
      return p;
    } catch {}
  }
  return null;
};

// wrangler 的 OAuth **access token 壽命很短**（分鐘級），直接讀 default.toml 常常拿到
// 已過期的 → API 回 `9109 Invalid access token`。wrangler 自己會用 refresh_token 換新並
// 寫回檔案，所以過期時先跑一次 `wrangler whoami` 借它的手刷新，再重讀。
// （踩過：沒有這段時，腳本隔一陣子再跑就必定失敗。）
const readToken = () => {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;

  const p = tokenPath();
  if (!p) return null;
  const parse = () => {
    const raw = readFileSync(p, "utf8");
    const tok = /^oauth_token\s*=\s*"([^"]+)"/m.exec(raw);
    const exp = /^expiration_time\s*=\s*"([^"]+)"/m.exec(raw);
    return { token: tok ? tok[1] : null, expiresAt: exp ? Date.parse(exp[1]) : 0 };
  };

  let { token, expiresAt } = parse();
  // 留 60 秒緩衝：查詢本身要花時間，剛好卡在到期邊緣一樣會失敗。
  if (!token || !(expiresAt > Date.now() + 60_000)) {
    try {
      // 單一字串 + shell（不是 args 陣列）：Windows 上 npx 需要 shell，而傳 args 陣列
      // 又會觸發 Node 的 DEP0190 警告。這裡沒有外來輸入，字串固定。
      execSync("npx wrangler whoami", { stdio: "ignore" });
    } catch {}
    ({ token } = parse());
  }
  return token;
};

const api = async (token, path) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  if (!j.success) throw new Error(`API ${path}: ${JSON.stringify(j.errors)}`);
  return j.result;
};

const QUERY = `query($acc:String!,$from:Time!,$to:Time!){
  viewer{accounts(filter:{accountTag:$acc}){
    workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:$from,datetime_leq:$to}){
      sum{requests errors subrequests}
      dimensions{scriptName}
    }}}}`;

const main = async () => {
  const days = Number((process.argv.find((a) => a.startsWith("--days=")) || "").split("=")[1] || 1);
  const token = readToken();
  if (!token) {
    console.error("找不到 wrangler OAuth token，先跑 `npx wrangler login`。");
    process.exit(2);
  }

  // account id 動態取得：不硬編進 repo（專案隱私規範禁止寫入機器專屬細節）。
  const accounts = await api(token, "/accounts");
  const acc = accounts[0];

  // 免費方案額度以 UTC 午夜為界（超過回 Error 1027）。
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  from.setUTCHours(0, 0, 0, 0);

  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: { acc: acc.id, from: from.toISOString(), to: to.toISOString() },
    }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));

  const rows = j.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
  const total = rows.reduce((n, x) => n + x.sum.requests, 0);
  const errors = rows.reduce((n, x) => n + x.sum.errors, 0);
  const subs = rows.reduce((n, x) => n + x.sum.subrequests, 0);

  console.log(`區間 ${from.toISOString()} → ${to.toISOString()}（UTC，${days} 天）`);
  for (const x of rows) {
    console.log(`  ${x.dimensions.scriptName}: requests=${x.sum.requests} errors=${x.sum.errors} subrequests=${x.sum.subrequests}`);
  }
  const pct = ((total / FREE_DAILY_LIMIT) * 100).toFixed(3);
  console.log(`\nWorker 執行次數 ${total} / ${FREE_DAILY_LIMIT} 免費日額度 = ${pct}%`);
  console.log(`回源次數 ${subs}（= 快取沒命中的次數）／錯誤 ${errors}`);
  // Analytics 有數分鐘延遲，剛打的請求不會馬上出現——別把「數字沒動」當成沒計費。
  console.log("\n注意：Analytics 有數分鐘延遲；快取命中不會出現在這裡（Worker 未執行）。");
};

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
