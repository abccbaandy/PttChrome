// 守護 scripts/check-remote-commits.mjs（SessionStart hook）：
//   1. remote 沒新 commit ⇒ stdout 必須完全空（不打擾 session）。
//   2. remote 有新 commit ⇒ 輸出 SessionStart JSON，additionalContext 要求先 pull。
//   3. 沒 upstream ⇒ 靜默。分岔／dirty 給對應指示。
// 用真 git repo（暫存目錄），不 mock。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNotice, checkRemote } from '../../scripts/check-remote-commits.mjs';

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
