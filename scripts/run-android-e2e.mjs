// Android 模擬器 e2e 的執行器（`yarn test:e2e:android`）。設計見 docs/android-e2e.md。
//
//   1. （--if-changed[=<base>]）沒改到相關檔案 ⇒ 印「略過」exit 0（名單：android-e2e-needed.mjs）
//   2. 找模擬器：已經有一台在跑就用它；沒有就用 AVD `pttchrome_e2e`（原生 Pixel 6）開一台，
//      沒有 AVD 就建
//   3. playwright test --project=android，依 JSON 報告分類結論
//   4. 自己開的模擬器自己關（--keep-emulator 留著，下一輪省開機時間）
//
// exit code（刻意分三種，比照 scripts/run-adverse-e2e.mjs）：
//   0 全綠／略過｜1 有真失敗｜2 環境沒準備好、未取得有效結論（不可以當綠）
// --no-boot：只用已經在跑的模擬器（CI：emulator-runner 已經開好）。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { androidE2eNeeded } from "./android-e2e-needed.mjs";

const require = createRequire(import.meta.url);
const env = require("../tests/e2e/android/android_env.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAYWRIGHT_CLI = path.join(ROOT, "node_modules", "playwright", "cli.js");
const BOOT_TIMEOUT_MS = 300000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 純函式（unit 守護：tests/unit/android_e2e.test.js）----

export function parseArgs(argv) {
  const opts = { ifChanged: null, keepEmulator: false, boot: true, passthrough: [] };
  for (const arg of argv) {
    const m = /^--if-changed(?:=(.+))?$/.exec(arg);
    if (m) opts.ifChanged = m[1] || "origin/dev";
    else if (arg === "--keep-emulator") opts.keepEmulator = true;
    else if (arg === "--no-boot") opts.boot = false;
    else opts.passthrough.push(arg);
  }
  return opts;
}

// playwright JSON 報告 → 'pass' | 'fail' | 'env'。
// 失敗的測試**全部**都是環境錯誤（ENV_ERROR_TAG）才算 env；混到任何一條真斷言紅就是 fail，
// 不能讓環境問題把真失敗蓋掉。沒有報告（playwright 本身起不來）＝ env。
export function classifyReport(report) {
  if (!report || !Array.isArray(report.suites)) return "env";
  const failed = [];
  const walk = (suite) => {
    for (const s of suite.suites || []) walk(s);
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        for (const r of t.results || []) {
          if (r.status === "failed" || r.status === "timedOut") failed.push(r);
        }
      }
    }
  };
  report.suites.forEach(walk);
  const errors = report.errors || [];
  if (!failed.length && !errors.length) return report.stats && report.stats.expected > 0 ? "pass" : "env";
  const isEnv = (e) => String((e && e.message) || "").includes(env.ENV_ERROR_TAG);
  const allEnv =
    failed.every((r) => (r.errors || [r.error]).some(isEnv)) && errors.every(isEnv);
  return allEnv ? "env" : "fail";
}

// ---- 環境 ----

function adb(args, opts = {}) {
  return spawnSync(env.sdkTool("adb"), args, { encoding: "utf8", ...opts });
}

function adbSerials() {
  const r = adb(["devices"]);
  if (r.error || r.status !== 0) return null;
  return env.parseAdbDevices(r.stdout);
}

