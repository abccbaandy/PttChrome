// 「觸控板返回手勢交給瀏覽器原生跑」這件事**只有 CSS 一層守得住**，而它正是
// 最容易被下一個人「順手改回去」的地方（`overscroll-behavior-x: none` 看起來像
// 在防誤觸，實際上會把原生的返回箭頭／跟手／半途取消整組關掉，2026-09 已改掉）。
//
// 靜態掃描 src 底下所有 CSS（＋JSX inline style），風格比照 tests/unit/e2e_layout_settle.test.js。
// 只掃 main.css 不夠：元件 CSS 或 inline style 一樣能把水平導航關掉。
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");
const srcFiles = (re) =>
  fs
    .readdirSync(SRC, { recursive: true })
    .filter((f) => re.test(f))
    .map((f) => path.join(SRC, f));

const CSS = fs.readFileSync(path.join(SRC, "css/main.css"), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

// 去掉註解再掃：檔案裡刻意留了「不要把 none 加回來」的說明文字。
const DECLS = stripComments(CSS);
const ALL_CSS = srcFiles(/\.css$/).map((f) => stripComments(fs.readFileSync(f, "utf8"))).join("\n");

// `.foo, .bar { ... }` → 取出 selector 命中的那個 block 內容。
function blocksFor(selector) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(DECLS))) {
    const sels = m[1].split(",").map((s) => s.trim());
    if (sels.includes(selector)) out.push(m[2]);
  }
  return out;
}

describe("原生返回手勢不可以被 CSS 擋掉", () => {
  test("src 的 CSS 都不得把水平軸設成 none 或 contain", () => {
    // MDN：contain 跟 none 一樣 "disables native browser navigation"；logical 軸
    // inline 在橫書下就是 x。
    expect(ALL_CSS).not.toMatch(/overscroll-behavior-(x|inline)\s*:\s*(none|contain)/);
  });

  test("也不得用兩軸的 overscroll-behavior 簡寫（contain/none 都會停用導航）", () => {
    // 簡寫套兩軸 ⇒ 水平導航一起沒了。兩個值的簡寫第一個值是 x。
    expect(ALL_CSS).not.toMatch(/overscroll-behavior\s*:\s*(none|contain)/);
  });

  test("JSX inline style 也不得擋水平導航", () => {
    const bad = srcFiles(/\.jsx?$/).filter((f) =>
      /overscrollBehavior(X|Inline)?\s*:\s*['"](none|contain)/.test(fs.readFileSync(f, "utf8"))
    );
    expect(bad).toEqual([]);
  });

  test.each([".main", ".listBodyView"])(
    "%s 拆軸：-y 收住 rubber-band，-x 放行導航",
    (sel) => {
      const blocks = blocksFor(sel);
      expect(blocks.length).toBeGreaterThan(0);
      const decls = blocks.join("\n");
      expect(decls).toMatch(/overscroll-behavior-y\s*:\s*contain/);
      // 取**最後一個** -x 宣告：同一個 block 後寫的覆蓋前寫的。
      const xs = [...decls.matchAll(/overscroll-behavior-x\s*:\s*([\w-]+)/g)].map((m) => m[1]);
      expect(xs.at(-1)).toBe("auto");
    }
  );
});
