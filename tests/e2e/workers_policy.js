'use strict';

// playwright.config.js 的 `workers` 決策（純函式，unit 守護：tests/unit/e2e_workers_policy.test.js）。
//
// Playwright 的 `workers` 是**全域**設定，不能每個 project 各設，所以從命令列推導：
//   - 這一輪只跑 offline* project ⇒ 多 worker。offline 每條 test 自己開 page、
//     stub WebSocket 在 page 內、不寫檔不佔 port，彼此沒有相依性。
//   - 其餘一律 1：live 靠 worker-scoped 的共用 session（helpers/fixtures.js），
//     多一個 worker 就多一次登入，直接違反「整輪只登入一次」（PTT 登入頻率限制、
//     BOT 封鎖，見 CLAUDE.md 測試段）。**沒指定 --project 也算**（會跑到 live）。
// 判斷方向刻意是「證明全是 offline 才放開」，而不是「看到 live 才收緊」：
// 漏判只會變慢，不會多登入。
//
// 本機 '50%'＝邏輯核心數的一半；CI（GitHub ubuntu-latest 4 vCPU）用 4。實測 CI 2 workers
// 時 offline 13–14 分 → 8.3 分（只快 1.6 倍，本機 8 workers 快 4 倍）⇒ 2 沒吃滿 CPU。
// 逆境 job 在 workflow 另以 E2E_WORKERS 開更多（等延遲圖片不吃 CPU）。
// env E2E_WORKERS 可覆寫並行值（只影響「全是 offline」的情況；CLI `--workers` 本來就優先於 config）。

function projectsFromArgv(argv) {
  const projects = [];
  for (let i = 0; i < argv.length; i++) {
    const m = /^--project=(.+)$/.exec(argv[i]);
    if (m) projects.push(...m[1].split(','));
    else if (argv[i] === '--project' && argv[i + 1]) projects.push(...argv[++i].split(','));
  }
  return projects.map((p) => p.trim()).filter(Boolean);
}

function e2eWorkers(argv, env) {
  const projects = projectsFromArgv(argv);
  const offlineOnly = projects.length > 0 && projects.every((p) => p.startsWith('offline'));
  if (!offlineOnly) return 1;
  if (env.E2E_WORKERS) return parseWorkersEnv(env.E2E_WORKERS);
  return env.CI ? 4 : '50%';
}

// env 只能是字串，Playwright 的 config.workers 卻只收「正整數或百分比字串」——裸 "3"
// 會讓 config 載入丟錯。格式不合直接丟錯，不默默退回預設（否則 CI 設了等於沒設）。
function parseWorkersEnv(raw) {
  const v = String(raw).trim();
  if (/^[1-9]\d*$/.test(v)) return Number(v);
  if (/^[1-9]\d*%$/.test(v)) return v;
  throw new Error(`E2E_WORKERS 必須是正整數或百分比（如 4、50%），收到：${raw}`);
}

module.exports = { e2eWorkers, projectsFromArgv };
