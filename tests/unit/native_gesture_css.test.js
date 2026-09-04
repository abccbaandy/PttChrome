// 「觸控板返回手勢交給瀏覽器原生跑」這件事**只有 CSS 一層守得住**，而它正是
// 最容易被下一個人「順手改回去」的地方（`overscroll-behavior-x: none` 看起來像
// 在防誤觸，實際上會把原生的返回箭頭／跟手／半途取消整組關掉，2026-09 已改掉）。
//
// 靜態掃描 src/css/main.css，風格比照 tests/unit/e2e_layout_settle.test.js。
import fs from "node:fs";
import path from "node:path";

const CSS = fs.readFileSync(
  path.join(process.cwd(), "src/css/main.css"),
  "utf8"
);

// 去掉註解再掃：檔案裡刻意留了「不要把 none 加回來」的說明文字。
const DECLS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

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
  test("整份 main.css 都不得再出現 overscroll-behavior-x: none", () => {
    expect(DECLS).not.toMatch(/overscroll-behavior-x\s*:\s*none/);
  });

  test("也不得用兩軸的 overscroll-behavior 簡寫（contain/none 都會停用導航）", () => {
    // MDN：contain "disables native browser navigation, including ... horizontal
    // swipe navigation"。簡寫套兩軸 ⇒ 水平導航一起沒了。
    expect(DECLS).not.toMatch(/overscroll-behavior\s*:\s*(none|contain)/);
  });

  test.each([".main", ".listBodyView"])(
    "%s 拆軸：-y 收住 rubber-band，-x 放行導航",
    (sel) => {
      const blocks = blocksFor(sel);
      expect(blocks.length).toBeGreaterThan(0);
      const decls = blocks.join("\n");
      expect(decls).toMatch(/overscroll-behavior-y\s*:\s*contain/);
      expect(decls).toMatch(/overscroll-behavior-x\s*:\s*auto/);
    }
  );
});
