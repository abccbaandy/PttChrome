// pageState 一律用 PAGE_STATE 具名常數（架構 review A3 步驟 c，docs/screen-model.md）：
// 「3 是文章、2 是列表」這種魔術數字散在幾十個檔裡，PTT 改版要找受影響的判定時只能靠人記得。
// 靜態掃整個 src 的程式碼（註解不算）：名字以 pageState／PageState 結尾的變數不准跟數字比、不准被賦數字。
import fs from "node:fs";
import path from "node:path";
import { PAGE_STATE } from "../../src/js/screen_model.js";

const SRC = path.join(process.cwd(), "src");
const FILES = fs
  .readdirSync(SRC, { recursive: true })
  .filter((f) => /\.jsx?$/.test(f))
  .map((f) => f.split(path.sep).join("/"));

// 一行的程式碼部分：整行註解不算，行尾 `// ...` 也不算（前面要是空白，避免吃到 URL 的 //）。
function codeOf(line) {
  const t = line.trimStart();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
  const m = line.match(/(^|\s)\/\//);
  return m ? line.slice(0, m.index) : line;
}

const MAGIC = [
  /(?<![\w$])[\w$.?]*[pP]ageState\s*(?:===|==|!==|!=|<=|>=|<|>)\s*\d/,
  /(?<![\w.])\d\s*(?:===|==|!==|!=)\s*[\w$.?]*[pP]ageState\b/,
  /(?<![\w$])[\w$.?]*[pP]ageState\s*=(?!=)\s*\d/,
];

function offenders(text) {
  return text
    .split("\n")
    .map(codeOf)
    .filter((code) => MAGIC.some((re) => re.test(code)));
}

describe("pageState 不寫魔術數字", () => {
  test("src 的程式碼裡沒有 pageState 跟數字比較或被賦數字", () => {
    const bad = [];
    for (const f of FILES) {
      if (f === "js/screen_model.js") continue; // 常數本身定義在這裡
      for (const line of offenders(fs.readFileSync(path.join(SRC, f), "utf8"))) bad.push(`${f}: ${line.trim()}`);
    }
    expect(bad).toEqual([]);
  });

  test("守護本身認得出違規（不是永遠綠）", () => {
    for (const bad of [
      "if (this.buf.pageState == 3) {",
      "buf?.pageState === 2 &&",
      "if (3 === pageState) x();",
      "this.prevPageState = 0;",
      "  settledPageState !== 1",
    ])
      expect(offenders(bad), bad).toHaveLength(1);
    for (const ok of [
      "if (pageState === PAGE_STATE.READING) {",
      "// pageState === 3 這種寫法會被擋",
      "const pageStateOverride = 5;",
      "a.pageState == b.pageState",
    ])
      expect(offenders(ok), ok).toHaveLength(0);
  });

  test("常數值沒動（TermBuf.setPageState 寫的就是這些數字，存檔與錄製也是）", () => {
    expect(PAGE_STATE).toEqual({ NORMAL: 0, MENU: 1, LIST: 2, READING: 3, LEGACY_4: 4, PASS: 5, EDITOR: 6 });
  });
});
