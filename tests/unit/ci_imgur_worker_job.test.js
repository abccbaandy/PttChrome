// CI 對「非 yarn 子專案」的覆蓋契約（.github/workflows/test.yml）。
//
// 根目錄的四個測試 job 跑的都是 yarn script（test:unit / test:integration /
// test:e2e:offline*），include 全指向根目錄的 tests/ ⇒ proxy/imgur-worker 這種自帶
// package-lock.json 的獨立 npm 子專案，**一條都掃不到**。後果不是「少跑一點測試」，
// 而是綠勾會說謊：2026-09-10 的 PR #29（該子專案的 vitest 4→5 major bump）五個 check
// 全綠，卻沒有任何一條測試碰過被改的東西，得靠人在本機 npm ci && npm test 才驗得到。
//
// 所以這裡守的是覆蓋率本身，而不只是「那個 job 還在」：repo 裡每多一個獨立的 npm
// 子專案，就必須有一個 working-directory 指向它的 job。新增第二個 worker 時最容易漏，
// 漏了就又回到「綠勾與改動無關」的狀態。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const YAML = fs.readFileSync(
  path.join(ROOT, ".github", "workflows", "test.yml"),
  "utf8",
);

// 以 job 為單位切開（頂層 job 是 2 空格縮排的 `<name>:`）——與 ci_apt_sources.test.js 同法。
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

// 有自己 package-lock.json 的子目錄 ＝ 獨立 npm 專案（yarn workspace 不會有）。
// 只掃已知會放它們的地方，避免走進 node_modules 或建置產物。
const npmSubprojects = () => {
  const found = [];
  const walk = (rel, depth) => {
    if (depth > 3) return;
    const abs = path.join(ROOT, rel);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === "node_modules") continue;
      const child = path.posix.join(rel, ent.name);
      if (fs.existsSync(path.join(ROOT, child, "package-lock.json"))) {
        found.push(child);
        continue; // 子專案內部不再往下找
      }
      walk(child, depth + 1);
    }
  };
  walk("proxy", 1);
  return found;
};

describe("test.yml：獨立的 npm 子專案要有自己的 CI job", () => {
  test("掃得到子專案（掃描沒失效）", () => {
    expect(npmSubprojects()).toContain("proxy/imgur-worker");
  });

  test("每個子專案都有一個 working-directory 指向它的 job", () => {
    const all = jobs();
    for (const dir of npmSubprojects()) {
      const owner = all.find((j) =>
        new RegExp(`^\\s*working-directory:\\s*${dir}\\s*$`, "m").test(j.body),
      );
      expect(owner, `沒有任何 job 跑 ${dir} 的測試`).toBeTruthy();
    }
  });

  test("那個 job 用 npm ci（不是 npm install）並真的跑測試", () => {
    const job = jobs().find((j) => j.name === "test-imgur-worker");
    expect(job, "test-imgur-worker job 不見了").toBeTruthy();
    // npm ci 才會照 lock 裝——Dependabot 改的就是 lock，用 npm install 等於驗了別的東西。
    expect(job.body).toMatch(/^\s*npm ci\s*$/m);
    expect(job.body).toMatch(/^\s*npm test\s*$/m);
  });

  test("子專案的 test script 存在（job 不會跑到空氣）", () => {
    for (const dir of npmSubprojects()) {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(ROOT, dir, "package.json"), "utf8"),
      );
      expect(pkg.scripts?.test, `${dir} 沒有 test script`).toBeTruthy();
    }
  });
});
