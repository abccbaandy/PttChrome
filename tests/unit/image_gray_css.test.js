// 單張圖灰階切換鈕的 CSS 契約（src/css/main.css）。
//
// jsdom 沒有排版、也不解 var()/calc()，所以真幾何（按鈕右緣是否貼齊圖片右緣、
// filter 的計算值）只能在真瀏覽器量（tests/e2e/offline/image_gray.offline.spec.js）。
// 這裡守的是「那幾條規則還在、而且沒有被改成寫死尺寸」——三條都是**改壞了也不會有
// 任何測試紅**的那種：
//   1. filter: grayscale(...) 是整個功能的效果本身；
//   2. margin-right 的 --img-w：有人「順手」把它改成寫死的 px 或乾脆拿掉，按鈕就會
//      跑到 slot（整寬區塊）的右緣去，離圖片右上角很遠；
//   3. visibility:hidden + :hover：拿掉就變成每張圖上永遠掛著一顆按鈕。
//
// 手法照抄 tests/unit/merged_comment_image_css.test.js：讀檔、剝註解、正則取規則體。
import fs from "node:fs";
import path from "node:path";

const CSS = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "css", "main.css"),
  "utf8",
);
const STRIPPED = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

const rulesWith = (...fragments) => {
  const out = [];
  for (const m of STRIPPED.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    if (fragments.every((f) => m[1].includes(f)))
      out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
};
const ruleWith = (...fragments) => rulesWith(...fragments)[0] || null;

const decl = (body, prop) => {
  const m = body && body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
};

describe("main.css：單張圖的暫時性灰階", () => {
  test("data-gray 的 slot 裡，真圖套上 grayscale filter", () => {
    const rule = ruleWith('[data-gray="1"]');
    expect(rule).not.toBeNull();
    const value = decl(rule.body, "filter");
    expect(value).not.toBeNull();
    expect(value).toMatch(/grayscale\(/);
    // 只打 <img>：替身盒（.inlinePreviewGhost）雖然也掛 .easyReadingImg，
    // 但它是空的 <div>，灰階它毫無意義。
    expect(rule.selector).toContain("img.easyReadingImg");
  });

  test("按鈕疊在同一個 grid area ⇒ 不增加 slot 高度", () => {
    const rule = ruleWith(".previewGrayBtn");
    expect(rule).not.toBeNull();
    // slot 是 display:grid / grid-template-areas:"stack"（見同檔的佔位盒那段）。
    expect(decl(rule.body, "grid-area")).toBe("stack");
  });

  test("水平位置靠 --img-w 的百分比 margin，不得改成寫死尺寸", () => {
    const rule = ruleWith(".previewGrayBtn");
    expect(rule).not.toBeNull();
    const value = decl(rule.body, "margin-right");
    expect(value).not.toBeNull();
    // 「(100% - 圖寬) / 2」＝ 抵掉 `margin: 0.5em auto` 造成的單側留白。
    expect(value).toContain("--img-w");
    expect(value).toContain("100%");
    expect(value).toMatch(/calc\(/);
  });

  // 垂直方向同理靠量到的值，不是照抄圖片的 0.5em：em 在按鈕身上以按鈕自己的
  // font-size 解析，圖片那個 0.5em 用的是終端機字級 ⇒ 按鈕會浮到圖片上緣之外
  // （實測差 9px，直接壓到上一列文字）。
  test("上緣靠 --img-top，不得寫成 em/寫死尺寸", () => {
    const value = decl(ruleWith(".previewGrayBtn").body, "margin-top");
    expect(value).not.toBeNull();
    expect(value).toContain("--img-top");
    expect(value).not.toMatch(/\d\s*em/);
  });

  test("按鈕不得用 position:fixed/absolute 去貼座標", () => {
    // .main 整體經 transform:scale()，圖片身上還有一條動態反向 scale
    // （term_view.js）⇒ viewport 座標與這裡的 layout 空間對不起來，而且得自己
    // 跟捲動與 resize。整個設計的重點就是**留在同一個 layout 空間裡**。
    // relative（位移 0，只為了開堆疊脈絡）可以，fixed/absolute 不行。
    const rule = ruleWith(".previewGrayBtn");
    const pos = decl(rule.body, "position");
    expect(pos === null || pos === "static" || pos === "relative").toBe(true);
    for (const p of ["top", "left", "right", "bottom"])
      expect(decl(rule.body, p), `position:relative 不該帶 ${p} 位移`).toBeNull();
  });

  // 「DOM 排在後面」不足以疊在圖片上方：<img> 是行內置換元素（繪製順序第 7 步），
  // 按鈕是 block-level grid item（第 4 步）⇒ 圖片反而蓋住按鈕，看得見卻點不到。
  // 拿掉這組宣告不會有任何版面變化，只會讓按鈕靜默失效 —— 正是要守的那種。
  test("按鈕要有自己的堆疊脈絡，否則會被圖片蓋住（看得見卻點不到）", () => {
    const body = ruleWith(".previewGrayBtn").body;
    expect(decl(body, "position")).toBe("relative");
    expect(Number(decl(body, "z-index"))).toBeGreaterThan(0);
  });

  test("平時隱藏，hover slot 或按鈕取得鍵盤焦點才浮現", () => {
    expect(decl(ruleWith(".previewGrayBtn").body, "visibility")).toBe("hidden");
    const shown = rulesWith(".previewGrayBtn").find(
      (r) => decl(r.body, "visibility") === "visible",
    );
    expect(shown, "少了這條按鈕就永遠叫不出來").toBeTruthy();
    expect(shown.selector).toContain(":hover");
    expect(shown.selector).toContain(":focus-visible");
  });

  test("不得動用 !important（比照專案慣例：不堆疊硬調）", () => {
    for (const r of rulesWith(".previewGrayBtn"))
      expect(r.body).not.toMatch(/!important/);
    expect(ruleWith('[data-gray="1"]').body).not.toMatch(/!important/);
  });
});
