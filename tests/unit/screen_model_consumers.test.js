// A3（docs/screen-model.md「消費端」）：已改讀畫面物件（screen_model.screenOf）的模組，不准再直接讀
// `buf.pageState`。改回直接讀就是兩套判準並存：同一幀裡一個讀模型、一個讀 buf，中間 buffer 被改寫時
// 兩邊說法不一（送鍵的守門尤其要緊）。新搬完一個模組就加進 MIGRATED。
// 只掃程式碼：註解剝掉（註解照舊可以寫 pageState 的數字與來歷）。
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "..", "src", "js");

const MIGRATED = [
  "comment_bar.js",
  "article_tools.js",
  "nav_key_gate.js",
  "long_push_gate.js",
  "aid_navigation.js",
  "next_article.js",
  "new_comments.js",
  "recent_articles.js",
  "editor_input.js",
  "live_helper.js",
];

// 一行的程式碼部分（跟 lint 規則接手前的 page_state_constants.test.js#codeOf 同一套）：逐行判，不跨行剝 ⇒ 字串裡的 `/*` 不會
// 吃掉後面整段程式碼造成假綠，行號也跟原檔一致。
function codeOf(line) {
  const t = line.trimStart();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
  const m = line.match(/(^|\s)\/\//);
  return m ? line.slice(0, m.index) : line;
}
const stripComments = (code) => code.split("\n").map(codeOf).join("\n");

describe("已搬到畫面物件的模組不直接讀 buf.pageState", () => {
  test.each(MIGRATED)("%s", (file) => {
    const code = stripComments(fs.readFileSync(path.join(SRC, file), "utf8"));
    const hits = code
      .split("\n")
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => /\b(?:buf|_termBuf|termBuf)\.pageState\b|\[[\x27"]pageState[\x27"]\]|\{[^}]*\bpageState\b[^}]*\}\s*=\s*(?:this\.)?_?(?:buf|termBuf)\b/.test(line));
    expect(hits).toEqual([]);
  });

  test("每個都真的讀了 screenOf（不是整段拿掉判斷）", () => {
    for (const file of MIGRATED) {
      const code = stripComments(fs.readFileSync(path.join(SRC, file), "utf8"));
      expect(code, file).toMatch(/\bscreenOf\(/);
    }
  });
});
