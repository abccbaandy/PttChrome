// Android 模擬器 e2e 設施的純函式守護（不碰 adb、不開模擬器）。設計見 docs/android-e2e.md。
//
// 要鎖住的幾件事：
//   - 只會選到模擬器：開發機常同時連著實機（無線 adb），測試會斷網、清 Chrome 資料；
//   - 環境問題 → exit 2、真失敗 → exit 1，兩者混在一起時以真失敗為準（不可被蓋掉）；
//   - `--if-changed` 名單裡的路徑都還存在（改名不得讓它靜默變成「永遠略過」）；
//   - live project 不會順手把 android spec 抓去跑。
import fs from "fs";
import path from "path";
import config from "../../playwright.config.js";
import androidEnv from "../e2e/android/android_env.js";
import { ANDROID_E2E_GLOBS, globToRegExp, matchAndroidE2e } from "../../scripts/android-e2e-needed.mjs";
import { classifyReport, parseArgs } from "../../scripts/run-android-e2e.mjs";

const { ENV_ERROR_TAG, pickEmulatorSerial, toDevicePoint, parseAdbDevices } = androidEnv;
const ROOT = path.resolve(__dirname, "../..");

describe("pickEmulatorSerial：只碰模擬器", () => {
  const phone = "adb-XXXX._adb-tls-connect._tcp";
  test("實機＋一台模擬器 ⇒ 選模擬器", () => {
    expect(pickEmulatorSerial([phone, "emulator-5554"], {})).toBe("emulator-5554");
  });
  test("只有實機 ⇒ 不選", () => {
    expect(pickEmulatorSerial([phone], {})).toBeNull();
    expect(pickEmulatorSerial(["R5CT1234567"], {})).toBeNull();
  });
  test("兩台模擬器 ⇒ 不猜（要 ANDROID_SERIAL）", () => {
    expect(pickEmulatorSerial(["emulator-5554", "emulator-5556"], {})).toBeNull();
    expect(pickEmulatorSerial(["emulator-5554", "emulator-5556"], { ANDROID_SERIAL: "emulator-5556" })).toBe("emulator-5556");
  });
  test("ANDROID_SERIAL 指定但不在線上 ⇒ 不退回自動挑", () => {
    expect(pickEmulatorSerial(["emulator-5554"], { ANDROID_SERIAL: "emulator-5556" })).toBeNull();
  });
});

describe("座標與 adb 輸出", () => {
  test("toDevicePoint：CSS px × DPR ＋ WebView 原點", () => {
    expect(toDevicePoint({ x: 0, y: 330 }, 2.625, { x: 160, y: 44 })).toEqual({ x: 420, y: 446 });
  });
  test("parseAdbDevices 只收 state=device", () => {
    const out = "List of devices attached\nemulator-5554\tdevice product:sdk\nemulator-5556\toffline\nabc\tunauthorized\n\n";
    expect(parseAdbDevices(out)).toEqual(["emulator-5554"]);
  });
});

describe("classifyReport：0／1／2 的依據", () => {
  const report = (results, extra = {}) => ({
    suites: [{ specs: [{ tests: [{ results }] }] }],
    errors: [],
    stats: { expected: results.filter((r) => r.status === "passed").length },
    ...extra,
  });
  const envErr = { message: `Error: ${ENV_ERROR_TAG} 觸控落點偏移` };
  const realErr = { message: "Error: expect(received).toBe(expected)" };

  test("全過 ⇒ pass", () => {
    expect(classifyReport(report([{ status: "passed" }]))).toBe("pass");
  });
  test("失敗全是環境錯誤 ⇒ env", () => {
    expect(classifyReport(report([{ status: "failed", errors: [envErr] }]))).toBe("env");
  });
  test("REGRESSION 防線：環境錯誤混真失敗 ⇒ fail（不可被蓋掉）", () => {
    expect(
      classifyReport(report([{ status: "failed", errors: [envErr] }, { status: "failed", errors: [realErr] }]))
    ).toBe("fail");
    expect(classifyReport(report([{ status: "timedOut", errors: [realErr] }]))).toBe("fail");
  });
  test("worker fixture 掛掉（頂層 errors）帶標記 ⇒ env；不帶 ⇒ fail", () => {
    expect(classifyReport(report([], { errors: [envErr] }))).toBe("env");
    expect(classifyReport(report([], { errors: [realErr] }))).toBe("fail");
  });
  test("沒有報告、一條都沒跑 ⇒ env（不可以當綠）", () => {
    expect(classifyReport(null)).toBe("env");
    expect(classifyReport(report([]))).toBe("env");
  });
});

