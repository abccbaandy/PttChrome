// 守護 scripts/check-remote-commits.mjs（SessionStart hook）：
//   1. remote 沒新 commit ⇒ stdout 必須完全空（不打擾 session）。
//   2. remote 有新 commit ⇒ 輸出 SessionStart JSON，additionalContext 要求先 pull。
//   3. 沒 upstream ⇒ 靜默。分岔／dirty 給對應指示。
//   4. 依賴升版：新 commit 動 yarn.lock ⇒ 提醒 install；本地 node_modules／Playwright 瀏覽器沒跟上 ⇒ 提醒。
// 用真 git repo（暫存目錄），不 mock。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browsersDir, buildNotice, checkLocalDeps, checkRemote } from '../../scripts/check-remote-commits.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-remote-commits.mjs', import.meta.url));
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const runHook = (root) =>
  execFileSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let tmp;
let upstream;
let author;
let local;

function commit(dir, file, msg) {
  fs.writeFileSync(path.join(dir, file), `${msg}\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', msg);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chkremote-'));
  upstream = path.join(tmp, 'upstream.git');
  author = path.join(tmp, 'author');
  local = path.join(tmp, 'local');
  git(tmp, 'init', '--bare', '-b', 'dev', upstream);
  git(tmp, 'clone', '-q', upstream, author);
  git(author, 'checkout', '-qb', 'dev');
  commit(author, 'a.txt', 'one');
  git(author, 'push', '-q', '-u', 'origin', 'dev');
  git(tmp, 'clone', '-q', '-b', 'dev', upstream, local);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('check-remote-commits', () => {
  test('remote 沒新 commit ⇒ stdout 完全空', () => {
    expect(checkRemote(local)).toBeNull();
    expect(runHook(local)).toBe('');
  });

  test('remote 有新 commit ⇒ 輸出 SessionStart JSON 要求先 pull', () => {
    commit(author, 'b.txt', 'two');
    commit(author, 'c.txt', 'three');
    git(author, 'push', '-q');
    const out = JSON.parse(runHook(local));
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('origin/dev 比本地 HEAD 多 2 個 commit');
    expect(ctx).toContain('two');
    expect(ctx).toContain('three');
    expect(ctx).toContain('git pull --ff-only');
    expect(out.systemMessage).toContain('origin/dev');
    // 只 fetch 不 pull
    expect(fs.existsSync(path.join(local, 'b.txt'))).toBe(false);
  });

  test('沒 upstream 的分支 ⇒ 靜默', () => {
    commit(author, 'b.txt', 'two');
    git(author, 'push', '-q');
    git(local, 'checkout', '-qb', 'claude/x', 'HEAD');
    expect(runHook(local)).toBe('');
  });

  test('本地有未 push commit 且分岔 ⇒ 指示 rebase；dirty ⇒ 指示 stash', () => {
    commit(author, 'b.txt', 'two');
    git(author, 'push', '-q');
    commit(local, 'l.txt', 'local');
    fs.writeFileSync(path.join(local, 'a.txt'), 'edited\n');
    const r = checkRemote(local);
    expect(r).toMatchObject({ upstream: 'origin/dev', behind: 1, ahead: 1, dirty: true });
    const notice = buildNotice(r);
    expect(notice).toContain('git pull --rebase');
    expect(notice).toContain('git stash');
  });

  test('新 commit 動到 yarn.lock 且 @playwright/test 升版 ⇒ 提醒 install＋裝瀏覽器', () => {
    const lock = (v) => `"@playwright/test@npm:^1.0.0":\n  version: ${v}\n  resolution: "x"\n`;
    fs.writeFileSync(path.join(author, 'yarn.lock'), lock('1.63.0'));
    git(author, 'add', '.');
    git(author, 'commit', '-qm', 'lock');
    git(author, 'push', '-q');
    git(local, 'pull', '-q');
    fs.writeFileSync(path.join(author, 'yarn.lock'), lock('1.64.0'));
    git(author, 'commit', '-qam', 'bump playwright');
    git(author, 'push', '-q');
    const r = checkRemote(local);
    expect(r).toMatchObject({ lockChanged: true, playwright: { from: '1.63.0', to: '1.64.0' } });
    const notice = buildNotice(r, { yarnInstall: true, missingBrowsers: [] });
    expect(notice).toContain('pull 完執行 `yarn install`');
    expect(notice).toContain('yarn playwright install chromium firefox');
    // remote 已要求 install ⇒ 不重複出本地 [依賴未更新]
    expect(notice).not.toContain('[依賴未更新]');
  });

  test('沒動 yarn.lock 的新 commit ⇒ 不提 install', () => {
    commit(author, 'b.txt', 'two');
    git(author, 'push', '-q');
    const r = checkRemote(local);
    expect(r.lockChanged).toBe(false);
    expect(buildNotice(r)).not.toContain('yarn install');
  });

  test('本地：yarn.lock 比 .yarn-state.yml 新 ⇒ yarn install（沒落後也要提醒）', () => {
    const nm = path.join(local, 'node_modules');
    fs.mkdirSync(nm);
    fs.writeFileSync(path.join(nm, '.yarn-state.yml'), '');
    fs.writeFileSync(path.join(local, 'yarn.lock'), '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(nm, '.yarn-state.yml'), old, old);
    expect(checkLocalDeps(local, tmp)).toEqual({ yarnInstall: true, missingBrowsers: [] });
    const out = JSON.parse(runHook(local));
    expect(out.hookSpecificOutput.additionalContext).toContain('[依賴未更新]');

    // install 過（state 比 lock 新）⇒ 不提醒
    const now = new Date();
    fs.utimesSync(path.join(nm, '.yarn-state.yml'), now, now);
    fs.utimesSync(path.join(local, 'yarn.lock'), old, old);
    expect(checkLocalDeps(local, tmp).yarnInstall).toBe(false);
  });

  test('本地：playwright-core 要求的瀏覽器 revision 不在 ⇒ 列出缺的', () => {
    const nm = path.join(local, 'node_modules');
    fs.mkdirSync(path.join(nm, 'playwright-core'), { recursive: true });
    fs.writeFileSync(path.join(local, 'yarn.lock'), '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(local, 'yarn.lock'), old, old);
    fs.writeFileSync(path.join(nm, '.yarn-state.yml'), '');
    fs.writeFileSync(
      path.join(nm, 'playwright-core', 'browsers.json'),
      JSON.stringify({
        browsers: [
          { name: 'chromium', revision: '1200' },
          { name: 'firefox', revision: '1500' },
          { name: 'webkit', revision: '2200' },
        ],
      }),
    );
    const dir = path.join(tmp, 'ms-playwright');
    fs.mkdirSync(path.join(dir, 'chromium-1200'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'firefox-1499'));
    expect(checkLocalDeps(local, dir)).toEqual({ yarnInstall: false, missingBrowsers: ['firefox'] });
    expect(buildNotice(null, { yarnInstall: false, missingBrowsers: ['firefox'] })).toContain(
      'yarn playwright install firefox',
    );
    fs.mkdirSync(path.join(dir, 'firefox-1500'));
    expect(checkLocalDeps(local, dir).missingBrowsers).toEqual([]);
  });

  test('browsersDir：PLAYWRIGHT_BROWSERS_PATH 優先，否則各平台預設', () => {
    expect(browsersDir({ PLAYWRIGHT_BROWSERS_PATH: '/x/pw' }, 'win32', '/h')).toBe('/x/pw');
    expect(browsersDir({}, 'linux', '/h')).toBe(path.join('/h', '.cache', 'ms-playwright'));
    expect(browsersDir({}, 'darwin', '/h')).toBe(path.join('/h', 'Library', 'Caches', 'ms-playwright'));
  });

  test('超過列出上限 ⇒ 標示剩餘數量', () => {
    const notice = buildNotice({
      upstream: 'origin/dev',
      behind: 12,
      ahead: 0,
      dirty: false,
      commits: Array.from({ length: 10 }, (_, i) => `abc${i} m${i}`),
    });
    expect(notice).toContain('另 2 個');
  });
});
