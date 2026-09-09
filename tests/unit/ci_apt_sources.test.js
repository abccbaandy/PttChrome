// CI 的「apt 來源清理」契約（.github/workflows/test.yml）。
//
// `playwright install --with-deps` 會先跑 apt-get update。GitHub runner image 內建一個
// Google Chrome 的 apt 來源，它一旦處在「Release 宣告的雜湊與實際 Packages.gz 對不起來」
// 的發布中間態，apt-get update 就整包回 100 ⇒ 瀏覽器連下載都沒開始、**一條測試都沒跑**，
// 但 job 紅得像 e2e 整批爆炸（2026-09-09 實測：Release 宣告 233e56de…、實際檔案
// bc1428ab…；重跑兩次同樣紅，直接對 dl.google.com 抓下來比對也是同一組值 ⇒ 上游還在壞，
// 重跑無效）。我們用的是 Playwright 自帶的瀏覽器、系統依賴全來自 Ubuntu 官方 archive，
// 那個第三方來源純屬多餘。
//
// 這裡守的是「每個會跑 --with-deps 的 job 都先移掉它，而且順序在前」——新增第三個 e2e
// job 時最容易漏掉，漏了就只會在 Google 下次發布出包時才炸，且看起來像被測 code 壞了。
import fs from "node:fs";
import path from "node:path";

const YAML = fs.readFileSync(
  path.join(__dirname, "..", "..", ".github", "workflows", "test.yml"),
  "utf8",
);

// **anchor 一律釘在真正的指令行上**：上面那段 why 的註解本身就提到
// `playwright install --with-deps`，用裸字串 indexOf 會抓到註解裡那一次，
// 順序斷言就會以「移除步驟跑在 install 後面」假紅。
const DROP_CMD = /^\s*run:\s*sudo rm -f \/etc\/apt\/sources\.list\.d\/google-chrome\*/m;
const INSTALL_CMD = /^\s*npx playwright install --with-deps/m;

// 以 job 為單位切開（頂層 job 是 2 空格縮排的 `<name>:`）。
const jobs = () => {
  const out = [];
  const lines = YAML.split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
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

const withDepsJobs = () => jobs().filter((j) => INSTALL_CMD.test(j.body));

describe("test.yml：跑 playwright install --with-deps 的 job 要先清掉多餘 apt 來源", () => {
  test("至少找得到那些 job（切割沒失效）", () => {
    const names = withDepsJobs().map((j) => j.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain("test-e2e-offline");
    expect(names).toContain("test-e2e-offline-adverse");
  });

  test("每個都移除 Google Chrome 的 apt 來源", () => {
    for (const job of withDepsJobs()) {
      expect(job.body, `${job.name} 少了移除 apt 來源的步驟`).toMatch(DROP_CMD);
    }
  });

  test("移除步驟必須在 --with-deps 之前（跑在後面等於沒做）", () => {
    for (const job of withDepsJobs()) {
      const drop = job.body.search(DROP_CMD);
      const install = job.body.search(INSTALL_CMD);
      expect(drop).toBeGreaterThanOrEqual(0);
      expect(install).toBeGreaterThanOrEqual(0);
      expect(drop, `${job.name} 的移除步驟跑在 install 後面`).toBeLessThan(
        install,
      );
    }
  });
});
