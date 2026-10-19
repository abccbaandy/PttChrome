// 把 `3rd_script/` 底下的參考 repo（pttbbs、ptt-term…）對齊到上游最新。
// SessionStart hook 每個新 session 跑一次；設計目標是 0 token／0 context：
//   - hook 模式（無參數）只 fork 一個 detached 背景 worker 就立刻 exit 0，**stdout 永遠空**
//     （SessionStart hook 的 stdout 會被注入 session context）。git fetch 不拖慢開 session。
//   - 結果只寫進 `3rd_script/.sync.log`（gitignored），要查時自己看。
//
// 為什麼不 `git pull`：上游作者會 rebase 後 force push（pttbbs 實測本地 master
// ahead 106／behind 114，ahead 那 106 個全是上游作者自己被改寫前的舊 commit），
// pull 必然 merge 衝突。我們對這些 repo 只讀不改 ⇒ fetch 後 `reset --hard` 到上游分支。
// 守門：tracked 檔有未提交改動就跳過不動（避免默默毀掉手動實驗），記進 log。
//
// 用法：
//   node scripts/sync-3rd-script.mjs            hook 模式（背景、無輸出、10 分鐘內節流）
//   node scripts/sync-3rd-script.mjs --now      前景同步並印結果（手動用，不節流）
//   --root <dir>                                專案根目錄（預設本檔上一層；測試用）
// 守護：tests/unit/sync_3rd_script.test.js

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
export const MIN_INTERVAL_MS = 10 * 60 * 1000;
const LOCK_STALE_MS = 15 * 60 * 1000;

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: opts.timeout ?? 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return '';
  }
}

// 3rd_script 底下「自己就是 repo 根」的直接子目錄（沒有 .git 的子目錄會落到外層
// 專案 repo，不能碰）。
export function listRepos(thirdDir) {
  if (!fs.existsSync(thirdDir)) return [];
  return fs
    .readdirSync(thirdDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(thirdDir, d.name, '.git')))
    .map((d) => path.join(thirdDir, d.name))
    .sort();
}

// 要對齊的上游 ref：目前分支的 upstream，沒有（detached 等）就用 origin/HEAD。
function upstreamRef(dir) {
  return (
    tryGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) ||
    tryGit(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  );
}

// 上游目前的預設分支（`ls-remote --symref <remote> HEAD`）；查不到（離線等）回 ''。
function remoteDefaultBranch(dir, remote) {
  const out = tryGit(dir, ['ls-remote', '--symref', remote, 'HEAD']);
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(out);
  return m ? m[1] : '';
}

