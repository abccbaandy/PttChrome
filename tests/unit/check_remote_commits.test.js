// 守護 scripts/check-remote-commits.mjs（SessionStart hook）：
//   1. remote 沒新 commit ⇒ stdout 必須完全空（不打擾 session）。
//   2. remote 有新 commit ⇒ 輸出 SessionStart JSON，additionalContext 要求先 pull。
//   3. 沒 upstream ⇒ 靜默。分岔／dirty 給對應指示。
//   4. 依賴升版：新 commit 動 yarn.lock ⇒ 提醒 install；本地 node_modules／Playwright 瀏覽器沒跟上 ⇒ 提醒。
//   5. 雲端 session（CLAUDE_CODE_REMOTE=true）：本地依賴缺漏直接自己裝（autoFixLocalDeps），裝不起來才提醒。
// 用真 git repo（暫存目錄），不 mock。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  autoFixLocalDeps,
  browsersDir,
  buildNotice,
  checkLocalDeps,
  checkRemote,
  installTargets,
} from '../../scripts/check-remote-commits.mjs';

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
// 在雲端 session 跑測試時 env 帶 CLAUDE_CODE_REMOTE=true ⇒ hook 會真的去 yarn install：一律拿掉
const HOOK_ENV = { ...process.env };
delete HOOK_ENV.CLAUDE_CODE_REMOTE;
const runHook = (root) =>
  execFileSync(process.execPath, [SCRIPT, '--root', root], {
    encoding: 'utf8',
    env: HOOK_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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

  // 實錄：桌面 app 開 session 時自己也在背景 fetch，同一秒撞上 hook 的 fetch（ref lock）
  // ⇒ hook fetch 失敗。舊版這時直接靜默，但 upstream ref 早被 app 更新好、明明落後 9 個
  // commit 卻一聲不吭。fetch 失敗要退回用本地現有的 upstream ref 判斷。
  test('fetch 失敗但本地 upstream ref 已落後 ⇒ 仍提醒（註明可能不是最新）', () => {
    commit(author, 'b.txt', 'two');
    git(author, 'push', '-q');
    git(local, 'fetch', '-q'); // 別人（app）已經 fetch 過
    git(local, 'remote', 'set-url', 'origin', path.join(tmp, 'missing.git')); // hook 的 fetch 會失敗
    const r = checkRemote(local);
    expect(r).toMatchObject({ upstream: 'origin/dev', behind: 1, fetchFailed: true });
    const out = JSON.parse(runHook(local));
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('origin/dev 比本地 HEAD 多 1 個 commit');
    expect(ctx).toContain('fetch 失敗');
  });

  test('fetch 失敗且本地 upstream ref 沒落後 ⇒ 靜默', () => {
    git(local, 'remote', 'set-url', 'origin', path.join(tmp, 'missing.git'));
    expect(checkRemote(local)).toBeNull();
    expect(runHook(local)).toBe('');
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
          { name: 'chromium-headless-shell', revision: '1200' },
          { name: 'firefox', revision: '1500' },
          { name: 'webkit', revision: '2200' },
          { name: 'ffmpeg', revision: '1013' },
        ],
      }),
    );
    const dir = path.join(tmp, 'ms-playwright');
    fs.mkdirSync(path.join(dir, 'chromium-1200'), { recursive: true });
    // 目錄名是底線（playwright-core registry），用連字號查會永遠判成缺
    fs.mkdirSync(path.join(dir, 'chromium_headless_shell-1200'));
    fs.mkdirSync(path.join(dir, 'ffmpeg-1013'));
    fs.mkdirSync(path.join(dir, 'firefox-1499'));
    expect(checkLocalDeps(local, dir)).toEqual({ yarnInstall: false, missingBrowsers: ['firefox'] });
    expect(buildNotice(null, { yarnInstall: false, missingBrowsers: ['firefox'] })).toContain(
      'yarn playwright install firefox',
    );
    fs.mkdirSync(path.join(dir, 'firefox-1500'));
    expect(checkLocalDeps(local, dir).missingBrowsers).toEqual([]);
  });

  test("本地：chromium 本體在、headless shell／ffmpeg 不在 ⇒ 也要報缺（實錄：整批 Executable doesn't exist）", () => {
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
          { name: 'chromium', revision: '1248' },
          { name: 'chromium-headless-shell', revision: '1248' },
          { name: 'ffmpeg', revision: '1013' },
        ],
      }),
    );
    const dir = path.join(tmp, 'ms-playwright');
    fs.mkdirSync(path.join(dir, 'chromium-1248'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ffmpeg-1011'));
    expect(checkLocalDeps(local, dir).missingBrowsers).toEqual(['chromium-headless-shell', 'ffmpeg']);
    // 補裝指令只要 chromium（headless shell、ffmpeg 隨它裝）
    expect(buildNotice(null, { yarnInstall: false, missingBrowsers: ['chromium-headless-shell', 'ffmpeg'] })).toContain(
      '`yarn playwright install chromium`',
    );
  });

  test('installTargets：元件併成 install 目標並去重', () => {
    expect(installTargets(['chromium-headless-shell', 'ffmpeg', 'firefox', 'chromium'])).toEqual(['chromium', 'firefox']);
    expect(installTargets([])).toEqual([]);
  });

  describe('雲端自動補裝（autoFixLocalDeps）', () => {
    const ok = { yarnInstall: false, missingBrowsers: [] };

    test('沒缺 ⇒ 什麼都不跑', () => {
      const run = vi.fn();
      expect(autoFixLocalDeps('/r', ok, { run, recheck: () => ok })).toEqual({ done: [], local: ok });
      expect(run).not.toHaveBeenCalled();
    });

    test('lock 比 node_modules 新 ⇒ 先 install，重查後缺的瀏覽器再補裝', () => {
      const run = vi.fn();
      const states = [{ yarnInstall: false, missingBrowsers: ['chromium-headless-shell', 'firefox'] }, ok];
      const r = autoFixLocalDeps('/r', { yarnInstall: true, missingBrowsers: [] }, { run, recheck: () => states.shift() });
      expect(run.mock.calls).toEqual([
        ['yarn', ['install', '--immutable']],
        ['yarn', ['playwright', 'install', 'chromium', 'firefox']],
      ]);
      expect(r).toEqual({ done: ['yarn install', 'playwright install chromium firefox'], local: ok });
    });

    test('install 失敗 ⇒ 不裝瀏覽器，缺漏原樣留給 notice', () => {
      const run = vi.fn(() => {
        throw new Error('network');
      });
      const before = { yarnInstall: true, missingBrowsers: [] };
      const r = autoFixLocalDeps('/r', before, { run, recheck: () => ok });
      expect(r).toEqual({ done: [], local: before });
      expect(buildNotice(null, r.local)).toContain('[依賴未更新]');
    });

    test('瀏覽器裝失敗 ⇒ 重查結果仍缺，照舊提醒', () => {
      const run = vi.fn(() => {
        throw new Error('403');
      });
      const missing = { yarnInstall: false, missingBrowsers: ['firefox'] };
      const r = autoFixLocalDeps('/r', missing, { run, recheck: () => missing });
      expect(r.done).toEqual([]);
      expect(buildNotice(null, r.local)).toContain('yarn playwright install firefox');
    });
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
