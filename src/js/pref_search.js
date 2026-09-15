// 設定頁搜尋（設定 → 左欄搜尋框）的索引與比對邏輯。純邏輯、無 DOM。
//
// **命名**：與右鍵選單的既有功能「快速搜尋」（quick_search.js，選字跳 Google）
// 完全無關，勿混用命名。這裡一律 settingsSearch / prefSearch。
//
// **索引是手動維護的第二份事實**：PrefModal.jsx 是純 hardcode JSX、沒有 schema
// 可反射，所以這份 PREF_SEARCH_ITEMS 必須手工跟著改。唯一的防線是
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

// 下拉最多顯示幾筆。**刻意壓在「不需要捲動」的高度內**：Mantine Modal 用
// RemoveScroll 包住自己且沒傳 shards，會 preventDefault() 掉 portal 出去的
// dropdown 上的 wheel 事件 ⇒ 下拉捲不動。鍵盤 ↑↓ 走 scrollIntoView，不受影響。
// 真要做可捲的長清單，逃生門是 <Modal removeScrollProps={{ shards: [ref] }}>。
export const MAX_RESULTS = 8;

// 分頁 value → 分頁標題的 i18n key。與 PrefModal.jsx 的 <Tabs.Tab value=…> 對齊。
export const PREF_SEARCH_TABS = {
  general: "options_general",
  mouse: "options_mouse",
  connection: "options_connection",
  enhance: "options_enhance",
  quicksearch: "options_quickSearch",
  autologin: "options_autoLoginTab",
  ai: "options_ai",
  local: "options_local",
  backup: "options_backup",
  about: "options_about",
};

// PrefModal.jsx 裡有 name= 但**刻意**不進索引者。值是理由，守護測試會驗這些
// 名字確實還在原始碼裡（防止名單腐爛）。
export const PREF_SEARCH_EXEMPT_NAMES = {
  backupImportFile:
    "隱藏的 <input type=file>，不是設定項；入口是它前面那顆匯入按鈕（已由 section:options_backupImport 代表）",
  "quickSearchBuiltin-":
    "動態產生，內容取自 quick_search.js#BUILTIN_QUICK_SEARCH，會隨清單變動；由 section:options_quickSearchBuiltin 代表",
};

// sectionTooltipKey === false ⇒ 這個分區不另外產生 section 項。用在兩種情形：
//   1) legend 與分頁名同字（「一般 → 一般」是廢結果）；
//   2) 分區裡就有一個項目的標題與 legend 同字（例如「滾輪」區的 mouseWheel）。
const inSection = (tab, sectionKey, sectionTooltipKey, items) => [
  ...(sectionTooltipKey === false
    ? []
    : [
        {
          kind: "section",
          key: `section:${sectionKey}`,
          tab,
          sectionKey,
          titleKey: sectionKey,
          tooltipKey: sectionTooltipKey || undefined,
        },
      ]),
  ...items.map((it) => ({ kind: "pref", ...it, tab, sectionKey })),
];

