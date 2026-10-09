// unit 測試分兩個 project（vitest.config.mjs）：預設 node（unit），需要 DOM 的檔案第一行寫
// BROWSER_MARKER ⇒ 跑在真 Chromium（unit-browser，Vitest Browser Mode）。
// 這支守住分流方式：
//   - 漏標記的 DOM 測試在 node 下也會紅，但錯誤從 testing-library 深處冒出來，不容易看出是
//     「少一行標記」；標記不在第一行則不會被 vitest.config.mjs 認到；
//   - browser 檔裡寫 node 專屬 API 會在**載入期**整檔炸掉（Module "fs" has been externalized…），
//     這裡先用一行清楚的訊息擋下；
//   - jsdom 已整個移除（2026-10：同一批檔案 59s → 15s，而且 layout／scrollTop／
//     IntersectionObserver 都是假的；DOM 模擬層跟使用者的瀏覽器行為不一致時，測試全綠、
//     實際卻壞）。不准任何測試或腳本再把它（或 happy-dom 之類的 DOM 模擬）帶回來。
import fs from "fs";
import path from "path";
import { BROWSER_MARKER, isBrowserTestSource } from "../../scripts/unit-browser-marker.mjs";

const UNIT_DIR = __dirname;
const ROOT = path.join(UNIT_DIR, "..", "..");
const DOM_EMULATORS = ["jsdom", "happy-dom"];

// 遞迴：vitest 的 include 是 `tests/unit/**`，子目錄的測試一樣會跑，守護範圍要一致。
const files = fs
  .readdirSync(UNIT_DIR, { recursive: true })
  .map((f) => f.split(path.sep).join("/"))
  .filter((f) => /\.test\.jsx?$/.test(f))
  // 本檔自己就含這些字串（當作比對目標）。
  .filter((f) => f !== path.basename(__filename))
  .sort();

const read = (f) => fs.readFileSync(path.join(UNIT_DIR, f), "utf8");
const browserFiles = files.filter((f) => isBrowserTestSource(read(f)));

// 註解行不算（說明文字常提到這些 API）。
const code = (src) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const NODE_ONLY = [
  [/from\s+["'](node:)?(fs|path|url|os|child_process)["']/, "node 內建模組"],
  [/\brequire\(/, "require()"],
  [/\b__dirname\b|\b__filename\b/, "__dirname／__filename"],
  [/\bBuffer\./, "Buffer"],
  // process.env 例外：vitest.config.mjs 的 define 會轉發（目前只有 UPDATE_GOLDEN）。
  [/(^|[^.\w$])process\.(on|cwd|argv|exit)\b/, "process.*"],
  [/(^|[^.\w$])global\./, "global（改用 globalThis）"],
];

describe("unit 測試環境分流", () => {
  test("用 @testing-library 的檔案必須在 unit-browser", () => {
    const missing = files.filter((f) => /@testing-library\//.test(read(f)) && !browserFiles.includes(f));
    expect(missing).toEqual([]);
  });

  test("browser 標記一律放第一行", () => {
    const misplaced = files.filter((f) => read(f).includes(BROWSER_MARKER) && !browserFiles.includes(f));
    expect(misplaced).toEqual([]);
  });

  test("沒有任何 @vitest-environment 宣告（分流只看 browser 標記）", () => {
    expect(files.filter((f) => /^\/\/ @vitest-environment /m.test(read(f)))).toEqual([]);
  });

  test("不准把 DOM 模擬（jsdom／happy-dom）帶回來：依賴與 import 都不行", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(DOM_EMULATORS.filter((d) => d in deps)).toEqual([]);

    const bad = [];
    const scan = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) scan(p);
        else if (/\.(m?js|jsx)$/.test(e.name) && p !== __filename) {
          const src = code(fs.readFileSync(p, "utf8"));
          if (DOM_EMULATORS.some((d) => new RegExp(`["']${d}["']`).test(src))) bad.push(path.relative(ROOT, p));
        }
      }
    };
    for (const d of ["src", "scripts", "tests"]) scan(path.join(ROOT, d));
    expect(bad).toEqual([]);
  });

  test("unit-browser 的檔案不用 node 專屬 API（fixture 用 ?raw／JSON import，寫檔用 vitest/browser 的 commands）", () => {
    const bad = [];
    for (const f of browserFiles) {
      const src = code(read(f));
      for (const [re, label] of NODE_ONLY) if (re.test(src)) bad.push(`${f}: ${label}`);
    }
    expect(bad).toEqual([]);
  });

  test("browser 檔共用的 helper 同樣不得用 node 專屬 API", () => {
    const dir = path.join(UNIT_DIR, "helpers");
    const bad = [];
    for (const f of fs.readdirSync(dir).filter((x) => /\.jsx?$/.test(x))) {
      const src = code(fs.readFileSync(path.join(dir, f), "utf8"));
      for (const [re, label] of NODE_ONLY) if (re.test(src)) bad.push(`helpers/${f}: ${label}`);
    }
    expect(bad).toEqual([]);
  });
});
