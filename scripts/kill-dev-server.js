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

// 找出正在 listen PORT 的 PID 清單。
function findListeningPids() {
  const pids = new Set();
  if (isWin) {
    // netstat 行範例： TCP    0.0.0.0:8080    0.0.0.0:0    LISTENING    12345
    const out = sh('netstat -ano -p tcp');
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      if (!new RegExp(`[:.]${PORT}\\b`).test(line)) continue;
      const m = line.trim().split(/\s+/);
      const pid = m[m.length - 1];
      if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
    }
  } else {
    const out = sh(`lsof -ti tcp:${PORT} -sTCP:LISTEN`);
    for (const pid of out.split(/\r?\n/)) {
      if (/^\d+$/.test(pid)) pids.add(pid);
    }
  }
  return [...pids];
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

main();
process.exit(0);
