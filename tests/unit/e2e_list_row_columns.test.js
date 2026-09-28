// live e2e 看板列表列的欄位解析（tests/e2e/helpers/list_row.js）。
//
// 為什麼要有這條：enhance.spec.js「看板列表黑名單」原本用 textContent.substring(17, 29)
// 切作者欄。推文數欄出現「爆」（全形：1 個 JS char、佔 2 個終端機欄位）時整列左移一格，
// 作者被砍頭（"350570 +爆 9/28 laptic" → "aptic"）⇒ 黑名單什麼都沒命中、noticeCount 0，
// 看起來像產品壞了。欄位一律按終端機欄位算（Big5：> 0x7f 雙寬）。
//
// 欄位（0-indexed）：cols 0-6 序號 %7d / 7 空白 / 8 type / 9-10 推文數 /
//   11-16 日期 / 17-29 作者 / 30-31 mark / 32 空白 / 33- 標題
import { sliceColumns, listRowAuthor, isListIndexRow } from "../e2e/helpers/list_row";

// 依欄位表組一列；push 欄固定 2 欄寬（「爆」本身就佔 2 欄）。
const row = ({ num = " 350570", type = "+", push = " 9", author = "laptic" }) =>
  num + " " + type + push + " 9/28 " + author.padEnd(13, " ") + "□ " + " [閒聊] 標題";

describe("sliceColumns（依終端機欄位切片）", () => {
  test("全 ASCII 時等同 substring", () => {
    expect(sliceColumns("abcdefgh", 2, 5)).toBe("cde");
  });

  test("全形字佔 2 欄，後面的欄位不左移", () => {
    // 爆 佔 cols 1-2 ⇒ 'x' 在 col 3
    expect(sliceColumns("a爆xyz", 3, 4)).toBe("x");
    expect(sliceColumns("a爆xyz", 1, 3)).toBe("爆");
  });

  test("跨越區間邊界的全形字不收（不切出半個字）", () => {
    expect(sliceColumns("a爆xyz", 2, 4)).toBe("x");
    expect(sliceColumns("a爆xyz", 0, 2)).toBe("a");
  });
});

describe("listRowAuthor（作者欄 cols 17-29）", () => {
  test("推文數是「爆」時作者完整（回歸：曾切成 'aptic'）", () => {
    const r = row({ push: "爆", author: "laptic" });
    expect(r.substring(17, 29).trim()).not.toBe("laptic"); // 舊寫法的症狀
    expect(listRowAuthor(r)).toBe("laptic");
  });

  test("一般數字推文數", () => {
    expect(listRowAuthor(row({ push: "12", author: "SomeUser" }))).toBe("SomeUser"); // 保留大小寫
  });

  test("置底列 ★ 與舊游標 ● 的雙寬前綴也不位移", () => {
    expect(listRowAuthor(row({ num: "      ★", author: "abc123" }))).toBe("abc123");
    expect(listRowAuthor(row({ num: "●50570", author: "abc123" }))).toBe("abc123");
  });

  test("作者欄不是合法帳號形狀（被刪文 '-'）回空字串", () => {
    expect(listRowAuthor(row({ author: "-" }))).toBe("");
  });
});

describe("isListIndexRow", () => {
  test("一般列／新游標 '>'／舊游標 ●／推文數「爆」都算索引列", () => {
    expect(isListIndexRow(row({}))).toBe(true);
    expect(isListIndexRow(row({ num: "> 50570" }))).toBe(true);
    expect(isListIndexRow(row({ num: "●50570" }))).toBe(true);
    expect(isListIndexRow(row({ push: "爆" }))).toBe(true);
  });

  test("置底列（序號欄是 ★）與非列表列不算", () => {
    expect(isListIndexRow(row({ num: "      ★" }))).toBe(false);
    expect(isListIndexRow("【板主:xxx】  看板《C_Chat》")).toBe(false);
    expect(isListIndexRow("")).toBe(false);
  });

  test("作者被刪（'-'）不算", () => {
    expect(isListIndexRow(row({ author: "-" }))).toBe(false);
  });
});
