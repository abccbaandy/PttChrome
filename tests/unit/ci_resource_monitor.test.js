// CI runner 資源取樣（scripts/ci-resource-monitor.mjs）的純函式＋workflow 接線。
//
// 回歸來源：adverse 分片一次 17 分（平常 3 分）、開頭 8 條 page.goto 逾時，log 裡只有耗時、
// 分不出是被同主機 VM 搶 CPU（steal）、自己吃滿、還是卡磁碟，只能猜。
import fs from "fs";
import path from "path";
import {
  parseProcStat,
  cpuPercent,
  parseMemAvailableMb,
  summarize,
  formatSample,
} from "../../scripts/ci-resource-monitor.mjs";

const ROOT = path.resolve(__dirname, "../..");

describe("/proc 解析", () => {
  test("parseProcStat：nice 併入 user、irq/softirq 併入 system、steal 獨立", () => {
    const text = "cpu  100 5 50 800 20 3 2 40 0 0\ncpu0 1 2 3 4 5 6 7 8 0 0\nintr 1\n";
    expect(parseProcStat(text)).toEqual({ user: 105, system: 55, idle: 800, iowait: 20, steal: 40 });
  });
  test("parseProcStat：沒有彙總 cpu 行 ⇒ null", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("cpu0 1 2 3 4\n")).toBeNull();
  });
  test("cpuPercent：取兩次的差值算佔比", () => {
    const a = { user: 100, system: 50, idle: 800, iowait: 0, steal: 0 };
    const b = { user: 150, system: 70, idle: 810, iowait: 0, steal: 20 };
    expect(cpuPercent(a, b)).toEqual({ user: 50, system: 20, iowait: 0, steal: 20, idle: 10 });
  });
  test("cpuPercent：差值為 0 或缺資料 ⇒ null（不准除以 0）", () => {
    const a = { user: 1, system: 1, idle: 1, iowait: 0, steal: 0 };
    expect(cpuPercent(a, a)).toBeNull();
    expect(cpuPercent(null, a)).toBeNull();
  });
  test("parseMemAvailableMb", () => {
    expect(parseMemAvailableMb("MemTotal: 16000000 kB\nMemAvailable:    8388608 kB\n")).toBe(8192);
    expect(parseMemAvailableMb("")).toBeNull();
  });
});

describe("summarize／formatSample", () => {
  const rows = [
    { t: 0, cpu: null, load1: 1, memAvailMb: 9000 },
    { t: 10000, cpu: { user: 40, system: 10, iowait: 0, steal: 5, idle: 45 }, load1: 3, memAvailMb: 8000 },
    { t: 20000, cpu: { user: 20, system: 10, iowait: 2, steal: 55, idle: 13 }, load1: 7.5, memAvailMb: 8500 },
  ];
  test("avg 看整體、max 抓尖峰；首筆無差值不計入 CPU", () => {
    expect(summarize(rows)).toEqual({
      samples: 2,
      spanSec: 10,
      user: { avg: 30, max: 40 },
      system: { avg: 10, max: 10 },
      iowait: { avg: 1, max: 2 },
      steal: { avg: 30, max: 55 },
      load1Max: 7.5,
      memAvailMinMb: 8000,
    });
  });
  test("沒有任何 CPU 取樣 ⇒ null", () => {
    expect(summarize([rows[0]])).toBeNull();
    expect(summarize([])).toBeNull();
  });
  test("formatSample 一行看得到 us+sy／wa／st", () => {
    expect(formatSample(rows[2])).toContain("st  55%");
    expect(formatSample(rows[0])).toContain("無差值");
  });
});

describe("test.yml：e2e job 都有資源取樣，且綠的 run 也印報告", () => {
  const yaml = fs.readFileSync(path.join(ROOT, ".github/workflows/test.yml"), "utf8");
  const job = (name) => {
    const start = yaml.indexOf(`\n  ${name}:`);
    const next = yaml.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
    return yaml.slice(start, next < 0 ? undefined : start + 1 + next);
  };
  test.each(["test-e2e-offline-shard", "test-e2e-offline-adverse-bucket", "test-e2e-android"])("%s", (name) => {
    const body = job(name);
    expect(body).toContain("node scripts/ci-resource-monitor.mjs start");
    // report 要 if: always()：綠的 run 才有基準可比，紅的 run 才印得出來。
    expect(body).toMatch(/if: always\(\)\s*\n\s*run: node scripts\/ci-resource-monitor\.mjs report/);
    // 失敗上傳要帶走逐筆取樣。
    expect(body).toMatch(/path: \|\s*\n\s*test-results\/\s*\n\s*ci-diagnostics\//);
  });
});
