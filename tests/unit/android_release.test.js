// scripts/android-release.mjs（APK 自動發版的版號與 release note）＋ android.yml 的發版契約。
// 設計見 docs/android-app.md「發佈」。import 本身也是守門：只有直接執行才呼叫 git。
import fs from "fs";
import path from "path";
import {
  parseVersion,
  latestReleaseTag,
  classifyCommit,
  nextVersion,
  buildReleaseNotes,
  parseGitLog,
  planRelease,
  INSTALL_SECTION,
} from "../../scripts/android-release.mjs";

const ROOT = path.resolve(__dirname, "../..");

describe("版號", () => {
  test("只認 android-vX.Y.Z，取最大的（不是字串排序）", () => {
    expect(parseVersion("android-v1.10.0")).toEqual([1, 10, 0]);
    expect(parseVersion("android-v1.2.0-test")).toBeNull();
    expect(parseVersion("v1.2.0")).toBeNull();
    expect(latestReleaseTag(["android-v1.9.0", "android-v1.10.0", "android-v2.0.0-rc"]).tag).toBe("android-v1.10.0");
    expect(latestReleaseTag([])).toBeNull();
  });

  test("有新功能 ⇒ minor+1；只有修正 ⇒ patch+1；沒有 tag ⇒ 1.0.0", () => {
    expect(nextVersion([1, 1, 3], [{ kind: "fix" }, { kind: "feature" }])).toEqual([1, 2, 0]);
    expect(nextVersion([1, 1, 3], [{ kind: "fix" }, { kind: null }])).toEqual([1, 1, 4]);
    expect(nextVersion([1, 1, 3], [])).toEqual([1, 1, 4]);
    expect(nextVersion(null, [{ kind: "feature" }])).toEqual([1, 0, 0]);
  });
});

describe("classifyCommit：commit → 給使用者看的一條", () => {
  test("拿掉 type(scope): 前綴，feat／fix 分組", () => {
    expect(classifyCommit({ subject: "feat(APK): 收到水球跳系統通知" })).toEqual({ kind: "feature", text: "收到水球跳系統通知" });
    expect(classifyCommit({ subject: "fix(android)!: 開啟雙指縮放" })).toEqual({ kind: "fix", text: "開啟雙指縮放" });
    expect(classifyCommit({ subject: "perf: 冷啟動變快" }).kind).toBe("fix");
  });

  test("內部改動不列；沒照格式的標題當修正", () => {
    for (const subject of ["chore(android): 升 AGP", "test(android): 補 JVM test", "build(deps): bump okhttp", "refactor: 拆檔", "ci: 調 workflow"]) {
      expect(classifyCommit({ subject }).kind).toBeNull();
    }
    expect(classifyCommit({ subject: "修好通知不響" })).toEqual({ kind: "fix", text: "修好通知不響" });
  });

  test("Release-Note: 取代標題；Release-Note: - 不列", () => {
    const body = "技術細節\n\nRelease-Note: 從 LINE 點 PTT 文章連結會直接在 App 開啟\nCo-Authored-By: x";
    expect(classifyCommit({ subject: "feat(android): deep link sentinel", body })).toEqual({
      kind: "feature",
      text: "從 LINE 點 PTT 文章連結會直接在 App 開啟",
    });
    expect(classifyCommit({ subject: "feat(android): debug APK 並存", body: "release-note: -" }).kind).toBeNull();
    expect(classifyCommit({ subject: "chore(android): 升 WebView 套件", body: "Release-Note: 修正部分手機開不起來" })).toEqual({
      kind: "fix",
      text: "修正部分手機開不起來",
    });
  });
});

describe("release note", () => {
  test("分組、去重、附安裝說明；不再指向 docs", () => {
    const notes = buildReleaseNotes([
      { kind: "feature", text: "A" },
      { kind: "fix", text: "B" },
      { kind: "feature", text: "A" },
      { kind: null, text: "內部" },
    ]);
    expect(notes).toContain("## 新功能\n- A\n\n## 修正與改進\n- B\n");
    expect(notes.match(/- A/g)).toHaveLength(1);
    expect(notes).not.toContain("內部");
    expect(notes).toContain(INSTALL_SECTION);
    expect(notes).not.toMatch(/docs\//);
  });

  test("全是內部改動 ⇒ 明講用起來沒差別", () => {
    expect(buildReleaseNotes([{ kind: null, text: "x" }])).toMatch(/^這一版是內部維護更新/);
  });
});

describe("planRelease", () => {
  const log = "feat(APK): 收到水球跳系統通知\x1fbody\n\x1e\nfix(android): 雙指縮放\x1f\x1e\n";

  test("parseGitLog 拆出 subject／body", () => {
    expect(parseGitLog(log)).toEqual([
      { subject: "feat(APK): 收到水球跳系統通知", body: "body\n" },
      { subject: "fix(android): 雙指縮放", body: "" },
    ]);
  });

  test("有新 commit ⇒ 發版，條列舊的在前", () => {
    const plan = planRelease({ tags: ["android-v1.0.0", "android-v1.1.0"], commits: parseGitLog(log) });
    expect(plan).toMatchObject({ release: true, version: "1.2.0", tag: "android-v1.2.0", previousTag: "android-v1.1.0" });
    expect(plan.notes.indexOf("收到水球")).toBeGreaterThan(-1);
  });

  test("沒有新 commit ⇒ 不發；--force 才發（patch+1）", () => {
    expect(planRelease({ tags: ["android-v1.1.0"], commits: [] }).release).toBe(false);
    expect(planRelease({ tags: ["android-v1.1.0"], commits: [], force: true })).toMatchObject({ release: true, version: "1.1.1" });
  });
});

describe("android.yml 發版契約", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github/workflows/android.yml"), "utf8");

  test("完整歷史（要看到上一個 tag）且同分支排隊", () => {
    expect(yml).toMatch(/fetch-depth:\s*0/);
    expect(yml).toMatch(/cancel-in-progress:\s*false/);
  });

  test("release note 來自腳本，不寫死", () => {
    expect(yml).toContain("scripts/android-release.mjs");
    expect(yml).toContain("--notes-file");
    expect(yml).not.toMatch(/--notes "/);
  });

  test("PR 不發版", () => {
    expect(yml).toMatch(/Plan release[\s\S]*?if: github\.ref == 'refs\/heads\/dev' && github\.event_name != 'pull_request'/);
    expect(yml).toMatch(/Publish release[\s\S]*?if: steps\.plan\.outputs\.release == 'true'/);
  });
});
