'use strict';

// 多 session 並行的守門：判斷目前 checkout 是不是 git linked worktree。
// 規則（CLAUDE.md「多 session 並行」）：
//   - worktree 裡禁跑 e2e／integration／record／android（搶 8080、Docker 容器、
//     PTT 帳號與大量 CPU；Playwright 的 reuseExistingServer 還會靜默測到主目錄的 code）
//     ⇒ assertNotWorktree() 以 exit 2 拒絕，逃生門 ALLOW_WORKTREE_E2E=1。
//   - worktree 裡 unit 照跑但限流（unitLimits），完整驗證交給 CI。
// 守護 tests/unit/worktree_guard.test.js。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ALLOW_ENV = 'ALLOW_WORKTREE_E2E';

// linked worktree 的 `.git` 是檔案，內容 `gitdir: <主 repo>/.git/worktrees/<name>`。
// submodule 的 `.git` 也是檔案但指向 `.git/modules/…`，不算；主目錄的 `.git` 是資料夾。
function isLinkedWorktreeGitFile(content) {
  if (typeof content !== 'string') return false;
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  return !!m && /[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(m[1]);
}

// 直接讀、不先 stat：先 stat 再讀是 TOCTOU（CodeQL js/file-system-race）。
// `.git` 是資料夾（主目錄）時 readFileSync 丟 EISDIR，不存在丟 ENOENT ⇒ 一律 null。
function readGitFile(root) {
  try {
    return fs.readFileSync(path.join(root, '.git'), 'utf8');
  } catch (e) {
    return null;
  }
}

function isLinkedWorktree(root = ROOT) {
  return isLinkedWorktreeGitFile(readGitFile(root));
}

function isBlocked({ worktree, env = {} }) {
  return worktree && env[ALLOW_ENV] !== '1';
}

function worktreeBlockMessage(label) {
  return [
    `[worktree-guard] ${label} 不可在 git worktree 裡跑（exit 2，不是測試失敗）。`,
    '理由：會跟主目錄 session 搶 8080／Docker 容器／PTT 登入預算與 CPU，',
    '      且 Playwright 會沿用主目錄的 dev server ⇒ 測到別人的 code 卻回報綠。',
    '做法：worktree 只跑 `yarn test:unit`，完整測試交給 CI（push 分支 → 開 PR → `yarn ci:status --branch <分支>`）。',
    `逃生門（確定主目錄沒有在跑測試時）：${ALLOW_ENV}=1`,
  ].join('\n');
}

// 被禁的入口呼叫：worktree 且沒開逃生門 ⇒ 印訊息、exit 2。
function assertNotWorktree(label, { root = ROOT, env = process.env } = {}) {
  if (!isBlocked({ worktree: isLinkedWorktree(root), env })) return;
  console.error(worktreeBlockMessage(label));
  process.exit(2);
}

// worktree 裡 unit 的限流：worker 少、單條 timeout 放寬 ⇒ 不搶主 session 的 CPU，
// 被別人擠慢時只會變慢、不會 `Test timed out in 5000ms` 假紅。主目錄／CI 維持預設。
function unitLimits(worktree) {
  return worktree ? { maxWorkers: 2, testTimeout: 20000 } : {};
}

module.exports = {
  ALLOW_ENV,
  isLinkedWorktreeGitFile,
  isLinkedWorktree,
  readGitFile,
  isBlocked,
  worktreeBlockMessage,
  assertNotWorktree,
  unitLimits,
};
