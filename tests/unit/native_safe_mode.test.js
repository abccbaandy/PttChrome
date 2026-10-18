// 安全模式「全部用原生」（pref nativeSafeMode）：讀取端把會改寫畫面／替使用者送鍵／
// 攔鍵的功能全部當成關，各自的 pref 不動。
//
// 兩件事要守：
//   1. effectivePrefs 的行為（蓋成 false、不動原物件、不寫回 localStorage）。
//   2. 功能判斷的讀取點**全部**走 effectivePrefs —— 漏一處就是「開了安全模式，某個
//      功能還在替使用者按鍵」，畫面上看不出來。靜態掃描 src 守這條。
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PREFS,
  NATIVE_SAFE_MODE_KEYS,
  effectivePrefs,
  readEffectivePrefs,
  readValuesWithDefault,
} from "../../src/js/pref_storage";

describe("effectivePrefs", () => {
  test("預設關，DEFAULT_PREFS 原樣通過", () => {
    expect(DEFAULT_PREFS.nativeSafeMode).toBe(false);
    expect(effectivePrefs({ ...DEFAULT_PREFS })).toEqual(DEFAULT_PREFS);
  });

  test("開著 ⇒ 名單內全部變 false，其他 key 不動", () => {
    const raw = { ...DEFAULT_PREFS, nativeSafeMode: true, blacklist: "abc" };
    const eff = effectivePrefs(raw);
    for (const key of NATIVE_SAFE_MODE_KEYS) expect(eff[key]).toBe(false);
    expect(eff.blacklist).toBe("abc");
    expect(eff.autoLogin).toBe(DEFAULT_PREFS.autoLogin);
    expect(eff.useMouseBrowsing).toBe(DEFAULT_PREFS.useMouseBrowsing);
  });

  test("不改傳入的物件（關掉安全模式要回到原本的設定）", () => {
    const raw = { ...DEFAULT_PREFS, nativeSafeMode: true };
    effectivePrefs(raw);
    for (const key of NATIVE_SAFE_MODE_KEYS) expect(raw[key]).toBe(DEFAULT_PREFS[key]);
  });

  test("名單裡每個 key 都是真的 pref，而且預設是開的布林值", () => {
    for (const key of NATIVE_SAFE_MODE_KEYS) expect(DEFAULT_PREFS[key]).toBe(true);
  });

  describe("readEffectivePrefs", () => {
    afterEach(() => vi.unstubAllGlobals());

    test("讀的是生效值、不寫 localStorage", () => {
      const setItem = vi.fn();
      vi.stubGlobal("window", {
        localStorage: {
          getItem: () =>
            JSON.stringify({ values: { nativeSafeMode: true, enableEasyReading: true } }),
          setItem,
        },
      });
      expect(readEffectivePrefs().enableEasyReading).toBe(false);
      expect(readValuesWithDefault().enableEasyReading).toBe(true);
      expect(setItem).not.toHaveBeenCalled();
    });
  });
});

describe("讀取點都經過安全模式（靜態掃描）", () => {
  const SRC = path.join(process.cwd(), "src");
  const files = fs
    .readdirSync(SRC, { recursive: true })
    .filter((f) => /\.(js|jsx)$/.test(f))
    .map((f) => ({ rel: f.split(path.sep).join("/"), text: fs.readFileSync(path.join(SRC, f), "utf8") }));
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const keyAccess = new RegExp(`\\.(${NATIVE_SAFE_MODE_KEYS.join("|")})\\b`);

  // 這兩個檔讀原始值是對的：
  //   pref_storage.js  定義本身
  //   PrefModal.jsx    設定頁要顯示、編輯使用者存的值（被蓋掉的項目另外 disabled）
  // pttchrome.jsx 的 readValuesWithDefault 只拿連線設定；名單內的 key 由
  // onValuesPrefChange 先過 effectivePrefs 再分派（下一條測試守）。
  const RAW_OK = new Set([
    "js/pref_storage.js",
    "components/ContextMenu/PrefModal.jsx",
    "js/pttchrome.jsx",
  ]);

  test("讀名單內 key 的檔案不可用 readValuesWithDefault", () => {
    const bad = files
      .filter(({ rel }) => !RAW_OK.has(rel))
      .filter(({ text }) => {
        const code = stripComments(text);
        return keyAccess.test(code) && /readValuesWithDefault\s*\(/.test(code);
      })
      .map(({ rel }) => rel);
    expect(bad).toEqual([]);
  });

  test("不可把整包原始偏好丟給判斷函式（prefs: readValuesWithDefault() 這種）", () => {
    const bad = files
      .filter(({ rel }) => rel !== "components/ContextMenu/PrefModal.jsx" && rel !== "js/pref_storage.js")
      .filter(({ text }) =>
        /[(,:]\s*readValuesWithDefault\(\)\s*[,)}]/.test(stripComments(text)),
      )
      .map(({ rel }) => rel);
    expect(bad).toEqual([]);
  });

  test("App.onValuesPrefChange 先過 effectivePrefs 再逐 key 分派", () => {
    const app = files.find(({ rel }) => rel === "js/pttchrome.jsx").text;
    const body = app.slice(app.indexOf("App.prototype.onValuesPrefChange"));
    const head = body.slice(0, body.indexOf("this.onPrefChange("));
    expect(head).toMatch(/effectivePrefs\(/);
  });
});