// 對齊的是**上游的預設分支**，不是 clone 當時的分支：ptt/pttbbs 把 master 改名成 main
// 並刪掉 master 後，舊 clone 的 upstream（origin/master）消失、fetch 直接 fatal ⇒ 本地
// 永遠停在舊 master（只在 .sync.log 報錯，沒人會看）。上游換預設分支時把本地分支跟著
// 切過去；`--depth 1` 單分支 clone（cloud-setup.sh）的 fetch refspec 只寫死舊分支，要一起改。
export function syncRepo(dir) {
  const name = path.basename(dir);
  try {
    const tracked = upstreamRef(dir);
    const remote = tracked ? tracked.split('/')[0] : 'origin';
    const branch =
      remoteDefaultBranch(dir, remote) || (tracked ? tracked.slice(remote.length + 1) : '');
    if (!branch) return { name, status: 'skip', detail: 'no upstream' };
    if (git(dir, ['status', '--porcelain', '--untracked-files=no'])) {
      return { name, status: 'skip', detail: 'dirty working tree' };
    }
    const target = `${remote}/${branch}`;
    const specs = tryGit(dir, ['config', '--get-all', `remote.${remote}.fetch`]);
    if (!specs.includes('refs/heads/*') && !specs.includes(`refs/heads/${branch}:`)) {
      git(dir, ['remote', 'set-branches', remote, branch]);
    }
    const shallow = tryGit(dir, ['rev-parse', '--is-shallow-repository']) === 'true';
    git(dir, ['fetch', '--prune', '--force', '--quiet', ...(shallow ? ['--depth=1'] : []), remote], {
      timeout: 5 * 60_000,
    });
    if (target !== tracked) {
      const before = git(dir, ['rev-parse', 'HEAD']);
      const oldLocal = tryGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      git(dir, ['remote', 'set-head', remote, branch]);
      git(dir, ['checkout', '-q', '-B', branch, target]);
      git(dir, ['branch', '-q', `--set-upstream-to=${target}`, branch]);
      if (oldLocal && oldLocal !== 'HEAD' && oldLocal !== branch) tryGit(dir, ['branch', '-q', '-D', oldLocal]);
      const after = git(dir, ['rev-parse', 'HEAD']);
      return {
        name,
        status: 'ok',
        detail: `switched ${tracked || '(none)'} -> ${target} ${before.slice(0, 8)} -> ${after.slice(0, 8)}`,
      };
    }
    const before = git(dir, ['rev-parse', 'HEAD']);
    const after = git(dir, ['rev-parse', target]);
    if (before === after) return { name, status: 'ok', detail: `up-to-date ${target} ${after.slice(0, 8)}` };
    git(dir, ['reset', '--hard', '--quiet', target]);
    return { name, status: 'ok', detail: `reset ${target} ${before.slice(0, 8)} -> ${after.slice(0, 8)}` };
  } catch (e) {
    const msg = String(e.stderr || e.message || e).trim().split('\n').pop();
    return { name, status: 'error', detail: msg };
  }
}

export function syncAll(root) {
  return listRepos(path.join(root, '3rd_script')).map(syncRepo);
}

export function shouldRun(lastMs, nowMs, interval = MIN_INTERVAL_MS) {
  return !(lastMs > 0) || nowMs - lastMs >= interval;
}

function statMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// 跨 session 互斥：多個 session 同時開時只讓一個 worker 動 git（index.lock 會互撞）。
function acquireLock(lockFile) {
  if (statMtime(lockFile) && Date.now() - statMtime(lockFile) > LOCK_STALE_MS) {
    fs.rmSync(lockFile, { force: true });
  }
  try {
    fs.closeSync(fs.openSync(lockFile, 'wx'));
    return true;
  } catch {
    return false;
  }
}

function runWorker(root) {
  const thirdDir = path.join(root, '3rd_script');
  const lockFile = path.join(thirdDir, '.sync.lock');
  if (!acquireLock(lockFile)) return;
  try {
    fs.writeFileSync(path.join(thirdDir, '.sync-stamp'), '');
    const lines = syncAll(root).map((r) => `${r.status}\t${r.name}\t${r.detail}`);
    fs.writeFileSync(path.join(thirdDir, '.sync.log'), `${new Date().toISOString()}\n${lines.join('\n')}\n`);
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

function main(argv) {
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx >= 0 ? path.resolve(argv[rootIdx + 1]) : path.resolve(path.dirname(SELF), '..');
  const thirdDir = path.join(root, '3rd_script');

  if (argv.includes('--now')) {
    for (const r of syncAll(root)) console.log(`${r.status}\t${r.name}\t${r.detail}`);
    return;
  }
  if (argv.includes('--worker')) {
    runWorker(root);
    return;
  }
  // hook 模式：不輸出任何東西、不失敗。worktree／雲端沒有 3rd_script（gitignored）⇒ no-op。
  if (!fs.existsSync(thirdDir)) return;
  if (!shouldRun(statMtime(path.join(thirdDir, '.sync-stamp')), Date.now())) return;
  spawn(process.execPath, [SELF, '--worker', '--root', root], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch {
    // hook 絕不可擋 session 啟動
  }
}
