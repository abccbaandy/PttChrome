// 安全性 pin（root `resolutions`／proxy worker 的 `overrides`）的存續契約。
//
// 這些 pin 只為「上游最新版仍把遞移依賴鎖在有 CVE 的範圍」而設：firestore 宣告 `@grpc/grpc-js ~1.9.0`、
// miniflare 精確 pin `undici`。pin 一旦沒有理由就該拆掉（`resolutions` 曾整塊變成零 consumer 的舊鏈殘渣），
// 所以這裡把「上游宣告的範圍」記成快照：上游改了範圍 ⇒ 紅，去看新範圍是否已涵蓋修補版——
// 涵蓋就刪 pin 和這一列，沒涵蓋就更新快照。判定與理由見 docs/build-modernization.md 套件選型表。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const YARN_LOCK = fs.readFileSync(path.join(ROOT, "yarn.lock"), "utf8");

// 只比 major.minor.patch（修補版門檻都是正式版）。
function gte(version, min) {
  const a = version.split(/[.-]/).map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

// yarn.lock 裡某個套件所有條目的內文（標頭行之後的縮排區塊）。條目之間以空行分隔。
function yarnEntries(name) {
  return YARN_LOCK.split("\n\n")
    .filter((block) => block.startsWith(`"${name}@npm:`))
    .map((block) => block.slice(block.indexOf("\n") + 1));
}

describe("root：@grpc/grpc-js（經 @firebase/firestore）", () => {
  const PATCHED = "1.13.6"; // GHSA-m9gg-hp2v-232j、GHSA-f596-whhp-79r4

  test("pin 仍在 resolutions", () => {
    expect(readJson("package.json").resolutions?.["@grpc/grpc-js"]).toBe(`^${PATCHED}`);
  });

  test("firestore 宣告的範圍仍未涵蓋修補版（變了就重新評估是否拆 pin）", () => {
    const entries = yarnEntries("@firebase/firestore");
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e).toContain(`"@grpc/grpc-js": "npm:~1.9.0"`);
  });

  test("實際裝到的版本 ≥ 修補版", () => {
    const versions = yarnEntries("@grpc/grpc-js").map((e) => e.match(/^  version: (\S+)/m)[1]);
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) expect(gte(v, PATCHED)).toBe(true);
  });
});

describe.each(["proxy/imgur-worker", "proxy/ptt-announcements-worker"])(
  "%s：undici（經 wrangler → miniflare）",
  (dir) => {
    const PATCHED = "7.30.1"; // GHSA-xjj6-f33q-929c、GHSA-4qv8-2p9j-2685、GHSA-f72v-6w45-q472
    const pkg = readJson(`${dir}/package.json`);
    const lock = readJson(`${dir}/package-lock.json`).packages;

    test("pin 仍在 overrides", () => {
      expect(pkg.overrides?.undici).toBe(`^${PATCHED}`);
    });

    test("miniflare 仍精確 pin 舊版（變了就重新評估是否拆 pin）", () => {
      expect(lock["node_modules/miniflare"].dependencies.undici).toBe("7.29.1");
    });

    test("lock 裡每份 undici ≥ 修補版", () => {
      const found = Object.entries(lock).filter(([k]) => k.endsWith("node_modules/undici"));
      expect(found.length).toBeGreaterThan(0);
      for (const [, v] of found) expect(gte(v.version, PATCHED)).toBe(true);
    });
  },
);
