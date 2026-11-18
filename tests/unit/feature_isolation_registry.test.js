// 故障停用的登記表對得起來（架構 review A6「功能註冊表」的前置守護，docs/feature-isolation.md）。
//
// `buf.addEventListener(type, fn, { feature: '<設定鍵>', disable })` 的 feature 一出錯就會：
//   - 用 `options_<feature>` 當名字跳紅底提示「「<設定名稱>」出了問題…」（App._onFeatureError）；
//   - 指的是使用者在設定頁關得掉的那個開關。
// 鍵打錯或改名沒跟上，提示會印出原始鍵名（enableFooBar），文件裡的登記清單也會跟程式脫節，
// 畫面與其他測試照樣全綠。這裡靜態掃 src/ 每個登記，逐一對預設值、語系字串、文件清單。
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { zh_TW } from "../../src/js/zh_TW_messages";

const SRC = path.join(process.cwd(), "src");
const DOC = fs.readFileSync(path.join(process.cwd(), "docs", "feature-isolation.md"), "utf8");

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(js|jsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}

// addEventListener(…, { … feature: 'x', disable … }) 的 feature。閱讀紀錄的書籤（{ feature: 'long-push' }）
// 也長這樣，但它們的鍵帶連字號、後面也沒有 disable ⇒ 只收駝峰鍵、且 300 字內帶 disable 的。
const FEATURE_RE = /\bfeature:\s*['"]([A-Za-z0-9_]+)['"]/g;

function registrations() {
  const out = [];
  for (const f of walk(SRC)) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(FEATURE_RE)) {
      const around = src.slice(Math.max(0, m.index - 300), m.index + 300);
      if (!/\bdisable\s*:/.test(around)) continue;
      out.push({ key: m[1], file: path.relative(SRC, f).split(path.sep).join("/") });
    }
  }
  return out;
}

const REGS = registrations();

describe("故障停用登記（feature）對得起來", () => {
  test("掃得到登記（掃描本身沒壞）", () => {
    expect(REGS.length).toBeGreaterThanOrEqual(16);
  });

  test.each(REGS.map((r) => [r.key, r.file]))("%s（%s）是設定鍵，有預設值", (key) => {
    expect(Object.prototype.hasOwnProperty.call(DEFAULT_PREFS, key)).toBe(true);
  });

  test.each(REGS.map((r) => [r.key, r.file]))("%s（%s）有 options_ 名稱，暫停提示不會印出鍵名", (key) => {
    const entry = zh_TW["options_" + key];
    expect(entry && String(entry.message).trim()).toBeTruthy();
  });

  test("每個登記都列在 docs/feature-isolation.md「目前登記的」", () => {
    const line = DOC.split("\n").find((l) => l.startsWith("- 目前登記的："));
    expect(line, "docs/feature-isolation.md 找不到「- 目前登記的：」那一行").toBeTruthy();
    const missing = REGS.filter((r) => !line.includes("`" + r.key + "`")).map((r) => r.key + "（" + r.file + "）");
    expect(missing, "新登記的功能要補進文件的清單").toEqual([]);
  });
});
