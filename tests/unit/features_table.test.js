// 週邊功能宣告表（src/js/features.js，架構 review A6）對得起來：
//   - 每一項的 pref 是 DEFAULT_PREFS 鍵，而且就是該功能故障停用時登記的 feature（同一個開關）；
//   - App 建構子只經 createFeatures 建，不再自己 new（兩條路並存＝建兩份、settle 監聽掛兩次）。
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { LIST_TOOL_FEATURES, createFeatures } from "../../src/js/features";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const snake = (name) => name.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());

describe("週邊功能宣告表", () => {
  test("名稱不重複、pref 是預設值裡的鍵", () => {
    const names = LIST_TOOL_FEATURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    for (const f of LIST_TOOL_FEATURES) expect(DEFAULT_PREFS).toHaveProperty(f.pref);
  });

  test.each(LIST_TOOL_FEATURES.map((f) => [f.name, f.pref]))(
    "%s 的故障停用登記用的就是表裡的 pref（%s）",
    (name, pref) => {
      const src = read(`src/js/${snake(name)}.js`);
      expect(src).toMatch(new RegExp(`feature:\\s*['"]${pref}['"]`));
    },
  );

  test("App 建構子不再自己 new 表裡的功能", () => {
    const app = read("src/js/pttchrome.jsx");
    expect(app).toMatch(/createFeatures\(this, LIST_TOOL_FEATURES\)/);
    for (const f of LIST_TOOL_FEATURES) {
      expect(app).not.toMatch(new RegExp(`this\\.${f.name}\\s*=\\s*new\\b`));
    }
  });

  test("createFeatures 照表順序建、掛在 app[name]", () => {
    const order = [];
    const app = {};
    createFeatures(app, [
      { name: "a", pref: "x", create: (o) => (order.push("a"), { owner: o }) },
      { name: "b", pref: "y", create: () => (order.push("b"), 2) },
    ]);
    expect(order).toEqual(["a", "b"]);
    expect(app.a.owner).toBe(app);
    expect(app.b).toBe(2);
  });
});
