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
//   - `--ipc=host`：Docker 預設 /dev/shm 64MB，多 worker 的 Chromium 會被撐爆。
import fs from "node:fs";
import path from "node:path";
import { playwrightVersionFromLock } from "../../scripts/playwright-version.mjs";

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

describe("test.yml：e2e job 跑在 Playwright 官方 image", () => {
  test("找得到 e2e job（切割沒失效）", () => {
    expect(e2eJobs().map((j) => j.name)).toEqual(["test-e2e-offline", "test-e2e-offline-adverse"]);
  });

  test.each(["test-e2e-offline", "test-e2e-offline-adverse"])("%s：image 版本取自 playwright-version job", (name) => {
    const job = jobs().find((j) => j.name === name);
    expect(job.body).toMatch(/^\s*needs: playwright-version\s*$/m);
    expect(job.body).toMatch(
      /^\s*image: mcr\.microsoft\.com\/playwright:v\$\{\{ needs\.playwright-version\.outputs\.version \}\}-noble\s*$/m,
    );
    expect(job.body).toMatch(/^\s*options: .*--ipc=host/m);
  });

  // 沒設就是 GitHub 預設 360 分鐘；deploy.yml 的 concurrency 不取消舊 run，一個卡住的
  // e2e job 會讓之後所有 push 排隊幾個小時。
  test.each(["test-e2e-offline", "test-e2e-offline-adverse"])("%s：有 timeout-minutes 且不超過 60", (name) => {
    const job = jobs().find((j) => j.name === name);
    const m = /^ {4}timeout-minutes: (\d+)\s*$/m.exec(job.body);
    expect(m, `${name} 沒設 timeout-minutes`).not.toBeNull();
    expect(Number(m[1])).toBeLessThanOrEqual(60);
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
