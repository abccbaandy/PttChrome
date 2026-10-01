// deploy.yml 的部署鎖契約。
//
// 鎖（concurrency: pages）只放在 deploy job：放在 workflow 層級時，連續 push 的**測試**也要
// 整輪排隊，一輪卡住後面全等（2026-10-01：一個卡住的 adverse job 讓後續 push 全部 pending）。
// 但只鎖 deploy job 之後各輪測試平行跑，舊 commit 若測試較慢，它的部署會排在新 commit 之後
// 把站台蓋回舊版 ⇒ deploy job 拿到鎖後必須先確認自己仍是 branch 最新的 commit。
import fs from "node:fs";
import path from "node:path";

const YAML = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "deploy.yml"), "utf8");

// 頂層區塊（0 縮排的 `key:`）與 job（2 縮排）切開。
const topLevelKeys = YAML.split(/\r?\n/)
  .map((l) => /^([A-Za-z][\w-]*):/.exec(l))
  .filter(Boolean)
  .map((m) => m[1]);

const deployJob = (() => {
  const start = YAML.search(/^ {2}deploy:\s*$/m);
  const rest = YAML.slice(start + 1);
  const next = rest.search(/^ {2}[A-Za-z][\w-]*:\s*$/m);
  return next < 0 ? YAML.slice(start) : YAML.slice(start, start + 1 + next);
})();

describe("deploy.yml：部署鎖只鎖 deploy job", () => {
  test("workflow 層級沒有 concurrency（否則測試也跟著排隊）", () => {
    expect(topLevelKeys).toContain("jobs");
    expect(topLevelKeys).not.toContain("concurrency");
  });

  test("deploy job 有 pages 鎖，且不砍正在部署的那個", () => {
    expect(deployJob).toMatch(/^ {4}concurrency:\s*\n {6}group: pages\s*\n {6}cancel-in-progress: false\s*$/m);
  });

  test("拿到鎖後先檢查是否仍為最新 commit，部署 step 以它為條件", () => {
    const check = deployJob.search(/^\s*id: latest\s*$/m);
    const deploy = deployJob.search(/uses: actions\/deploy-pages@/);
    expect(check).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(check);
    expect(deployJob).toMatch(/if: steps\.latest\.outputs\.deploy == 'true'\s*\n\s*uses: actions\/deploy-pages@/);
    expect(deployJob).toContain("${{ github.sha }}");
  });
});

// build 與 test 平行跑（省掉 build 排在測試後面的那段），但 deploy 必須同時等兩者：
// 漏了 test 就是「測試紅也照樣部署」。
const buildJob = (() => {
  const start = YAML.search(/^ {2}build:\s*$/m);
  const rest = YAML.slice(start + 1);
  const next = rest.search(/^ {2}[A-Za-z][\w-]*:\s*$/m);
  return next < 0 ? YAML.slice(start) : YAML.slice(start, start + 1 + next);
})();

describe("deploy.yml：build 不等測試，deploy 等測試與 build", () => {
  test("build 沒有 needs", () => {
    expect(buildJob).toMatch(/^ {2}build:/);
    expect(buildJob).not.toMatch(/^ {4}needs:/m);
  });

  test("deploy needs 同時含 test 與 build", () => {
    const m = /^ {4}needs: \[([^\]]*)\]\s*$/m.exec(deployJob);
    expect(m, "deploy 的 needs 必須是陣列形式").not.toBeNull();
    expect(m[1].split(",").map((s) => s.trim()).sort()).toEqual(["build", "test"]);
  });
});
