// scripts/run-adverse-e2e.mjs 的純函式守護（不起進程、不開瀏覽器）。
//
// 這支要鎖住的核心行為只有一條：**真失敗絕不可以被判成「環境崩潰」而自動重跑**。
// 逆境 offline e2e 的整個價值就是「把 CI 偶發紅變成必現紅」，一旦重試條件放寬到會
// 吃掉斷言失敗，等於把 docs/offline-replay-testing.md 講的「offline e2e 不接受
// flaky」偷偷廢掉，而且是靜默的。
import fs from "fs";
import path from "path";
import {
  ADVERSE_PROJECTS,
  buildBatches,
  classifyRun,
  parseAdverseSpecs,
  parseArgs,
  splitPassthrough,
} from "../../scripts/run-adverse-e2e.mjs";

const ROOT = path.join(__dirname, "..", "..");
const configSource = fs.readFileSync(path.join(ROOT, "playwright.config.js"), "utf8");

// worker 一啟動就死的真實輸出（2026-08-29 本機實錄的形狀）。
const ENV_CRASH_OUTPUT = `
Running 60 tests using 1 worker
  ✓  1 [offline-mixed] › offline/mouse.offline.spec.js:31:5 › 點推文列 (1.2s)
  ✘  2 [offline-mixed] › offline/enhance.offline.spec.js:44:5 › 樓層編號 (0ms)

  1) [offline-mixed] › offline/enhance.offline.spec.js:44:5 › 樓層編號 ─────────────

    Error: worker process exited unexpectedly (code=3221225794, signal=null)
`;

test("import 純函式不得有副作用（不起 dev server、不 exit）", async () => {
  const mod = await import("../../scripts/run-adverse-e2e.mjs");
  expect(typeof mod.classifyRun).toBe("function");
  expect(process.exitCode).toBeUndefined();
});

describe("classifyRun", () => {
  test("exit 0 → pass", () => {
    expect(classifyRun({ code: 0, output: "60 passed (3.4m)" })).toBe("pass");
  });

  test("worker 崩潰 + 0xC0000142 + 零斷言錯 → env-crash", () => {
    expect(classifyRun({ code: 1, output: ENV_CRASH_OUTPUT })).toBe("env-crash");
  });

  test("同一輪裡只要有真斷言失敗就是 fail，即使 worker 也崩了", () => {
    const mixed = ENV_CRASH_OUTPUT + "\n    AssertionError: expected 3 to be 4\n";
    expect(classifyRun({ code: 1, output: mixed })).toBe("fail");
  });

  test("Test timeout 是真失敗（可能是產品真的卡住），不重試", () => {
    expect(
      classifyRun({ code: 1, output: "Test timeout of 300000ms exceeded while running test." })
    ).toBe("fail");
  });

  test("expect 失敗 → fail", () => {
    expect(
      classifyRun({ code: 1, output: "Error: expect(received).toBeVisible()\n\nCall log:" })
    ).toBe("fail");
  });

  test("沒有 0xC0000142 的 worker 崩潰不算環境崩潰（可能是 OOM／被測 code 炸掉）", () => {
    expect(
      classifyRun({ code: 1, output: "Error: worker process exited unexpectedly (code=1)" })
    ).toBe("fail");
  });
});

