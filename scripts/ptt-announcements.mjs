// PttCurrent 公告 bot 的本機入口。正式環境是 Cloudflare Worker cron
// （proxy/ptt-announcements-worker），這支跑同一份 core.js，用來在本機驗解析或補跑。
// 設計見 docs/ptt-announcement-bot.md。
//
// 用法：
//   node scripts/ptt-announcements.mjs --dry-run  只印計畫，不寫入（沒 token 也能跑）
//   node scripts/ptt-announcements.mjs --seed     照常建 issue 但不 fire
//   node scripts/ptt-announcements.mjs            正常執行（需 GH_TOKEN＋兩個 routine 變數）
//   --repo owner/name                             預設取 git remote
//
// 環境變數：GH_TOKEN、CLAUDE_ROUTINE_FIRE_URL、CLAUDE_ROUTINE_TOKEN。
// exit code：0 正常（含沒有新公告）／1 抓取、解析、API 失敗／2 設定問題（缺 token、secret）。
// **抓到的不是 Atom（Cloudflare challenge 是 HTML）一律 exit 1**，不可當成「沒有新公告」。
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseRepoFromRemote } from "./ci-status.mjs";
import { sync, ConfigError } from "../proxy/ptt-announcements-worker/src/core.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

function gitRemote() {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function main() {
  const repo = arg("repo") || parseRepoFromRemote(gitRemote());
  if (!repo) throw new ConfigError("找不到 GitHub repo，請用 --repo owner/name。");
  const dryRun = flag("dry-run");
  if (dryRun && !process.env.GH_TOKEN) console.log("（沒有 GH_TOKEN：當作 repo 裡還沒有任何公告 issue）");
  await sync({
    fetch: globalThis.fetch,
    env: { ...process.env, GITHUB_REPO: repo },
    log: (m) => console.log(m),
    dryRun,
    seed: flag("seed"),
  });
  return 0;
}

// 收尾不用 process.exit()（Windows 上 undici keep-alive 會讓 exit code 變 127），
// 理由同 ci-status.mjs#finish。
async function finish(code) {
  process.exitCode = code;
  try {
    await globalThis[Symbol.for("undici.globalDispatcher.1")]?.close?.();
  } catch {
    /* exitCode 已經設好 */
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then(finish, (e) => {
    console.error(e.message);
    return finish(e instanceof ConfigError ? 2 : 1);
  });
}
