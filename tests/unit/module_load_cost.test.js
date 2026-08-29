// 「模組載入成本不得算進單一 case 的 timeout」的靜態守護。
//
// 病例（2026-08-29 實錄）：tests/unit/bell.test.js 有一條 case 在 test body 裡
// `await import("../../src/js/pttchrome")`。那一句會拖進整條主程式依賴鏈，冷載入在
// 機器忙的時候超過 vitest 預設的 5000ms testTimeout ⇒ 整批 `yarn test:unit` 偶發紅
// （`Error: Test timed out in 5000ms`），單獨重跑該檔又全綠。這種紅最難處理的地方是
// 它指向一支跟載入完全無關的測試名稱，看起來像產品壞掉。
//
// 規則：**test/it 的 body 裡不准動態 import `src/` 的模組**。放檔案層級即可——那段
// 載入發生在 vitest 收集階段，不佔任何一條 case 的預算。
//
// 唯一豁免：檔案裡有 `vi.resetModules()`（模組有 page-lifetime 快取，每條 case 必須
// 拿到全新實例，例如 auto_login_credentials.test.js）。那種情況是刻意重載，不是順手寫的。
import fs from "fs";
import path from "path";

const UNIT_DIR = path.join(__dirname);

// 只掃程式碼：本檔與其他檔的註解本來就在談 `await import(`。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const files = fs
  .readdirSync(UNIT_DIR)
  .filter((f) => /\.test\.jsx?$/.test(f))
  .sort();

test("test body 裡不得動態 import src/ 模組（載入成本會吃掉 case 的 timeout）", () => {
  const offenders = [];
  for (const file of files) {
    const src = stripComments(fs.readFileSync(path.join(UNIT_DIR, file), "utf8"));
    if (/vi\.resetModules\(\)/.test(src)) continue; // 刻意重載，見上方豁免說明
    for (const line of src.split("\n")) {
      // 縮排 > 0 ＝ 在某個 callback 裡；頂層 `await import(...)` 不受限（它跟
      // 一般 import 一樣在收集階段就跑完了）。
      if (/^\s+.*await import\(\s*['"]\.\.\/\.\.\/src\//.test(line)) {
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
  }
  expect(offenders, `把這些 import 提到檔案層級：\n${offenders.join("\n")}`).toEqual([]);
});
