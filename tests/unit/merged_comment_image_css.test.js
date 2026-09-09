// 合併推文塊裡的自動開圖「不吃懸掛縮排」的 CSS 契約（src/css/main.css）。
//
// 使用者 2026-09 回報：文章好讀模式下，落在「連續同作者推文合併塊」裡的圖沒滿版
// ——左緣貼齊作者 id 欄，點圖放大後仍少掉整個縮排寬。
// 成因：懸掛縮排是 bbsrow 的 padding-left，而自動開圖的佔位盒 .inlinePreviewSlot
// **住在同一個 bbsrow 裡**且是區塊盒 ⇒ containing block 先被縮排扣掉一截，
// 一般態的 `margin: 0.5em auto` 在變窄的盒子裡置中、放大態的 width:100% 也短一截。
//
// 修法是一條等量負 margin-left（區塊盒 `margin-left + width(auto) = 容器寬` ⇒ 同時
// 拉回左緣並補回寬度）。這裡守的是「規則還在、沒被改成寫死尺寸」——
// jsdom 沒有 layout、也不解 var()/calc()，真幾何只能在真瀏覽器量
// （tests/e2e/offline/comment_merge.offline.spec.js 的「自動開圖不吃懸掛縮排」）。
//
// 手法照抄 tests/unit/comment_spacing_css.test.js：讀檔、剝註解、正則取規則體。
import fs from "node:fs";
import path from "node:path";

const CSS = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "css", "main.css"),
  "utf8",
);
const STRIPPED = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

// 選擇器含所有 fragment 的第一條規則 → 回 { selector, body }。
const ruleWith = (...fragments) => {
  for (const m of STRIPPED.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    if (fragments.every((f) => m[1].includes(f)))
      return { selector: m[1].trim(), body: m[2] };
  }
  return null;
};

const decl = (body, prop) => {
  const m = body && body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
};

describe("main.css：合併推文塊的自動開圖不吃懸掛縮排", () => {
  test("佔位盒以等量負 margin-left 抵消 --merged-comment-indent", () => {
    const rule = ruleWith(".mergedCommentBlock", ".inlinePreviewSlot");
    expect(rule).not.toBeNull();
    const value = decl(rule.body, "margin-left");
    expect(value).not.toBeNull();
    // 必須是「-1 × 同一個縮排變數」，不是任何寫死的數字。
    expect(value).toMatch(/-1\s*\*/);
    expect(value).toContain("--merged-comment-indent");
  });

  test("縮排本體仍在（兩條規則成對，少一條圖就凸出容器左緣）", () => {
    const indent = ruleWith('.mergedCommentBlock span[type="bbsrow"]');
    expect(indent).not.toBeNull();
    expect(decl(indent.body, "padding-left")).toContain(
      "--merged-comment-indent",
    );
  });

  test("不得改成寫死尺寸或 !important", () => {
    const rule = ruleWith(".mergedCommentBlock", ".inlinePreviewSlot");
    expect(rule).not.toBeNull();
    // 寫死 width/padding 會在字級（forceWidth）與視窗寬改變時失準。
    expect(rule.body).not.toMatch(/(?:^|;)\s*width\s*:/);
    expect(rule.body).not.toMatch(/padding/);
    expect(rule.body).not.toMatch(/!important/);
  });

  test("只在合併塊內生效（不污染一般推文列與原生畫面的佔位盒）", () => {
    const rule = ruleWith(".mergedCommentBlock", ".inlinePreviewSlot");
    expect(rule).not.toBeNull();
    for (const sel of rule.selector.split(",")) {
      expect(sel).toContain(".mergedCommentBlock");
    }
  });
});
