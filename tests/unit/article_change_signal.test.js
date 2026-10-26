// 靜態守護：增量掃好讀累積頁（只餵新長出來的列）的快取，換文章一律要看 view._articleInstanceId。
//
// 這類快取原本只靠「首列變了／累積頁變短」認換文章，但首列是「作者 … 看板 …」：同作者同看板的
// 兩篇一字不差，上一篇又比下一篇的第一頁短時兩個訊號都認不出來 ⇒ 接著上一篇的列往下數。
// 實際爆過：AID 用上一篇的（長推文送 #AID 推到別篇）、新推文標記記到上一篇的紀錄、
// 篩選鈕則數疊上一篇、導覽軸／工具側欄標在上一篇的位置。
// 判準：檔案裡有「拿累積頁首列當快取鍵」的寫法（getRowText(0, 0, …, acc|lines)）就要同檔用到 _articleInstanceId。
import fs from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../../src/js");
const HEAD_KEY = /getRowText\(0,\s*0,\s*[\w.]+\.cols,\s*(acc|lines)\)/;

const files = fs
  .readdirSync(SRC)
  .filter((f) => /\.(js|jsx)$/.test(f))
  .filter((f) => HEAD_KEY.test(fs.readFileSync(path.join(SRC, f), "utf8")));

test("有用累積頁首列當快取鍵的模組（避免守護空轉）", () => {
  expect(files).toEqual(
    expect.arrayContaining(["aid_navigation.js", "article_nav.js", "article_tools.js", "new_comments.js", "term_view.js"]),
  );
});

test.each(files)("%s：換文章看 _articleInstanceId", (f) => {
  expect(fs.readFileSync(path.join(SRC, f), "utf8")).toContain("_articleInstanceId");
});
