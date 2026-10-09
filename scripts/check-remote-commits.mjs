// SessionStart hook：開 session 時 fetch 目前分支的 upstream，remote 有新 commit 就提醒先 pull。
//   - 沒落後（或沒 upstream、fetch 失敗、離線）⇒ **stdout 完全空**（SessionStart 的 stdout 會注入
//     session context，沒事就不打擾）。
//   - 落後 ⇒ 輸出 SessionStart JSON：`additionalContext` 給 Claude（開工前先 pull）、
//     `systemMessage` 給使用者看。
// 只 fetch 不 pull：工作樹可能有未提交改動、或本地有未 push 的 commit，由 session 依情況處理。
// 沒 upstream 的分支（worktree 的 `claude/*` 新分支）不查：worktree 跟 base 同步走 ccd_host 的 sync 工具。
//
// 用法：
//   node scripts/check-remote-commits.mjs            hook 模式
//   --root <dir>                                     repo 根目錄（預設本檔上一層；測試用）
// 守護：tests/unit/check_remote_commits.test.js

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const FETCH_TIMEOUT_MS = 15_000;
export const MAX_LISTED = 10;

function git(cwd, args, timeout = 10_000) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

// 回傳 null ＝不提醒；否則 { upstream, behind, ahead, dirty, commits }
export function checkRemote(root) {
  let upstream;
  try {
    upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  } catch {
    return null; // 沒 upstream／detached
  }
  if (!upstream) return null;
  const remote = upstream.split('/')[0];
  const branch = upstream.slice(remote.length + 1);
  try {
    git(root, ['fetch', '--quiet', '--no-tags', remote, branch], FETCH_TIMEOUT_MS);
  } catch {
    return null; // 離線／其他 session 正在 fetch（lock）⇒ 不打擾
  }
  const [ahead, behind] = git(root, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])
    .split(/\s+/)
    .map(Number);
  if (!(behind > 0)) return null;
  const commits = git(root, ['log', '--oneline', '--no-decorate', `-${MAX_LISTED}`, `HEAD..${upstream}`])
    .split('\n')
    .filter(Boolean);
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']) !== '';
  return { upstream, behind, ahead, dirty, commits };
}

export function buildNotice(r) {
  if (!r) return null;
  const lines = [`[remote 有新 commit] ${r.upstream} 比本地 HEAD 多 ${r.behind} 個 commit：`];
  for (const c of r.commits) lines.push(`  ${c}`);
  if (r.behind > r.commits.length) lines.push(`  …（另 ${r.behind - r.commits.length} 個）`);
  if (r.ahead > 0) {
    lines.push(`本地另有 ${r.ahead} 個未 push 的 commit（已分岔）⇒ 用 \`git pull --rebase\`，有衝突先回報使用者。`);
  } else {
    lines.push('開工前先 `git pull --ff-only`。');
  }
  if (r.dirty) lines.push('工作樹有未提交改動：先 `git stash` → pull → `git stash pop`，或先問使用者。');
  return lines.join('\n');
}

function main(argv) {
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx >= 0 ? path.resolve(argv[rootIdx + 1]) : path.resolve(path.dirname(SELF), '..');
  const notice = buildNotice(checkRemote(root));
  if (!notice) return;
  process.stdout.write(
    JSON.stringify({
      systemMessage: notice.split('\n')[0] + '（已提醒 Claude 先 pull）',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `${notice}\n在處理使用者的第一個需求前，先告知使用者並完成 pull。`,
      },
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch {
    // hook 絕不可擋 session 啟動
  }
}
