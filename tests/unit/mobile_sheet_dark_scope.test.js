// 手機 sheet 的暗色子樹（components/MobileSheet/index.jsx#sheetDarkVarsCss）成立的前提：
// 淺色主題時 <html data-mantine-color-scheme="light">，sheet 掛 "dark"，元件 CSS 的
// `[data-mantine-color-scheme='light'] .m_x` 與 `[...='dark'] .m_x` 在 sheet 裡**兩條都中**、
// 特異度相同 ⇒ 靠「暗色那條寫在後面」勝出。升 Mantine 時順序若變了，sheet 裡的元件就會
// 靜默變回淺色（e2e mobile_sheet「淺色主題」那條只量指令面板一處）。這裡掃 mantine.css
// 載入的每一份元件 CSS：同一個選擇器，淺色規則必須先出現。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const files = fs
  .readFileSync(path.join(ROOT, "src/css/mantine.css"), "utf8")
  .match(/@mantine\/core\/styles\/[A-Za-z]+\.css/g);

// global.css 的 .mantine-dark-hidden／.mantine-light-hidden 是各自一條、不互蓋，不適用。
const EXEMPT = new Set([".mantine-dark-hidden"]);

test("mantine.css 有載元件 CSS", () => {
  expect(files.length).toBeGreaterThan(5);
});

test("同一個選擇器：淺色規則一律寫在暗色規則前面", () => {
  const darkFirst = [];
  for (const f of files) {
    const css = fs.readFileSync(path.join(ROOT, "node_modules", f), "utf8");
    const re = /\[data-mantine-color-scheme=['"](light|dark)['"]\]\s*([^{,]+)/g;
    const first = new Map();
    let m;
    while ((m = re.exec(css))) {
      const sel = m[2].trim();
      if (!first.has(sel)) first.set(sel, m[1]);
    }
    for (const [sel, scheme] of first)
      if (scheme === "dark" && !EXEMPT.has(sel)) darkFirst.push(f + " " + sel);
  }
  expect(darkFirst).toEqual([]);
});
