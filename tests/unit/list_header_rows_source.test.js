// 「header 列數只有 session 說了算」的靜態守護。
//
// 兩種列表的 header 是**兩個不同的常數**（`list_window.LIST_HEADER_ROWS` 與
// `board_list_parse.BRD_HEADER_ROWS`，同值 3 但語意不同、刻意各自宣告），而滑鼠
// 座標鏈是**兩者共用**的一條路：
//
//   clientToPos（pttchrome.jsx）      螢幕 y → render row
//   onListMouseMove（term_view.js）   render row → body idx（hover）
//   onMouseClick（兩個 session）      render row → body idx（開文／進板）
//
// 呼叫端自己挑常數時，只要其中一邊改版就是**靜默連坐**：clientToPos 用文章列表的
// 常數算出 row，BoardListSession 再用自己的常數反算 idx ⇒ 點進錯的看板、hover 落在
// 錯的列，而且不會有任何錯誤訊息。所以規則是：**這兩個檔案不得直接消費那兩個常數
// 當作「列表 header 列數」，一律問 session 的 headerRows()。**
//
// 行為面的鎖在 tests/unit/list_mark_read.test.js 與 board_list_session.test.js
// （覆寫 headerRows() 後換算要跟著走）；這支補的是那兩個 unit 測不到的呼叫端
// （需要真 DOM + componentScreen）。純靜態掃描 ⇒ 放 unit，比照
// tests/unit/e2e_layout_settle.test.js。
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..");
const SRC = path.join(ROOT, "src", "js");

// 只掃**程式碼**：這幾個檔案的註解本來就在談這兩個常數（那正是規範的內容），
// 連註解一起掃會被自己的說明文字誤判。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const read = (f) => stripComments(fs.readFileSync(path.join(SRC, f), "utf8"));

// term_view 有**自己的**組裝路徑會正當使用這兩個常數（buildListWindowLines /
// buildBoardListWindowLines 各組各的畫面，以及 render 分支的 bodyStart 分岔），
// 所以不能整檔禁用，只鎖那個兩種列表共用的函式。
function functionBody(src, name) {
  const start = src.indexOf(name + ": function");
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  let i = src.indexOf("{", start);
  const from = i;
  for (; i < src.length; ++i) {
    if (src[i] === "{") ++depth;
    else if (src[i] === "}" && --depth === 0) return src.slice(from, i + 1);
  }
  throw new Error(`找不到 ${name} 的函式尾`);
}

describe("header 列數的單一真相源", () => {
  test("兩個 session 都提供 headerRows()，各回自己的常數", () => {
    const ls = read("list_session.js");
    const bs = read("board_list_session.js");
    expect(functionBody(ls, "headerRows")).toContain("LIST_HEADER_ROWS");
    expect(functionBody(bs, "headerRows")).toContain("BRD_HEADER_ROWS");
  });

  test("clientToPos（pttchrome.jsx）不得自己挑常數", () => {
    const src = read("pttchrome.jsx");
    expect(src).not.toContain("LIST_HEADER_ROWS");
    expect(src).not.toContain("BRD_HEADER_ROWS");
    // 走的是 session。
    expect(src).toContain("headerRows()");
  });

  test("onListMouseMove（term_view.js）不得自己挑常數", () => {
    const body = functionBody(read("term_view.js"), "onListMouseMove");
    expect(body).not.toContain("LIST_HEADER_ROWS");
    expect(body).not.toContain("BRD_HEADER_ROWS");
    expect(body).toContain("headerRows()");
  });

  test("兩個 session 的 onMouseClick 都走 headerRows()", () => {
    for (const f of ["list_session.js", "board_list_session.js"]) {
      const body = functionBody(read(f), "onMouseClick");
      expect(body).not.toContain("LIST_HEADER_ROWS");
      expect(body).not.toContain("BRD_HEADER_ROWS");
      expect(body).toContain("this.headerRows()");
    }
  });
});
