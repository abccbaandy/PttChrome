// android e2e 開站用的打包版（PTTCHROME_E2E_BUNDLE=1，tests/e2e/android/bundle_server.js）：
// 它保留 developer mode（window.__app 等 e2e 探針、dev 預設站台），**絕不能變成部署的那份**。
// 純靜態掃描：讀 vite.config.mjs 與 workflow 的文字，不載入 Vite。
import fs from "node:fs";
import path from "node:path";
import { useDevServer, OUT_DIR } from "../e2e/android/bundle_server";

const ROOT = path.join(__dirname, "..", "..");
const viteConfig = fs.readFileSync(path.join(ROOT, "vite.config.mjs"), "utf8");

describe("PTTCHROME_E2E_BUNDLE（android e2e 的打包版）", () => {
  test("只在 vite build 時生效，輸出到 dist-e2e（部署讀的是 dist）", () => {
    expect(viteConfig).toMatch(/E2E_BUNDLE\s*=\s*command === 'build' && process\.env\.PTTCHROME_E2E_BUNDLE === '1'/);
    expect(viteConfig).toMatch(/outDir:\s*E2E_BUNDLE \? 'dist-e2e' : 'dist'/);
    expect(OUT_DIR).toBe("dist-e2e");
  });

  test("沒有任何 workflow 設這個環境變數（部署的 build 一定是正式版）", () => {
    const dir = path.join(ROOT, ".github", "workflows");
    for (const f of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      expect(text, f).not.toMatch(/PTTCHROME_E2E_BUNDLE/);
    }
  });

  test("dist-e2e 不進 git", () => {
    expect(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8")).toMatch(/^dist-e2e\/$/m);
  });

  test("逃生門 ANDROID_E2E_DEV_SERVER=1 才改連 dev server", () => {
    expect(useDevServer({})).toBe(false);
    expect(useDevServer({ ANDROID_E2E_DEV_SERVER: "0" })).toBe(false);
    expect(useDevServer({ ANDROID_E2E_DEV_SERVER: "1" })).toBe(true);
  });
});
