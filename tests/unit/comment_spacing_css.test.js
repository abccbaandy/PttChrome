// 推文區塊行距的 CSS 契約（src/css/main.css 的 .commentSpacing 區塊）。
//
// 手法照抄 tests/unit/lights_on_css.test.js：讀檔、剝註解、正則取規則體。
// 這裡鎖的四件事都是「後人順手改一下就靜默壞掉」的：
//  (1) 兩條規則都在 —— 少了塊間那條就沒有間距，少了塊內那條就沒有 group 感；
//  (2) 塊內（line-height 換算出的額外行距）必須**小於**塊間（margin-top），
//      「內緊外鬆」才成立，反過來就變成「同一人的推文被拆得比別人還開」；
//  (3) 整段不含 letter-spacing / padding / font-weight —— 等寬格線一位移，
//      term_view.fixedResize 的 .wpadding 寬度契約、mouse_geometry.colFromClientX
//      的推文列點擊欄位判定、.floorBadge 的零寬盒全部跟著壞；
//  (4) 不得用 margin-bottom —— #easyReadingLastRow 以 margin-top:-1em 疊在
//      #mainContainer 的 paddingBottom:1em 上，尾端多出的 margin 會把它推離。
import fs from "node:fs";
import path from "node:path";

const CSS = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "css", "main.css"),
  "utf8",
);
const STRIPPED = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

// 含 .commentSpacing 的每一條規則的宣告區塊（選擇器可能是多行逗號串）。
const spacingBlocks = () =>
  [...STRIPPED.matchAll(/[^{}]*\.commentSpacing[^{}]*\{([^}]*)\}/g)].map(
    (m) => m[1],
  );

// 一條規則的「選擇器 + 宣告」整段，方便對特定選擇器取值。
const ruleFor = (selectorFragment) => {
  for (const m of STRIPPED.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    if (m[1].includes(".commentSpacing") && m[1].includes(selectorFragment))
      return m[2];
  }
  return null;
};

const emValue = (body, prop) => {
  const m = body && body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  return m ? parseFloat(m[1]) : null;
};

describe("main.css 的推文區塊行距契約", () => {
  test("塊間（單則推文列與合併塊）有 margin-top", () => {
    const body = ruleFor('span[type="bbsrow"][data-pusher]');
    expect(body).not.toBeNull();
    expect(emValue(body, "margin-top")).toBeGreaterThan(0);
    // 合併塊要跟單則推文列走同一條（或至少也有塊間間距）。
    expect(STRIPPED).toMatch(/\.commentSpacing[^{}]*\.mergedCommentBlock/);
  });

  test("塊內（合併塊每一則）用 line-height 撐開", () => {
    const body = ruleFor(".mergedCommentBlock span");
    expect(body).not.toBeNull();
    const lh = emValue(body, "line-height");
    expect(lh).not.toBeNull();
    expect(lh).toBeGreaterThan(1);
  });

  test("內緊外鬆：塊內的額外行距小於塊間的 margin-top", () => {
    const outer = emValue(ruleFor('span[type="bbsrow"][data-pusher]'), "margin-top");
    const lh = emValue(ruleFor(".mergedCommentBlock span"), "line-height");
    // line-height: 1.3 ⇒ 每則之間多出 0.3em。
    expect(lh - 1).toBeLessThan(outer);
  });

  test("不得出現任何影響橫向格線的屬性", () => {
    for (const body of spacingBlocks()) {
      expect(body).not.toMatch(/letter-spacing/);
      expect(body).not.toMatch(/padding/);
      expect(body).not.toMatch(/font-weight/);
    }
  });

  test("不得用 margin-bottom（會推離 #easyReadingLastRow）", () => {
    for (const body of spacingBlocks()) {
      expect(body).not.toMatch(/margin-bottom/);
      // margin 簡寫同樣含 bottom。
      expect(body).not.toMatch(/(?:^|;)\s*margin\s*:/);
    }
  });

  test("只掛在 #mainContainer.commentSpacing 下（不會污染原生畫面）", () => {
    for (const m of STRIPPED.matchAll(/([^{}]*)\{[^}]*\}/g)) {
      if (!m[1].includes(".commentSpacing")) continue;
      for (const sel of m[1].split(",")) {
        if (!sel.includes(".commentSpacing")) continue;
        expect(sel).toMatch(/#mainContainer\.commentSpacing/);
      }
    }
  });
});
