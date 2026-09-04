// 「開燈」的 CSS 契約（src/css/color.css 的 .lightsOn 區塊）。
//
// 手法照抄 tests/unit/cursor_row_brighten.test.js：讀檔、剝註解、正則取規則體。
// 這裡鎖的三件事都是「後人順手改一下就靜默壞掉」的：
//  (1) 八條 .lightsOn .qN.bN 都在 —— 隱藏文字的判準是 fg===bg，缺一條就漏一種顏色；
//  (2) 整段不含 font-weight / letter-spacing / padding —— 等寬格線一位移，
//      .wpadding 的寬度契約（term_view.fixedResize 直接掃 DOM 改 style.width）跟著壞；
//  (3) 提亮色不可用 #808080 —— 那與 ESC[1;30m 深灰撞色，會分不清「被提亮的隱藏字」
//      與「原本就是深灰的字」。
import fs from "node:fs";
import path from "node:path";

const CSS = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "css", "color.css"),
  "utf8",
);
const STRIPPED = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

// .lightsOn 開頭的每一條規則的宣告區塊（選擇器可能是多行逗號串）。
const lightsBlocks = () =>
  [...STRIPPED.matchAll(/\.lightsOn[^{}]*\{([^}]*)\}/g)].map((m) => m[1]);

describe("color.css 的 .lightsOn 契約", () => {
  test("q0..q7 各自對上同號的 bN（fg===bg 的八種）", () => {
    for (let n = 0; n <= 7; ++n) {
      expect(STRIPPED).toMatch(
        new RegExp(`\\.lightsOn\\s+\\.q${n}\\.b${n}(?![0-9])`),
      );
    }
  });

  test("有提亮色與 text-shadow 標示", () => {
    const blocks = lightsBlocks();
    expect(blocks.length).toBeGreaterThan(0);
    const all = blocks.join(";");
    expect(all).toMatch(/color\s*:/);
    expect(all).toMatch(/text-shadow\s*:/);
  });

  test("不得出現任何影響 layout 的屬性（等寬格線會整列位移）", () => {
    for (const body of lightsBlocks()) {
      expect(body).not.toMatch(/font-weight/);
      expect(body).not.toMatch(/letter-spacing/);
      expect(body).not.toMatch(/padding/);
    }
  });

  test("不用 background-color 當標示（會把整片尾隨空白一起塗亮）", () => {
    for (const body of lightsBlocks()) expect(body).not.toMatch(/background/);
  });

  test("提亮色不是 #808080（會與 1;30 深灰撞色）", () => {
    for (const body of lightsBlocks()) {
      const m = body.match(/(?:^|;)\s*color\s*:\s*([^;]+)/);
      if (!m) continue;
      expect(m[1].trim().toLowerCase()).not.toBe("#808080");
    }
  });

  test("specificity 蓋得過上班模式與游標提亮（都是 .x .qN ＝ (0,2,0)）", () => {
    // .lightsOn .qN.bN 是 (0,3,0)：兩個 class 在同一個 compound selector 上。
    // 這條測試鎖的是「選擇器形狀」——寫成 `.lightsOn .qN .bN`（後代）就會退化成
    // 匹配不到任何東西（同一個 span 上的兩個 class 不是後代關係）。
    expect(STRIPPED).toMatch(/\.lightsOn\s+\.q0\.b0/);
    expect(STRIPPED).not.toMatch(/\.lightsOn\s+\.q0\s+\.b0/);
  });
});
