// 設定頁搜尋（設定 → 左欄搜尋框）的索引與比對邏輯。純邏輯、無 DOM。
//
// **命名**：與右鍵選單的既有功能「快速搜尋」（quick_search.js，選字跳 Google）
// 完全無關，勿混用命名。這裡一律 settingsSearch / prefSearch。
//
// **索引是設定頁勾選列的文字來源**：PrefModal.jsx 的 <PrefCheckRow name="…"> 直接
// 用這裡的 titleKey／tooltipKey 畫標題與說明（prefItem）；「一般」分頁的四個分區（一般、右鍵選單與輸入、外觀、
// 游標所在列）、「連線」分頁的編碼／圖片代理／開文快取三區與「增強功能」分頁整區由這裡的順序與 type 畫出（<PrefIndexRows>，prefSectionRows）。其他分區的其餘欄位（數字、下拉、
// 帶額外內容的勾選）仍是 hardcode JSX，這份 PREF_SEARCH_ITEMS 要手工跟著改。防線是
// tests/unit/pref_search_index.test.js——它靜態掃 PrefModal.jsx 的每個
// name="…" 與 <legend>，漏收就紅。新增設定項卻忘了進索引，是這個功能唯一
// 會**靜默**失效的方式（畫面一切正常，就是搜不到）。
//
// **key 同時是 data-pref-anchor 的值**（跳轉錨點，見 PrefModal.jsx#anchorFor）。
// 非 pref 的項目一律加前綴，確保永遠不會跟 pref key 撞名：
//   pref     → 原始 pref key（enableEasyReading、termSize.cols）
//   ui:…     → 沒有 name 屬性的可操作項（主題切換、色票列、debug 開關）
//   section:… → 分區（fieldset 的 legend，或「關於」頁的小標）
import { zh_TW } from "./zh_TW_messages";
import { en_US } from "./en_US_messages";
import { getLang } from "./i18n";
import { groupTitleByKey } from "./pref_groups";
// 索引本體在葉模組 pref_schema.js（不依賴 i18n，A7）；這裡照舊整份 re-export，呼叫端不用改。
import { PREF_SEARCH_TABS, mobileTextKey, PREF_SEARCH_ITEMS } from "./pref_schema";
export * from "./pref_schema";

// 下拉最多顯示幾筆。**刻意壓在「不需要捲動」的高度內**：Mantine Modal 用
// RemoveScroll 包住自己且沒傳 shards，會 preventDefault() 掉 portal 出去的
// dropdown 上的 wheel 事件 ⇒ 下拉捲不動。鍵盤 ↑↓ 走 scrollIntoView，不受影響。
// 真要做可捲的長清單，逃生門是 <Modal removeScrollProps={{ shards: [ref] }}>。
export const MAX_RESULTS = 8;

// 「一般」分區裡每一項屬於哪一段小標（P94，src/js/pref_groups.js）。索引的順序就是
// 設定頁上的順序，所以直接拿它切段。
const GENERAL_GROUP_OF = groupTitleByKey(
  PREF_SEARCH_ITEMS.filter((it) => it.sectionKey === "options_general").map(
    (it) => it.key,
  ),
);

const MESSAGES = { zh_tw: zh_TW, en_us: en_US };

// about_new_content 的 message 是**陣列**；不扁平化的話後面的 toLowerCase()
// 會拿到 "a,b,c" 之外更糟的結果（或直接炸在非字串上）。
const flatten = (m) => (Array.isArray(m) ? m.join(" ") : m == null ? "" : m);

// 刻意不經 i18n()：它對缺 key 會 console.log('missing i18n …')，而索引本來就
// 會查到一些只存在於單一語系情境的 key。缺 key 由守護測試擋，不靠 runtime log。
const msg = (lang, key) => {
  const entry = key && MESSAGES[lang] && MESSAGES[lang][key];
  return entry ? String(flatten(entry.message)) : "";
};