describe("parseAdverseSpecs", () => {
  test("讀得到 playwright.config.js 的兩份逆境清單", () => {
    const { layout, image } = parseAdverseSpecs(configSource);
    expect(layout.length).toBeGreaterThan(0);
    expect(image.length).toBeGreaterThan(0);
    for (const spec of [...layout, ...image]) {
      expect(spec).toMatch(/^offline\/.+\.offline\.spec\.js$/);
      expect(fs.existsSync(path.join(ROOT, "tests", "e2e", spec))).toBe(true);
    }
  });

  test("常數改名會被抓到（--batch=spec 會靜默退化成跑不到任何 spec）", () => {
    expect(configSource).toMatch(/const\s+ADVERSE_LAYOUT_SPECS\s*=\s*\[/);
    expect(configSource).toMatch(/const\s+ADVERSE_IMAGE_SPECS\s*=\s*\[/);
  });
});

test("腳本的桶名與 playwright.config.js 的逆境 project 一致", () => {
  const names = [...configSource.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
  for (const p of ADVERSE_PROJECTS) expect(names).toContain(p);
  // 反向：config 裡有 timeout: 300000 的 project（＝逆境桶的標記）不可漏在清單外。
  const adverseInConfig = configSource
    .split(/\{\s*\n/)
    .filter((chunk) => /timeout:\s*300000/.test(chunk))
    .map((chunk) => /name:\s*'([^']+)'/.exec(chunk)?.[1])
    .filter(Boolean);
  expect(adverseInConfig.sort()).toEqual([...ADVERSE_PROJECTS].sort());
});

test("逆境 project 本機不錄影、CI 才錄（省掉每條一份 screencast 通道）", () => {
  expect(configSource).toMatch(
    /const ADVERSE_USE = \{[\s\S]*?video: process\.env\.CI \? 'retain-on-failure' : 'off'/
  );
  // 三個桶都要用它，別漏掉一個還在用裸 devices。
  const uses = [...configSource.matchAll(/name: '(offline-(?:slow|broken|mixed))',\s*\n\s*use: (\w+)/g)];
  expect(uses.length).toBe(3);
  for (const [, , useExpr] of uses) expect(useExpr).toBe("ADVERSE_USE");
});

describe("parseArgs", () => {
  test("預設：分 project、開重試", () => {
    expect(parseArgs([])).toEqual({ batch: "project", only: null, retry: true, passthrough: [] });
  });

  test("逃生門旗標", () => {
    const o = parseArgs(["--batch=spec", "--only=offline-mixed", "--no-retry"]);
    expect(o).toMatchObject({ batch: "spec", only: ["offline-mixed"], retry: false });
  });

  test("--only 吃逗號分隔（本機想分兩段跑時用得到）", () => {
    expect(parseArgs(["--only=offline-slow, offline-mixed"]).only).toEqual([
      "offline-slow",
      "offline-mixed",
    ]);
  });

  test("不認得的旗標原封不動透傳給 playwright", () => {
    expect(parseArgs(["--workers=2", "--grep", "樓層"]).passthrough).toEqual([
      "--workers=2",
      "--grep",
      "樓層",
    ]);
  });
});

describe("buildBatches", () => {
  const specs = {
    layout: ["offline/mouse.offline.spec.js", "offline/enhance.offline.spec.js"],
    image: ["offline/easy-reading.offline.spec.js"],
  };

  test("project 模式：一桶一批", () => {
    const batches = buildBatches({ batch: "project", only: null }, specs, []);
    expect(batches.map((b) => b.project)).toEqual(ADVERSE_PROJECTS);
    expect(batches.every((b) => b.args.length === 0)).toBe(true);
  });

  test("spec 模式：Tier B 只切給 offline-slow（與 config 的 testMatch 一致）", () => {
    const batches = buildBatches({ batch: "spec", only: null }, specs, []);
    const bySlow = batches.filter((b) => b.project === "offline-slow").map((b) => b.args[0]);
    const byMixed = batches.filter((b) => b.project === "offline-mixed").map((b) => b.args[0]);
    expect(bySlow).toContain("easy-reading.offline.spec.js");
    expect(byMixed).not.toContain("easy-reading.offline.spec.js");
  });

  test("spec 模式下的檔名 filter 用來篩批次，不往下傳", () => {
    // 往下傳會與每批自己的檔名 filter 形成 OR ⇒ 每批都多跑一次那些檔案。
    const batches = buildBatches({ batch: "spec", only: ["offline-slow"] }, specs, ["mouse"]);
    expect(batches).toHaveLength(1);
    expect(batches[0].args).toEqual(["mouse.offline.spec.js"]);
  });
});

describe("splitPassthrough", () => {
  test("帶值的旗標不會被誤認成檔名", () => {
    expect(splitPassthrough(["--grep", "樓層", "mouse.offline.spec.js"])).toEqual({
      flags: ["--grep", "樓層"],
      filters: ["mouse.offline.spec.js"],
    });
  });

  test("`--flag=value` 形式後面的位置參數仍是檔名", () => {
    expect(splitPassthrough(["--workers=2", "mouse.offline.spec.js"])).toEqual({
      flags: ["--workers=2"],
      filters: ["mouse.offline.spec.js"],
    });
  });
});
