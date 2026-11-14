// 守護 scripts/cloud-user-hooks.mjs：雲端 session 在 repo 上一層啟動時，專案層 `.claude/settings.json`
// 不會載入（edit-guard 靜默失效：`sed -i`、`python3 - <<EOF` 寫 repo 檔都沒被擋），所以 setup 把同一組
// hook 掛到使用者層。這裡鎖「在別處啟動會跑、在 repo 啟動不重跑、exit code 原樣帶出、可重複執行」。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MARKER, mergeUserSettings, wrapCommand } from '../../scripts/cloud-user-hooks.mjs';

const REPO = "/work/it's repo";
const project = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../.claude/settings.json', import.meta.url)), 'utf8'));

function runSh(command, env) {
  return spawnSync('sh', ['-c', command], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
}

describe('wrapCommand', () => {
  test('在 repo 以外啟動：照跑原指令，CLAUDE_PROJECT_DIR 指回 repo，exit 2（擋下）原樣帶出', () => {
    const r = runSh(wrapCommand('echo "dir=$CLAUDE_PROJECT_DIR"; exit 2', REPO), { CLAUDE_PROJECT_DIR: '/work' });
    expect(r.stdout.trim()).toBe(`dir=${REPO}`);
    expect(r.status).toBe(2);
  });

  test('沒有 CLAUDE_PROJECT_DIR 也照跑', () => {
    const r = runSh(wrapCommand('exit 2', REPO), {});
    expect(r.status).toBe(2);
  });

  test('在 repo 啟動（專案層 hook 已在跑）：略過，不跑兩次', () => {
    const r = runSh(wrapCommand('echo ran; exit 2', REPO), { CLAUDE_PROJECT_DIR: REPO });
    expect(r.stdout).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('mergeUserSettings', () => {
  test('專案層每一條 hook 都掛上去，含 edit-guard 的 PreToolUse', () => {
    const out = mergeUserSettings({}, project, REPO);
    const count = (s) => Object.values(s.hooks).flat().flatMap((g) => g.hooks).length;
    expect(count(out)).toBe(count(project));
    const pre = out.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => [g.matcher, h.command]));
    expect(pre.some(([m, c]) => /Bash/.test(m) && c.includes('edit-guard.mjs') && c.includes('--pre-tool'))).toBe(true);
    for (const g of Object.values(out.hooks).flat()) for (const h of g.hooks) expect(h.command).toContain(MARKER);
  });

  test('保留 timeout 等欄位', () => {
    const out = mergeUserSettings({}, { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'x', timeout: 900 }] }] } }, REPO);
    expect(out.hooks.SessionStart[0]).toMatchObject({ matcher: 'startup', hooks: [{ timeout: 900 }] });
  });

  test('重跑不重複、使用者自己的 hook 與其他設定不動', () => {
    const mine = { model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } };
    const once = mergeUserSettings(mine, project, REPO);
    const twice = mergeUserSettings(once, project, REPO);
    expect(twice).toEqual(once);
    expect(twice.model).toBe('x');
    expect(twice.hooks.PreToolUse[0].hooks[0].command).toBe('mine');
    expect(mine.hooks.PreToolUse).toHaveLength(1);
  });

  test('專案層拿掉的事件，上次掛的也一起清掉', () => {
    const once = mergeUserSettings({}, project, REPO);
    expect(mergeUserSettings(once, { hooks: {} }, REPO)).toEqual({ hooks: {} });
  });
});

test('cloud-setup.sh 會呼叫它', () => {
  const sh = fs.readFileSync(fileURLToPath(new URL('../../scripts/cloud-setup.sh', import.meta.url)), 'utf8');
  expect(sh.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).toMatch(/node scripts\/cloud-user-hooks\.mjs/);
});
