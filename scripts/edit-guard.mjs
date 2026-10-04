// 編輯防呆守門：Claude Code hook（`.claude/settings.json`）與 husky pre-commit 共用。
//
// 為什麼要強制而不是寫規則：歷來的編輯坑全發生在「經 shell 改檔」這層——heredoc 把雙反斜線
// 折成一個、`String.replace` 的 `$` 序列把全文再貼一次、Windows python 文字模式寫出 CRLF、
// PowerShell here-string 被丟進 Bash。Edit／Write 工具沒有 shell 跳脫與換行轉換，這幾類
// 不可能發生；而 CLAUDE.md 的規則擋不住系統提示鼓勵「用 sed／heredoc 改檔」。
//
// 模式：
//   --pre-tool   PreToolUse（Bash|PowerShell）：擋「用 shell 寫專案文字檔」，exit 2 把理由回饋給模型。
//                放行：寫到暫存目錄（tmp／Temp／scratchpad／$null）、`node <腳本檔>` 這類執行檔案
//                （批次改動的正規出口：先用 Write 寫腳本，再執行）。
//   --post-tool  PostToolUse（Edit|Write|MultiEdit|Bash|PowerShell）：檢查剛被寫的檔案。
//                Edit／Write 查該檔；shell 查本次指令期間 mtime 有變的 git 變更檔（起點由 pre-tool 記）。
//   --staged     husky pre-commit：檢查 staged 內容，exit 1 擋 commit。
// 檢查項目（inspectContent）：文字檔出現 NUL 位元組（git 會整檔當二進位）、CRLF（*.bat 除外，
// `.gitattributes` 強制 LF）、相對 HEAD 新冒出的大段重複區塊（`$` 序列把全文重貼的特徵）。
//
// hook 一律 fail-open（輸入解析不了就放行）：守門壞掉不能把 session 卡死；接線與行為由
// tests/unit/edit_guard.test.js 守護。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_EXT =
  /\.(?:[cm]?[jt]sx?|json|md|css|s[ac]ss|html?|svg|xml|ya?ml|toml|txt|sh|ps1|bat|py|kt|kts|java|gradle|properties|rules)$/i;

// shell 重導向／tee 的目標若是這些就算「專案文字檔」（.txt／.log 不算：ci:status 輸出檔是正規用法）。
const PROTECTED_EXT =
  /\.(?:[cm]?[jt]sx?|json|md|css|s[ac]ss|html?|svg|xml|ya?ml|toml|sh|ps1|bat|py|kt|kts|java|gradle|properties|rules)$/i;

