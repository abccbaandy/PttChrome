// 殺掉殘留的 Vite dev server（佔 8080 的孤兒 node 進程）。
// 雙重守門：先找佔 8080 的 PID，再驗該進程確實是 node+vite 才砍，
// 避免誤殺其他佔 8080 的服務（如 java）。永不 fail（一律 exit 0），CI 上無孤兒時是 no-op。
//
// 用法：node scripts/kill-dev-server.js（或 yarn kill:dev）。

const { execSync } = require('child_process');

const PORT = 8080;
const isWin = process.platform === 'win32';

// 安靜執行一段指令，回傳 stdout（trim）；失敗回空字串。
function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) {
    return '';
  }
}

// 解析「正在 listen PORT 的 PID」清單（純函式，unit test 守護：
// tests/unit/kill_dev_server_parse.test.js）。
//   netstat 行範例（Windows）：
//     TCP    0.0.0.0:8080    0.0.0.0:0    LISTENING    12345
//     TCP    [::1]:8080      [::]:0       LISTENING    12345
//   lsof（非 Windows，已加 -t -sTCP:LISTEN）：一行一個 PID。
//
// **本機位址一定要連 IPv6 一起看**：Vite 在 Windows 只綁 `[::1]:8080`，而
// `netstat -ano -p tcp` 只列 IPv4 → 舊版在這裡回空清單，`yarn kill:dev` 靜默
// 沒殺到任何東西（腳本一律 exit 0，連錯誤都不會冒出來）。故改用不帶 `-p` 的
// `netstat -ano`（IPv4+IPv6 全列），並在這裡自行篩 TCP/LISTENING。
function parseListeningPids(out, port, { lsof = false } = {}) {
  const pids = new Set();
  for (const raw of String(out).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (lsof) {
      if (/^\d+$/.test(line)) pids.add(line);
      continue;
    }
    if (!/^TCP\b/i.test(line)) continue;
    if (!/\bLISTENING\b/i.test(line)) continue;
    const cols = line.split(/\s+/);
    // 本機位址（cols[1]）的埠必須正好是 port——用整行比對會誤中遠端位址與
    // 「18080 / 80800」這種相鄰數字。
    const local = cols[1] || '';
    if (local.slice(local.lastIndexOf(':') + 1) !== String(port)) continue;
    const pid = cols[cols.length - 1];
    if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
  }
  return [...pids];
}

// 找出正在 listen PORT 的 PID 清單。
function findListeningPids() {
  return isWin
    ? parseListeningPids(sh('netstat -ano'), PORT)
    : parseListeningPids(sh(`lsof -ti tcp:${PORT} -sTCP:LISTEN`), PORT, {
        lsof: true,
      });
}

// 驗 PID 是否為 node 跑 vite 的進程。回傳 true 才砍。
function isDevServer(pid) {
  if (isWin) {
    const out = sh(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -ExpandProperty CommandLine)"`
    );
    return /node(\.exe)?\b/i.test(out) && /vite/i.test(out);
  }
  const out = sh(`ps -p ${pid} -o command=`);
  return /node\b/i.test(out) && /vite/i.test(out);
}

function kill(pid) {
  if (isWin) sh(`taskkill /PID ${pid} /T /F`);
  else sh(`kill -9 ${pid}`);
}

function main() {
  let pids;
  try {
    pids = findListeningPids();
  } catch (e) {
    return; // 工具不存在等 → 視為沒有孤兒
  }
  if (!pids.length) return; // 8080 沒人佔，靜默

  for (const pid of pids) {
    try {
      if (isDevServer(pid)) {
        kill(pid);
        console.log(`killed stale dev server on :${PORT} (pid ${pid})`);
      } else {
        console.log(`:${PORT} 被非 dev-server 進程佔用 (pid ${pid})，未動`);
      }
    } catch (e) {
      // 個別 PID 失敗不影響其他，吞掉
    }
  }
}

// 被 require（unit test 取用 parseListeningPids）時不可自己跑起來、更不可 exit。
if (require.main === module) {
  main();
  process.exit(0);
}

module.exports = { parseListeningPids };
