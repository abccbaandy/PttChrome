// 型別檢查的範圍（架構 review A5 步驟 b，docs/build-modernization.md「型別檢查」）：
// `yarn typecheck` 只檢查檔頭寫了 `// @ts-check` 的 JS。這裡守兩件事：
//   1. 指定要檢查的模組真的有 @ts-check（拿掉就等於默默退出型別檢查）。
//   2. 設定維持「逐檔 opt-in、strict」：checkJs 一打開，整個舊式 prototype 碼會一次湧進來。
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

// 新寫的出口與模型、指定的純邏輯模組。要加就加在這裡（並在檔頭寫 // @ts-check）。
const CHECKED = ["src/js/wire_send.js", "src/js/screen_model.js"];

describe("yarn typecheck 的範圍", () => {
  test.each(CHECKED)("%s 檔頭是 // @ts-check", (f) => {
    const first = fs.readFileSync(path.join(ROOT, f), "utf8").split("\n")[0];
    expect(first).toBe("// @ts-check");
  });

  test("tsconfig.check.json：逐檔 opt-in、strict、不輸出", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "tsconfig.check.json"), "utf8"));
    expect(cfg.compilerOptions).toMatchObject({ allowJs: true, checkJs: false, strict: true, noEmit: true });
  });

  test("CI 的 test-unit job 有跑 yarn typecheck 與 yarn lint", () => {
    const yml = fs.readFileSync(path.join(ROOT, ".github/workflows/test.yml"), "utf8");
    const job = yml.slice(yml.indexOf("  test-unit:"), yml.indexOf("  test-integration:"));
    expect(job).toMatch(/^\s*run: yarn lint\s*$/m);
    expect(job).toMatch(/^\s*run: yarn typecheck\s*$/m);
  });
});