const TEMP_TARGET = /^(?:\/dev\/null|nul|\$null)$|(?:^|[\\/])(?:tmp|temp)(?:[\\/]|$)|scratchpad|^\$\{?(?:TMP|TEMP|TMPDIR)\b|^\$env:(?:TMP|TEMP)\b/i;
const TEMP_HINT = /(?:^|[\s'"=(])\/tmp\/|[\\/](?:tmp|temp)[\\/]|scratchpad|\$\{?(?:TMP|TEMP|TMPDIR)\b|\$env:(?:TMP|TEMP)\b|\btmpdir\(\)|tempfile\.|GetTempPath/i;

function isProtectedTarget(target) {
  const t = target.replace(/^['"]|['"]$/g, '');
  if (!t || TEMP_TARGET.test(t)) return false;
  const base = t.split(/[\\/]/).pop();
  return PROTECTED_EXT.test(t) || /^\.[\w.-]+$/.test(base) || /(?:^|[\\/])\.husky[\\/]/.test(t);
}

const SED_INPLACE = /\bsed\b[^|;&\n]*\s(?:--in-place|-[a-zA-Z]*i)/;
const PERL_RUBY_INPLACE = /\b(?:perl|ruby)\b[^|;&\n]*\s-[a-zA-Z]*i/;
// 直譯器吃行內程式碼：-c／-e／--eval／`-`（stdin），或直接接 heredoc。
const INLINE_INTERP =
  /\b(?:python3?|py|node|perl|ruby|deno|bun)(?:\.exe)?\s+(?:[^|;&\n]*?\s)?(?:-c|-e|--eval|-)(?=\s|$|['"])|\b(?:python3?|py|node|perl|ruby)(?:\.exe)?\s*<</;
const WRITE_API =
  /writeFileSync|\bwriteFile\s*\(|appendFile(?:Sync)?\s*\(|createWriteStream|\.write_text\s*\(|\.write_bytes\s*\(|\bopen\s*\([^)]*['"](?:[wax]|r\+)[bt+]*['"]|WriteAll(?:Text|Lines|Bytes)/i;
const PS_WRITE = /\b(?:Set-Content|Add-Content|Out-File|New-Item\b[^|;\n]*-Value)\b|\[(?:System\.)?IO\.File\]::(?:WriteAll|Append)/i;
const REDIRECT = /(?<![=\-<>])(?:\d|&)?>>?\s*(?!&)("[^"]+"|'[^']+'|[^\s;|&()<>]+)/g;
const TEE = /\btee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s;|&()<>]+)/g;

const ALTERNATIVE =
  '改用 Edit／Write 工具（沒有 shell 跳脫與換行轉換）。批次改動：先用 Write 寫腳本檔，再 `node <腳本檔>` 執行' +
  '（腳本內 `String.replace` 的替換值一律傳函式 `() => neu`；讀寫保留 LF）。只是要輸出結果就寫到 scratchpad／暫存目錄。';

// 純函式：判斷一條 shell 指令是否在「用 shell 寫專案文字檔」。回傳 { block, reason }。
export function classifyShellCommand(command) {
  const cmd = String(command || '');
  const block = (why) => ({ block: true, reason: `edit-guard 擋下：${why}。${ALTERNATIVE}` });

  if (SED_INPLACE.test(cmd)) return block('`sed -i` 就地改檔');
  if (PERL_RUBY_INPLACE.test(cmd)) return block('perl／ruby `-i` 就地改檔');
  if (INLINE_INTERP.test(cmd) && WRITE_API.test(cmd) && !TEMP_HINT.test(cmd)) {
    return block('行內直譯器（-c／-e／heredoc）寫檔，heredoc 會折掉反斜線、Windows python 會寫出 CRLF');
  }
  if (PS_WRITE.test(cmd) && !TEMP_HINT.test(cmd)) {
    return block('PowerShell 寫檔 cmdlet（Set-Content／Out-File 等），預設編碼與換行不受控');
  }
  for (const re of [REDIRECT, TEE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(cmd))) {
      if (isProtectedTarget(m[1])) return block(`shell 重導向寫入專案檔 ${m[1]}`);
    }
  }
  return { block: false, reason: '' };
}

// 純函式：找「newText 裡重複出現、oldText 裡沒有重複」的連續區塊（`$` 序列把全文重貼的特徵）。
// 回傳第二次出現的 1-based 行號，沒有則 null。區塊須含夠多相異非空行，避免空白列／`});` 這類誤報。
export function findDuplicateBlock(oldText, newText, { window = 20, minDistinct = 10 } = {}) {
  const lines = (s) => String(s || '').replace(/\r\n/g, '\n').split('\n');
  const count = (arr) => {
    const map = new Map();
    for (let i = 0; i + window <= arr.length; i++) {
      const key = arr.slice(i, i + window).join('\n');
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  };
  const neu = lines(newText);
  if (neu.length < window * 2) return null;
  const oldCounts = count(lines(oldText));
  const seen = new Set();
  for (let i = 0; i + window <= neu.length; i++) {
    const slice = neu.slice(i, i + window);
    const key = slice.join('\n');
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    if ((oldCounts.get(key) || 0) >= 2) continue;
    const distinct = new Set(slice.map((l) => l.trim()).filter(Boolean));
    if (distinct.size >= minDistinct) return i + 1;
  }
  return null;
}

// 純函式：檢查一個檔案內容，回傳問題字串陣列。
export function inspectContent(relPath, buf, oldBuf, { checkCrlf = true } = {}) {
  const p = String(relPath).replace(/\\/g, '/');
  const base = p.split('/').pop();
  if (!TEXT_EXT.test(p) && !/^\.[\w.-]+$/.test(base) && !p.startsWith('.husky/')) return [];
  const issues = [];
  const oldBinary = oldBuf && oldBuf.includes(0);
  if (buf.includes(0) && !oldBinary) {
    issues.push(`${p}：含 NUL 位元組（git 會把整檔當二進位）。原始碼要用跳脫序列表示，不可放真的 NUL`);
  }
  if (checkCrlf && !/\.bat$/i.test(p) && buf.includes('\r\n')) {
    issues.push(`${p}：含 CRLF（.gitattributes 強制 LF）。常見成因是 Windows python 文字模式寫檔`);
  }
  if (!oldBinary) {
    const line = findDuplicateBlock(oldBuf ? oldBuf.toString('utf8') : '', buf.toString('utf8'));
    if (line) {
      issues.push(
        `${p}：第 ${line} 行起出現相對 HEAD 新增的大段重複內容，疑似 \`String.replace\` 替換值的 \`$\` 序列把全文再貼一次；確認是刻意複製再保留`,
      );
    }
  }
  return issues;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}

function gitBlob(root, spec) {
  try {
    return git(root, ['show', spec]);
  } catch {
    return null;
  }
}

function nulList(buf) {
  return buf.toString('utf8').split('\0').filter(Boolean);
}

function toRel(root, file) {
  const rel = path.relative(root, path.resolve(root, file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// 同一個 fd 先 fstat 再讀：分開 stat(path)＋read(path) 之間檔案可能被換掉（CodeQL js/file-system-race）。
function inspectWorktreeFile(root, rel) {
  let fd;
  try {
    fd = fs.openSync(path.join(root, rel), 'r');
  } catch {
    return [];
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return [];
    return inspectContent(rel, fs.readFileSync(fd), gitBlob(root, `HEAD:${rel}`));
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

// pre-tool 記起點、post-tool 讀回，所以檔名必須可預測 ⇒ 放專案內（gitignored），不放共用的
// os.tmpdir()：那裡別的使用者可搶先建同名檔／symlink（CodeQL js/insecure-temporary-file）。
// 與 kill-dev-server 的 pidfile 同一個目錄慣例。
export function snapshotPath(root, input) {
  const id = String(input.tool_use_id || input.session_id || 'default').replace(/[^\w-]/g, '_');
  return path.join(root, 'node_modules', '.cache', 'edit-guard', `${id}.json`);
}

function changedFilesSince(root, since) {
  let files = [];
  try {
    files = [
      ...nulList(git(root, ['diff', '--name-only', '-z', 'HEAD'])),
      ...nulList(git(root, ['ls-files', '--others', '--exclude-standard', '-z'])),
    ];
  } catch {
    return [];
  }
  return [...new Set(files)].filter((rel) => {
    try {
      return fs.statSync(path.join(root, rel)).mtimeMs >= since - 2000;
    } catch {
      return false;
    }
  });
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function runPreTool(input, root) {
  if (!SHELL_TOOLS.has(input.tool_name)) return 0;
  const { block, reason } = classifyShellCommand(input.tool_input?.command);
  if (block) {
    process.stderr.write(reason + '\n');
    return 2;
  }
  try {
    const snap = snapshotPath(root, input);
    fs.mkdirSync(path.dirname(snap), { recursive: true });
    fs.writeFileSync(snap, JSON.stringify({ start: Date.now() }));
  } catch {}
  return 0;
}

function runPostTool(input, root) {
  let issues = [];
  if (FILE_TOOLS.has(input.tool_name)) {
    const rel = toRel(root, input.tool_input?.file_path || input.tool_input?.notebook_path || '');
    if (rel) issues = inspectWorktreeFile(root, rel);
  } else if (SHELL_TOOLS.has(input.tool_name)) {
    const snap = snapshotPath(root, input);
    let start = null;
    try {
      start = JSON.parse(fs.readFileSync(snap, 'utf8')).start;
      fs.rmSync(snap, { force: true });
    } catch {}
    if (start == null) return 0;
    for (const rel of changedFilesSince(root, start)) issues.push(...inspectWorktreeFile(root, rel));
  }
  if (!issues.length) return 0;
  process.stderr.write(`edit-guard 發現剛寫入的檔案有問題：\n- ${issues.join('\n- ')}\n`);
  return 2;
}

function runStaged() {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).toString().trim();
  const files = nulList(git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']));
  const issues = [];
  for (const rel of files) {
    const staged = gitBlob(root, `:${rel}`);
    if (!staged || staged.length > 2 * 1024 * 1024) continue;
    // staged blob 已被 .gitattributes 正規化成 LF，CRLF 在此不會出現也不必查。
    issues.push(...inspectContent(rel, staged, gitBlob(root, `HEAD:${rel}`), { checkCrlf: false }));
  }
  if (!issues.length) return 0;
  process.stderr.write(`edit-guard（pre-commit）擋下：\n- ${issues.join('\n- ')}\n`);
  return 1;
}

function main(argv) {
  const mode = argv[2];
  if (mode === '--staged') return runStaged();
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  if (mode === '--pre-tool') return runPreTool(input, root);
  if (mode === '--post-tool') return runPostTool(input, root);
  process.stderr.write('用法：node scripts/edit-guard.mjs --pre-tool|--post-tool|--staged\n');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
