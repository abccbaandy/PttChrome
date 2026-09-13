// build.target 必須是 Vite 的 'baseline-widely-available' 字面值，不得退回手寫版本號。
//
// 為什麼要守這一行（它是「改掉也不會有任何其他測試紅」的那種）：
//   * 字面值由 Vite 解析成 Baseline Widely Available 那組，且**每個 Vite major 自己
//     往前 bump** ⇒ 零維護。手寫版本號沒有人會記得更新——2026-09 之前它就釘在
//     chrome110/edge110/firefox110/safari16（2023 年初）整整三年，比 CLAUDE.md 慣例
//     寫的「主流桌機瀏覽器現代版」寬鬆得多，而且挑那組數字時沒有任何依據。
//   * **Playwright 跑的是它自帶的最新 Chromium/Firefox**，所以「用了超出 target 的
//     語法／CSS 特性」在整套 e2e 裡一條都不會紅 —— 這個設定是唯一防線。CSS 的選擇器
//     清單裡只要有一個無效，整條規則會被丟棄（2026-09 灰階鈕的 `:has()` 差點踩到：
//     它要 Firefox 121，超出這條線，而測試完全抓不到）。
//
// 純靜態掃描：讀 vite.config.mjs 的文字，不載入它（載入會拉起整條 Vite 依賴鏈，
// 違反 module_load_cost 的規範）。
import fs from "node:fs";
import path from "node:path";

const CONFIG = fs.readFileSync(
  path.join(__dirname, "..", "..", "vite.config.mjs"),
  "utf8",
);
// 剝掉註解，免得被說明文字裡提到的版本號誤傷。
const CODE = CONFIG.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("vite.config.mjs：build.target", () => {
  test("用 'baseline-widely-available' 字面值（隨 Vite major 自動前進）", () => {
    const m = CODE.match(/\btarget\s*:\s*([^,\n]+)/);
    expect(m, "找不到 build.target").not.toBeNull();
    expect(m[1].trim().replace(/['"]/g, "")).toBe("baseline-widely-available");
  });

  test("不得退回手寫的瀏覽器版本號陣列", () => {
    // 任何 `target: ['chrome110', ...]` 形狀都算退化：沒人會記得更新它。
    expect(
      /\btarget\s*:\s*\[/.test(CODE),
      "build.target 被改回手寫版本號陣列 ⇒ 它會再一次原地放三年",
    ).toBe(false);
    expect(/chrome\d+|firefox\d+|safari\d+/.test(CODE)).toBe(false);
  });
});
