// 設定備份（匯出／匯入檔案）的純邏輯。最重要的一條是回歸守護：**匯出檔永遠不得
// 出現 PTT 帳號、密碼與 2FA 金鑰**——備份檔是純文字，比雲端 doc 更容易外流。
import {
  buildExportPayload,
  parseImportPayload,
  mergeImportedPrefs,
  backupFileName,
  BACKUP_SCHEMA_VERSION,
} from "../../src/js/pref_backup";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";

const withCredentials = (extra) => ({
  ...DEFAULT_PREFS,
  autoLogin: true,
  autoLoginUser: "someuser",
  autoLoginPassword: "s3cret",
  autoLoginOtpSecret: "JBSWY3DPEHPK3PXP",
  enableWorkMode: true,
  ...extra,
});

describe("buildExportPayload", () => {
  test("憑證與本機專屬設定一律不進匯出檔（即使值非空）", () => {
    const payload = buildExportPayload(withCredentials());
    expect(payload.prefs).not.toHaveProperty("autoLoginUser");
    expect(payload.prefs).not.toHaveProperty("autoLoginPassword");
    expect(payload.prefs).not.toHaveProperty("autoLoginOtpSecret");
    expect(payload.prefs).not.toHaveProperty("enableWorkMode");
    // 連序列化後的字串裡都不該找得到密碼／金鑰。
    const json = JSON.stringify(payload);
    expect(json).not.toContain("s3cret");
    expect(json).not.toContain("someuser");
    expect(json).not.toContain("JBSWY3DPEHPK3PXP");
  });

  test("autoLogin 開關本身（非機密）照樣匯出", () => {
    expect(buildExportPayload(withCredentials()).prefs.autoLogin).toBe(true);
  });

  test("信封帶得出 app/kind/schemaVersion/exportedAt", () => {
    const now = new Date("2026-08-14T01:02:03.000Z");
    const payload = buildExportPayload(DEFAULT_PREFS, now);
    expect(payload.app).toBe("pttchrome");
    expect(payload.kind).toBe("prefs");
    expect(payload.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(payload.exportedAt).toBe("2026-08-14T01:02:03.000Z");
  });

  test("不動到傳入的 values（不可就地刪 key）", () => {
    const values = withCredentials();
    buildExportPayload(values);
    expect(values.autoLoginPassword).toBe("s3cret");
  });
});

describe("parseImportPayload：拒收", () => {
  test("壞掉的 JSON → badJson", () => {
    expect(parseImportPayload("{not json")).toEqual({
      ok: false,
      reason: "badJson",
    });
  });

  test.each([
    ["陣列", "[1,2,3]"],
    ["字串", '"hello"'],
    ["null", "null"],
    ["沒有 prefs/values 信封", '{"foo":1}'],
    ["prefs 是空物件", '{"prefs":{}}'],
    ["整份都是不認得的 key", '{"prefs":{"nope":1,"alsoNope":2}}'],
  ])("%s → badFormat", (_name, text) => {
    expect(parseImportPayload(text)).toEqual({
      ok: false,
      reason: "badFormat",
    });
  });
});

describe("parseImportPayload：過濾", () => {
  test("不認得的 key 丟棄，認得的保留", () => {
    const res = parseImportPayload(
      JSON.stringify({ prefs: { fontSize: 24, __proto__evil: 1, nope: true } }),
    );
    expect(res).toEqual({ ok: true, prefs: { fontSize: 24 } });
  });

  test("型別與 DEFAULT_PREFS 不符的 key 丟棄", () => {
    const res = parseImportPayload(
      JSON.stringify({
        prefs: {
          fontSize: "big", // number ← string
          lineWrap: 78,
          blacklist: 123, // string ← number
          quickSearchDisabled: "nope", // array ← string
          enablePicPreview: "yes", // boolean ← string
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.prefs).toEqual({ lineWrap: 78 });
  });

  test("termSize 缺欄位或非數字 → 整個丟掉（半套尺寸會算錯版面）", () => {
    const bad = parseImportPayload(
      JSON.stringify({ prefs: { termSize: { cols: 80 }, lineWrap: 78 } }),
    );
    expect(bad.prefs).toEqual({ lineWrap: 78 });

    const good = parseImportPayload(
      JSON.stringify({ prefs: { termSize: { cols: 80, rows: 24 } } }),
    );
    expect(good.prefs).toEqual({ termSize: { cols: 80, rows: 24 } });
  });

  test("手改檔案硬塞憑證進來也不吃", () => {
    const res = parseImportPayload(
      JSON.stringify({
        prefs: {
          fontSize: 24,
          autoLoginUser: "evil",
          autoLoginPassword: "evil",
          autoLoginOtpSecret: "EVIL",
          enableWorkMode: true,
        },
      }),
    );
    expect(res).toEqual({ ok: true, prefs: { fontSize: 24 } });
  });

  test("localStorage 原始格式 { values } 也吃得下", () => {
    const res = parseImportPayload(
      JSON.stringify({ values: { fontSize: 18 } }),
    );
    expect(res).toEqual({ ok: true, prefs: { fontSize: 18 } });
  });

  test("陣列型 pref 原樣保留", () => {
    const custom = [
      {
        id: "a",
        name: "n",
        urlTemplate: "https://x/%s",
        match: "any",
        enabled: true,
      },
    ];
    const res = parseImportPayload(
      JSON.stringify({ prefs: { quickSearchCustom: custom } }),
    );
    expect(res.prefs.quickSearchCustom).toEqual(custom);
  });
});

describe("mergeImportedPrefs", () => {
  test("備份檔沒提到的 key 回預設值，不是保留本機現值", () => {
    const local = { ...DEFAULT_PREFS, fontSize: 26, lineWrap: 99 };
    const merged = mergeImportedPrefs(DEFAULT_PREFS, local, { lineWrap: 60 });
    expect(merged.lineWrap).toBe(60);
    // 同一個備份檔在任何機器上都該還原出同一組設定 ⇒ fontSize 不能沿用本機的 26。
    expect(merged.fontSize).toBe(DEFAULT_PREFS.fontSize);
  });

  test("憑證與上班模式一律保留本機現值（匯入檔本來就不會帶）", () => {
    const local = withCredentials();
    const merged = mergeImportedPrefs(DEFAULT_PREFS, local, { fontSize: 26 });
    expect(merged.autoLoginUser).toBe("someuser");
    expect(merged.autoLoginPassword).toBe("s3cret");
    expect(merged.autoLoginOtpSecret).toBe("JBSWY3DPEHPK3PXP");
    expect(merged.enableWorkMode).toBe(true);
  });

  test("本機沒有值時 local-only 也回預設（不留 undefined）", () => {
    const merged = mergeImportedPrefs(DEFAULT_PREFS, {}, { fontSize: 26 });
    expect(merged.autoLoginPassword).toBe(DEFAULT_PREFS.autoLoginPassword);
    expect(merged.enableWorkMode).toBe(DEFAULT_PREFS.enableWorkMode);
  });

  test("每個 DEFAULT_PREFS 的 key 都有值（不會漏 key 讓渲染層拿到 undefined）", () => {
    const merged = mergeImportedPrefs(DEFAULT_PREFS, {}, {});
    for (const key of Object.keys(DEFAULT_PREFS)) {
      expect(merged[key]).toBeDefined();
    }
  });
});

describe("往返", () => {
  test("匯出 → 匯入 → 合併 = 原值（憑證與本機專屬設定取本機現值）", () => {
    const local = withCredentials({
      fontSize: 26,
      lineWrap: 60,
      blacklist: "someid",
      termSize: { cols: 120, rows: 40 },
      quickSearchDisabled: ["google"],
    });
    const parsed = parseImportPayload(
      JSON.stringify(buildExportPayload(local)),
    );
    expect(parsed.ok).toBe(true);
    expect(mergeImportedPrefs(DEFAULT_PREFS, local, parsed.prefs)).toEqual(
      local,
    );
  });
});

describe("backupFileName", () => {
  test("固定前綴＋零補位的日期時間戳", () => {
    expect(backupFileName(new Date(2026, 7, 4, 5, 6, 7))).toBe(
      "pttchrome-prefs-20260804-050607.json",
    );
  });
});
