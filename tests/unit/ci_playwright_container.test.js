// CI 的 e2e job 契約（.github/workflows/test.yml）：一律跑在 Playwright 官方 Docker image 裡。
//
// 為什麼：舊做法是每個 job 自己 `npx playwright install --with-deps`，底下是 apt ——
//   1. 速度看 Ubuntu 鏡像站臉色：同一輪兩個 job，一個 37 秒、另一個卡 414 秒；
//   2. 會被 runner 內建的第三方 apt 來源連坐（Google Chrome 來源發布中間態 ⇒
//      apt-get update 整包回 100，一條測試都沒跑卻像 e2e 整批爆炸）。
// image 內建瀏覽器與系統依賴，兩個問題一起消失。
//
// 守的東西：
//   - image tag 必須取自 playwright-version job（＝yarn.lock 的版本），不准寫死 ——
//     版本不一致 ⇒ `Executable doesn't exist` 整批秒掛，而 Dependabot 只改 yarn.lock；
//   - 不准再跑 `playwright install`（跑了＝又回到 apt）；
//   - `--ipc=host`：Docker 預設 /dev/shm 64MB，多 worker 的 Chromium 會被撐爆；
//   - e2e 是 matrix job（offline 拆 shard、adverse 每桶一個且可再拆 shard），required checks 綁的
//     `test-e2e-offline`／`test-e2e-offline-adverse` 改由收斂 job 扛 —— 收斂 job 必須
//     `if: always()` 並斷言上游 result，否則上游紅時它是 skipped，而 skipped 算通過。
import fs from "node:fs";
import path from "node:path";
import { playwrightVersionFromLock } from "../../scripts/playwright-version.mjs";
import { ADVERSE_PROJECTS } from "../../scripts/run-adverse-e2e.mjs";

const ROOT = path.join(__dirname, "..", "..");
const YAML = fs.readFileSync(path.join(ROOT, ".github", "workflows", "test.yml"), "utf8");

// 以 job 為單位切開（頂層 job 是 2 空格縮排的 `<name>:`）。
const jobs = () => {
  const out = [];
  let cur = null;
  for (const line of YAML.split(/\r?\n/)) {
    const m = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { name: m[1], body: "" };
      continue;
    }
    if (cur) cur.body += line + "\n";
  }
  if (cur) out.push(cur);
  return out;
};

// 「是 e2e job」以實際跑的指令判定，不靠 job 名稱（新增 job 改名也逃不掉）。
// anchor 釘在指令行上：註解裡也會提到這些字串。
const E2E_CMD = /^\s*yarn test:e2e/m;
const e2eJobs = () => jobs().filter((j) => E2E_CMD.test(j.body));

const E2E_JOBS = ["test-e2e-offline-shard", "test-e2e-offline-adverse-bucket"];

// 失敗現場要留得下來：offline 偶發紅常常本機重現不出來，CI 沒上傳 test-results 時
// 只剩一行 Received 可猜（issue #53 後續那次 long_push_image_upload 的偶發紅）。
describe("test.yml：e2e job 失敗時上傳 test-results；trace 不全錄", () => {
  test.each(E2E_JOBS)("%s：if: failure() 上傳 test-results/", (name) => {
    const job = jobs().find((j) => j.name === name);
    const step = job.body.split(/^\s*- /m).find((s) => /actions\/upload-artifact@/.test(s));
    expect(step).toBeDefined();
    expect(step).toMatch(/^\s*if: failure\(\)\s*$/m);
    expect(step).toMatch(/^\s*path: test-results\/?\s*$/m);
    // matrix 各格、重跑各次都要不同名，否則上傳撞名直接失敗。
    expect(step).toMatch(/name: .*\$\{\{ matrix\.\w+ \}\}.*\$\{\{ github\.run_attempt \}\}/);
  });

  // 反方向的坑：trace 改成每條都錄（'on'／'retain-on-failure'），錄製開銷會改變時序，
  // CI 上好讀類 spec 整批假紅（實測 4 條：PageDown 送兩次、游標未即時移動）。
  test("playwright.config 的 trace 不准每條都錄（開銷改變時序）", () => {
    const cfg = fs.readFileSync(path.join(ROOT, "playwright.config.js"), "utf8");
    const traces = [...cfg.matchAll(/^\s*trace:\s*(.+?),?\s*$/gm)].map((m) => m[1]);
    expect(traces.length).toBeGreaterThan(0);
    for (const t of traces) expect(t).not.toMatch(/'on'|retain-on-failure/);
  });
});

