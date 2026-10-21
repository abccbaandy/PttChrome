// 開站只載用得到的 Mantine 元件樣式（src/css/mantine.css）。整份 @mantine/core/styles.css
// 約 295 KB、會擋第一次繪製，大半是沒用到的元件。
//
// 拆了之後最容易壞的方式是「新用了一個 Mantine 元件、忘了補它的 CSS」：元件照常 render、
// 所有測試照常綠，只有畫面少了樣式。所以這裡從 src 裡 `import { … } from '@mantine/core'`
// 的每個名字出發，沿 Mantine 的 esm import 圖走一遍（Button → Loader、Modal → ModalBase／
// Overlay／ScrollArea …），收集所有用得到的 class（`m_xxxxxxxx`）與 keyframes，斷言
// mantine.css 列的檔案每一個都有定義。走的是整張 import 圖，比實際 render 到的多（安全方向）。
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const CORE = path.join(ROOT, "node_modules/@mantine/core");
const SUBSET = path.join(SRC, "css/mantine.css");
const BASE = ["baseline.css", "default-css-variables.css", "global.css"];

function walkSrc(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSrc(p, out);
    else if (/\.(jsx?|mjs|css)$/.test(e.name)) out.push(p);
  }
  return out;
}
const SRC_FILES = walkSrc(SRC);

function usedMantineExports() {
  const used = new Set();
  for (const f of SRC_FILES) {
    const s = fs.readFileSync(f, "utf8");
    for (const m of s.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@mantine\/core['"]/g))
      for (const n of m[1].split(","))
        if (n.trim()) used.add(n.trim().split(/\s+as\s+/)[0]);
  }
  return used;
}

// @mantine/core 的 esm 入口：export 名字 → 定義它的檔。
function exportFiles() {
  const index = fs.readFileSync(path.join(CORE, "esm/index.mjs"), "utf8");
  const map = new Map();
  for (const m of index.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g))
    for (const n of m[1].split(","))
      if (n.trim()) map.set(n.trim().split(/\s+as\s+/).pop(), path.join(CORE, "esm", m[2]));
  return map;
}

// 從這些 export 沿相對 import 走完，收集 *.module.mjs 裡的 class 名。
function reachableClasses(names) {
  const files = exportFiles();
  const stack = [];
  for (const n of names) {
    expect(files.has(n), `@mantine/core 沒有 export ${n}`).toBe(true);
    stack.push(files.get(n));
  }
  const seen = new Set();
  const classes = new Map(); // class → 宣告它的 module
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const s = fs.readFileSync(f, "utf8");
    if (f.endsWith(".module.mjs"))
      for (const m of s.matchAll(/"(m_[0-9a-f]+)"/g)) classes.set(m[1], path.relative(CORE, f));
    for (const m of s.matchAll(/(?:import|export)[^"]*?from\s*"(\.[^"]+)"/g))
      stack.push(path.resolve(path.dirname(f), m[1]));
  }
  return classes;
}

const subsetFiles = () =>
  [...fs.readFileSync(SUBSET, "utf8").matchAll(/@import\s+'@mantine\/core\/styles\/([^']+)'/g)].map((m) => m[1]);
const stylesCss = (name) => fs.readFileSync(path.join(CORE, "styles", name), "utf8");
// class 與 keyframes 名都算「有定義」（Loader／Progress 有些 m_ 名字是 keyframes）。
const definedNames = (css) =>
  new Set([...css.matchAll(/(?:\.|@keyframes\s+)(m_[0-9a-f]+)/g)].map((m) => m[1]));

describe("Mantine 只載用得到的元件樣式", () => {
  test("src 用到的每個 Mantine class，mantine.css 列的檔都有定義", () => {
    const defined = new Set();
    for (const f of subsetFiles()) for (const n of definedNames(stylesCss(f))) defined.add(n);
    const classes = reachableClasses(usedMantineExports());
    expect(classes.size).toBeGreaterThan(50);

    const owner = new Map();
    for (const f of fs.readdirSync(path.join(CORE, "styles"))) {
      if (!f.endsWith(".css") || f.endsWith(".layer.css")) continue;
      for (const n of definedNames(stylesCss(f))) if (!owner.has(n)) owner.set(n, f);
    }
    const missing = [...classes.keys()].filter((c) => !defined.has(c));
    const toAdd = [...new Set(missing.map((c) => owner.get(c) || `（${c} 找不到定義，來自 ${classes.get(c)}）`))];
    expect(toAdd, `src/css/mantine.css 要補：${toAdd.join("、")}`).toEqual([]);
  });

  test("順序照整份 styles.css，基底三個在最前面", () => {
    const files = subsetFiles();
    expect(files.slice(0, 3)).toEqual(BASE);
    const full = fs.readFileSync(path.join(CORE, "styles.css"), "utf8");
    const pos = files.map((f) => {
      const at = full.indexOf(stylesCss(f).trim().slice(0, 400));
      expect(at, `${f} 在 styles.css 裡找不到`).toBeGreaterThanOrEqual(0);
      return at;
    });
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
  });

  test("沒有人再載整份 styles.css；entry 載的是 mantine.css", () => {
    const offenders = SRC_FILES.filter((f) =>
      /['"]@mantine\/core\/styles(\.layer)?\.css['"]/.test(fs.readFileSync(f, "utf8")),
    ).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
    expect(fs.readFileSync(path.join(SRC, "entry.js"), "utf8")).toMatch(/import\s+'\.\/css\/mantine\.css';/);
  });
});
