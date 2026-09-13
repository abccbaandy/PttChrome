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

// 按鈕的**主規則**（外觀與定位那條）。不可用「第一個含 .previewGrayBtn 的規則」來取：
// 同一個 class 另有兩條 —— pointer-events 恢復條（slot 讓開 hit-test 之後子孫要逐一
// 取回，見 preview_pointer_events_css.test.js）與 :hover 顯示條，而且排在它前面。
// 認 grid-area 是因為「疊在同一格、不增加 slot 高度」本來就是主規則的識別特徵。
const btnRule = () =>
  rulesWith(".previewGrayBtn").find((r) => decl(r.body, "grid-area")) || null;

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
    const rule = btnRule();
    expect(rule).not.toBeNull();
    // slot 是 display:grid / grid-template-areas:"stack"（見同檔的佔位盒那段）。
    expect(decl(rule.body, "grid-area")).toBe("stack");
  });

  test("水平位置靠 --img-w 的百分比 margin，不得改成寫死尺寸", () => {
    const rule = btnRule();
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
    const value = decl(btnRule().body, "margin-top");
    expect(value).not.toBeNull();
    expect(value).toContain("--img-top");
    expect(value).not.toMatch(/\d\s*em/);
  });

  test("按鈕不得用 position:fixed/absolute 去貼座標", () => {
    // .main 整體經 transform:scale()，圖片身上還有一條動態反向 scale
    // （term_view.js）⇒ viewport 座標與這裡的 layout 空間對不起來，而且得自己
    // 跟捲動與 resize。整個設計的重點就是**留在同一個 layout 空間裡**。
    // relative（位移 0，只為了開堆疊脈絡）可以，fixed/absolute 不行。
    const rule = btnRule();
    const pos = decl(rule.body, "position");
    expect(pos === null || pos === "static" || pos === "relative").toBe(true);
    for (const p of ["top", "left", "right", "bottom"])
      expect(decl(rule.body, p), `position:relative 不該帶 ${p} 位移`).toBeNull();
  });

  // 「DOM 排在後面」不足以疊在圖片上方：<img> 是行內置換元素（繪製順序第 7 步），
  // 按鈕是 block-level grid item（第 4 步）⇒ 圖片反而蓋住按鈕，看得見卻點不到。
  // 拿掉這組宣告不會有任何版面變化，只會讓按鈕靜默失效 —— 正是要守的那種。
  test("按鈕要有自己的堆疊脈絡，否則會被圖片蓋住（看得見卻點不到）", () => {
    const body = btnRule().body;
    expect(decl(body, "position")).toBe("relative");
    expect(Number(decl(body, "z-index"))).toBeGreaterThan(0);
  });

  test("平時隱藏，hover 真圖或按鈕取得鍵盤焦點才浮現", () => {
    expect(decl(btnRule().body, "visibility")).toBe("hidden");
    const shown = rulesWith(".previewGrayBtn").find(
      (r) => decl(r.body, "visibility") === "visible",
    );
    expect(shown, "少了這條按鈕就永遠叫不出來").toBeTruthy();
    expect(shown.selector).toContain(":hover");
    expect(shown.selector).toContain(":focus-visible");
  });

  // 那條 :hover 寫的是 slot，而 slot 是**整列寬**的區塊（沒有 width 宣告，繼承 .main
  // 的 chw*80+10px，圖片卻是 max-width:39em + margin:auto 置中）。它之所以夠精確，
  // 完全靠 slot 的 pointer-events:none 把 hit target 收斂到媒體盒（:hover 再沿祖先鏈
  // 傳上來）。**兩條是綁死的一組**：只拿掉 pointer-events 那條，按鈕就退回「捲到這
  // 張圖就常駐」——使用者實際回報過的症狀，而且沒有任何其他測試會紅。
  //
  // 不用 :has(img:hover) 寫成明示條件是刻意的：build.target 含 firefox110，:has() 要
  // 到 Firefox 121 才有，選擇器清單裡有一個無效會讓**整條規則被丟棄** ⇒ 按鈕永遠
  // 叫不出來。宣告本身的守護在 preview_pointer_events_css.test.js，這裡守關聯。
  test("hover 觸發靠 slot 的 pointer-events:none 收斂，不得只剩選擇器", () => {
    const shown = rulesWith(".previewGrayBtn").find(
      (r) => decl(r.body, "visibility") === "visible",
    );
    expect(shown.selector).toContain(".inlinePreviewSlot:hover");
    const slot = rulesWith(".inlinePreviewSlot").find(
      (r) => r.selector === ".inlinePreviewSlot",
    );
    expect(slot, "找不到 .inlinePreviewSlot 的規則").toBeTruthy();
    expect(
      decl(slot.body, "pointer-events"),
      "slot 不讓開 hit-test ⇒ :hover 擴散到整列寬 ⇒ 按鈕幾乎永遠掛著",
    ).toBe("none");
  });

  test("不得動用 !important（比照專案慣例：不堆疊硬調）", () => {
    for (const r of rulesWith(".previewGrayBtn"))
      expect(r.body).not.toMatch(/!important/);
    expect(ruleWith('[data-gray="1"]').body).not.toMatch(/!important/);
  });
});
