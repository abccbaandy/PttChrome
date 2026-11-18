// 架構 review A7：設定索引（src/js/pref_schema.js）是**葉模組**，不准沿靜態 import
// 走到語系檔或 i18n。之後預設值／上雲與否併進同一張表時，開站就載的 pref_storage 要
// import 它；只要這裡有一條路通到 zh_TW_messages／en_US_messages，整份語系字串就被拉進
// 主 bundle，畫面與其他測試照樣全綠（lazy_modal_chunks 只守「現在」誰在主 bundle）。
import fs from "node:fs";
import path from "node:path";
import * as schema from "../../src/js/pref_schema";
import * as search from "../../src/js/pref_search";

const SRC = path.join(process.cwd(), "src");
const SCHEMA = path.join(SRC, "js", "pref_schema.js");
const FORBIDDEN = ["js/i18n.js", "js/zh_TW_messages.js", "js/en_US_messages.js"];

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
const STATIC_RE = /^\s*(?:import|export)\s+(?:[^'"();]*?\s+from\s+)?["']([^"']+)["']/gm;
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// file → 從 pref_schema 走過來的路徑（報錯時印出是哪條 import 鏈拉進來的）
function staticGraph(entry) {
  const via = new Map([[entry, [entry]]]);
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (!/\.(js|jsx|mjs)$/.test(f)) continue;
    const src = stripComments(fs.readFileSync(f, "utf8"));
    for (const m of src.matchAll(STATIC_RE)) {
      const r = resolve(f, m[1]);
      if (r && !via.has(r)) {
        via.set(r, [...via.get(f), r]);
        stack.push(r);
      }
    }
  }
  return via;
}

const rel = (p) => path.relative(SRC, p).split(path.sep).join("/");

describe("pref_schema 是葉模組（A7）", () => {
  test("沿靜態 import 走不到 i18n 或語系檔", () => {
    const via = staticGraph(SCHEMA);
    const bad = [...via.keys()]
      .filter((f) => FORBIDDEN.includes(rel(f)))
      .map((f) => via.get(f).map(rel).join(" → "));
    expect(bad, "pref_schema.js 不准依賴語系字串；要顯示文字的邏輯放 pref_search.js").toEqual([]);
  });

  test("pref_search 照舊 re-export 整份索引（呼叫端不用改）", () => {
    for (const name of Object.keys(schema)) {
      expect(search[name], name).toBe(schema[name]);
    }
    expect(Object.keys(schema)).toContain("PREF_SEARCH_ITEMS");
  });
});
