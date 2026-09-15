// 設定搜尋索引的靜態守護。
//
// src/js/pref_search.js 的 PREF_SEARCH_ITEMS 是**手動維護的第二份事實**：
// PrefModal.jsx 是純 hardcode JSX、沒有 schema 可反射。漏收一個設定項不會讓
// 任何東西壞掉——畫面一切正常，只是那一項**永遠搜不到**。這種靜默失效只有
// 靜態掃描擋得住，所以這裡直接讀 PrefModal.jsx 的原始碼比對。
//
// 做法沿用 tests/unit/e2e_login_budget.test.js：純 fs 讀檔、不渲染、不連網。
import fs from "fs";
import path from "path";
import {
  PREF_SEARCH_ITEMS,
  PREF_SEARCH_EXEMPT_NAMES,
  PREF_SEARCH_TABS,
} from "../../src/js/pref_search";
import { zh_TW as zh } from "../../src/js/zh_TW_messages";
import { en_US as en } from "../../src/js/en_US_messages";

const SRC_PATH = path.join(
  __dirname,
  "..",
  "..",
  "src",
  "components",
  "ContextMenu",
  "PrefModal.jsx",
);

// 只掃**程式碼**：PrefModal.jsx 的註解本來就在談這些 pref 名字與 legend
// （那正是它們存在的說明），連註解一起掃會被自己的文件誤判。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const SRC = stripComments(fs.readFileSync(SRC_PATH, "utf8"));

const matchAll = (re) => [...SRC.matchAll(re)].map((m) => m[1]);

// name="foo" 與 name={`quickSearchBuiltin-${b.id}`} 兩種寫法。
const staticNames = matchAll(/\bname="([^"]+)"/g);
const templateNames = matchAll(/\bname=\{`([^`$]*)\$\{/g);
// 分區一律走 <PrefSection legendKey="…">（adapter 負責 fieldset/legend 與錨點）。
const legendKeys = matchAll(/<PrefSection\s+legendKey="([^"]+)"/g);
// 沒有 name 的可操作項走 <PrefAnchor anchorKey="ui:…">。
const anchorKeys = matchAll(/<PrefAnchor\s+anchorKey="([^"]+)"/g);
// 非 checkbox 的輸入元件（TextInput/NumberInput/Select/Textarea/Switch）走
// {...anchor("…")}。PrefCheckbox 則由 adapter 自動掛，不需要寫在這裡。
const spreadAnchors = matchAll(/\{\.\.\.anchor\("([^"]+)"\)\}/g);
// PrefCheckbox 的 name＝它的錨點 key（adapter 內 anchorFor(name, …)）。
const checkboxNames = [...SRC.matchAll(/<PrefCheckbox\b[^>]*?\bname="([^"]+)"/g)].map(
  (m) => m[1],
);
const panelTabs = matchAll(/<Tabs\.Panel\s+value="([^"]+)"/g);

const indexedPrefKeys = new Set(
  PREF_SEARCH_ITEMS.filter((it) => it.kind === "pref").map((it) => it.key),
);
const exemptKeys = Object.keys(PREF_SEARCH_EXEMPT_NAMES);