function avdExists(emulator) {
  const r = spawnSync(emulator, ["-list-avds"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.split(/\r?\n/).includes(env.AVD_NAME);
}

function systemImageInstalled() {
  const dir = path.join(env.sdkRoot(), ...env.SYSTEM_IMAGE.split(";"));
  return fs.existsSync(dir);
}

// 一行版本資訊：Chrome／映像不同版時行為可能不同（GPU 當機、選取把手），CI 出事先對這行。
// host 端映像 revision 只代表 SDK 裝的那份；已在跑的模擬器以 fingerprint 為準。查不到印「?」，不擋測試。
function logDeviceInfo(serial) {
  const sh = (...args) => {
    const r = adb(["-s", serial, "shell", ...args]);
    return r.status === 0 ? r.stdout.trim() : "";
  };
  let revision = null;
  try {
    revision = env.parseImageRevision(
      fs.readFileSync(path.join(env.sdkRoot(), ...env.SYSTEM_IMAGE.split(";"), "source.properties"), "utf8")
    );
  } catch (e) {}
  const chrome = env.parseVersionName(sh("dumpsys", "package", "com.android.chrome"));
  console.log(
    `裝置：${serial}｜${sh("getprop", "ro.build.fingerprint") || "?"}｜` +
      `映像 ${env.SYSTEM_IMAGE} r${revision || "?"}｜Chrome ${chrome || "?"}`
  );
}

function createAvd() {
  const avdmanager = env.sdkTool("avdmanager");
  if (!avdmanager) return false;
  // .bat 會把 `;` 當參數分隔 ⇒ Windows 上整串要加引號，並走 shell（其他平台不能加，會變字面引號）
  const win = process.platform === "win32";
  const image = win ? `"${env.SYSTEM_IMAGE}"` : env.SYSTEM_IMAGE;
  const r = spawnSync(
    win ? `"${avdmanager}"` : avdmanager,
    ["create", "avd", "-n", env.AVD_NAME, "-k", image, "-d", env.AVD_DEVICE],
    { encoding: "utf8", input: "no\n", shell: win }
  );
  return r.status === 0;
}

async function bootEmulator(before) {
  const emulator = env.sdkTool("emulator");
  const child = spawn(
    emulator,
    ["-avd", env.AVD_NAME, "-no-snapshot", "-no-audio", "-no-boot-anim", "-gpu", "swiftshader_indirect"],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let serial = null;
  while (Date.now() < deadline) {
    if (!serial) {
      const now = adbSerials() || [];
      serial = now.find((s) => /^emulator-\d+$/.test(s) && !before.includes(s)) || null;
    }
    if (serial) {
      const r = adb(["-s", serial, "shell", "getprop", "sys.boot_completed"]);
      if (r.status === 0 && r.stdout.trim() === "1") return serial;
    }
    await sleep(2000);
  }
  if (serial) adb(["-s", serial, "emu", "kill"]);
  return null;
}

function runPlaywright(serial, passthrough) {
  const reportFile = path.join(os.tmpdir(), `android-e2e-${process.pid}.json`);
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [PLAYWRIGHT_CLI, "test", "--project=android", "--reporter=list,json", ...passthrough],
      {
        cwd: ROOT,
        stdio: "inherit",
        env: { ...process.env, ANDROID_SERIAL: serial, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
      }
    );
    child.on("close", (code) => {
      let report = null;
      try {
        report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
        fs.unlinkSync(reportFile);
      } catch (e) {}
      resolve({ code, report });
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.ifChanged) {
    const r = androidE2eNeeded(opts.ifChanged);
    if (!r.needed) {
      console.log(`略過：相對 ${opts.ifChanged} 沒有改到 Android e2e 相關檔案（scripts/android-e2e-needed.mjs）`);
      return 0;
    }
    console.log(r.reason ? `無法判斷改動（${r.reason}）⇒ 照跑` : `命中：${r.matched.join(", ")}`);
  }

  const before = adbSerials();
  if (!before) {
    console.error(`[環境] 找不到 adb（${env.sdkTool("adb")}）。安裝 Android SDK platform-tools，見 docs/android-e2e.md`);
    return 2;
  }

  let serial = env.pickEmulatorSerial(before, process.env);
  let booted = false;
  if (!serial) {
    const emus = before.filter((s) => /^emulator-\d+$/.test(s));
    if (process.env.ANDROID_SERIAL || emus.length > 1) {
      console.error(`[環境] 無法決定用哪台模擬器（adb：${before.join(", ")}；ANDROID_SERIAL=${process.env.ANDROID_SERIAL || "未設"}）`);
      return 2;
    }
    if (!opts.boot) {
      console.error("[環境] 沒有在跑的模擬器（--no-boot）");
      return 2;
    }
    const emulator = env.sdkTool("emulator");
    if (!emulator) {
      console.error("[環境] 找不到 emulator。`sdkmanager emulator` 後重試，見 docs/android-e2e.md");
      return 2;
    }
    if (!avdExists(emulator)) {
      if (!systemImageInstalled() || !createAvd()) {
        console.error(`[環境] 沒有 AVD ${env.AVD_NAME}，也建不起來。先 \`sdkmanager "${env.SYSTEM_IMAGE}"\`，見 docs/android-e2e.md`);
        return 2;
      }
      console.log(`已建立 AVD ${env.AVD_NAME}`);
    }
    console.log(`開機中（${env.AVD_NAME}）…`);
    const t0 = Date.now();
    serial = await bootEmulator(before);
    if (!serial) {
      console.error(`[環境] 模擬器 ${BOOT_TIMEOUT_MS / 1000}s 內沒開完機（Windows 要開 WHPX，見 docs/android-e2e.md）`);
      return 2;
    }
    booted = true;
    console.log(`開機完成：${serial}（${Math.round((Date.now() - t0) / 1000)}s）`);
  }

  logDeviceInfo(serial);

  try {
    const inst = spawnSync(process.execPath, [PLAYWRIGHT_CLI, "install", "android"], { cwd: ROOT, stdio: "inherit" });
    if (inst.status !== 0) {
      console.error("[環境] playwright install android 失敗");
      return 2;
    }

    const { code, report } = await runPlaywright(serial, opts.passthrough);
    const verdict = code === 0 ? "pass" : classifyReport(report);
    if (verdict === "pass") {
      console.log("結論：全綠。");
      return 0;
    }
    if (verdict === "env") {
      console.error(`結論：環境問題（失敗全帶 ${env.ENV_ERROR_TAG}），未取得有效結論。`);
      return 2;
    }
    console.error("結論：有真失敗。");
    return 1;
  } finally {
    if (booted && !opts.keepEmulator) adb(["-s", serial, "emu", "kill"]);
  }
}

// 只有「直接執行」才跑 main——unit test import 純函式時不可碰 adb 或 exit。
// 收尾用 process.exitCode 而非 process.exit()（見 scripts/ci-status.mjs 的 libuv 註解）。
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(e.message);
      process.exitCode = 2;
    }
  );
}
