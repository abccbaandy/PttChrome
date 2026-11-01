// Android 模擬器 e2e 紅了之後的現場（.github/workflows/test.yml 的 test-e2e-android、flaky-hunt 的
// android-repeat，`if: failure()`）。
//
//   node scripts/ci-emulator-postmortem.mjs
//
// 為什麼要它：模擬器程序曾在跑到一半整台消失（issue #287：`launchBrowser: Device is closed` →
// adb 看不到 → 收尾 `emu kill` 連不上 5554），emulator 的 stdout 最後一行停在幾十秒前、沒有任何
// 退出訊息；同時段的資源取樣 memAvail 還有 9 GB ⇒ 光看 job log 分不出是 kernel 砍的（OOM killer、
// segfault）還是模擬器自己崩（它會把 crash dump 寫進 emulator-runner 的 `/tmp/android-runner/
// emu-crash-*.db`，log 開頭那行「Storing crashdata in: …」）。這支把兩邊都帶走：
//   - `dmesg` 尾段 → ci-diagnostics/dmesg.txt，並把跟程序被砍有關的行直接印在 log（不用下載 artifact）；
//   - emu-crash-* → ci-diagnostics/emulator-crash/（跟 ci-diagnostics/ 一起上傳）。
// 任何錯誤都不准讓 job 紅：這是診斷，不是測試。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "ci-diagnostics");
const CRASH_PARENT = "/tmp/android-runner";
const DMESG_TAIL = 400;

// ---- 純函式（unit 守護：tests/unit/ci_emulator_postmortem.test.js）----

// kernel 砍掉／收掉一個程序時會留的字樣（mm/oom_kill.c、arch/x86/mm/fault.c 的 show_signal_msg、
// kernel/hung_task.c）。只挑這幾種，其他 kernel 訊息（網卡、cgroup 建立）不算。
const KILL_PATTERNS = [
  /out of memory/i,
  /oom[-_ ]kill/i,
  /killed process/i,
  /segfault at/i,
  /general protection/i,
  /traps:/i,
  /blocked for more than/i,
  /\bqemu/i,
  /\bemulator\b/i,
];

export function killLines(text) {
  return String(text || "")
    .split("\n")
    .filter((l) => KILL_PATTERNS.some((re) => re.test(l)));
}

// 給 job log 一行結論。lines＝killLines 的結果，crashFiles＝emu-crash-* 底下的檔名。
export function verdict(lines, crashFiles) {
  const oom = lines.some((l) => /out of memory|oom[-_ ]kill|killed process/i.test(l));
  const fault = lines.some((l) => /segfault at|general protection|traps:/i.test(l));
  if (oom) return "kernel OOM killer 砍了程序（看 dmesg.txt 的 Killed process 是不是 qemu／emulator）";
  if (fault) return "程序被 kernel 以 segfault／GP fault 收掉（看 dmesg.txt 是哪個程序）";
  if (crashFiles.length) return `dmesg 沒有砍程序的紀錄；模擬器自己留了 ${crashFiles.length} 個 crash 檔（ci-diagnostics/emulator-crash/）`;
  return "dmesg 沒有砍程序的紀錄，模擬器也沒留 crash 檔（不是 OOM／segfault；記進 issue #287）";
}

// ---- 執行 ----

function readDmesg() {
  for (const cmd of [["sudo", ["-n", "dmesg", "-T"]], ["dmesg", ["-T"]]]) {
    try {
      return execFileSync(cmd[0], cmd[1], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // 下一個
    }
  }
  return null;
}

function copyCrashData() {
  const files = [];
  let entries = [];
  try {
    entries = fs.readdirSync(CRASH_PARENT).filter((n) => n.startsWith("emu-crash"));
  } catch {
    return files;
  }
  const dest = path.join(OUT_DIR, "emulator-crash");
  for (const name of entries) {
    const src = path.join(CRASH_PARENT, name);
    try {
      fs.cpSync(src, path.join(dest, name), { recursive: true });
      const walk = (p) => {
        const st = fs.statSync(p);
        if (st.isDirectory()) for (const c of fs.readdirSync(p)) walk(path.join(p, c));
        else files.push(path.relative(CRASH_PARENT, p));
      };
      walk(src);
    } catch (e) {
      console.log(`複製 ${src} 失敗：${e.message}`);
    }
  }
  return files;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dmesg = readDmesg();
  let lines = [];
  if (dmesg == null) {
    console.log("讀不到 dmesg（沒有 sudo？）");
  } else {
    const tail = dmesg.trimEnd().split("\n").slice(-DMESG_TAIL).join("\n");
    fs.writeFileSync(path.join(OUT_DIR, "dmesg.txt"), tail + "\n");
    lines = killLines(tail);
    console.log(`dmesg 尾段 ${DMESG_TAIL} 行 → ci-diagnostics/dmesg.txt；跟程序被砍有關的 ${lines.length} 行：`);
    for (const l of lines) console.log(`  ${l}`);
  }
  const crashFiles = copyCrashData();
  console.log(`模擬器 crash 檔（${CRASH_PARENT}/emu-crash-*）：${crashFiles.length ? crashFiles.join("、") : "無"}`);
  console.log(`結論：${verdict(lines, crashFiles)}`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    main();
  } catch (e) {
    console.log(`模擬器現場收集失敗（不影響測試）：${e.message}`);
  }
}
