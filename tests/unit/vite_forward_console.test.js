// vite.config.mjs 的 server.forwardConsole 必須明確寫 true。
//
// Vite 8 沒設時的預設是 `determineAgent().isAgent`：在 AI coding agent 裡跑 dev server
// 才開、CI 與一般人手動 `yarn start` 不開 ⇒ dev server 的行為隨「誰在跑」而變。
// 實例：tests/e2e/offline/harness.offline.spec.js「送出紀錄不混進 Vite HMR 流量」以
// 「HMR socket 真的送出 vite:forward-console」當柵欄前提，本機（agent）6/6 綠、CI 必紅。
// 刪掉這一行本機任何測試都不會紅，所以這裡守。
//
// 純靜態掃描（理由同 build_target_baseline.test.js：載入 config 會拉起整條 Vite 依賴鏈）。
import fs from "node:fs";
import path from "node:path";

const CODE = fs
  .readFileSync(path.join(__dirname, "..", "..", "vite.config.mjs"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("vite.config.mjs：server.forwardConsole", () => {
  test("明確開啟（不吃 agent 偵測的預設）", () => {
    expect(CODE).toMatch(/\bforwardConsole\s*:\s*true\b/);
  });
});
