// 主 bundle 拆檔（docs/build-modernization.md「主 bundle 拆檔」）：用到才開的大彈窗
// 走 React.lazy，各自成獨立 chunk，不進開站就要下載／解析的主 bundle。
//
// 這件事最容易被「順手」改壞：任何一個開站就會載入的模組多寫一行
// `import PrefModal from ".../PrefModal"`，Rolldown 就把整包（連同 NumberInput、
// react-number-format、Tabs、設定搜尋索引）拉回主 bundle，畫面與測試全都照常綠。
// 所以這裡從 entry 沿著**靜態** import 走一遍（dynamic import() 不算），
// 斷言這些模組一個都走不到。
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");
const ENTRY = path.join(SRC, "entry.js");

// 只該出現在 lazy chunk 的模組（相對 src）。
const LAZY_ONLY = [
  "components/ContextMenu/PrefModal.jsx",
  "components/ContextMenu/PrefSearchBox.jsx",
  "components/ContextMenu/CommandPalette.jsx",
  "components/ContextMenu/SearchModal.jsx",
  "components/ContextMenu/InputHelperModal.jsx",
  "components/ContextMenu/LiveHelperModal.jsx",
  "components/ContextMenu/LongPushModal.jsx",
  "js/pref_search.js",
  "js/command_palette.js",
  // 英文語系：i18n.js 用 dynamic import 載，main.jsx 開站前 await（中文使用者不下載）。
  "js/en_US_messages.js",
];

// 只有上面那些彈窗用到的 Mantine 元件：主 bundle 引用任何一個，就會把它（和它
// 背後的 react-number-format／Combobox 等）拉回開站必載的範圍。
const LAZY_ONLY_MANTINE = ["NumberInput", "Tabs", "SegmentedControl", "Select", "Switch", "Combobox"];

const EXTS = ["", ".js", ".jsx", "/index.js", "/index.jsx"];
const resolve = (from, spec) => {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), spec.replace(/\?.*$/, ""));
  for (const ext of EXTS) {
    const p = base + ext;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
};

// 靜態 import／re-export（多行 import 也吃）；`import(` 開頭的 dynamic import 不吃。
const STATIC_RE = /^\s*(?:import|export)\s+(?:[^'"();]*?\s+from\s+)?["']([^"']+)["']/gm;
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function eagerGraph() {
  const seen = new Map(); // file → source
  const stack = [ENTRY];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || !/\.(js|jsx|mjs)$/.test(f)) continue;
    const src = stripComments(fs.readFileSync(f, "utf8"));
    seen.set(f, src);
    for (const m of src.matchAll(STATIC_RE)) {
      const r = resolve(f, m[1]);
      if (r) stack.push(r);
    }
  }
  return seen;
}

const graph = eagerGraph();
const rel = (f) => path.relative(SRC, f).split(path.sep).join("/");

test("entry 的靜態 import 圖確實有走到核心模組（掃描器本身沒壞）", () => {
  const files = [...graph.keys()].map(rel);
  expect(files).toContain("js/main.jsx");
  expect(files).toContain("components/ContextMenu/index.jsx");
  expect(files).toContain("js/term_view.js");
  expect(files.length).toBeGreaterThan(100);
});

test.each(LAZY_ONLY)("%s 不在開站必載的靜態 import 圖裡", (mod) => {
  const files = [...graph.keys()].map(rel);
  expect(files).not.toContain(mod);
});

test("開站必載的模組都不從 @mantine/core 引用只有 lazy 彈窗才用的元件", () => {
  const offenders = [];
  for (const [f, src] of graph) {
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@mantine\/core["']/g)) {
      const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]);
      for (const n of names) if (LAZY_ONLY_MANTINE.includes(n)) offenders.push(`${rel(f)}: ${n}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("ContextMenu 以 lazy(() => import(...)) 載入這些彈窗，且都包在 Suspense 裡", () => {
  const src = fs.readFileSync(path.join(SRC, "components/ContextMenu/index.jsx"), "utf8");
  const names = LAZY_ONLY.filter((m) => m.startsWith("components/ContextMenu/") && !m.includes("PrefSearchBox")).map(
    (m) => path.basename(m, ".jsx"),
  );
  for (const n of names) {
    expect(src).toMatch(new RegExp(`const ${n} = lazy\\(\\(\\) => import\\("\\./${n}"\\)\\)`));
    // 這個元件的 JSX 緊接在 <Suspense fallback={null}> 後面：沒包的話 lazy 元件一
    // suspend，就會往上找到更外層的 boundary（或沒有 ⇒ 整棵 ContextMenu 一起空白）。
    expect(src).toMatch(new RegExp(`<Suspense fallback=\\{null\\}>\\s*<${n}\\b`));
  }
});
