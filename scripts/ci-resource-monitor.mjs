// CI runner 的資源取樣（.github/workflows/test.yml 的 e2e job）：判斷「整台機器變慢」是哪一種慢。
//
//   node scripts/ci-resource-monitor.mjs start    印機器規格，背景每 10s 取樣一次寫進 ci-diagnostics/
//   node scripts/ci-resource-monitor.mjs report   印摘要＋逐筆取樣（if: always()，綠的 run 也印，才有基準可比）
//
// 讀 /proc（Linux 限定；e2e job 跑在 Playwright Docker image 裡，容器共用 kernel ⇒ 數字是整台 runner 的），
// 不用 vmstat：image 裡不保證有 procps。判讀（docs/ci-troubleshooting.md「runner 變慢」）：
//   steal 高 ＝ CPU 被同一台實體主機上的其他 VM 搶走（換台機器才會好，重跑）；
//   user+sys 滿 ＝ 我們自己的瀏覽器／vite／模擬器吃滿 CPU（降 worker 數）；
//   iowait 高 ＝ 卡磁碟。
// 任何錯誤都不准讓 job 紅：這是診斷，不是測試。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_DIR = path.join(ROOT, "ci-diagnostics");
const LOG = path.join(OUT_DIR, "resources.jsonl");
const INTERVAL_MS = 10000;
const MAX_RUN_MS = 3 * 60 * 60 * 1000;

// ---- 純函式（unit 守護：tests/unit/ci_resource_monitor.test.js）----

// /proc/stat 第一行（彙總 cpu）→ 累計 jiffies。欄位順序見 proc(5)：
// user nice system idle iowait irq softirq steal（guest 已含在 user 裡，不另計）。
export function parseProcStat(text) {
  const line = String(text || "").split("\n").find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const [user, nice, system, idle, iowait, irq, softirq, steal] = line.trim().split(/\s+/).slice(1).map(Number);
  return { user: user + nice, system: system + irq + softirq, idle, iowait: iowait || 0, steal: steal || 0 };
}

// 兩次累計值之差 → 各類佔比（%，整數）。總差為 0（同一個 tick 內取兩次）⇒ null。
export function cpuPercent(prev, cur) {
  if (!prev || !cur) return null;
  const d = {};
  let total = 0;
  for (const k of Object.keys(cur)) {
    d[k] = Math.max(0, cur[k] - prev[k]);
    total += d[k];
  }
  if (!total) return null;
  const pct = (k) => Math.round((d[k] / total) * 100);
  return { user: pct("user"), system: pct("system"), iowait: pct("iowait"), steal: pct("steal"), idle: pct("idle") };
}

// /proc/meminfo → MemAvailable（MB）。
export function parseMemAvailableMb(text) {
  const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(String(text || ""));
  return m ? Math.round(Number(m[1]) / 1024) : null;
}

// 逐筆取樣 → 摘要。avg 看整體，max 抓尖峰（短暫被搶也會讓 page.goto 逾時）。
export function summarize(samples) {
  const cpu = samples.filter((s) => s.cpu);
  if (!cpu.length) return null;
  const stat = (k) => {
    const v = cpu.map((s) => s.cpu[k]);
    return { avg: Math.round(v.reduce((a, b) => a + b, 0) / v.length), max: Math.max(...v) };
  };
  return {
    samples: cpu.length,
    spanSec: Math.round((cpu[cpu.length - 1].t - cpu[0].t) / 1000),
    user: stat("user"),
    system: stat("system"),
    iowait: stat("iowait"),
    steal: stat("steal"),
    load1Max: Math.max(...samples.map((s) => s.load1 || 0)),
    memAvailMinMb: Math.min(...samples.map((s) => (s.memAvailMb == null ? Infinity : s.memAvailMb))),
  };
}

export function formatSample(s) {
  const time = new Date(s.t).toISOString().slice(11, 19);
  const c = s.cpu ? `us+sy ${String(s.cpu.user + s.cpu.system).padStart(3)}% wa ${String(s.cpu.iowait).padStart(3)}% st ${String(s.cpu.steal).padStart(3)}%` : "（首筆，無差值）";
  return `${time}  ${c}  load1 ${s.load1}  memAvail ${s.memAvailMb}MB`;
}

// ---- 以下有副作用 ----

const read = (f) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

function sampleLoop() {
  let prev = parseProcStat(read("/proc/stat"));
  const tick = () => {
    const cur = parseProcStat(read("/proc/stat"));
    const row = {
      t: Date.now(),
      cpu: cpuPercent(prev, cur),
      load1: Number(read("/proc/loadavg").split(" ")[0]) || 0,
      memAvailMb: parseMemAvailableMb(read("/proc/meminfo")),
    };
    prev = cur;
    try {
      fs.appendFileSync(LOG, JSON.stringify(row) + "\n");
    } catch {
      /* 目錄被清掉就算了 */
    }
  };
  setInterval(tick, INTERVAL_MS);
  // CI 收尾會殺掉它；本機誤跑 start 時也不准無限期留著。
  setTimeout(() => process.exit(0), MAX_RUN_MS).unref();
}

function start() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cpus = os.cpus();
  console.log(`CPU：${cpus.length} 核｜${cpus[0] ? cpus[0].model : "?"}`);
  console.log(`記憶體：${Math.round(os.totalmem() / 2 ** 20)}MB（可用 ${parseMemAvailableMb(read("/proc/meminfo"))}MB）`);
  console.log(`load：${read("/proc/loadavg").trim()}`);
  if (!fs.existsSync("/proc/stat")) {
    console.log("沒有 /proc/stat（非 Linux），不取樣。");
    return;
  }
  // detached＋unref：step 結束後繼續跑到 job 收尾（Actions 的 Cleaning up orphan processes）。
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "sample"], { detached: true, stdio: "ignore" });
  child.unref();
  console.log(`背景取樣中（每 ${INTERVAL_MS / 1000}s）→ ${path.relative(ROOT, LOG)}`);
}

function report() {
  const samples = read(LOG)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const s = summarize(samples);
  if (!s) {
    console.log(`沒有取樣資料（${path.relative(ROOT, LOG)}）：取樣進程沒起來或活不過 step？`);
    return;
  }
  console.log(
    `摘要（${s.samples} 筆／${s.spanSec}s）：user avg ${s.user.avg}% max ${s.user.max}%｜system avg ${s.system.avg}% max ${s.system.max}%｜` +
      `iowait avg ${s.iowait.avg}% max ${s.iowait.max}%｜steal avg ${s.steal.avg}% max ${s.steal.max}%｜load1 max ${s.load1Max}｜memAvail min ${s.memAvailMinMb}MB`
  );
  console.log("判讀：steal 高＝被同主機其他 VM 搶 CPU；user+sys 滿＝自己吃滿；iowait 高＝卡磁碟（docs/ci-troubleshooting.md）");
  for (const row of samples) console.log(formatSample(row));
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const cmd = process.argv[2];
  try {
    if (cmd === "start") start();
    else if (cmd === "report") report();
    else if (cmd === "sample") sampleLoop();
    else console.log("用法：ci-resource-monitor.mjs start|report");
  } catch (e) {
    console.log(`資源取樣失敗（不影響測試）：${e.message}`);
  }
}
