// 從 yarn.lock 讀出 @playwright/test 實際鎖定的版本，給 CI 組 Playwright 官方 Docker image tag
// （.github/workflows/test.yml 的 playwright-version job → e2e job 的 container.image）。
//
// 為什麼 image tag 不直接寫死在 workflow：image 內建的瀏覽器版本必須與 npm 套件完全一致
// （不一致 ⇒ `Executable doesn't exist`，整批秒掛）。Dependabot 升 @playwright/test 時只會改
// package.json／yarn.lock，不會動 workflow 裡的字串 ⇒ 寫死就是每次升版都紅。
// 讀 yarn.lock 而非 node_modules：這個 job 不跑 yarn install，checkout 完就能讀。
//
// 用法：`node scripts/playwright-version.mjs` → stdout 印 `version=1.63.0`（直接 >> $GITHUB_OUTPUT）。
// 守護 tests/unit/ci_playwright_container.test.js。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 純函式：yarn.lock（Yarn berry 格式）原文 → @playwright/test 的版本字串；找不到丟錯。
export function playwrightVersionFromLock(lock) {
  const m = /^"@playwright\/test@[^"\n]*":\n {2}version: (\S+)$/m.exec(lock);
  if (!m) throw new Error("yarn.lock 裡找不到 @playwright/test");
  if (!/^\d+\.\d+\.\d+$/.test(m[1])) throw new Error(`@playwright/test 版本格式不符：${m[1]}`);
  return m[1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const lock = fs.readFileSync(path.join(root, "yarn.lock"), "utf8");
  console.log(`version=${playwrightVersionFromLock(lock)}`);
}
