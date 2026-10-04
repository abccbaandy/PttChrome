// 守護 scripts/sync-3rd-script.mjs（SessionStart hook）：
//   1. 上游 rebase＋force push 後，本地要直接對齊上游（`git pull` 會衝突的情境）。
//   2. tracked 檔有未提交改動 ⇒ 跳過不動。
//   3. hook 模式 stdout 必須是空的（SessionStart 的 stdout 會注入 session context）。
// 用真 git repo（暫存目錄），不 mock。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldRun, syncAll, MIN_INTERVAL_MS } from '../../scripts/sync-3rd-script.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/sync-3rd-script.mjs', import.meta.url));
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tmp;
let root;
let upstream;
let author;
let clone;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync3rd-'));
  upstream = path.join(tmp, 'upstream.git');
  author = path.join(tmp, 'author');
  root = path.join(tmp, 'proj');
  clone = path.join(root, '3rd_script', 'pttbbs');
  git(tmp, 'init', '--bare', '-b', 'master', upstream);
  git(tmp, 'clone', '-q', upstream, author);
  fs.writeFileSync(path.join(author, 'a.c'), 'v1\n');
  git(author, 'add', '.');
  git(author, 'commit', '-qm', 'one');
  git(author, 'push', '-q', 'origin', 'master');
  fs.mkdirSync(path.join(root, '3rd_script'), { recursive: true });
  git(tmp, 'clone', '-q', upstream, clone);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// 上游改寫歷史：amend 掉舊 commit 再 force push（本地 pull 會分岔）
function rewriteUpstream() {
  fs.writeFileSync(path.join(author, 'a.c'), 'v2-rewritten\n');
  git(author, 'commit', '-qa', '--amend', '-m', 'one (rewritten)');
  git(author, 'push', '-qf', 'origin', 'master');
  return git(author, 'rev-parse', 'HEAD');
}

describe('sync-3rd-script', () => {
  test('上游 force push 改寫歷史 ⇒ 本地直接對齊上游', () => {
    const newHead = rewriteUpstream();
    const [r] = syncAll(root);
    expect(r.status).toBe('ok');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(newHead);
    // 機器的 core.autocrlf 可能把簽出轉成 CRLF，只比內容
    expect(fs.readFileSync(path.join(clone, 'a.c'), 'utf8').trim()).toBe('v2-rewritten');
  }, 30000);

  test('tracked 檔有未提交改動 ⇒ 跳過不動', () => {
    const oldHead = git(clone, 'rev-parse', 'HEAD');
    rewriteUpstream();
    fs.writeFileSync(path.join(clone, 'a.c'), 'local edit\n');
    const [r] = syncAll(root);
    expect(r).toMatchObject({ status: 'skip', detail: 'dirty working tree' });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(oldHead);
    expect(fs.readFileSync(path.join(clone, 'a.c'), 'utf8').trim()).toBe('local edit');
  }, 30000);

  test('沒有自己 .git 的子目錄不碰（會落到外層專案 repo）', () => {
    fs.mkdirSync(path.join(root, '3rd_script', 'tools'));
    expect(syncAll(root).map((r) => r.name)).toEqual(['pttbbs']);
  }, 30000);

  test('hook 模式 stdout 為空、exit 0', () => {
    // 先放新的 stamp ⇒ 節流擋下，不真的 fork worker（避免測試留下背景進程）
    fs.writeFileSync(path.join(root, '3rd_script', '.sync-stamp'), '');
    const out = execFileSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
    expect(out).toBe('');
    const noThird = execFileSync(process.execPath, [SCRIPT, '--root', tmp], { encoding: 'utf8' });
    expect(noThird).toBe('');
  }, 30000);

  test('節流：上次同步後未滿間隔不再跑', () => {
    const now = 1_000_000_000;
    expect(shouldRun(0, now)).toBe(true);
    expect(shouldRun(now - MIN_INTERVAL_MS + 1, now)).toBe(false);
    expect(shouldRun(now - MIN_INTERVAL_MS, now)).toBe(true);
  });
});
