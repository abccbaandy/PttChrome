// 設定索引的欄位型別（type，架構 review A7 第十一步）：索引項記下設定頁用哪種欄位畫它，
// 為「一般列由表 map 出來」鋪路。這裡守兩件事：①設定頁 JSX 實際用的元件跟 type 一致
// ②type 跟預設值的型別對得上（勾選＝布林、數字＝數字、文字類＝字串）。
import fs from "node:fs";
import path from "node:path";
import {
  PREF_SEARCH_ITEMS,
  prefItem,
  prefSectionItems,
  prefShown,
  PREF_SHOWN_IF,
  searchPrefSettings,
  MOBILE_TEXT_KEYS,
  mobileTextKey,
} from "../../src/js/pref_search";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { zh_TW } from "../../src/js/zh_TW_messages";
import { en_US } from "../../src/js/en_US_messages";

const msgOf = (lang, key) =>
  ((lang === "en_us" ? en_US : zh_TW)[key] || {}).message;

const COMPONENT_TYPE = {
  PrefCheckRow: "check",
  PrefCheckbox: "check",
  PrefSelect: "select",
  PrefNumber: "number",
  PrefText: "text",
  PrefTextarea: "textarea",
  PrefHotkey: "hotkey",
};

const prefs = PREF_SEARCH_ITEMS.filter((it) => it.kind === "pref");

/** termSize.cols 這種點號鍵到巢狀預設值裡找。 */
function defaultOf(key) {
  if (key in DEFAULT_PREFS) return DEFAULT_PREFS[key];
  return key
    .split(".")
    .reduce((o, k) => (o == null ? undefined : o[k]), DEFAULT_PREFS);
}

