// App 內更新（docs/android-app.md「App 內更新」）跨檔契約的靜態守護。判斷邏輯本身在 JVM `UpdateCheckTest`；
// 這裡守「兩邊各自改一邊就靜默壞掉」的接點：
//   1. 原生解析的 tag 前綴／附件檔名／安裝段標題，必須等於發版腳本與 workflow 實際發出去的；
//   2. 自動檢查、手動檢查、安裝結果三個入口都還接著（原生沒有可跑的 UI 測試）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TAG_PREFIX, INSTALL_SECTION } from "../../scripts/android-release.mjs";

const root = join(__dirname, "../..");
const main = join(root, "android/app/src/main");
const kt = (name) => readFileSync(join(main, "java/io/github/abccbaandy/pttchrome", name), "utf8");
const check = kt("UpdateCheck.kt");
const updater = kt("AppUpdater.kt");
const manifest = readFileSync(join(main, "AndroidManifest.xml"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/android.yml"), "utf8");

const constant = (name) => new RegExp(`const val ${name} = "([^"]*)"`).exec(check)?.[1];

describe("原生解析的字串＝發版實際發出去的", () => {
  test("tag 前綴與發版腳本相同", () => {
    expect(constant("TAG_PREFIX")).toBe(TAG_PREFIX);
  });

  test("附件檔名就是 workflow 上傳到 Release 的那個", () => {
    expect(constant("APK_NAME")).toBe("pttchrome.apk");
    expect(workflow).toMatch(/gh release create "\$TAG" pttchrome\.apk/);
  });

  test("安裝段標題＝release note 尾段的第一行（App 從這裡切掉）", () => {
    expect(constant("INSTALL_HEADING")).toBe(INSTALL_SECTION.split("\n")[0]);
  });

  test("只查、只下載本 repo 的 Release", () => {
    expect(constant("RELEASES_API")).toMatch(/^https:\/\/api\.github\.com\/repos\/abccbaandy\/PttChrome\/releases\b/);
    expect(constant("DOWNLOAD_PREFIX")).toBe("https://github.com/abccbaandy/PttChrome/releases/download/");
  });
});

describe("入口都接著", () => {
  test("主畫面回到前景時自動檢查", () => {
    const activity = kt("MainActivity.kt");
    const onStart = activity.slice(activity.indexOf("override fun onStart()"));
    expect(onStart).toMatch(/updater\.autoCheck\(\)/);
  });

  test("自動檢查一天一次：查成功才記日期", () => {
    expect(updater).toMatch(/UpdateCheck\.shouldAutoCheck\(settings\.lastUpdateCheckDay, today\)/);
    expect(updater).toMatch(/if \(result != null\) settings\.lastUpdateCheckDay = today/);
  });

  test("設定頁顯示版本＋手動檢查", () => {
    const settings = kt("SettingsActivity.kt");
    expect(settings).toMatch(/R\.string\.settings_version, BuildConfig\.VERSION_NAME/);
    expect(settings).toMatch(/updater\.manualCheck/);
  });

  test("下載完先驗證再交給系統安裝", () => {
    expect(updater).toMatch(/UpdateCheck\.verifyDownload\(file, release\)/);
  });

  test("manifest：安裝權限＋安裝結果 receiver（不對外）", () => {
    expect(manifest).toMatch(/android\.permission\.REQUEST_INSTALL_PACKAGES/);
    expect(manifest).toMatch(/<receiver\s+android:name="\.UpdateReceiver"\s+android:exported="false">/);
    expect(manifest).toMatch(/android\.intent\.action\.MY_PACKAGE_REPLACED/);
    expect(updater).toMatch(/Intent\(activity, UpdateReceiver::class\.java\)/);
  });
});