describe("test.yml：e2e job 跑在 Playwright 官方 image", () => {
  test("找得到 e2e job（切割沒失效）", () => {
    expect(e2eJobs().map((j) => j.name)).toEqual(E2E_JOBS);
  });

  test.each(E2E_JOBS)("%s：image 版本取自 playwright-version job", (name) => {
    const job = jobs().find((j) => j.name === name);
    expect(job.body).toMatch(/^\s*needs: playwright-version\s*$/m);
    expect(job.body).toMatch(
      /^\s*image: mcr\.microsoft\.com\/playwright:v\$\{\{ needs\.playwright-version\.outputs\.version \}\}-noble\s*$/m,
    );
    expect(job.body).toMatch(/^\s*options: .*--ipc=host/m);
  });

  // 沒設就是 GitHub 預設 360 分鐘；deploy.yml 的 concurrency 不取消舊 run，一個卡住的
  // e2e job 會讓之後所有 push 排隊幾個小時。
  test.each(E2E_JOBS)("%s：有 timeout-minutes 且不超過 60", (name) => {
    const job = jobs().find((j) => j.name === name);
    const m = /^ {4}timeout-minutes: (\d+)\s*$/m.exec(job.body);
    expect(m, `${name} 沒設 timeout-minutes`).not.toBeNull();
    expect(Number(m[1])).toBeLessThanOrEqual(60);
  });

  test("offline 拆 shard：matrix 的每個 shard 都傳進 --shard，分母等於 shard 數", () => {
    const job = jobs().find((j) => j.name === "test-e2e-offline-shard");
    const shards = /^\s*shard: \[([\d, ]+)\]\s*$/m.exec(job.body);
    expect(shards, "沒有 matrix.shard").not.toBeNull();
    const n = shards[1].split(",").length;
    expect(shards[1].split(",").map(Number)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    const lines = job.body.split("\n").map((l) => l.trim());
    expect(lines).toContain(`yarn test:e2e:offline --shard=\${{ matrix.shard }}/${n}`);
  });

  // matrix.include 切成一格一格（每格以 `- bucket:` 開頭，後面縮排的 key 屬於它）。
  const adverseCells = () => {
    const job = jobs().find((j) => j.name === "test-e2e-offline-adverse-bucket");
    const include = /^\s*include:\s*$([\s\S]*?)^ {4}\w/m.exec(job.body);
    expect(include, "沒有 matrix.include").not.toBeNull();
    return include[1]
      .split(/^\s*- (?=bucket:)/m)
      .slice(1)
      .map((cell) => Object.fromEntries([...cell.matchAll(/^\s*(\w+): ([\w-]+)\s*$/gm)].map((m) => [m[1], m[2]])));
  };

  test("adverse 每桶（或桶的每片）一個 job：matrix 涵蓋 runner 的全部桶，且以 --only 只跑該桶", () => {
    const job = jobs().find((j) => j.name === "test-e2e-offline-adverse-bucket");
    const buckets = [...new Set(adverseCells().map((c) => c.bucket))];
    expect(buckets.sort()).toEqual([...ADVERSE_PROJECTS].sort());
    expect(job.body).toMatch(
      /^\s*yarn test:e2e:offline:adverse --only=\$\{\{ matrix\.bucket \}\} --shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ matrix\.shards \}\}\s*$/m,
    );
  });

  // 漏一片＝那片的測試靜默不跑、CI 照樣全綠；重複一片＝白跑一個 job。
  test("adverse 拆片：每桶的 shard 恰好是 1..shards 各一格，shards 一致", () => {
    const byBucket = {};
    for (const c of adverseCells()) (byBucket[c.bucket] ||= []).push(c);
    for (const [bucket, cells] of Object.entries(byBucket)) {
      const totals = [...new Set(cells.map((c) => c.shards))];
      expect(totals, `${bucket} 的 shards 不一致`).toHaveLength(1);
      const n = Number(totals[0]);
      expect(n, `${bucket} 沒有 shards`).toBeGreaterThan(0);
      const got = cells.map((c) => Number(c.shard)).sort((a, b) => a - b);
      expect(got, bucket).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    }
  });

  test.each([
    ["test-e2e-offline", "test-e2e-offline-shard"],
    ["test-e2e-offline-adverse", "test-e2e-offline-adverse-bucket"],
  ])("收斂 job %s：always() 且斷言 %s 的 result", (gate, upstream) => {
    const job = jobs().find((j) => j.name === gate);
    expect(job, `${gate} 不見了 ⇒ 分支保護的 required check 永遠 pending`).toBeDefined();
    expect(job.body.split("\n").map((l) => l.trim())).toContain(`needs: ${upstream}`);
    expect(job.body).toMatch(/^\s*if: always\(\)\s*$/m);
    expect(job.body).toContain(`test "\${{ needs.${upstream}.result }}" = success`);
  });

  // unit-browser project 要真 Chromium；不在 image 裡就只能 playwright install（＝apt）。
  test("跑 yarn test:unit 的 job 也在 Playwright image 裡", () => {
    const unitJobs = jobs().filter((j) => /^\s*yarn test:unit\s*$/m.test(j.body));
    expect(unitJobs.map((j) => j.name)).toEqual(["test-unit"]);
    const [job] = unitJobs;
    expect(job.body).toMatch(/^\s*needs: playwright-version\s*$/m);
    expect(job.body).toMatch(
      /^\s*image: mcr\.microsoft\.com\/playwright:v\$\{\{ needs\.playwright-version\.outputs\.version \}\}-noble\s*$/m,
    );
    expect(job.body).toMatch(/^\s*options: .*--ipc=host/m);
    expect(job.body).toMatch(/^ {4}timeout-minutes: \d+\s*$/m);
  });

  test("沒有任何 job 再跑 playwright install（那就是 apt）", () => {
    const offenders = jobs().filter((j) => /^\s*(npx|yarn) playwright install/m.test(j.body));
    expect(offenders.map((j) => j.name)).toEqual([]);
  });

  test("playwright-version job 把腳本輸出寫進 GITHUB_OUTPUT，且 checkout 得到它要讀的檔", () => {
    const job = jobs().find((j) => j.name === "playwright-version");
    expect(job.body).toMatch(/version: \$\{\{ steps\.v\.outputs\.version \}\}/);
    expect(job.body).toMatch(/node scripts\/playwright-version\.mjs >> "\$GITHUB_OUTPUT"/);
    expect(job.body).toContain("yarn.lock");
    expect(job.body).toContain("scripts/playwright-version.mjs");
  });
});