describe("parseArgs", () => {
  test("--if-changed 預設 base 為 origin/dev；其餘透傳", () => {
    expect(parseArgs(["--if-changed", "--grep", "x"])).toMatchObject({ ifChanged: "origin/dev", passthrough: ["--grep", "x"] });
    expect(parseArgs(["--if-changed=HEAD~3", "--no-boot", "--keep-emulator"])).toMatchObject({
      ifChanged: "HEAD~3",
      boot: false,
      keepEmulator: true,
    });
  });
});

describe("--if-changed 名單", () => {
  test("glob 語意：** 跨目錄、* 不跨 /", () => {
    expect(globToRegExp("src/components/ContextMenu/**").test("src/components/ContextMenu/a/b.jsx")).toBe(true);
    expect(globToRegExp("src/*.js").test("src/a/b.js")).toBe(false);
    expect(globToRegExp("src/css/main.css").test("src/css/mainXcss")).toBe(false);
  });
  test("相關檔案命中、無關檔案不命中、Windows 路徑正規化", () => {
    expect(
      matchAndroidE2e([
        "src/js/context_menu_items.js",
        "src\\components\\ContextMenu\\index.jsx",
        "src/components/MobileKeypad/index.jsx",
        "tests/e2e/android/fixtures.js",
        "src/js/term_view.js",
        "docs/mobile.md",
      ])
    ).toEqual([
      "src/js/context_menu_items.js",
      "src/components/ContextMenu/index.jsx",
      "src/components/MobileKeypad/index.jsx",
      "tests/e2e/android/fixtures.js",
    ]);
  });
  test("名單裡的每個路徑都還存在（改名不得讓它靜默變成永遠略過）", () => {
    for (const g of ANDROID_E2E_GLOBS) {
      const p = g.endsWith("/**") ? g.slice(0, -3) : g;
      expect(fs.existsSync(path.join(ROOT, p)), g).toBe(true);
    }
  });
});

describe("playwright.config：android project", () => {
  const android = config.projects.find((p) => p.name === "android");
  test("存在、只收 android/ 底下的 spec、worker 不會被放大（名稱不得以 offline 開頭）", () => {
    expect(android).toBeTruthy();
    expect(android.testMatch).toBe("android/**/*.android.spec.js");
  });
  test("live project 排除 android/（否則 yarn test:e2e 會去找模擬器）", () => {
    const live = config.projects.find((p) => p.name === "live");
    expect(live.testIgnore).toContain("android/**");
  });
});

// 這兩行刪掉不會讓任何東西編譯失敗，只會讓整輪變成偶發 exit 2（畫面被系統對話框蓋住、
// UIAutomator 讀不到 WebView），而且要冷開機才比較容易遇到。理由見 fixtures.js 註解。
describe("android fixture：擋畫面的對話框", () => {
  const src = fs.readFileSync(path.join(ROOT, "tests/e2e/android/fixtures.js"), "utf8");
  test("pm clear 之後預先授權通知（否則 Android 13+ 跳權限推廣對話框）", () => {
    expect(src).toMatch(/pm clear \$\{CHROME\}; pm grant \$\{CHROME\} android\.permission\.POST_NOTIFICATIONS/);
  });
  test("關掉系統錯誤對話框（模擬器軟體 GPU 上 Chrome 的 GPU 程序會當，跳「keeps stopping」）", () => {
    expect(src).toMatch(/settings put global hide_error_dialogs 1/);
  });
  test("launchBrowser 有自己的逾時，卡住時歸類為環境問題", () => {
    expect(src).toMatch(/LAUNCH_TIMEOUT_MS/);
    expect(src).toMatch(/Promise\.race\(\[\s*android\.device\.launchBrowser/);
  });
});

// UIAutomator 的 device.wait 等的是「UI 變化」：目標在 wait 開始前就已經出現、之後畫面
// 不再變時，畫面上明明有它也會等滿逾時（實測 Copy 工具列）。一律 expect.poll(device.info)。
describe("android spec：不准用 device.wait", () => {
  const dir = path.join(ROOT, "tests/e2e/android");
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    test(f, () => {
      const code = fs
        .readFileSync(path.join(dir, f), "utf8")
        .split("\n")
        .filter((l) => !/^\s*\/\//.test(l))
        .join("\n");
      expect(code).not.toMatch(/\bdevice\s*\.\s*wait\s*\(/);
    });
  }
});