describe("設定搜尋索引 ↔ PrefModal.jsx", () => {
  test("抽得到東西（掃描本身沒壞掉）", () => {
    expect(staticNames.length).toBeGreaterThan(50);
    expect(legendKeys.length).toBeGreaterThan(20);
    expect(panelTabs.length).toBe(10);
  });

  test("每個 name= 的設定項都在索引或豁免名單裡", () => {
    const missing = [...new Set([...staticNames, ...templateNames])].filter(
      (n) => !indexedPrefKeys.has(n) && !exemptKeys.includes(n),
    );
    // 訊息直接列出漏掉的名字：這條紅掉時通常是「剛加了新設定項」，要知道加哪個。
    expect(`未進索引: ${missing.join(", ")}`).toBe("未進索引: ");
  });

  test("索引裡的 pref key 都真的存在於 PrefModal.jsx", () => {
    const stale = [...indexedPrefKeys].filter(
      (k) => !staticNames.includes(k) && !templateNames.includes(k),
    );
    expect(`索引有但畫面沒有: ${stale.join(", ")}`).toBe("索引有但畫面沒有: ");
  });

  test("豁免名單不腐爛（每個名字都還在原始碼裡）", () => {
    const gone = exemptKeys.filter(
      (k) => !staticNames.includes(k) && !templateNames.includes(k),
    );
    expect(`豁免名單已失效: ${gone.join(", ")}`).toBe("豁免名單已失效: ");
  });

  test("每個 tab 都是真實存在的 Tabs.Panel", () => {
    const tabs = new Set(panelTabs);
    PREF_SEARCH_ITEMS.forEach((it) => {
      expect(tabs.has(it.tab)).toBe(true);
    });
    // 分頁對照表也要完整，否則搜尋結果的分頁名會是空字串。
    expect(Object.keys(PREF_SEARCH_TABS).sort()).toEqual([...tabs].sort());
  });

  test("每個 legend 都有對應的 section 項或已被刻意併入", () => {
    const sections = new Set(
      PREF_SEARCH_ITEMS.filter((it) => it.kind === "section").map(
        (it) => it.sectionKey,
      ),
    );
    // 沒有獨立 section 項的 legend，必須是「legend 與分頁名同字」或「legend 與
    // 區內某個項目的標題同字」——這兩種情形做出來就是重複的廢結果。
    const titleKeysBySection = {};
    PREF_SEARCH_ITEMS.forEach((it) => {
      (titleKeysBySection[it.sectionKey] ||= []).push(it.titleKey);
    });
    const tabTitleKeys = new Set(Object.values(PREF_SEARCH_TABS));

    const unexplained = legendKeys.filter(
      (k) =>
        !sections.has(k) &&
        !tabTitleKeys.has(k) &&
        !(titleKeysBySection[k] || []).includes(k),
    );
    expect(`legend 沒進索引: ${unexplained.join(", ")}`).toBe(
      "legend 沒進索引: ",
    );
  });

  test("key 不重複", () => {
    const keys = PREF_SEARCH_ITEMS.map((it) => it.key);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(`重複的 key: ${dupes.join(", ")}`).toBe("重複的 key: ");
  });

  test("非 pref 項目的 key 一律帶前綴（永不與 pref key 撞名）", () => {
    PREF_SEARCH_ITEMS.filter((it) => it.kind !== "pref").forEach((it) => {
      expect(it.key).toMatch(/^(ui|section):/);
    });
  });

  // 這條是「搜到了卻跳不過去」的守護：索引有、畫面上卻沒有對應錨點的話，點下去
  // 會切到分頁但什麼都不會發生（querySelector 回 null，靜默無效）。
  test("索引裡每一項在畫面上都有錨點", () => {
    const rendered = new Set([
      ...legendKeys.map((k) => `section:${k}`),
      ...anchorKeys,
      ...spreadAnchors,
      ...checkboxNames,
    ]);
    const missing = PREF_SEARCH_ITEMS.filter(
      (it) => !rendered.has(it.key),
    ).map((it) => it.key);
    expect(`缺錨點: ${missing.join(", ")}`).toBe("缺錨點: ");
  });

  test("畫面上的 {...anchor()} 都在索引裡", () => {
    const indexed = new Set(PREF_SEARCH_ITEMS.map((it) => it.key));
    const stale = spreadAnchors.filter((k) => !indexed.has(k));
    expect(`anchor() 沒進索引: ${stale.join(", ")}`).toBe("anchor() 沒進索引: ");
  });

  test("畫面上的 PrefAnchor 都在索引裡（沒有孤兒錨點）", () => {
    const indexed = new Set(PREF_SEARCH_ITEMS.map((it) => it.key));
    const stale = anchorKeys.filter((k) => !indexed.has(k));
    expect(`PrefAnchor 沒進索引: ${stale.join(", ")}`).toBe(
      "PrefAnchor 沒進索引: ",
    );
  });

  test("每個 i18n key 在兩個語系都存在", () => {
    const missing = [];
    PREF_SEARCH_ITEMS.forEach((it) => {
      [it.titleKey, it.tooltipKey, it.sectionKey].forEach((k) => {
        if (!k) return;
        if (!(k in zh)) missing.push(`zh_TW:${k}`);
        if (!(k in en)) missing.push(`en_US:${k}`);
      });
    });
    // i18n() 對缺 key 回 undefined ⇒ 搜尋結果會是一列空白，看起來像功能壞了。
    expect(`缺字串: ${[...new Set(missing)].join(", ")}`).toBe("缺字串: ");
  });
});
