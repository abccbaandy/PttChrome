// 雲端 session 把本專案的 hook 掛到使用者層設定（~/.claude/settings.json）。
//
// 為什麼：Claude Code 只讀「啟動目錄」的 `.claude/settings.json`。雲端 session 可能在 repo 的上一層
// 啟動（repo 是它底下的子目錄），這時專案層的 hook 全部不載入：edit-guard 不擋 shell 改檔、
// SessionStart 不補裝過期依賴，而且沒有任何訊息。使用者層設定不看啟動目錄，一定會載入。
//
// 做法：把專案層 `.claude/settings.json` 的每一條 hook 照抄一份到使用者層，指令改成
//   [ "$CLAUDE_PROJECT_DIR" = '<repo>' ] || { export CLAUDE_PROJECT_DIR='<repo>'; <原指令>; }
// ⇒ 在 repo 裡啟動時（專案層已經在跑）直接略過，不會跑兩次；在別處啟動時把 CLAUDE_PROJECT_DIR
// 指回 repo 再跑原指令（edit-guard 以它當 repo 根目錄）。原指令的 exit code 原樣帶出（exit 2＝擋下）。
// 每條帶 MARKER，重跑時先拿掉舊的再加：可以重複執行，使用者自己加的 hook 不動。
//
// 由 scripts/cloud-setup.sh 呼叫；守護 tests/unit/cloud_user_hooks.test.js。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = '# pttchrome-project-hook';

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** 一條專案層 hook 指令 → 使用者層版本。 */
export function wrapCommand(command, repo) {
  const q = shQuote(repo);
  return `[ "$CLAUDE_PROJECT_DIR" = ${q} ] || { export CLAUDE_PROJECT_DIR=${q}; ${command}; } ${MARKER}`;
}

const isManaged = (h) => typeof h?.command === 'string' && h.command.includes(MARKER);

/**
 * 把專案層 hooks 併進使用者層設定，回傳新物件（不改輸入）。
 * @param {any} userSettings 使用者層設定（可為 {}）
 * @param {any} projectSettings 專案層 `.claude/settings.json`
 * @param {string} repo repo 絕對路徑
 */
export function mergeUserSettings(userSettings, projectSettings, repo) {
  const out = structuredClone(userSettings && typeof userSettings === 'object' ? userSettings : {});
  const hooks = (out.hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {});
  // 先清掉上次掛的（含專案層已經拿掉的事件）。
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev]
      .map((g) => ({ ...g, hooks: Array.isArray(g?.hooks) ? g.hooks.filter((h) => !isManaged(h)) : g?.hooks }))
      .filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (hooks[ev].length === 0) delete hooks[ev];
  }
  for (const [ev, groups] of Object.entries(projectSettings?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const wrapped = (g.hooks || [])
        .filter((h) => h?.type === 'command' && typeof h.command === 'string')
        .map((h) => ({ ...h, command: wrapCommand(h.command, repo) }));
      if (!wrapped.length) continue;
      (hooks[ev] = hooks[ev] || []).push({ ...g, hooks: wrapped });
    }
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

function main() {
  const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const userFile = process.env.CLAUDE_USER_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
  const project = readJson(path.join(repo, '.claude', 'settings.json'));
  const merged = mergeUserSettings(readJson(userFile), project, repo);
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, JSON.stringify(merged, null, 2) + '\n');
  const n = Object.values(merged.hooks).flat().flatMap((g) => g.hooks || []).filter(isManaged).length;
  console.log(`[cloud-user-hooks] 已把 ${n} 條專案 hook 掛到 ${userFile}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
