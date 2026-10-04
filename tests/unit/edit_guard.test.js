// 守護 scripts/edit-guard.mjs：用 harness 強制「不准經 shell 改專案檔」＋寫入後的內容檢查。
//
// 歷來的編輯坑（heredoc 折反斜線、`String.replace` 的 `$` 序列重貼全文、Windows python 寫
// CRLF、PowerShell here-string 丟進 Bash）全發生在 shell 寫檔這層；規則文字擋不住，所以改成
// hook。這裡鎖三件事：判斷邏輯（擋該擋的、不誤擋日常讀取／輸出到暫存）、內容檢查抓得到三種
// 症狀、以及 hook／pre-commit 的接線沒被拆掉。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyShellCommand, findDuplicateBlock, inspectContent } from '../../scripts/edit-guard.mjs';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/edit-guard.mjs');

describe('classifyShellCommand：擋 shell 寫專案檔', () => {
  test.each([
    ["sed -i 's/a/b/' src/js/term_view.js"],
    ['sed -E -i.bak "s/x/y/" README.md'],
    ["perl -pi -e 's/a/b/' src/js/x.js"],
    ["python - <<'PY'\nopen('src/js/x.js', 'w', newline='').write(s)\nPY"],
    ['python -c "import pathlib; pathlib.Path(\'a.md\').write_text(s)"'],
    ["node -e \"require('fs').writeFileSync('src/js/a.js', s)\""],
    ["node <<'EOF'\nconst fs=require('fs');fs.writeFileSync('docs/a.md', t)\nEOF"],
    ["cat > src/js/new.js <<'EOF'\nexport {}\nEOF"],
    ['echo "{}" > package.json'],
    ['printf x >> docs/run-local.md'],
    ['git show HEAD:src/a.js | tee src/a.js'],
    ['echo x > .gitattributes'],
    ["(Get-Content a.js) -replace 'a','b' | Set-Content a.js"],
    ['"x" | Out-File -FilePath docs/a.md'],
    ["[IO.File]::WriteAllText('src/a.js', $s)"],
  ])('擋：%s', (cmd) => {
    const r = classifyShellCommand(cmd);
    expect(r.block).toBe(true);
    expect(r.reason).toMatch(/Edit／Write/);
  });

  test.each([
    ['cat src/js/term_view.js'],
    ["sed -n '1,40p' src/js/term_view.js"],
    ['grep -rn "foo" src > /dev/null'],
    ['yarn ci:status --branch dev > ci.txt 2>&1; echo "EXIT=$?"'],
    ['yarn test:unit > /tmp/unit.log 2>&1'],
    ['node scripts/bulk-rename.mjs'],
    ["node -e \"console.log(require('fs').readFileSync('package.json','utf8'))\""],
    ["python - <<'PY'\nprint(open('src/js/x.js', encoding='utf-8').read()[:100])\nPY"],
    ["node -e \"require('fs').writeFileSync(require('os').tmpdir()+'/a.json', s)\""],
    ['git commit -F msg.txt'],
    ['ls 2>&1 | head'],
    ['Get-Content src/js/a.js | Select-Object -First 5'],
    ['"x" | Out-File $env:TEMP\\out.md'],
    ['node -e "[1,2].map(x => x > 1)"'],
  ])('放行：%s', (cmd) => {
    expect(classifyShellCommand(cmd).block).toBe(false);
  });
});

