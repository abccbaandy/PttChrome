// 拖放上傳 e2e 的檔案路徑守護（issue #53）。
//
// 沒設 locale 的環境（LANG/LC_ALL 空）下，Chromium 的 CDP 拖放遇到非 ASCII 檔案路徑時
// dataTransfer.types 是空的 ⇒ 拖放 spec 整批 `.ImageUploadDropZone` not found。
// 以前檔案寫在 test.info().outputPath()（目錄名＝含中文的 spec 標題）就中了。
import fs from "fs";
import os from "os";
import path from "path";
import { writeDropFiles } from "../e2e/helpers/drop_files.js";

const ASCII = /^[\x20-\x7e]*$/;

describe("writeDropFiles", () => {
  test("檔案落在 os.tmpdir() 下、tmpdir 之後的路徑段全是 ASCII，內容照副檔名", () => {
    const files = writeDropFiles(["a.png", "b.txt"]);
    for (const p of files) {
      const rel = path.relative(os.tmpdir(), p);
      expect(rel.startsWith("..")).toBe(false);
      expect(rel).toMatch(ASCII);
    }
    expect(fs.readFileSync(files[0])[0]).toBe(0x89);
    expect(fs.readFileSync(files[1], "utf8")).toBe("hello");
  });

  test("每次呼叫各用自己的目錄（offline fullyParallel，不可共用檔）", () => {
    const [a] = writeDropFiles(["a.png"]);
    const [b] = writeDropFiles(["a.png"]);
    expect(path.dirname(a)).not.toBe(path.dirname(b));
  });

  test("非 ASCII 檔名直接 throw", () => {
    expect(() => writeDropFiles(["圖片.png"])).toThrow(/ASCII/);
  });

  test("dragFiles 不准再把檔案寫到 test.info().outputPath()", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../e2e/helpers/real_input.js"),
      "utf8",
    );
    expect(src).not.toMatch(/outputPath\(/);
    expect(src).toMatch(/writeDropFiles\(names\)/);
  });
});
