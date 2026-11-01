import fs from "node:fs";
import path from "node:path";
import { killLines, verdict } from "../../scripts/ci-emulator-postmortem.mjs";

const ROOT = path.resolve(__dirname, "../..");

// 模擬器整台消失（issue #287）時，job log 要直接說出「kernel 砍的／模擬器自己崩／都不是」。
describe("ci-emulator-postmortem：dmesg 判讀", () => {
  const dmesg = [
    "[Sat Oct 31 19:04:01 2026] eth0: Link is Up",
    "[Sat Oct 31 19:06:58 2026] qemu-system-x86 invoked oom-killer: gfp_mask=0x140cca",
    "[Sat Oct 31 19:06:58 2026] Out of memory: Killed process 2859 (qemu-system-x86) total-vm:12345kB",
    "[Sat Oct 31 19:06:59 2026] audit: type=1400 apparmor=\"STATUS\"",
  ].join("\n");

  test("只挑跟程序被砍有關的行", () => {
    const lines = killLines(dmesg);
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("Link is Up");
  });
  test("OOM ⇒ 結論說 OOM killer", () => {
    expect(verdict(killLines(dmesg), [])).toContain("OOM");
  });
  test("segfault ⇒ 結論說 segfault", () => {
    const l = killLines("[x] qemu-system-x86[2859]: segfault at 0 ip 0000 sp 0000 error 4");
    expect(verdict(l, [])).toContain("segfault");
  });
  test("dmesg 乾淨但有 crash 檔 ⇒ 模擬器自己崩", () => {
    expect(verdict([], ["emu-crash-37.2.13.db/abc.dmp"])).toContain("crash 檔");
  });
  test("都沒有 ⇒ 明講不是 OOM／segfault", () => {
    expect(verdict(killLines("[x] eth0: Link is Up"), [])).toContain("不是 OOM");
    expect(killLines("")).toEqual([]);
  });
});

describe("Android e2e job 失敗時收模擬器現場、且在上傳之前", () => {
  const jobBody = (file, name) => {
    const yaml = fs.readFileSync(path.join(ROOT, ".github/workflows", file), "utf8");
    const start = yaml.indexOf(`\n  ${name}:`);
    const next = yaml.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
    return yaml.slice(start, next < 0 ? undefined : start + 1 + next);
  };
  test.each([
    ["test.yml", "test-e2e-android"],
    ["flaky-hunt.yml", "android-repeat"],
  ])("%s %s", (file, name) => {
    const body = jobBody(file, name);
    const pm = body.search(/if: failure\(\)\s*\n\s*run: node scripts\/ci-emulator-postmortem\.mjs/);
    expect(pm).toBeGreaterThan(body.indexOf("android-emulator-runner@"));
    expect(body.indexOf("actions/upload-artifact@")).toBeGreaterThan(pm);
  });
});
