// unit project 預設 node 環境（vitest.config.mjs），需要 DOM 的檔案自己在檔頭宣告 jsdom。
// 這支守住宣告方式：漏宣告的檔案在 node 下也會紅，但錯誤會從 testing-library 深處冒出來，
// 不容易看出是「少一行宣告」；宣告不在第一行則可能被誤讀成一般註解而被刪掉。
import fs from "fs";
import path from "path";

const UNIT_DIR = __dirname;
const DOCBLOCK = "// @vitest-environment jsdom";

const files = fs
  .readdirSync(UNIT_DIR)
  .filter((f) => /\.test\.jsx?$/.test(f))
  // 本檔自己就含這些字串（當作比對目標）。
  .filter((f) => f !== path.basename(__filename))
  .sort();

const read = (f) => fs.readFileSync(path.join(UNIT_DIR, f), "utf8");

describe("unit 測試環境宣告", () => {
  test("用 @testing-library 的檔案必須宣告 jsdom", () => {
    const missing = files.filter((f) => /@testing-library\//.test(read(f)) && !read(f).includes(DOCBLOCK));
    expect(missing).toEqual([]);
  });

  test("jsdom 宣告一律放第一行", () => {
    const misplaced = files.filter((f) => read(f).includes(DOCBLOCK) && !read(f).startsWith(DOCBLOCK + "\n"));
    expect(misplaced).toEqual([]);
  });

  test("沒有多餘的 node 宣告（node 已是預設）", () => {
    expect(files.filter((f) => read(f).includes("@vitest-environment node"))).toEqual([]);
  });
});