// 順序 = 設定頁上的實際排列。同分時用它當最後的 tie-break，結果才穩定可斷言。
export const PREF_SEARCH_ITEMS = [
  // ── 一般 ────────────────────────────────────────────────────────
  ...inSection("general", "options_general", false, [
    { key: "enablePicPreview", titleKey: "options_enablePicPreview" },
    { key: "enableNotifications", titleKey: "options_enableNotifications" },
    { key: "deepLinkHandoffNotify", titleKey: "options_deepLinkHandoffNotify" },
    { key: "enableEasyReading", titleKey: "options_enableEasyReading" },
    { key: "enableEasyReadingList", titleKey: "options_enableEasyReadingList" },
    {
      key: "enableBoardListSmoothScroll",
      titleKey: "options_enableBoardListSmoothScroll",
      tooltipKey: "tooltip_enableBoardListSmoothScroll",
    },
    {
      key: "enableListNativeAutoResume",
      titleKey: "options_enableListNativeAutoResume",
      tooltipKey: "tooltip_enableListNativeAutoResume",
    },
    {
      key: "easyReadingEndSwitchNative",
      titleKey: "options_easyReadingEndSwitchNative",
    },
    {
      key: "easyReadingEndSwitchKey",
      titleKey: "options_easyReadingEndSwitchKey",
      tooltipKey: "tooltip_easyReadingEndSwitchKey",
    },
    {
      key: "aidNavBackKey",
      titleKey: "options_aidNavBackKey",
      tooltipKey: "tooltip_aidNavBackKey",
    },
    {
      key: "deepLinkCopyKey",
      titleKey: "options_deepLinkCopyKey",
      tooltipKey: "tooltip_deepLinkCopyKey",
    },
    { key: "endTurnsOnLiveUpdate", titleKey: "options_endTurnsOnLiveUpdate" },
    { key: "copyOnSelect", titleKey: "options_copyOnSelect" },
    { key: "enableBell", titleKey: "options_enableBell" },
    {
      key: "antiIdleTime",
      titleKey: "options_antiIdleTime",
      tooltipKey: "tooltip_antiIdleTime",
    },
    { key: "lineWrap", titleKey: "options_lineWrap" },
  ]),
  ...inSection("general", "options_contextMenu", null, [
    { key: "enableInputHelper", titleKey: "options_enableInputHelper" },
    {
      key: "enableLiveArticleHelper",
      titleKey: "options_enableLiveArticleHelper",
    },
    { key: "enableLongPush", titleKey: "options_enableLongPush" },
    {
      key: "pushKeyOpensLongPush",
      titleKey: "options_pushKeyOpensLongPush",
      tooltipKey: "tooltip_pushKeyOpensLongPush",
    },
  ]),
  ...inSection("general", "options_appearance", null, [
    {
      key: "autoHideBlinkCursor",
      titleKey: "options_autoHideBlinkCursor",
      tooltipKey: "tooltip_autoHideBlinkCursor",
    },
    { kind: "ui", key: "ui:theme", titleKey: "options_theme" },
    {
      key: "fontFace",
      titleKey: "options_fontFace",
      tooltipKey: "tooltip_fontFace",
    },
    { key: "bbsMargin", titleKey: "options_bbsMargin" },
    {
      key: "termSizeMode",
      titleKey: "options_termSize",
      tooltipKey: "tooltip_termSize",
    },
    { key: "termSize.cols", titleKey: "options_cols" },
    { key: "termSize.rows", titleKey: "options_rows" },
    { key: "fontFitWindowWidth", titleKey: "options_fontFitWindowWidth" },
    { key: "fontSize", titleKey: "options_fontSize" },
  ]),
  ...inSection("general", "options_cursorHighlight", null, [
    {
      key: "cursorRowBrighten",
      titleKey: "options_cursorRowBrighten",
      tooltipKey: "tooltip_cursorRowBrighten",
    },
    { key: "cursorRowBackground", titleKey: "options_cursorRowBackground" },
    {
      key: "keyboardCursorHighlight",
      titleKey: "options_keyboardCursorHighlight",
    },
    {
      kind: "ui",
      key: "ui:highlightColor",
      titleKey: "options_highlightColor",
      tooltipKey: "tooltip_highlightColorShared",
    },
  ]),

  // ── 滑鼠 ────────────────────────────────────────────────────────
  ...inSection("mouse", "options_mouseBrowsing", null, [
    {
      key: "useMouseBrowsing",
      titleKey: "options_useMouseBrowsing",
      tooltipKey: "tooltip_useMouseBrowsing",
    },
  ]),
  ...inSection("mouse", "options_mouseMove", null, [
    {
      key: "mouseBrowsingHighlight",
      titleKey: "options_mouseBrowsingHighlight",
      tooltipKey: "tooltip_mouseBrowsingHighlight",
    },
  ]),
  ...inSection("mouse", "options_mouseLeftClick", null, [
    {
      key: "mouseLeftClick",
      titleKey: "options_enableMouseLeftClick",
      tooltipKey: "tooltip_mouseLeftClick",
    },
  ]),
  ...inSection("mouse", "options_mouseMisclickGuard", null, [
    {
      key: "mouseMisclickGuard",
      titleKey: "options_enableMouseMisclickGuard",
      tooltipKey: "tooltip_mouseMisclickGuard",
    },
  ]),
  ...inSection("mouse", "options_mouseEdgePaging", null, [
    {
      key: "mouseEdgePaging",
      titleKey: "options_enableMouseEdgePaging",
      tooltipKey: "tooltip_mouseEdgePaging",
    },
  ]),
  ...inSection("mouse", "options_mouseFunctionKeys", null, [
    {
      key: "mouseFunctionKeys",
      titleKey: "options_enableMouseFunctionKeys",
      tooltipKey: "tooltip_mouseFunctionKeys",
    },
  ]),
  // 以下四區的 legend 與區內項目標題同字 ⇒ 不另外產生 section 項。
  ...inSection("mouse", "options_mouseMiddleClick", false, [
    { key: "mouseMiddleClick", titleKey: "options_mouseMiddleClick" },
  ]),
  ...inSection("mouse", "options_mouseWheel", false, [
    {
      key: "mouseWheel",
      titleKey: "options_mouseWheel",
      tooltipKey: "tooltip_mouseWheel",
    },
    {
      key: "mouseWheelSmoothScroll",
      titleKey: "options_mouseWheelSmoothScroll",
      tooltipKey: "tooltip_mouseWheelSmoothScroll",
    },
  ]),
  ...inSection("mouse", "options_mouseBackNav", false, [
    {
      key: "mouseBackNav",
      titleKey: "options_mouseBackNav",
      tooltipKey: "tooltip_mouseBackNav",
    },
  ]),
  ...inSection("mouse", "options_mouseServerReport", false, [
    {
      key: "mouseServerReport",
      titleKey: "options_mouseServerReport",
      tooltipKey: "tooltip_mouseServerReport",
    },
  ]),

  // ── 連線 ────────────────────────────────────────────────────────
  ...inSection("connection", "options_connection_bbs", null, [
    { key: "useProxy", titleKey: "options_useProxy" },
    {
      key: "proxyUrl",
      titleKey: "options_proxyUrl",
      tooltipKey: "tooltip_proxyUrl",
    },
  ]),
  ...inSection("connection", "options_imgurProxy", "tooltip_imgurProxy", [
    { key: "useImgurProxy", titleKey: "options_useImgurProxy" },
    {
      key: "imgurProxyUrl",
      titleKey: "options_imgurProxyUrl",
      tooltipKey: "tooltip_imgurProxyUrl",
    },
  ]),

  // ── 增強 ────────────────────────────────────────────────────────
  ...inSection("enhance", "options_enhance", false, [
    { key: "showFloorNumbers", titleKey: "options_showFloorNumbers" },
    {
      key: "mergeSameAuthorComments",
      titleKey: "options_mergeSameAuthorComments",
    },
    { key: "commentBlockSpacing", titleKey: "options_commentBlockSpacing" },
    {
      key: "highlightAuthorComments",
      titleKey: "options_highlightAuthorComments",
    },
    { key: "enableAutoFixUrl", titleKey: "options_enableAutoFixUrl" },
    { key: "enableXMentionLink", titleKey: "options_enableXMentionLink" },
    { key: "enableBareDomainLink", titleKey: "options_enableBareDomainLink" },
    { key: "enableImageUpload", titleKey: "options_enableImageUpload" },
    {
      key: "blacklist",
      titleKey: "options_blacklist",
      tooltipKey: "tooltip_blacklist",
    },
    {
      key: "titleBlacklist",
      titleKey: "options_title_blacklist",
      tooltipKey: "tooltip_title_blacklist",
    },
  ]),

  // ── 快速搜尋（右鍵選單的那個功能，非本搜尋框）────────────────────
  ...inSection(
    "quicksearch",
    "options_quickSearchBuiltin",
    "tooltip_quickSearch",
    [],
  ),
  ...inSection("quicksearch", "options_quickSearchCustom", null, []),

  // ── 自動登入 ────────────────────────────────────────────────────
  ...inSection("autologin", "options_autoLogin", "tooltip_autoLoginSynced", [
    {
      key: "autoLogin",
      titleKey: "options_autoLoginEnable",
      tooltipKey: "tooltip_autoLogin",
    },
    { key: "autoLoginDupConn", titleKey: "options_autoLoginDupConn" },
    { key: "autoLoginSkipWelcome", titleKey: "options_autoLoginSkipWelcome" },
  ]),
  ...inSection("autologin", "options_autoLoginCredentials", null, [
    { key: "autoLoginUser", titleKey: "options_autoLoginUser" },
    { key: "autoLoginPassword", titleKey: "options_autoLoginPassword" },
    {
      key: "autoLoginOtpSecret",
      titleKey: "options_autoLoginOtpSecret",
      tooltipKey: "tooltip_autoLoginOtpSecret",
    },
  ]),

  // ── AI ──────────────────────────────────────────────────────────
  ...inSection("ai", "options_ai", false, [
    { key: "enableAi", titleKey: "options_enableAi", tooltipKey: "tooltip_ai" },
  ]),
  ...inSection("ai", "options_ai_features", null, [
    { key: "enableCaptionAi", titleKey: "options_enableCaptionAi" },
    {
      key: "enableUrlAi",
      titleKey: "options_enableUrlAi",
      tooltipKey: "tooltip_enableUrlAi",
    },
  ]),

  // ── 本機設定 ────────────────────────────────────────────────────
  ...inSection("local", "options_local", false, [
    {
      key: "enableWorkMode",
      titleKey: "options_enableWorkMode",
      tooltipKey: "tooltip_local",
    },
    {
      key: "imageUploadToken",
      titleKey: "options_imageUploadToken",
      tooltipKey: "tooltip_imageUploadToken",
    },
  ]),

  // ── 備份／同步 ──────────────────────────────────────────────────
  ...inSection("backup", "options_backupExport", "tooltip_backupExport", []),
  ...inSection("backup", "options_backupImport", "tooltip_backupImport", []),
  ...inSection("backup", "options_sync", "tooltip_sync", []),

  // ── 關於（沒有 fieldset，錨點掛在各區的 <div> 上）────────────────
  ...inSection("about", "about_version_title", null, []),
  ...inSection("about", "options_debugMode_title", null, [
    {
      kind: "ui",
      key: "ui:debugMode",
      titleKey: "options_debugMode",
      tooltipKey: "options_debugMode_desc",
    },
  ]),
  ...inSection("about", "about_new_title", null, []),
];

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
const scoreItem = (item, q, lang) => {
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
  const tabText = norm(msg(lang, PREF_SEARCH_TABS[item.tab]));
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
    norm(msg(alt, PREF_SEARCH_TABS[item.tab]));
  if (altOther.includes(q)) {
    return { score: SCORE.altOther, matchedVia: "altLang", ranges: [] };
  }
  return null;
};

/**
 * 設定頁搜尋。純函式，無 DOM、無副作用。
 *
 * @param {string} query 使用者輸入
 * @param {{lang?: string, limit?: number}} [opts] lang 預設取 i18n.getLang()
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
    const m = scoreItem(item, q, lang);
    if (!m) return;
    const title = msg(lang, item.titleKey);
    const tabLabel = msg(lang, PREF_SEARCH_TABS[item.tab]);
    // 分區項不重複自己的名字；分區名與分頁名同字時也只留分頁名（否則副標會印成
    // 「增強功能 · 增強功能」——設定頁上有五個分區刻意與分頁同名）。
    const section = msg(lang, item.sectionKey);
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
