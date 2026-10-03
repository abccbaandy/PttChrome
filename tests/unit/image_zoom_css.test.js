// 整頁圖片倍率的 CSS 契約（src/css/main.css）。
//
// 這支是 node 環境的靜態掃描。真幾何（圖寬 ≈ 小圖寬 × 倍率）要整份 main.css＋真圖，交給
// tests/e2e/offline/image_zoom.offline.spec.js。這裡守的是「改壞了不會有其他測試紅」的
// 那幾條：倍率公式的輸入、倍率列的定位與 hover 浮現、放大態隱藏倍率列。
// 手法照抄 image_gray_css.test.js。
import fs from "node:fs";
import path from "node:path";

const CSS = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "css", "main.css"),
  "utf8",
);
const STRIPPED = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

const rules = [...STRIPPED.matchAll(/([^{}]*)\{([^}]*)\}/g)].map((m) => ({
  selector: m[1].trim(),
  body: m[2],
}));
const rulesWith = (...fragments) =>
  rules.filter((r) => fragments.every((f) => r.selector.includes(f)));

const decl = (body, prop) => {
  const m = body && body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
};

const barRule = () =>
  rulesWith(".previewZoomBar").find((r) => decl(r.body, "grid-area")) || null;

describe("main.css：整頁圖片倍率", () => {
  test("倍率態的寬度＝小圖寬 × --img-zoom，上限容器寬，高度等比", () => {
    const rule = rulesWith("#mainContainer.imagesZoomed", ".easyReadingImg")[0];
    expect(rule).toBeTruthy();
    const width = decl(rule.body, "width");
    expect(width).toContain("--img-zoom");
    // 小圖寬 = min(原寬, 39em, 19em×寬高比)：與 .easyReadingImg 的兩條上限同一組數字。
    expect(width).toContain("--nat-w");
    expect(width).toContain("--nat-h");
    expect(width).toContain("39em");
    expect(width).toContain("19em");
    expect(decl(rule.body, "max-width")).toBe("100%");
    expect(decl(rule.body, "max-height")).toBe("none");
    expect(decl(rule.body, "height")).toBe("auto");
  });

  test("一鍵放大的規則維持原樣（滿版 width:100%）", () => {
    const rule = rulesWith(
      "#mainContainer.imagesEnlarged",
      ".easyReadingImg",
    ).find((r) => decl(r.body, "width"));
    expect(decl(rule.body, "width")).toBe("100%");
  });

  // 水平置中而非貼圖片邊角：倍率一變圖寬，貼角的按鈕就跟著邊緣跑 ⇒ 無法原地連點。
  test("倍率列疊在同一個 grid area、水平置中、上緣靠量到的 --img-top", () => {
    const rule = barRule();
    expect(rule).not.toBeNull();
    expect(decl(rule.body, "grid-area")).toBe("stack");
    expect(decl(rule.body, "justify-self")).toBe("center");
    expect(decl(rule.body, "margin-left")).toBeNull();
    expect(decl(rule.body, "margin-top")).toContain("--img-top");
    // 同灰階鈕：自己的堆疊脈絡，否則被行內置換元素 <img> 蓋住（看得見卻點不到）。
    expect(decl(rule.body, "position")).toBe("relative");
    expect(Number(decl(rule.body, "z-index"))).toBeGreaterThan(0);
  });

  test("平時隱藏，hover 媒體盒或鍵盤焦點才浮現", () => {
    expect(decl(barRule().body, "visibility")).toBe("hidden");
    const shown = rulesWith(".previewZoomBar").find(
      (r) => decl(r.body, "visibility") === "visible",
    );
    expect(shown).toBeTruthy();
    expect(shown.selector).toContain(".inlinePreviewSlot:hover");
    expect(shown.selector).toContain(":focus-within");
  });

  test("放大態時倍率列藏起來（那時倍率不作用）", () => {
    const hidden = rulesWith(".imagesEnlarged", ".previewZoomBar").find(
      (r) => decl(r.body, "display") === "none",
    );
    expect(hidden).toBeTruthy();
  });

  // 「150% 滾輪往上捲不動、畫面上下抖」的根因（ptt-debug-20260928-181323）：slot 的
  // implicit auto 軌道被替身盒（<div>，絕對寬＝小圖寬×倍率）撐寬 ⇒ max-width:100% 失效。
  // 真幾何在 tests/e2e/offline/image_zoom.offline.spec.js「替身盒與真圖同尺寸」。
  test("slot 的欄寬釘死在 slot 寬，不隨內容長（倍率態替身盒才不會撐破版面）", () => {
    const slot = rules.find((r) => r.selector === ".inlinePreviewSlot");
    expect(slot).toBeTruthy();
    expect(decl(slot.body, "grid-template-columns")).toBe("minmax(0, 1fr)");
  });

  test("不用 :has()（build.target 含 firefox110）", () => {
    for (const r of rulesWith(".previewZoomBar"))
      expect(r.selector).not.toContain(":has(");
    for (const r of rulesWith(".imagesZoomed"))
      expect(r.selector).not.toContain(":has(");
  });
});