describe("設定索引的欄位型別", () => {
  test("每個設定項都有 type，且是已知的六種之一", () => {
    const known = new Set(Object.values(COMPONENT_TYPE));
    for (const it of prefs)
      expect(known.has(it.type), `${it.key}: ${it.type}`).toBe(true);
  });

  test("設定頁 JSX 用的元件跟索引的 type 一致", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/components/ContextMenu/PrefModal.jsx"),
      "utf8",
    );
    const re = new RegExp(
      `<(${Object.keys(COMPONENT_TYPE).join("|")})\\b([^>]*?)/?>`,
      "gs",
    );
    let checked = 0;
    for (const m of src.matchAll(re)) {
      const name = /\bname="([^"]+)"/.exec(m[2])?.[1];
      if (!name) continue; // 動態 name（快速搜尋內建列、元件定義本身）
      const item = prefItem(name);
      if (!item) continue; // 刻意不進索引者由 pref_search_index.test.js 管
      expect(item.type, `${name} 用 <${m[1]}>`).toBe(COMPONENT_TYPE[m[1]]);
      checked++;
    }
    // 由索引畫出的分區（<PrefIndexRows>）照 type 選元件，不必再比；這裡只比還手寫的格子。
    // 門檻算「手寫＋由索引畫出」：分區陸續改由索引畫出時不用每次調；掃描壞掉才會掉到門檻下。
    const fromIndex = [
      ...src.matchAll(/<PrefIndexRows\s+sectionKey="([^"]+)"/g),
    ].reduce((n, m) => n + prefSectionItems(m[1]).length, 0);
    expect(checked + fromIndex).toBeGreaterThan(140);
  });

  test("索引的 sub（縮排子選項）＝設定頁畫在 .PrefModal__SubOptions 裡的那幾格", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/components/ContextMenu/PrefModal.jsx"),
      "utf8",
    );
    const inJsx = new Set();
    for (const m of src.matchAll(
      /<div className="PrefModal__SubOptions">([\s\S]*?)<\/div>/g,
    ))
      for (const n of m[1].matchAll(/\bname="([^"]+)"/g)) inJsx.add(n[1]);
    // 由索引畫出的分區：sub 本身就是畫進 .PrefModal__SubOptions 的依據（PrefIndexRows），
    // 畫面上真的縮排由 pref_groups.test.jsx「由索引畫出」守。
    for (const m of src.matchAll(/<PrefIndexRows\s+sectionKey="([^"]+)"/g))
      for (const it of prefSectionItems(m[1])) if (it.sub) inJsx.add(it.key);
    const inIndex = new Set(prefs.filter((it) => it.sub).map((it) => it.key));
    expect(inJsx.size).toBeGreaterThan(0);
    expect([...inIndex].sort()).toEqual([...inJsx].sort());
    // 縮排的子選項一定有上層開關（縮排就是在說「它屬於上面那格」）。
    for (const it of prefs.filter((p) => p.sub))
      expect(it.requires, it.key).toBeTruthy();
  });

  test("hintInBox（說明畫在勾選框裡）只用在有說明的勾選列", () => {
    const inBox = prefs.filter((it) => it.hintInBox);
    expect(inBox.length).toBeGreaterThan(0);
    for (const it of inBox) {
      expect(it.type, it.key).toBe("check");
      expect(it.tooltipKey, it.key).toBeTruthy();
    }
  });

  test("shownIf 指到條件表裡的 id，條件看的那一格是同分區、排在前面的下拉選單", () => {
    const withShownIf = prefs.filter((it) => it.shownIf);
    expect(withShownIf.length).toBeGreaterThan(0);
    for (const it of withShownIf) {
      const cond = PREF_SHOWN_IF[it.shownIf];
      expect(cond, it.key).toBeTruthy();
      const ctl = prefItem(cond.key);
      expect(ctl && ctl.type, `${it.key} ← ${cond.key}`).toBe("select");
      expect(ctl.sectionKey, it.key).toBe(it.sectionKey);
      expect(
        PREF_SEARCH_ITEMS.indexOf(ctl) < PREF_SEARCH_ITEMS.indexOf(it),
        it.key,
      ).toBe(true);
    }
  });

  test("prefShown：eq／ne 兩種條件，沒有 shownIf 的一律畫", () => {
    expect(
      prefShown("termSize.cols", { termSizeMode: "fixed-term-size" }),
    ).toBe(true);
    expect(
      prefShown("termSize.cols", { termSizeMode: "fixed-font-size" }),
    ).toBe(false);
    expect(prefShown("fontSize", { termSizeMode: "fixed-font-size" })).toBe(
      true,
    );
    expect(prefShown("mobileHangIndent", { mobileLayout: "auto" })).toBe(true);
    expect(prefShown("mobileHangIndent", { mobileLayout: "off" })).toBe(false);
    expect(prefShown("fontFace", {})).toBe(true);
  });

  test("desktopOnly（P100）：手機版面一律不畫、不進設定搜尋；電腦版照 shownIf", () => {
    const v = { termSizeMode: "fixed-term-size" };
    expect(prefShown("termSize.cols", v, { mobile: true })).toBe(false);
    expect(prefShown("termSizeMode", v, { mobile: true })).toBe(false);
    expect(prefShown("termSize.cols", v, { mobile: false })).toBe(true);
    expect(prefShown("fontFace", v, { mobile: true })).toBe(true);
    const keys = (opts) =>
      searchPrefSettings("終端機大小", {
        lang: "zh_tw",
        limit: 50,
        ...opts,
      }).map((h) => h.key);
    expect(keys({})).toContain("termSizeMode");
    expect(keys({ mobile: true })).not.toContain("termSizeMode");
  });

  test("P96：手機版面的設定搜尋用手機用語、不列滑鼠滾輪那類手機沒有的操作", () => {
    const hits = (q, opts) =>
      searchPrefSettings(q, { lang: "zh_tw", limit: 50, ...opts });
    const keys = (q, opts) => hits(q, opts).map((h) => h.key);
    // 手機叫「系統返回鍵／返回手勢」，結果標題與分頁名都是手機的字。
    const back = hits("系統返回鍵", { mobile: true });
    expect(back.map((h) => h.key)).toContain("mouseBackNav");
    const hit = back.find((h) => h.key === "mouseBackNav");
    expect(hit.title).toBe("系統返回鍵／返回手勢");
    expect(hit.tabLabel).toBe("點擊與返回");
    expect(keys("系統返回鍵", {})).not.toContain("mouseBackNav");
    // 分頁名換了：手機搜「點擊與返回」找得到整個分頁的項目，電腦版沒有這個字。
    expect(keys("點擊與返回", { mobile: true })).toContain("useMouseBrowsing");
    expect(keys("點擊與返回", {})).toEqual([]);
    // 手機沒有滾輪、中鍵、滑鼠停留：不列（分區項也不列，跳過去會撲空）。
    for (const q of ["滑鼠滾輪", "滑鼠中鍵", "滑鼠移動", "平滑捲動"]) {
      const mobileKeys = keys(q, { mobile: true });
      for (const k of [
        "mouseWheel",
        "mouseWheelSmoothScroll",
        "mouseMiddleClick",
        "mouseBrowsingHighlight",
        "section:options_mouseMove",
      ])
        expect(mobileKeys, q).not.toContain(k);
    }
    expect(keys("滑鼠滾輪", {})).toContain("mouseWheel");
    // 「交給 PTT」手機也有作用（serverReport 讓點擊讓位）⇒ 留著，換手機用語。
    expect(keys("把點擊交給 PTT", { mobile: true })).toContain(
      "mouseServerReport",
    );
  });

  test("P96：手機版文字對照表的 key 兩語系都有、跟電腦版不同字", () => {
    for (const [desk, mob] of Object.entries(MOBILE_TEXT_KEYS)) {
      for (const lang of ["zh_tw", "en_us"]) {
        const d = msgOf(lang, desk);
        const m = msgOf(lang, mob);
        expect(d, `${lang} ${desk}`).toBeTruthy();
        expect(m, `${lang} ${mob}`).toBeTruthy();
        expect(m, `${lang} ${mob}`).not.toBe(d);
      }
    }
    expect(mobileTextKey("options_mouse", true)).toBe("options_mouse_mobile");
    expect(mobileTextKey("options_mouse", false)).toBe("options_mouse");
    expect(mobileTextKey("options_general", true)).toBe("options_general");
  });

  test("rows（名單欄最少列數）只用在 textarea，而且每個 textarea 都有", () => {
    for (const it of prefs) {
      if (it.type === "textarea") expect(it.rows, it.key).toBeGreaterThan(0);
      else expect(it.rows, it.key).toBeUndefined();
    }
  });

  test("type 跟預設值的型別對得上", () => {
    const expected = {
      check: ["boolean"],
      number: ["number"],
      text: ["string"],
      textarea: ["string"],
      hotkey: ["string"],
      select: ["string", "number"],
    };
    for (const it of prefs) {
      const d = defaultOf(it.key);
      if (d === undefined) continue; // 不存預設值的（例如密碼只存在瀏覽器密碼管理員）
      expect(
        expected[it.type],
        `${it.key}（${it.type}）預設值 ${JSON.stringify(d)}`,
      ).toContain(typeof d);
    }
  });
});
