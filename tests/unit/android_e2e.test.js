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
import { apkBuildPlan, classifyReport, parseArgs } from "../../scripts/run-android-e2e.mjs";

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

describe("裝置資訊 log 的解析", () => {
  test("parseImageRevision 取 Pkg.Revision；沒有 ⇒ null", () => {
    expect(androidEnv.parseImageRevision("Pkg.Desc=Google APIs\r\nPkg.Revision=14\r\n")).toBe("14");
    expect(androidEnv.parseImageRevision("Pkg.Desc=x")).toBe(null);
  });
  test("parseVersionName 取第一個 versionName；沒有 ⇒ null", () => {
    const dump = "Packages:\n  Package [com.android.chrome]\n    versionCode=567 minSdk=29\n    versionName=113.0.5672.136\n    versionName=110.0.1\n";
    expect(androidEnv.parseVersionName(dump)).toBe("113.0.5672.136");
    expect(androidEnv.parseVersionName("")).toBe(null);
  });
});

// APK spec 用它判「App 在前景／被丟到背景／外部瀏覽器起來了」。
describe("parseResumedPackage：前景 App", () => {
  test("Android 14 的 topResumedActivity", () => {
    const dump =
      "  Task display areas in top down Z order:\n" +
      "    topResumedActivity=ActivityRecord{3d2a1b u0 com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity t15}\n" +
      "    mResumedActivity: ActivityRecord{3d2a1b u0 com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity t15}\n";
    expect(androidEnv.parseResumedPackage(dump)).toBe("com.android.chrome");
  });
  test("舊格式 mResumedActivity: 也認；debug APK 的套件名帶 .debug", () => {
    const dump = "  mResumedActivity: ActivityRecord{9f u0 io.github.abccbaandy.pttchrome.debug/io.github.abccbaandy.pttchrome.MainActivity t3}";
    expect(androidEnv.parseResumedPackage(dump)).toBe(androidEnv.APK_PKG);
  });
  test("沒有前景 Activity ⇒ null", () => {
    expect(androidEnv.parseResumedPackage("topResumedActivity=null")).toBe(null);
    expect(androidEnv.parseResumedPackage("")).toBe(null);
  });
});