// enableEasyReading → "enable easy reading"、termSize.cols → "term size cols"。
// 讓中文介面下打 "easy reading" 或 "auto login" 也命中。
const deCamel = (key) =>
  key
    .replace(/[.:_-]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();

// 只做 toLowerCase，**不做 NFKC**：正規化會改變字串長度，高亮 offset 就對不回
// 顯示用的原字串了。全形英數的容錯不值這個風險。
const norm = (s) => String(s == null ? "" : s).toLowerCase();

const SCORE = {
  titlePrefix: 100,
  title: 90,
  keyPrefix: 80,
  key: 70,
  section: 60,
  tooltip: 50,
  altTitle: 40,
  altOther: 30,
};

const otherLang = (lang) => (lang === "en_us" ? "zh_tw" : "en_us");

// 回傳 { score, matchedVia, ranges } 或 null。ranges 只在命中「當前語系標題」時
// 才有值——靠英文 key 或另一語系命中時硬畫一段高亮是假的，寧可不畫。
const scoreItem = (item, q, lang, tabKey = PREF_SEARCH_TABS[item.tab]) => {
  const alt = otherLang(lang);
  const title = msg(lang, item.titleKey);
  const t = norm(title);

  if (t && t.startsWith(q)) {
    return { score: SCORE.titlePrefix, matchedVia: "title", ranges: [[0, q.length]] };
  }
  const at = t ? t.indexOf(q) : -1;
  if (at >= 0) {
    return { score: SCORE.title, matchedVia: "title", ranges: [[at, at + q.length]] };
  }

  // key 比對只對真正的 pref 有意義：ui:/section: 前綴項的 key 是我們自己編的，
  // 拿它去比會讓分區莫名其妙以 80 分排到具體設定項前面。
  if (item.kind === "pref") {
    const k = deCamel(item.key);
    if (k.startsWith(q) || norm(item.key).startsWith(q)) {
      return { score: SCORE.keyPrefix, matchedVia: "key", ranges: [] };
    }
    if (k.includes(q) || norm(item.key).includes(q)) {
      return { score: SCORE.key, matchedVia: "key", ranges: [] };
    }
  }

  const sectionText = norm(msg(lang, item.sectionKey));
  const tabText = norm(msg(lang, tabKey));
  if ((sectionText && sectionText.includes(q)) || (tabText && tabText.includes(q))) {
    return { score: SCORE.section, matchedVia: "section", ranges: [] };
  }

  const tip = norm(msg(lang, item.tooltipKey));
  if (tip && tip.includes(q)) {
    return { score: SCORE.tooltip, matchedVia: "tooltip", ranges: [] };
  }

  if (norm(msg(alt, item.titleKey)).includes(q)) {
    return { score: SCORE.altTitle, matchedVia: "altLang", ranges: [] };
  }
  const altOther =
    norm(msg(alt, item.tooltipKey)) +
    " " +
    norm(msg(alt, item.sectionKey)) +
    " " +
    norm(msg(alt, tabKey));
  if (altOther.includes(q)) {
    return { score: SCORE.altOther, matchedVia: "altLang", ranges: [] };
  }
  return null;
};

/**
 * 設定頁搜尋。純函式，無 DOM、無副作用。
 *
 * @param {string} query 使用者輸入
 * @param {{lang?: string, limit?: number, mobile?: boolean}} [opts] lang 預設取 i18n.getLang()；
 *   mobile＝手機版面，desktopOnly 的項目不列（設定頁上根本沒畫，跳過去會撲空）
 * @returns {Array<{key, tab, tabLabel, sectionLabel, title, ranges, matchedVia, score}>}
 *   已排序、已截斷到 limit（預設 MAX_RESULTS）。ranges 是針對 title 的高亮區間，
 *   **UI 端直接照切，不得自己再比對一次**——比對規則只能有一份。
 */
export function searchPrefSettings(query, opts = {}) {
  const q = norm(query).trim();
  if (!q) return [];
  const lang = opts.lang || getLang();
  const limit = opts.limit == null ? MAX_RESULTS : opts.limit;

  const hits = [];
  PREF_SEARCH_ITEMS.forEach((item, index) => {
    if (opts.mobile && item.desktopOnly) return;
    const tabKey = mobileTextKey(PREF_SEARCH_TABS[item.tab], opts.mobile);
    if (opts.mobile) {
      item = {
        ...item,
        titleKey: mobileTextKey(item.titleKey, true),
        tooltipKey: mobileTextKey(item.tooltipKey, true),
        sectionKey: mobileTextKey(item.sectionKey, true),
      };
    }
    const m = scoreItem(item, q, lang, tabKey);
    if (!m) return;
    const title = msg(lang, item.titleKey);
    const tabLabel = msg(lang, tabKey);
    // 分區項不重複自己的名字；分區名與分頁名同字時也只留分頁名（否則副標會印成
    // 「增強功能 · 增強功能」——設定頁上有五個分區刻意與分頁同名）。
    // 「一般」分區跟分頁同名，改寫它在哪一段（「一般 · 首頁與收藏」）。
    const groupKey = GENERAL_GROUP_OF.get(item.key);
    const section = groupKey
      ? msg(lang, groupKey)
      : msg(lang, item.sectionKey);
    const sectionLabel =
      item.kind === "section" || !section || section === tabLabel
        ? null
        : section;
    hits.push({
      key: item.key,
      kind: item.kind,
      tab: item.tab,
      tabLabel,
      sectionLabel,
      title,
      ranges: m.ranges,
      matchedVia: m.matchedVia,
      score: m.score,
      index,
    });
  });

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.title.length - b.title.length ||
      a.index - b.index,
  );
  return hits.slice(0, limit).map(({ index, ...rest }) => rest);
}
