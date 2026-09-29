// vite.config.mjs 的 optimizeDeps.entries 必須只指向 app 自己的入口。
//
// 沒設的話 Vite 會掃專案底下**所有** .html 當依賴掃描的入口，連 gitignore 掉的
// 3rd_script/（別人的專案原始碼，研究用，依賴沒裝）也掃 ⇒ 每次 `yarn start` 都印一整串
// 「Failed to run dependency scan … Are they installed?」，而且掃描失敗會讓 Vite 跳過
// 整個預打包（firebase 那組 include 一起失效 ⇒ 冷快取時 mid-session re-optimize ⇒
// 強制 full reload）。刪掉這一行不會讓任何其他測試紅，所以這裡守。
//
// 純靜態掃描（理由同 build_target_baseline.test.js：載入 config 會拉起整條 Vite 依賴鏈）。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const CODE = fs
  .readFileSync(path.join(ROOT, "vite.config.mjs"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("vite.config.mjs：optimizeDeps.entries", () => {
  test("只有根目錄的 index.html（app 唯一入口）", () => {
    const m = CODE.match(/\bentries\s*:\s*\[([^\]]*)\]/);
    expect(m, "optimizeDeps.entries 不見了 ⇒ 依賴掃描會掃進 3rd_script/").not.toBeNull();
    const entries = m[1]
      .split(",")
      .map((s) => s.trim().replace(/['"]/g, ""))
      .filter(Boolean);
    expect(entries).toEqual(["index.html"]);
    expect(fs.existsSync(path.join(ROOT, "index.html"))).toBe(true);
  });
});
