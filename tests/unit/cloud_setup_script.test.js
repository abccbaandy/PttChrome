// 守護 scripts/cloud-setup.sh（雲端環境的 Setup script，環境設定欄位只呼叫它）。
// 這份跑壞了不會有人立刻發現：session 照樣開得起來，只是第一個 unit-browser／e2e 才整批秒掛。
// 所以只鎖「能解析」與「該裝的都有裝」。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/cloud-setup.sh', import.meta.url));
const src = fs.readFileSync(SCRIPT, 'utf8');
const code = src
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

test('bash 語法正確', () => {
  execFileSync('bash', ['-n', SCRIPT]);
});

test('依 lock 安裝依賴（--immutable，同 CI）', () => {
  expect(code).toMatch(/yarn install --immutable/);
});

test('裝 chromium（含 headless shell／ffmpeg）與 firefox：unit-browser、offline e2e、offline-firefox 都要', () => {
  expect(code).toMatch(/yarn playwright install\b[^\n]*\bchromium\b[^\n]*\bfirefox\b/);
});

test('拉 pttbbs 原始碼（CLAUDE.md「PTT 邏輯不准猜」）', () => {
  expect(code).toMatch(/github\.com\/ptt\/pttbbs/);
});

test('輸出記進固定 log（環境設定頁看不到 setup 的輸出），含呼叫端工作目錄', () => {
  expect(code).toMatch(/LOG=\/root\/\.cache\/pttchrome-cloud-setup\.log/);
  expect(code).toMatch(/\$PWD/);
});

test('非必要步驟失敗不讓 session 起不來：不開 set -e', () => {
  expect(code).not.toMatch(/^\s*set\s+-[a-z]*e/m);
});