describe('inspectContent：寫入後的三種症狀', () => {
  const body = Array.from({ length: 30 }, (_, i) => `const line${i} = ${i};`).join('\n');

  test('NUL 位元組', () => {
    const issues = inspectContent('src/js/a.js', Buffer.from('const k = "a\0b";\n'), null);
    expect(issues.join()).toMatch(/NUL/);
  });

  test('原本就是二進位的檔不報 NUL', () => {
    expect(inspectContent('src/js/a.js', Buffer.from('x\0y'), Buffer.from('a\0b'))).toEqual([]);
  });

  test('CRLF（*.bat 例外；staged 模式不查）', () => {
    expect(inspectContent('src/js/a.js', Buffer.from('a\r\nb\r\n'), null).join()).toMatch(/CRLF/);
    expect(inspectContent('android/gradlew.bat', Buffer.from('a\r\nb\r\n'), null)).toEqual([]);
    expect(inspectContent('src/js/a.js', Buffer.from('a\r\nb\r\n'), null, { checkCrlf: false })).toEqual([]);
  });

  test('`$` 序列把前文重貼一次 → 抓到重複區塊', () => {
    const old = `${body}\n// anchor\nrest();\n`;
    // 模擬 s.replace('// anchor', '`$`' 開頭的替換值) 的結果：anchor 前的全文被插入一次。
    const broken = old.replace('// anchor', () => `${body}\n// anchor`);
    expect(findDuplicateBlock(old, broken)).toBe(31);
    expect(inspectContent('docs/a.md', Buffer.from(broken), Buffer.from(old)).join()).toMatch(/重複/);
  });

  test('HEAD 已存在的重複、空白列重複、非文字檔都不報', () => {
    const dup = `${body}\n${body}\n`;
    expect(findDuplicateBlock(dup, `${dup}x\n`)).toBeNull();
    expect(findDuplicateBlock('', '\n'.repeat(100))).toBeNull();
    expect(findDuplicateBlock('', '});\n'.repeat(100))).toBeNull();
    expect(inspectContent('a.png', Buffer.from(`${body}\n${body}\0`), null)).toEqual([]);
  });
});

describe('hook CLI 協定（exit 2＋stderr 回饋給模型）', () => {
  const run = (mode, input) =>
    spawnSync(process.execPath, [SCRIPT, mode], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
    });

  test('pre-tool：擋下回 2、放行回 0、壞輸入 fail-open', () => {
    const blocked = run('--pre-tool', { tool_name: 'Bash', tool_input: { command: 'sed -i s/a/b/ a.js' } });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toMatch(/edit-guard/);
    expect(run('--pre-tool', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' }).status).toBe(0);
    expect(run('--pre-tool', { tool_name: 'Read', tool_input: {} }).status).toBe(0);
    const bad = spawnSync(process.execPath, [SCRIPT, '--pre-tool'], { input: 'not json', encoding: 'utf8' });
    expect(bad.status).toBe(0);
  });

  test('post-tool：Edit 寫出 CRLF 回 2；專案外的檔不查', () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.edit-guard-test-'));
    const outside = path.join(os.tmpdir(), `edit-guard-${process.pid}.js`);
    try {
      const file = path.join(dir, 'a.js');
      fs.writeFileSync(file, 'a\r\nb\r\n');
      const r = run('--post-tool', { tool_name: 'Edit', tool_input: { file_path: file } });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/CRLF/);
      fs.writeFileSync(outside, 'a\r\nb\r\n');
      expect(run('--post-tool', { tool_name: 'Write', tool_input: { file_path: outside } }).status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { force: true });
    }
  });
});

describe('接線：hook 與 pre-commit 沒被拆掉', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
  const commandsOf = (event) =>
    (settings.hooks?.[event] || []).map((h) => ({
      matcher: h.matcher || '',
      commands: (h.hooks || []).map((x) => x.command).join('\n'),
    }));

  test('PreToolUse 掛在 Bash 與 PowerShell', () => {
    const entry = commandsOf('PreToolUse').find((h) => /edit-guard\.mjs" --pre-tool/.test(h.commands));
    expect(entry).toBeTruthy();
    for (const tool of ['Bash', 'PowerShell']) expect(entry.matcher.split('|')).toContain(tool);
  });

  test('PostToolUse 掛在檔案工具與 shell 工具', () => {
    const entry = commandsOf('PostToolUse').find((h) => /edit-guard\.mjs" --post-tool/.test(h.commands));
    expect(entry).toBeTruthy();
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'Bash', 'PowerShell']) {
      expect(entry.matcher.split('|')).toContain(tool);
    }
  });

  test('husky pre-commit 跑 --staged', () => {
    const hook = fs.readFileSync(path.join(ROOT, '.husky/pre-commit'), 'utf8');
    expect(hook).toMatch(/node scripts\/edit-guard\.mjs --staged/);
  });
});
