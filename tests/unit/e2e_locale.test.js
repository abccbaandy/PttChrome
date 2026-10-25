// e2e 介面語系一律中文的靜態守護（i18n 以中文為準，見 CLAUDE.md 測試段）。
//
// headless Chromium 預設 en-US，app 依 `navigator.languages` 選語系 ⇒ 沒設 locale 的
// context 跑出來、截出來的都是英文介面，中文字較寬才會出現的換行／截斷整輪 e2e 看不到。
// 兩個漏洞各守一條：
//   1. playwright.config.js 的 `use.locale`（所有 project 的預設 context），project 不得蓋掉。
//   2. 自己 `browser.newContext()` 開的 context **不吃** project 的 use ⇒ 每一處都要明確帶 locale。
// 純靜態，不開瀏覽器 ⇒ 放 unit（比照 e2e_offline_no_network.test.js）。
import fs from "fs";
import path from "path";
import config from "../../playwright.config.js";
import { E2E_LOCALE } from "../e2e/e2e_locale.js";

const E2E_DIR = path.resolve(__dirname, "../e2e");

function specFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === "__recordings__" || name === "cassettes" || name === "node_modules") continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) specFiles(p, out);
    else if (/\.(c|m)?js$/.test(name)) out.push(p);
  }
  return out;
}

// 回傳每個 `newContext(` 呼叫的完整引數字串（括號配對，跨行）。
function newContextCalls(src) {
  const calls = [];
  const re = /\bnewContext\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    calls.push(src.slice(re.lastIndex, i - 1));
  }
  return calls;
}

describe("e2e 介面語系：一律中文", () => {
  test("語系常數是 zh-TW", () => {
    expect(E2E_LOCALE).toBe("zh-TW");
  });

  test("playwright.config.js 的預設 use 帶中文 locale", () => {
    expect(config.use.locale).toBe(E2E_LOCALE);
  });

  test("沒有 project 把 locale 蓋成別的語系", () => {
    const overridden = config.projects
      .filter((p) => p.use && "locale" in p.use && p.use.locale !== E2E_LOCALE)
      .map((p) => p.name);
    expect(overridden).toEqual([]);
  });

  test("自開的 browser.newContext() 每一處都明確帶 locale", () => {
    const missing = [];
    let total = 0;
    for (const f of specFiles(E2E_DIR)) {
      // 整行註解不算（e2e_locale.js 自己的說明就提到這個呼叫）。
      const src = fs.readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "");
      for (const args of newContextCalls(src)) {
        total++;
        if (!/\blocale\s*[:,}]/.test(args)) missing.push(path.relative(E2E_DIR, f));
      }
    }
    // 至少掃到共用 session（helpers/fixtures.js）那一處，掃描本身壞掉不得靜默變綠。
    expect(total).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  test("unit-browser（真 Chromium）也帶中文 locale", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../vitest.config.mjs"), "utf8");
    expect(src).toMatch(/playwright\(\{\s*contextOptions:\s*\{\s*locale:\s*e2eLocale\.E2E_LOCALE\s*\}\s*\}\)/);
  });

  test("unit-browser 的 navigator 真的是中文", () => {
    // node project 拿不到瀏覽器；真實語系由 browser 那支 i18n_locale_env.test.js 斷言。
    expect(fs.existsSync(path.resolve(__dirname, "i18n_locale_env.test.js"))).toBe(true);
  });

  test("掃描器認得出漏帶 locale 的呼叫", () => {
    expect(newContextCalls("browser.newContext({ baseURL: 'x' })")).toEqual(["{ baseURL: 'x' }"]);
    const [withLocale] = newContextCalls("browser.newContext({\n  baseURL: 'x',\n  locale: L,\n})");
    expect(/\blocale\s*[:,}]/.test(withLocale)).toBe(true);
    expect(/\blocale\s*[:,}]/.test("{ baseURL: 'x' }")).toBe(false);
  });
});
