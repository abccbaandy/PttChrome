// 週邊功能宣告表（src/js/features.js，架構 review A6）對得起來：
//   - 每一項的 pref 是 DEFAULT_PREFS 鍵，而且就是該功能故障停用時登記的 feature（同一個開關）；
//   - App 建構子只經 createFeatures 建，不再自己 new（兩條路並存＝建兩份、settle 監聽掛兩次）；
//   - 「順序有意義」只寫在表的 after，且每一組都列在 listener_order 的 BEFORE（真 boot 量派發順序）。
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import {
  ALL_FEATURE_TABLES,
  HOME_FEATURES,
  LATE_PERIPHERAL_FEATURES,
  PERIPHERAL_FEATURES,
  createFeatures,
} from "../../src/js/features";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const snake = (name) => name.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
const ALL = ALL_FEATURE_TABLES.flat();

describe("週邊功能宣告表", () => {
  test("名稱不重複、pref 是預設值裡的鍵", () => {
    const names = ALL.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    for (const f of ALL) expect(DEFAULT_PREFS).toHaveProperty(f.pref);
  });

  test.each(ALL.map((f) => [f.name, f.pref]))(
    "%s 的故障停用登記用的就是表裡的 pref（%s）",
    (name, pref) => {
      const src = read(`src/js/${snake(name)}.js`);
      expect(src).toMatch(new RegExp(`feature:\\s*['"]${pref}['"]`));
    },
  );

  test("App 建構子不再自己 new 表裡的功能、三段表照順序建", () => {
    const app = read("src/js/pttchrome.jsx");
    const home = app.indexOf("createFeatures(this, HOME_FEATURES)");
    const first = app.indexOf("createFeatures(this, PERIPHERAL_FEATURES)");
    const late = app.indexOf("createFeatures(this, LATE_PERIPHERAL_FEATURES)");
    expect(home).toBeGreaterThan(0);
    expect(first).toBeGreaterThan(home);
    expect(late).toBeGreaterThan(first);
    for (const f of ALL) {
      expect(app).not.toMatch(new RegExp(`this\\.${f.name}\\s*=\\s*new\\b`));
    }
  });

  test("after 只指向排在前面的功能（同表前面、前面的表，或那段表之前建構子已經 new 的核心流程）", () => {
    const app = read("src/js/pttchrome.jsx");
    const seen = new Set();
    const tables = [
      ["HOME_FEATURES", HOME_FEATURES],
      ["PERIPHERAL_FEATURES", PERIPHERAL_FEATURES],
      ["LATE_PERIPHERAL_FEATURES", LATE_PERIPHERAL_FEATURES],
    ];
    for (const [label, table] of tables) {
      const at = app.indexOf(`createFeatures(this, ${label})`);
      for (const f of table) {
        for (const dep of f.after || []) {
          const core = app.search(new RegExp(`this\\.${dep}\\s*=\\s*new\\b`));
          const ok = seen.has(dep) || (core > 0 && core < at);
          expect(ok, `${f.name} after ${dep}`).toBe(true);
        }
        seen.add(f.name);
      }
    }
  });

  test("每一組 after 都列在 listener_order.offline.spec.js 的 BEFORE", () => {
    const spec = read("tests/e2e/offline/listener_order.offline.spec.js");
    const pairs = ALL.flatMap((f) => (f.after || []).map((dep) => [dep, f.name]));
    expect(pairs.length).toBeGreaterThan(0);
    for (const [a, b] of pairs) {
      expect(spec, `BEFORE 缺 ['${a}', '${b}']`).toContain(`['${a}', '${b}']`);
    }
  });

  test("createFeatures 照表順序建、掛在 app[name]", () => {
    const order = [];
    const app = {};
    createFeatures(app, [
      { name: "a", pref: "x", create: (o) => (order.push("a"), { owner: o }) },
      { name: "b", pref: "y", create: () => (order.push("b"), 2), after: ["a"] },
    ]);
    expect(order).toEqual(["a", "b"]);
    expect(app.a.owner).toBe(app);
    expect(app.b).toBe(2);
  });

  test("after 的功能還沒建 ⇒ 丟例外、不建（不會靜默換了 settle 派發順序）", () => {
    const app = {};
    const create = vi.fn(() => 1);
    expect(() => createFeatures(app, [{ name: "b", pref: "y", create, after: ["a"] }])).toThrow(/a/);
    expect(create).not.toHaveBeenCalled();
  });
});