describe("playwrightVersionFromLock", () => {
  test("讀出目前 yarn.lock 的版本，且與已安裝的套件一致", () => {
    const lock = fs.readFileSync(path.join(ROOT, "yarn.lock"), "utf8");
    const installed = JSON.parse(
      fs.readFileSync(path.join(ROOT, "node_modules", "@playwright", "test", "package.json"), "utf8"),
    ).version;
    expect(playwrightVersionFromLock(lock)).toBe(installed);
  });

  // unit-browser（Vitest Browser Mode）走的是 `playwright` 套件的瀏覽器，image tag 卻取自
  // @playwright/test ⇒ 兩者不同版時 test-unit 會 `Executable doesn't exist` 整批秒掛。
  test("playwright 與 @playwright/test 鎖在同一版（test-unit 的 image 才對得上）", () => {
    const v = (pkg) =>
      JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", ...pkg.split("/"), "package.json"), "utf8")).version;
    expect(v("playwright")).toBe(v("@playwright/test"));
  });

  test("不會誤抓 playwright／playwright-core 的條目", () => {
    const lock = [
      '"playwright-core@npm:9.9.9":',
      "  version: 9.9.9",
      "",
      '"@playwright/test@npm:^1.63.0":',
      "  version: 1.63.0",
      "",
    ].join("\n");
    expect(playwrightVersionFromLock(lock)).toBe("1.63.0");
  });

  test("找不到或格式怪異就丟錯（不能印出空版本讓 image tag 變成 v-noble）", () => {
    expect(() => playwrightVersionFromLock("")).toThrow();
    expect(() => playwrightVersionFromLock('"@playwright/test@npm:^1":\n  version: next\n')).toThrow();
  });
});
