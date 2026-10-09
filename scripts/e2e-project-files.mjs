// 「Playwright 的某個 project 實際會跑哪些檔」——給靜態守護測試用的掃描範圍。
//
// 守護若自己寫 `readdirSync(tests/e2e).filter(.spec.js)`，範圍就比 Playwright 窄：
// live project 沒設 testMatch ⇒ 用預設的遞迴 `**/*.@(spec|test).?(c|m)[jt]s?(x)`，
// 子目錄、`.test.js`、`.spec.mjs` 都會跑，守護卻看不到 ⇒ 違規照綠。所以範圍一律
// 從 playwright.config.js 的 testMatch／testIgnore 推導，跟 Playwright 用同一套規則：
// 字串是 glob，比對絕對路徑，不以 `**/` 開頭的自動補上（playwright-core 的
// createFileMatcher）。
import fs from "fs";
import path from "path";
import picomatch from "picomatch";
import config from "../playwright.config.js";

const ROOT = path.join(import.meta.dirname, "..");
const TEST_DIR = path.join(ROOT, config.testDir || ".");
const DEFAULT_TEST_MATCH = "**/*.@(spec|test).?(c|m)[jt]s?(x)";

function matcher(patterns) {
  const list = [].concat(patterns || []);
  const fns = list.map((p) => {
    if (p instanceof RegExp) return (abs) => p.test(abs);
    const glob = p.startsWith("**/") || path.isAbsolute(p) ? p : "**/" + p;
    const m = picomatch(glob, { dot: true });
    return (abs) => m(abs);
  });
  return (abs) => fns.some((fn) => fn(abs));
}

function walk(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.join(d.parentPath, d.name))
    .filter((abs) => !abs.split(path.sep).includes("node_modules"));
}

// 回傳相對 testDir、以 `/` 分隔、排序過的檔名。
export function e2eProjectFiles(name) {
  const project = config.projects.find((p) => p.name === name);
  if (!project) throw new Error(`playwright.config.js 沒有 project「${name}」`);
  const match = matcher(project.testMatch || config.testMatch || DEFAULT_TEST_MATCH);
  const ignore = matcher(project.testIgnore || config.testIgnore || []);
  return walk(TEST_DIR)
    .map((abs) => abs.split(path.sep).join("/"))
    .filter((abs) => match(abs) && !ignore(abs))
    .map((abs) => path.relative(TEST_DIR, abs).split(path.sep).join("/"))
    .sort();
}

// 所有 offline* project（含手機、Firefox、逆境桶）會跑的 offline/ 底下 spec，
// 回傳相對 offline/ 的檔名（子目錄保留 `sub/x.spec.js`）。
export function offlineSpecFiles() {
  const all = new Set();
  for (const p of config.projects) {
    if (!/^offline(-|$)/.test(p.name)) continue;
    for (const f of e2eProjectFiles(p.name)) {
      if (f.startsWith("offline/")) all.add(f.slice("offline/".length));
    }
  }
  return [...all].sort();
}

export const E2E_DIR = TEST_DIR;
export const OFFLINE_DIR = path.join(TEST_DIR, "offline");
