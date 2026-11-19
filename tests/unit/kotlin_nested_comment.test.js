// Kotlin 的區塊註解可以巢狀：KDoc 裡寫 `image/*` 這種字會開一層新的註解，整個檔案剩下的部分都變成註解
// ⇒ 編譯錯「Unclosed comment」。本機沒有 Android SDK、只有 CI 的 android.yml 才編得到，這裡先擋。
// 做法：拿掉字串字面量後，`/*` 與 `*/` 的數量要相等。
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../android');

function kotlinFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'build' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...kotlinFiles(p));
    else if (e.name.endsWith('.kt') || e.name.endsWith('.kts')) out.push(p);
  }
  return out;
}

export function unbalancedBlockComments(src) {
  // 先拿掉 raw string（"""…"""）與一般字串（"…"，含跳脫），再拿掉行註解。
  const code = src
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/\/\/(?![^\n]*\*\/)[^\n]*/g, '');
  const open = (code.match(/\/\*/g) || []).length;
  const close = (code.match(/\*\//g) || []).length;
  return open - close;
}

test('detects the KDoc trap', () => {
  expect(unbalancedBlockComments('/** `image/*` 但不是 GIF */\nfun a() {}')).toBe(1);
  expect(unbalancedBlockComments('/** image/ 開頭 */\nval s = "image/*;q=0.8"')).toBe(0);
});

test('every Kotlin file closes its block comments', () => {
  const files = kotlinFiles(ROOT);
  expect(files.length).toBeGreaterThan(10);
  const bad = files.filter((f) => unbalancedBlockComments(fs.readFileSync(f, 'utf8')) !== 0);
  expect(bad.map((f) => path.relative(ROOT, f))).toEqual([]);
});
