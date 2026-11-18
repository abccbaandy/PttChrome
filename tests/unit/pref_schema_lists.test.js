// 設定的各份清單對得起來（架構 review A7：設定 schema 單一來源的前置守護）。
//
// 同一個設定鍵現在散在四個地方：
//   - pref_storage.js#DEFAULT_PREFS        預設值（決定這個鍵存不存在）
//   - pref_search.js#PREF_SEARCH_ITEMS     設定索引（設定頁怎麼畫、搜尋、型別、前置開關）
//   - pref_storage.js#NATIVE_SAFE_MODE_KEYS 安全模式要蓋成關的功能
//   - pref_sync_logic.js#LOCAL_ONLY_PREF_KEYS 只存本機、不上雲、不進備份
// 四份手動維護，漏一份不會有任何東西壞掉：預設值有但索引沒有 ⇒ 設定頁沒有那一格；
// 安全模式名單打錯字 ⇒ 安全模式靜默少關一個會送鍵的功能；本機專屬名單打錯字 ⇒
// 憑證上雲。這支測試把「對得起來」變成會紅的規則，之後才能放心併成一張表。
import {
  PREF_SEARCH_ITEMS,
  PREF_DEFAULTS_NOT_INDEXED,
} from "../../src/js/pref_search";
import {
  DEFAULT_PREFS,
  NATIVE_SAFE_MODE_KEYS,
} from "../../src/js/pref_storage";
import { LOCAL_ONLY_PREF_KEYS } from "../../src/js/pref_sync_logic";
import fs from "fs";
import path from "path";

const prefItems = PREF_SEARCH_ITEMS.filter((it) => it.kind === "pref");
const sectionKeys = new Set(
  PREF_SEARCH_ITEMS.filter((it) => it.kind === "section").map(
    (it) => it.sectionKey,
  ),
);
// termSize.cols 這種點號鍵算在頂層鍵 termSize 底下。
const topKey = (key) => key.split(".")[0];
const indexedTop = new Set(prefItems.map((it) => topKey(it.key)));
const itemByKey = new Map(prefItems.map((it) => [it.key, it]));

const dupes = (list) => list.filter((k, i) => list.indexOf(k) !== i);

describe("預設值 ↔ 設定索引", () => {
  test("每個預設值都有索引項，不然就要寫明為什麼沒有", () => {
    const missing = Object.keys(DEFAULT_PREFS).filter(
      (k) => !indexedTop.has(k) && !(k in PREF_DEFAULTS_NOT_INDEXED),
    );
    expect(missing).toEqual([]);
  });

  test("「刻意不進索引」名單沒有腐爛：鍵還存在、也真的沒有索引項", () => {
    for (const key of Object.keys(PREF_DEFAULTS_NOT_INDEXED)) {
      expect(key in DEFAULT_PREFS, `${key} 已不在 DEFAULT_PREFS`).toBe(true);
      expect(indexedTop.has(key), `${key} 已經有索引項，從名單拿掉`).toBe(
        false,
      );
    }
  });

  test("理由裡說「由 section:… 代表」的分區真的存在", () => {
    for (const [key, why] of Object.entries(PREF_DEFAULTS_NOT_INDEXED)) {
      for (const m of why.matchAll(/section:(\w+)/g))
        expect(sectionKeys.has(m[1]), `${key} → ${m[1]}`).toBe(true);
    }
  });

  test("每個索引項（ui:… 除外）都找得到預設值", () => {
    const orphan = prefItems
      .filter((it) => !it.key.startsWith("ui:"))
      .filter(
        (it) =>
          it.key
            .split(".")
            .reduce((o, k) => (o == null ? undefined : o[k]), DEFAULT_PREFS) ===
          undefined,
      )
      .map((it) => it.key);
    expect(orphan).toEqual([]);
  });
});

// 第五個地方：套用端。App.onValuesPrefChange 把每個頂層鍵丟進 onPrefChange 的 switch；
// case 名打錯字不會有任何東西壞掉，只是那個設定改了要重整才生效（或永遠不生效）。
// 沒有 case 的鍵是「用到時才讀」（讀 prefs.values），那它至少要在程式某處被讀到。
describe("套用端（App.onPrefChange）↔ 預設值", () => {
  const SRC = path.resolve(__dirname, "../../src");
  const appSrc = fs.readFileSync(path.join(SRC, "js/pttchrome.jsx"), "utf8");
  const start = appSrc.indexOf("App.prototype.onPrefChange = function");
  const body = appSrc.slice(start, appSrc.indexOf("\n};", start));
  const cases = [...body.matchAll(/case\s+['"]([\w.]+)['"]\s*:/g)].map(
    (m) => m[1],
  );

  test("找得到 onPrefChange 的 switch", () => {
    expect(start).toBeGreaterThan(0);
    expect(cases.length).toBeGreaterThan(20);
  });

  test("每個 case 都是預設值裡的鍵（打錯字或鍵已刪的 case 永遠不會跑）", () => {
    expect(cases.filter((k) => !(k in DEFAULT_PREFS))).toEqual([]);
  });

  test("沒有 case 的鍵在定義它的模組以外至少被讀一次", () => {
    // 設定的定義／索引／文案檔不算「讀」。
    const defining =
      /(pref_storage|pref_schema|pref_search|pref_sync_logic|_messages)\.jsx?$/;
    const sources = [];
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.jsx?$/.test(f.name) && !defining.test(f.name))
          sources.push(fs.readFileSync(p, "utf8"));
      }
    };
    walk(SRC);
    const unread = Object.keys(DEFAULT_PREFS)
      .filter((k) => !cases.includes(k))
      .filter((k) => {
        const re = new RegExp(`\\b${k}\\b`);
        return !sources.some((s) => re.test(s));
      });
    expect(unread).toEqual([]);
  });
});

describe("安全模式名單", () => {
  test("沒有重複", () => {
    expect(dupes([...NATIVE_SAFE_MODE_KEYS])).toEqual([]);
  });

  test.each([...NATIVE_SAFE_MODE_KEYS])(
    "%s 是預設值裡的布林開關，設定頁有它的勾選格",
    (key) => {
      // effectivePrefs 把名單裡的鍵蓋成 false：不是布林就蓋錯型別；打錯字就什麼都沒蓋到。
      expect(typeof DEFAULT_PREFS[key]).toBe("boolean");
      expect(itemByKey.get(key)?.type).toBe("check");
    },
  );
});

describe("本機專屬名單（不上雲、不進備份）", () => {
  test("沒有重複", () => {
    expect(dupes(LOCAL_ONLY_PREF_KEYS)).toEqual([]);
  });

  test.each(LOCAL_ONLY_PREF_KEYS)("%s 是預設值裡的鍵，設定頁有它", (key) => {
    // 打錯字 ⇒ sanitizeForCloud 刪不到真正的鍵 ⇒ 照樣上雲。
    expect(key in DEFAULT_PREFS).toBe(true);
    expect(itemByKey.has(key)).toBe(true);
  });

  test("索引標成憑證的欄位一定在本機專屬名單裡", () => {
    const creds = prefItems.filter((it) => it.credential).map((it) => it.key);
    expect(creds.length).toBeGreaterThan(0);
    for (const key of creds) expect(LOCAL_ONLY_PREF_KEYS).toContain(key);
  });

  test("本機專屬的設定不在安全模式名單（兩者互不相干，同時出現代表放錯名單）", () => {
    for (const key of LOCAL_ONLY_PREF_KEYS)
      expect(NATIVE_SAFE_MODE_KEYS).not.toContain(key);
  });
});
