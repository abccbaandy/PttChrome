// pageState 一律用 PAGE_STATE 具名常數（架構 review A3 步驟 c，docs/screen-model.md）：
// 「3 是文章、2 是列表」這種魔術數字散在幾十個檔裡，PTT 改版要找受影響的判定時只能靠人記得。
// 「src 裡名字以 pageState／PageState 結尾的不准跟數字比、被賦數字、switch case 數字」由 lint 規則
// pttchrome/no-magic-page-state 擋（tools/lint/pttchrome_rules.mjs，自證在 lint_rules.test.js）。
// 這裡只鎖常數值本身。
import { PAGE_STATE } from "../../src/js/screen_model.js";

test("常數值沒動（TermBuf.setPageState 寫的就是這些數字，存檔與錄製也是）", () => {
  expect(PAGE_STATE).toEqual({ NORMAL: 0, MENU: 1, LIST: 2, READING: 3, LEGACY_4: 4, PASS: 5, EDITOR: 6 });
});
