// SessionStart hook：開 session 時檢查兩件事，有狀況才提醒，沒事 **stdout 完全空**
// （SessionStart 的 stdout 會注入 session context，沒事就不打擾）：
//   1. remote 有新 commit：fetch 目前分支的 upstream，落後就要求先 pull；
//      新 commit 若動到 yarn.lock，順帶提醒 pull 完要 `yarn install`（@playwright/test 升版再加裝瀏覽器）。
//   2. 本地依賴沒跟上（不論有沒有落後；涵蓋「pull 了但忘了 install」）：
//      - yarn.lock 比 node_modules/.yarn-state.yml 新 ⇒ `yarn install`
//        （git 只重寫內容有變的檔，lock mtime 變新＝lock 內容在上次 install 之後改過）。
//      - node_modules 的 playwright-core 要求的 chromium／firefox revision 不在瀏覽器目錄 ⇒
//        `yarn playwright install chromium firefox`。
// 有狀況 ⇒ 輸出 SessionStart JSON：`additionalContext` 給 Claude、`systemMessage` 給使用者看。
// 只 fetch 不 pull／不 install：工作樹可能有未提交改動、或本地有未 push 的 commit，由 session 依情況處理。
// 沒 upstream 的分支（worktree 的 `claude/*` 新分支）不查 remote：worktree 跟 base 同步走 ccd_host 的 sync 工具。
//
// 用法：
//   node scripts/check-remote-commits.mjs            hook 模式
//   --root <dir>                                     repo 根目錄（預設本檔上一層；測試用）
// 守護：tests/unit/check_remote_commits.test.js

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const FETCH_TIMEOUT_MS = 15_000;
export const MAX_LISTED = 10;
// e2e 用到的瀏覽器（CLAUDE.md「測試」節：chromium 必裝、offline-firefox project 要 firefox）
const NEEDED_BROWSERS = ['chromium', 'firefox'];

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

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return '';
  }
}

// yarn.lock（Yarn berry 格式）原文 → @playwright/test 版本；找不到回 null
export function playwrightVersionFromLock(lock) {
  const m = /^"@playwright\/test@[^"\n]*":\n {2}version: (\S+)$/m.exec(lock || '');
  return m ? m[1] : null;
}

// 回傳 null ＝不提醒；否則 { upstream, behind, ahead, dirty, commits, lockChanged, playwright }
export function checkRemote(root) {
  const upstream = tryGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream) return null; // 沒 upstream／detached
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
  const lockChanged = tryGit(root, ['diff', '--name-only', `HEAD...${upstream}`, '--', 'yarn.lock']) !== '';
  let playwright = null;
  if (lockChanged) {
    const from = playwrightVersionFromLock(tryGit(root, ['show', 'HEAD:yarn.lock']));
    const to = playwrightVersionFromLock(tryGit(root, ['show', `${upstream}:yarn.lock`]));
    if (from !== to) playwright = { from, to };
  }
  return { upstream, behind, ahead, dirty, commits, lockChanged, playwright };
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Playwright 瀏覽器安裝目錄（與 playwright-core 的 registry 預設一致）
export function browsersDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0') return env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright');
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'ms-playwright');
}

// 回傳 { yarnInstall: bool, missingBrowsers: string[] }
export function checkLocalDeps(root, dir = browsersDir()) {
  const nm = path.join(root, 'node_modules');
  if (!fs.existsSync(path.join(root, 'yarn.lock'))) return { yarnInstall: false, missingBrowsers: [] };
  const state = mtime(path.join(nm, '.yarn-state.yml'));
  const yarnInstall = !state || mtime(path.join(root, 'yarn.lock')) > state;
  // node_modules 還沒對齊時，裡面的 browsers.json 是舊版的，判了也不準 ⇒ 交給 install 後的提示
  if (yarnInstall) return { yarnInstall, missingBrowsers: [] };
  const manifest = readJson(path.join(nm, 'playwright-core', 'browsers.json'));
  const missingBrowsers = (manifest?.browsers || [])
    .filter((b) => NEEDED_BROWSERS.includes(b.name))
    .filter((b) => !fs.existsSync(path.join(dir, `${b.name}-${b.revision}`)))
    .map((b) => b.name);
  return { yarnInstall, missingBrowsers };
}

export function buildNotice(remote, local = { yarnInstall: false, missingBrowsers: [] }) {
  const lines = [];
  if (remote) {
    lines.push(`[remote 有新 commit] ${remote.upstream} 比本地 HEAD 多 ${remote.behind} 個 commit：`);
    for (const c of remote.commits) lines.push(`  ${c}`);
    if (remote.behind > remote.commits.length) lines.push(`  …（另 ${remote.behind - remote.commits.length} 個）`);
    if (remote.ahead > 0) {
      lines.push(`本地另有 ${remote.ahead} 個未 push 的 commit（已分岔）⇒ 用 \`git pull --rebase\`，有衝突先回報使用者。`);
    } else {
      lines.push('開工前先 `git pull --ff-only`。');
    }
    if (remote.dirty) lines.push('工作樹有未提交改動：先 `git stash` → pull → `git stash pop`，或先問使用者。');
    if (remote.lockChanged) lines.push('新 commit 動到 yarn.lock ⇒ pull 完執行 `yarn install`。');
    if (remote.playwright) {
      lines.push(
        `@playwright/test 升版 ${remote.playwright.from} → ${remote.playwright.to} ⇒ install 後再執行 \`yarn playwright install chromium firefox\`。`,
      );
    }
  }
  // 已經會因 remote 提醒 install 的，就不重複講本地狀態
  const remoteSaysInstall = remote?.lockChanged;
  if (local.yarnInstall && !remoteSaysInstall) {
    lines.push('[依賴未更新] yarn.lock 比 node_modules 新（pull 後沒 install）⇒ 執行 `yarn install`。');
  }
  if (local.missingBrowsers.length) {
    lines.push(
      `[瀏覽器未安裝] Playwright 需要的 ${local.missingBrowsers.join('／')} 版本不在本機 ⇒ 執行 \`yarn playwright install ${local.missingBrowsers.join(' ')}\`。`,
    );
  }
  return lines.length ? lines.join('\n') : null;
}

function main(argv) {
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx >= 0 ? path.resolve(argv[rootIdx + 1]) : path.resolve(path.dirname(SELF), '..');
  const notice = buildNotice(checkRemote(root), checkLocalDeps(root));
  if (!notice) return;
  process.stdout.write(
    JSON.stringify({
      systemMessage: `${notice.split('\n')[0]}（已提醒 Claude 先處理）`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `${notice}\n在處理使用者的第一個需求前，先告知使用者並完成上述 pull／安裝。`,
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
