// Bug 回報範本（.github/ISSUE_TEMPLATE/bug_report.yml）裡的教學照著 UI 字樣寫
// （去哪複製 build 資訊、怎麼開錄製）。UI 改名時範本不會跟著紅 ⇒ 回報者照著找不到按鈕。
// 這裡鎖住：範本引用的每個字樣都仍是現行 UI 的文字，且範本本身是合法的 issue form。
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { zh_TW as zh } from "../../src/js/zh_TW_messages";
import { debugRecordFileName } from "../../src/js/debug_record_control";

const ROOT = path.join(__dirname, "..", "..");
const RAW = fs.readFileSync(path.join(ROOT, ".github", "ISSUE_TEMPLATE", "bug_report.yml"), "utf8");
const FORM = parse(RAW);
// 範本裡巢狀引號寫成『』，UI 原文是「」。
const TEXT = RAW.replace(/『/g, "「").replace(/』/g, "」");
const PREF_MODAL = fs.readFileSync(
  path.join(ROOT, "src", "components", "ContextMenu", "PrefModal.jsx"),
  "utf8",
);
const ANDROID_STRINGS = fs.readFileSync(
  path.join(ROOT, "android", "app", "src", "main", "res", "values", "strings.xml"),
  "utf8",
);

const msg = (key) => {
  const m = zh[key] && zh[key].message;
  if (!m) throw new Error(`zh_TW_messages 沒有 ${key}`);
  return m;
};

describe("bug issue template", () => {
  test("是合法的 issue form：必要頂層欄位、id 不重複", () => {
    expect(FORM.name).toBeTruthy();
    expect(FORM.description).toBeTruthy();
    expect(Array.isArray(FORM.body)).toBe(true);
    const ids = FORM.body.filter((b) => b.id).map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of FORM.body) {
      expect(["markdown", "input", "textarea", "dropdown", "checkboxes"]).toContain(b.type);
      if (b.type !== "markdown") expect(b.attributes.label).toBeTruthy();
    }
  });

  test.each([
    "menu_settings",
    "options_about",
    "about_version_title",
    "options_debugMode_title",
    "options_debugMode",
    "options_bgDebugRecord",
    "debugRecord_start",
    "debugRecord_stop",
    "debugRecord_save",
    "mobileToolbar_more",
    "mobileMore_sectionDebug",
    "options_mobileFloatToolsInMore",
    "options_connection",
  ])("引用的 UI 字樣仍存在：%s", (key) => {
    expect(TEXT).toContain(msg(key));
  });

  test("「App 設定」鈕與 App 版本的字樣仍存在", () => {
    expect(Object.values(zh).some((v) => v && v.message === "App 設定")).toBe(true);
    expect(TEXT).toContain("App 設定");
    expect(ANDROID_STRINGS).toMatch(/<string name="settings_version">App 版本：%1\$s<\/string>/);
    expect(ANDROID_STRINGS).toMatch(/<string name="settings_about">關於<\/string>/);
  });

  test("「版本」區塊最後一行仍是 build 資訊", () => {
    expect(PREF_MODAL).toMatch(/build: <code>\{process\.env\.GIT_COMMIT\}<\/code>/);
    expect(TEXT).toContain("build:");
  });

  test("錄製檔檔名格式與錄製器一致", () => {
    expect(debugRecordFileName(new Date(2026, 0, 2, 3, 4, 5))).toMatch(/^ptt-debug-/);
    expect(TEXT).toContain("ptt-debug-");
  });
});