// debug APK 的 dev server 設定要對上 AppSettings.kt 的檔名與 key（改名＝APK 靜默載正式站）。
describe("APK dev server 設定", () => {
  const kt = fs.readFileSync(path.join(ROOT, "android/app/src/main/java/io/github/abccbaandy/pttchrome/AppSettings.kt"), "utf8");
  test("檔名 app_settings、key dev_server_enabled 與 AppSettings.kt 一致", () => {
    expect(kt).toMatch(/FILE = "app_settings"/);
    expect(kt).toMatch(/KEY_DEV_ENABLED = "dev_server_enabled"/);
    expect(androidEnv.APK_DEV_PREFS_XML).toContain("name='dev_server_enabled' value='true'");
    expect(fs.readFileSync(path.join(ROOT, "tests/e2e/android/fixtures.js"), "utf8")).toMatch(/shared_prefs\/app_settings\.xml/);
  });
  test("預設 dev 網址就是 localhost:8080（adb reverse 接的那個埠）", () => {
    const ps = fs.readFileSync(path.join(ROOT, "android/app/src/main/java/io/github/abccbaandy/pttchrome/PageSource.kt"), "utf8");
    expect(ps).toMatch(/DEFAULT_DEV_URL = "http:\/\/localhost:8080\/"/);
  });
  test("applicationIdSuffix .debug ⇒ APK_PKG", () => {
    const gradle = fs.readFileSync(path.join(ROOT, "android/app/build.gradle.kts"), "utf8");
    expect(gradle).toMatch(/applicationIdSuffix = "\.debug"/);
    expect(androidEnv.APK_PKG).toBe("io.github.abccbaandy.pttchrome.debug");
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
  test("--no-build；預設要建", () => {
    expect(parseArgs([]).build).toBe(true);
    expect(parseArgs(["--no-build"])).toMatchObject({ build: false, passthrough: [] });
  });
});

// 回歸：本機原本不建 APK，直接裝 build 輸出目錄裡的舊檔 ⇒ apk spec 測的是舊 code。
describe("apkBuildPlan：每輪先建 APK", () => {
  test("本機預設要建；Windows 走 shell＋絕對路徑的 gradlew.bat（整條一個字串）", () => {
    const android = path.join(ROOT, "android");
    expect(apkBuildPlan(parseArgs([]), {}, "win32")).toEqual({
      cmd: `"${path.join(android, "gradlew.bat")}" assembleDebug`,
      args: [],
      cwd: android,
      shell: true,
    });
    expect(apkBuildPlan(parseArgs([]), {}, "linux")).toEqual({
      cmd: path.join(android, "gradlew"),
      args: ["assembleDebug"],
      cwd: android,
      shell: false,
    });
  });
  test("CI 已指定 ANDROID_E2E_APK 或 --no-build ⇒ 不建", () => {
    expect(apkBuildPlan(parseArgs([]), { ANDROID_E2E_APK: "/x/app-debug.apk" }, "linux")).toBeNull();
    expect(apkBuildPlan(parseArgs(["--no-build"]), {}, "win32")).toBeNull();
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
        "src/components/MobileToolbar/index.jsx",
        "tests/e2e/android/fixtures.js",
        "src/js/term_view.js",
        "docs/mobile.md",
      ])
    ).toEqual([
      "src/js/context_menu_items.js",
      "src/components/ContextMenu/index.jsx",
      "src/components/MobileToolbar/index.jsx",
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
  // CI spike 20 輪有 3 輪：開機後、fixture 設 hide_error_dialogs 之前 Pixel Launcher 就 ANR，
  // 對話框已經掛在畫面上 —— 這個設定只擋之後的，不收已顯示的。順序要先設再關：反過來
  // 的話，兩步之間冒出的 ANR 照樣會顯示。
  test("設完 hide_error_dialogs 再廣播 CLOSE_SYSTEM_DIALOGS，收掉設定前就跳出來的 ANR 對話框", () => {
    const hide = src.indexOf("settings put global hide_error_dialogs 1");
    const close = src.indexOf("am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS");
    expect(close).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(hide);
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

// CI job：exit code 必須直接決定紅綠。spike 用的 continue-on-error＋把 exit 寫檔分類那套
// 一旦被抄進來，job 永遠綠、斷言紅也被吞掉；沒開 KVM 則開機 13–20 分鐘、adb 常 offline。
describe("test.yml：test-e2e-android job", () => {
  const yaml = fs.readFileSync(path.join(ROOT, ".github/workflows/test.yml"), "utf8");
  const m = /\n {2}test-e2e-android:\n([\s\S]*?)(?=\n {2}[A-Za-z][\w-]*:\n)/.exec(yaml);
  const body = m ? m[1] : "";
  test("存在，script 直接跑 run-android-e2e --no-boot，不吞 exit code", () => {
    expect(body).toMatch(/script: node scripts\/run-android-e2e\.mjs --no-boot\s*$/m);
    expect(body).not.toMatch(/continue-on-error/);
    expect(body).not.toMatch(/e2e\.exit|\|\| true/);
  });
  test("開模擬器前先開 KVM 權限", () => {
    const kvm = body.indexOf("udevadm trigger --name-match=kvm");
    const emu = body.indexOf("android-emulator-runner@");
    expect(kvm).toBeGreaterThan(-1);
    expect(emu).toBeGreaterThan(kvm);
  });
  // 少了這步，apk.android.spec.js 在 CI 會以「找不到 debug APK」整輪 exit 2。
  test("開模擬器前先建 debug APK，並把路徑交給 e2e", () => {
    const build = body.indexOf("assembleDebug");
    const emu = body.indexOf("android-emulator-runner@");
    expect(build).toBeGreaterThan(-1);
    expect(emu).toBeGreaterThan(build);
    expect(body).toMatch(/ANDROID_E2E_APK: .*app-debug\.apk/);
  });
});
