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
import { IMAGE_PROXY_SITES } from "./image_proxy";
import { groupTitleByKey } from "./pref_groups";

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
  shortcuts: "options_shortcuts",
  about: "options_about",
};

// 手機版面上換字（P96：「滑鼠」分頁在手機叫「點擊與返回」、改用觸控用語）。
// 電腦版 key → 手機版 key；只換字，設定值與電腦版共用。設定頁的分頁名／分區 legend／
// 每格標題與說明、設定搜尋（含指令面板）都經 mobileTextKey 取字，所以手機搜「返回手勢」找得到。
// 兩語系都要有手機版 key（i18n_parity 守）；守護 tests/unit/pref_groups.test.jsx「P96」。
export const MOBILE_TEXT_KEYS = {
  options_mouse: "options_mouse_mobile",
  optionsDesc_mouse: "optionsDesc_mouse_mobile",
  options_mouseBrowsing: "options_mouseBrowsing_mobile",
  options_useMouseBrowsing: "options_useMouseBrowsing_mobile",
  tooltip_useMouseBrowsing: "tooltip_useMouseBrowsing_mobile",
  options_mouseLeftClick: "options_mouseLeftClick_mobile",
  options_enableMouseLeftClick: "options_enableMouseLeftClick_mobile",
  tooltip_mouseLeftClick: "tooltip_mouseLeftClick_mobile",
  tooltip_mouseEdgePaging: "tooltip_mouseEdgePaging_mobile",
  tooltip_mouseClickRange: "tooltip_mouseClickRange_mobile",
  // 外觀分頁的游標底色說明指向「滑鼠」分頁的停留標示（手機收起了）。
  tooltip_highlightColorShared: "tooltip_highlightColorShared_mobile",
  options_mouseBackNav: "options_mouseBackNav_mobile",
  tooltip_mouseBackNav: "tooltip_mouseBackNav_mobile",
  options_mouseServerReport: "options_mouseServerReport_mobile",
  tooltip_mouseServerReport: "tooltip_mouseServerReport_mobile",
};

/**
 * 手機版面時換成手機版的 i18n key（沒有對照就原樣）。
 * @param {string | undefined} key
 * @param {boolean | undefined} mobile
 * @returns {string | undefined}
 */
export const mobileTextKey = (key, mobile) =>
  (mobile && key && MOBILE_TEXT_KEYS[key]) || key;

// PrefModal.jsx 裡有 name= 但**刻意**不進索引者。值是理由，守護測試會驗這些
// 名字確實還在原始碼裡（防止名單腐爛）。
export const PREF_SEARCH_EXEMPT_NAMES = {
  backupImportFile:
    "隱藏的 <input type=file>，不是設定項；入口是它前面那顆匯入按鈕（已由 section:options_backupImport 代表）",
  savedImportFile:
    "隱藏的 <input type=file>，不是設定項；入口是離線文章的匯入按鈕（已由 section:options_savedBackup 代表）",
  syncReadLater:
    "只在登入雲端同步後才畫出來（沒登入就沒東西可同步），搜尋跳不到；由 section:options_sync 代表",
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
          ...(items.length > 0 && items.every((it) => it.desktopOnly)
            ? { desktopOnly: true }
            : {}),
        },
      ]),
  ...items.map((it) => ({ kind: "pref", ...it, tab, sectionKey })),
];

// 順序 = 設定頁上的實際排列。同分時用它當最後的 tie-break，結果才穩定可斷言。
export const PREF_SEARCH_ITEMS = [
  // ── 一般 ────────────────────────────────────────────────────────
  ...inSection("general", "options_general", false, [
    {
      key: "nativeSafeMode",
      type: "check",
      titleKey: "options_nativeSafeMode",
      tooltipKey: "tooltip_nativeSafeMode",
    },
    { key: "enablePicPreview", type: "check", titleKey: "options_enablePicPreview" },
    {
      key: "imageFitScreen",
      type: "check",
      titleKey: "options_imageFitScreen",
      tooltipKey: "tooltip_imageFitScreen",
    },
    {
      key: "tapToLoadImagesOnMobileData",
      type: "check",
      titleKey: "options_tapToLoadImagesOnMobileData",
      tooltipKey: "tooltip_tapToLoadImagesOnMobileData",
    },
    { key: "enableNotifications", type: "check", titleKey: "options_enableNotifications" },
    { key: "deepLinkHandoffNotify", type: "check", titleKey: "options_deepLinkHandoffNotify" },
    {
      key: "enableMessageInbox",
      type: "check",
      titleKey: "options_enableMessageInbox",
      tooltipKey: "tooltip_enableMessageInbox",
    },
    {
      key: "showStatusHints",
      type: "check",
      titleKey: "options_showStatusHints",
      tooltipKey: "tooltip_showStatusHints",
    },
    { key: "enableEasyReading", type: "check", titleKey: "options_enableEasyReading" },
    {
      key: "enableHelpMenuPopup",
      type: "check",
      requires: "enableEasyReading",
      titleKey: "options_enableHelpMenuPopup",
      tooltipKey: "tooltip_enableHelpMenuPopup",
    },
    { key: "enableEasyReadingList", type: "check", titleKey: "options_enableEasyReadingList" },
    {
      key: "enableListFastScroll",
      type: "check",
      requires: "enableEasyReadingList",
      titleKey: "options_enableListFastScroll",
      tooltipKey: "tooltip_enableListFastScroll",
    },
    {
      key: "enableBoardListSmoothScroll",
      type: "check",
      titleKey: "options_enableBoardListSmoothScroll",
      tooltipKey: "tooltip_enableBoardListSmoothScroll",
    },
    {
      key: "enableListNativeAutoResume",
      type: "check",
      titleKey: "options_enableListNativeAutoResume",
      tooltipKey: "tooltip_enableListNativeAutoResume",
    },
    {
      key: "queueListClickWhenBusy",
      type: "check",
      titleKey: "options_queueListClickWhenBusy",
      tooltipKey: "tooltip_queueListClickWhenBusy",
    },
    {
      key: "skipBoardEntryScreen",
      type: "check",
      titleKey: "options_skipBoardEntryScreen",
      tooltipKey: "tooltip_skipBoardEntryScreen",
    },
    {
      key: "enableHomeDashboard",
      type: "check",
      titleKey: "options_enableHomeDashboard",
      tooltipKey: "tooltip_enableHomeDashboard",
    },
    {
      key: "showWhatsNew",
      type: "check",
      titleKey: "options_showWhatsNew",
      tooltipKey: "tooltip_showWhatsNew",
    },
    {
      key: "enableRecentArticles",
      type: "check",
      titleKey: "options_enableRecentArticles",
      tooltipKey: "tooltip_enableRecentArticles",
    },
    {
      key: "resumeRecentArticles",
      type: "check",
      requires: "enableRecentArticles",
      titleKey: "options_resumeRecentArticles",
      tooltipKey: "tooltip_resumeRecentArticles",
    },
    {
      key: "enableSavedArticles",
      type: "check",
      titleKey: "options_enableSavedArticles",
      tooltipKey: "tooltip_enableSavedArticles",
    },
    {
      key: "enableShareTarget",
      type: "check",
      titleKey: "options_enableShareTarget",
      tooltipKey: "tooltip_enableShareTarget",
    },
    {
      key: "enableBoardTabs",
      type: "check",
      titleKey: "options_enableBoardTabs",
      tooltipKey: "tooltip_enableBoardTabs",
    },
    {
      key: "enableSplitReading",
      type: "check",
      titleKey: "options_enableSplitReading",
      tooltipKey: "tooltip_enableSplitReading",
    },
    {
      key: "enableNextArticleCard",
      type: "check",
      titleKey: "options_enableNextArticleCard",
      tooltipKey: "tooltip_enableNextArticleCard",
    },
    {
      key: "nextArticleSameSubject",
      type: "check",
      sub: true,
      requires: "enableNextArticleCard",
      titleKey: "options_nextArticleSameSubject",
      tooltipKey: "tooltip_nextArticleSameSubject",
    },
    {
      key: "enableArticleTools",
      type: "check",
      titleKey: "options_enableArticleTools",
      tooltipKey: "tooltip_enableArticleTools",
    },
    {
      key: "enableArticleNav",
      type: "check",
      titleKey: "options_enableArticleNav",
      tooltipKey: "tooltip_enableArticleNav",
    },
    {
      key: "easyReadingFooterProgress",
      type: "check",
      titleKey: "options_easyReadingFooterProgress",
      tooltipKey: "tooltip_easyReadingFooterProgress",
    },
    {
      key: "easyReadingBrowserFind",
      type: "check",
      titleKey: "options_easyReadingBrowserFind",
      tooltipKey: "tooltip_easyReadingBrowserFind",
    },
    {
      key: "easyReadingEndSwitchNative",
      type: "check",
      titleKey: "options_easyReadingEndSwitchNative",
    },
    {
      key: "easyReadingEndSwitchKey",
      type: "hotkey",
      requires: "easyReadingEndSwitchNative",
      titleKey: "options_easyReadingEndSwitchKey",
      tooltipKey: "tooltip_easyReadingEndSwitchKey",
    },
    {
      key: "aidNavBackKey",
      type: "hotkey",
      titleKey: "options_aidNavBackKey",
      tooltipKey: "tooltip_aidNavBackKey",
    },
    {
      key: "deepLinkCopyKey",
      type: "hotkey",
      titleKey: "options_deepLinkCopyKey",
      tooltipKey: "tooltip_deepLinkCopyKey",
    },
    {
      key: "unreadJumpKey",
      type: "hotkey",
      titleKey: "options_unreadJumpKey",
      tooltipKey: "tooltip_unreadJumpKey",
    },
    {
      key: "unreadJumpProgress",
      hintInBox: true,
      type: "check",
      titleKey: "options_unreadJumpProgress",
      tooltipKey: "tooltip_unreadJumpProgress",
    },
    {
      key: "unreadJumpDivider",
      hintInBox: true,
      type: "check",
      titleKey: "options_unreadJumpDivider",
      tooltipKey: "tooltip_unreadJumpDivider",
    },
    {
      key: "enableCommandPalette",
      hintInBox: true,
      type: "check",
      titleKey: "options_enableCommandPalette",
      tooltipKey: "tooltip_enableCommandPalette",
    },
    {
      key: "commandPaletteKey",
      type: "hotkey",
      requires: "enableCommandPalette",
      titleKey: "options_commandPaletteKey",
      tooltipKey: "tooltip_commandPaletteKey",
    },
    {
      key: "paletteQuickBoards",
      hintInBox: true,
      type: "check",
      requires: "enableCommandPalette",
      titleKey: "options_paletteQuickBoards",
      tooltipKey: "tooltip_paletteQuickBoards",
    },
    {
      key: "refreshKeyIntercept",
      hintInBox: true,
      type: "check",
      titleKey: "options_refreshKeyIntercept",
      tooltipKey: "tooltip_refreshKeyIntercept",
    },
    {
      key: "refreshMinIntervalSec",
      type: "number",
      min: 0,
      titleKey: "options_refreshMinIntervalSec",
      tooltipKey: "tooltip_refreshMinIntervalSec",
    },
    { key: "endTurnsOnLiveUpdate", type: "check", titleKey: "options_endTurnsOnLiveUpdate" },
    { key: "copyOnSelect", type: "check", titleKey: "options_copyOnSelect" },
    { key: "enableBell", type: "check", titleKey: "options_enableBell" },
    {
      key: "reconnectResume",
      type: "check",
      titleKey: "options_reconnectResume",
      tooltipKey: "tooltip_reconnectResume",
    },
    {
      key: "resumeLastPlace",
      type: "check",
      titleKey: "options_resumeLastPlace",
      tooltipKey: "tooltip_resumeLastPlace",
    },
    {
      key: "antiIdleTime",
      type: "number",
      titleKey: "options_antiIdleTime",
      tooltipKey: "tooltip_antiIdleTime",
    },
    { key: "lineWrap", type: "number", titleKey: "options_lineWrap" },
  ]),
  ...inSection("general", "options_contextMenu", null, [
    { key: "highlightMenuTarget", type: "check", titleKey: "options_highlightMenuTarget" },
    {
      key: "articleCopyLinkRow",
      type: "check",
      titleKey: "options_articleCopyLinkRow",
      tooltipKey: "tooltip_articleCopyLinkRow",
    },
    { key: "enableInputHelper", type: "check", titleKey: "options_enableInputHelper" },
    {
      key: "enableLiveArticleHelper",
      type: "check",
      titleKey: "options_enableLiveArticleHelper",
    },
    {
      key: "enableEditorInput",
      type: "check",
      titleKey: "options_enableEditorInput",
      tooltipKey: "tooltip_enableEditorInput",
    },
    { key: "enableLongPush", type: "check", titleKey: "options_enableLongPush" },
    {
      key: "pushKeyOpensLongPush",
      type: "check",
      requires: "enableLongPush",
      titleKey: "options_pushKeyOpensLongPush",
      tooltipKey: "tooltip_pushKeyOpensLongPush",
    },
    {
      key: "enableCommentBar",
      type: "check",
      requires: "enableLongPush",
      titleKey: "options_enableCommentBar",
      tooltipKey: "tooltip_enableCommentBar",
    },
    {
      key: "commentReplyMenu",
      type: "check",
      requires: "enableCommentBar",
      titleKey: "options_commentReplyMenu",
      tooltipKey: "tooltip_commentReplyMenu",
    },
    {
      key: "enableCommentFilter",
      type: "check",
      titleKey: "options_enableCommentFilter",
      tooltipKey: "tooltip_enableCommentFilter",
    },
    {
      key: "mobileCommentBarFold",
      type: "check",
      requires: "enableCommentBar",
      titleKey: "options_mobileCommentBarFold",
      tooltipKey: "tooltip_mobileCommentBarFold",
    },
    {
      key: "commentBarCounter",
      type: "check",
      requires: "enableCommentBar",
      titleKey: "options_commentBarCounter",
      tooltipKey: "tooltip_commentBarCounter",
    },
    {
      key: "searchKeyOpensModal",
      type: "check",
      titleKey: "options_searchKeyOpensModal",
      tooltipKey: "tooltip_searchKeyOpensModal",
    },
    {
      key: "enableSearchStatus",
      type: "check",
      titleKey: "options_enableSearchStatus",
      tooltipKey: "tooltip_enableSearchStatus",
    },
  ]),
  ...inSection("general", "options_appearance", null, [
    {
      key: "autoHideBlinkCursor",
      type: "check",
      titleKey: "options_autoHideBlinkCursor",
      tooltipKey: "tooltip_autoHideBlinkCursor",
    },
    {
      key: "dimReadArticles",
      type: "check",
      titleKey: "options_dimReadArticles",
      tooltipKey: "tooltip_dimReadArticles",
    },
    {
      key: "boardListUnreadMark",
      type: "check",
      titleKey: "options_boardListUnreadMark",
      tooltipKey: "tooltip_boardListUnreadMark",
    },
    { kind: "ui", key: "ui:theme", titleKey: "options_theme" },
    {
      key: "fontFace",
      type: "text",
      titleKey: "options_fontFace",
      tooltipKey: "tooltip_fontFace",
    },
    { key: "bbsMargin", type: "number", titleKey: "options_bbsMargin" },
    {
      key: "termSizeMode",
      type: "select",
      desktopOnly: true,
      mobileNoteKey: "options_desktopOnlyOnMobile",
      titleKey: "options_termSize",
      tooltipKey: "tooltip_termSize",
    },
    {
      key: "termSize.cols",
      type: "number",
      shownIf: "fixedTermSize",
      desktopOnly: true,
      titleKey: "options_cols",
    },
    {
      key: "termSize.rows",
      type: "number",
      shownIf: "fixedTermSize",
      desktopOnly: true,
      titleKey: "options_rows",
    },
    {
      key: "fontFitWindowWidth",
      type: "check",
      shownIf: "fixedTermSize",
      desktopOnly: true,
      titleKey: "options_fontFitWindowWidth",
    },
    {
      key: "fontSize",
      type: "number",
      shownIf: "fixedFontSize",
      desktopOnly: true,
      titleKey: "options_fontSize",
    },
    {
      key: "mobileLayout",
      type: "select",
      titleKey: "options_mobileLayout",
      tooltipKey: "tooltip_mobileLayout",
    },
    {
      key: "mobileFontSize",
      type: "select",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileFontSize",
      tooltipKey: "tooltip_mobileFontSize",
    },
    {
      key: "mobileAppBarScrollTop",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileAppBarScrollTop",
      tooltipKey: "tooltip_mobileAppBarScrollTop",
    },
    {
      key: "mobileAppBarArticleDetail",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileAppBarArticleDetail",
      tooltipKey: "tooltip_mobileAppBarArticleDetail",
    },
    {
      key: "mobileSelectTextPage",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileSelectTextPage",
      tooltipKey: "tooltip_mobileSelectTextPage",
    },
    {
      key: "mobileFindInArticle",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileFindInArticle",
      tooltipKey: "tooltip_mobileFindInArticle",
    },
    {
      key: "mobileCardHideTitleBox",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileCardHideTitleBox",
      tooltipKey: "tooltip_mobileCardHideTitleBox",
    },
    {
      key: "mobileBoardCardUnread",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileBoardCardUnread",
      tooltipKey: "tooltip_mobileBoardCardUnread",
    },
    {
      key: "mobileListEndHint",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileListEndHint",
      tooltipKey: "tooltip_mobileListEndHint",
    },
    {
      key: "mobileFloatToolsInMore",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileFloatToolsInMore",
      tooltipKey: "tooltip_mobileFloatToolsInMore",
    },
    {
      key: "mobileBoardTools",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileBoardTools",
      tooltipKey: "tooltip_mobileBoardTools",
    },
    {
      key: "mobileMailListTools",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileMailListTools",
      tooltipKey: "tooltip_mobileMailListTools",
    },
    {
      key: "mobileMenuBannerCollapse",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileMenuBannerCollapse",
      tooltipKey: "tooltip_mobileMenuBannerCollapse",
    },
    {
      key: "mobileEssenceCards",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileEssenceCards",
      tooltipKey: "tooltip_mobileEssenceCards",
    },
    {
      key: "mobilePromptChoices",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobilePromptChoices",
      tooltipKey: "tooltip_mobilePromptChoices",
    },
    {
      key: "mobilePromptKeyboard",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobilePromptKeyboard",
      tooltipKey: "tooltip_mobilePromptKeyboard",
    },
    {
      key: "mobileAnyKeyContinue",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileAnyKeyContinue",
      tooltipKey: "tooltip_mobileAnyKeyContinue",
    },
    {
      key: "mobilePostInfoActions",
      type: "check",
      shownIf: "mobileLayoutOn",
      requires: "mobileAnyKeyContinue",
      titleKey: "options_mobilePostInfoActions",
      tooltipKey: "tooltip_mobilePostInfoActions",
    },
    {
      key: "mobileModernCommentCards",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileModernCommentCards",
      tooltipKey: "tooltip_mobileModernCommentCards",
    },
    {
      key: "mobileHangIndent",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileHangIndent",
      tooltipKey: "tooltip_mobileHangIndent",
    },
    {
      key: "mobileEditorSave",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileEditorSave",
      tooltipKey: "tooltip_mobileEditorSave",
    },
  ]),
  ...inSection("general", "options_cursorHighlight", null, [
    {
      key: "cursorRowBrighten",
      type: "check",
      titleKey: "options_cursorRowBrighten",
      tooltipKey: "tooltip_cursorRowBrighten",
    },
    { key: "cursorRowBackground", type: "check", titleKey: "options_cursorRowBackground" },
    {
      key: "keyboardCursorHighlight",
      type: "check",
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
      type: "check",
      titleKey: "options_useMouseBrowsing",
      tooltipKey: "tooltip_useMouseBrowsing",
    },
  ]),
  ...inSection("mouse", "options_mouseMove", null, [
    {
      key: "mouseBrowsingHighlight",
      desktopOnly: true,
      type: "check",
      requires: "useMouseBrowsing",
      titleKey: "options_mouseBrowsingHighlight",
      tooltipKey: "tooltip_mouseBrowsingHighlight",
    },
  ]),
  ...inSection("mouse", "options_mouseLeftClick", null, [
    {
      key: "mouseLeftClick",
      type: "check",
      requires: "useMouseBrowsing",
      titleKey: "options_enableMouseLeftClick",
      tooltipKey: "tooltip_mouseLeftClick",
    },
  ]),
  ...inSection("mouse", "options_mouseClickRange", "tooltip_mouseClickRange", [
    { key: "mouseListClickStart", type: "select", requires: "useMouseBrowsing", titleKey: "options_mouseListClickStart" },
    { key: "mousePushClickStart", type: "select", requires: "useMouseBrowsing", titleKey: "options_mousePushClickStart" },
    { key: "mousePushClickEnd", type: "select", requires: "useMouseBrowsing", titleKey: "options_mousePushClickEnd" },
  ]),
  ...inSection("mouse", "options_mouseEdgePaging", null, [
    {
      key: "mouseEdgePaging",
      type: "check",
      requires: "useMouseBrowsing",
      titleKey: "options_enableMouseEdgePaging",
      tooltipKey: "tooltip_mouseEdgePaging",
    },
  ]),
  ...inSection("mouse", "options_mouseFunctionKeys", null, [
    {
      key: "mouseFunctionKeys",
      type: "check",
      requires: "useMouseBrowsing",
      titleKey: "options_enableMouseFunctionKeys",
      tooltipKey: "tooltip_mouseFunctionKeys",
    },
  ]),
  // 以下四區的 legend 與區內項目標題同字 ⇒ 不另外產生 section 項。
  // 停留標示、中鍵、滾輪、平滑捲動在手機沒有對應的操作 ⇒ desktopOnly（手機整區不畫，P96）。
  // 「交給 PTT」手機也有作用（serverReport 會讓點擊整組讓位，mouse_regions.resolveMouseGates），留著。
  ...inSection("mouse", "options_mouseMiddleClick", false, [
    { key: "mouseMiddleClick", type: "select", desktopOnly: true, requires: "useMouseBrowsing", titleKey: "options_mouseMiddleClick" },
  ]),
  ...inSection("mouse", "options_mouseWheel", false, [
    {
      key: "mouseWheel",
      desktopOnly: true,
      type: "select",
      requires: "useMouseBrowsing",
      titleKey: "options_mouseWheel",
      tooltipKey: "tooltip_mouseWheel",
    },
    {
      key: "mouseWheelSmoothScroll",
      desktopOnly: true,
      type: "check",
      requires: "mouseWheel",
      titleKey: "options_mouseWheelSmoothScroll",
      tooltipKey: "tooltip_mouseWheelSmoothScroll",
    },
  ]),
  ...inSection("mouse", "options_mouseBackNav", false, [
    {
      key: "mouseBackNav",
      type: "select",
      requires: "useMouseBrowsing",
      titleKey: "options_mouseBackNav",
      tooltipKey: "tooltip_mouseBackNav",
    },
  ]),
  ...inSection("mouse", "options_mouseServerReport", false, [
    {
      key: "mouseServerReport",
      type: "check",
      requires: "useMouseBrowsing",
      titleKey: "options_mouseServerReport",
      tooltipKey: "tooltip_mouseServerReport",
    },
  ]),

  // ── 連線 ────────────────────────────────────────────────────────
  ...inSection("connection", "options_connection_bbs", null, [
    { key: "useProxy", type: "check", titleKey: "options_useProxy" },
    {
      key: "proxyUrl",
      type: "text",
      requires: "useProxy",
      titleKey: "options_proxyUrl",
      tooltipKey: "tooltip_proxyUrl",
    },
  ]),
  ...inSection("connection", "options_connectionProtocol", false, [
    {
      key: "connectionProtocol",
      type: "select",
      titleKey: "options_connectionProtocol",
      tooltipKey: "tooltip_connectionProtocol",
    },
    {
      key: "sshRelayUrl",
      type: "text",
      titleKey: "options_sshRelayUrl",
      tooltipKey: "tooltip_sshRelayUrl",
    },
  ]),
  ...inSection("connection", "options_connectionEncoding", false, [
    {
      key: "connectionEncoding",
      type: "select",
      titleKey: "options_connectionEncoding",
      tooltipKey: "tooltip_connectionEncoding",
    },
  ]),
  ...inSection("connection", "options_imgurProxy", "tooltip_imgurProxy", [
    { key: "useImgurProxy", type: "check", titleKey: "options_useImgurProxy" },
    ...IMAGE_PROXY_SITES.map((site) => ({
      key: site.prefKey,
      type: "check",
      sub: true,
      titleKey: site.labelKey,
      requires: "useImgurProxy",
    })),
    {
      key: "imgurProxyUrl",
      type: "text",
      requires: "useImgurProxy",
      titleKey: "options_imgurProxyUrl",
      tooltipKey: "tooltip_imgurProxyUrl",
    },
  ]),
  ...inSection("connection", "options_openCache", null, [
    {
      key: "enableOpenCache",
      type: "check",
      titleKey: "options_enableOpenCache",
      tooltipKey: "tooltip_enableOpenCache",
      hintInBox: true,
    },
  ]),

  // ── 增強 ────────────────────────────────────────────────────────
  ...inSection("enhance", "options_enhance", false, [
    { key: "showFloorNumbers", type: "check", titleKey: "options_showFloorNumbers" },
    {
      key: "mergeSameAuthorComments",
      type: "check",
      titleKey: "options_mergeSameAuthorComments",
    },
    {
      key: "mergedCommentEachTime",
      type: "check",
      requires: "mergeSameAuthorComments",
      titleKey: "options_mergedCommentEachTime",
    },
    { key: "commentBlockSpacing", type: "check", titleKey: "options_commentBlockSpacing" },
    {
      key: "showMergeCaptionButton",
      type: "check",
      titleKey: "options_showMergeCaptionButton",
      tooltipKey: "tooltip_showMergeCaptionButton",
    },
    {
      key: "showLightsOnButton",
      type: "check",
      titleKey: "options_showLightsOnButton",
      tooltipKey: "tooltip_showLightsOnButton",
    },
    {
      key: "highlightAuthorComments",
      type: "check",
      titleKey: "options_highlightAuthorComments",
    },
    {
      key: "highlightSelfComments",
      type: "check",
      titleKey: "options_highlightSelfComments",
    },
    {
      key: "markNewComments",
      type: "check",
      titleKey: "options_markNewComments",
      tooltipKey: "tooltip_markNewComments",
    },
    {
      key: "markJustPushed",
      type: "check",
      titleKey: "options_markJustPushed",
      tooltipKey: "tooltip_markJustPushed",
    },
    {
      key: "listNewPushCount",
      type: "check",
      titleKey: "options_listNewPushCount",
      tooltipKey: "tooltip_listNewPushCount",
    },
    { key: "enableAutoFixUrl", type: "check", titleKey: "options_enableAutoFixUrl" },
    { key: "enableXMentionLink", type: "check", titleKey: "options_enableXMentionLink" },
    { key: "enableBareDomainLink", type: "check", titleKey: "options_enableBareDomainLink" },
    { key: "enableImageUpload", type: "check", titleKey: "options_enableImageUpload" },
    {
      key: "blacklist",
      type: "textarea",
      rows: 6,
      titleKey: "options_blacklist",
      tooltipKey: "tooltip_blacklist",
    },
    {
      key: "titleBlacklist",
      type: "textarea",
      rows: 6,
      titleKey: "options_title_blacklist",
      tooltipKey: "tooltip_title_blacklist",
    },
    {
      key: "enableFollowList",
      type: "check",
      titleKey: "options_enableFollowList",
      tooltipKey: "tooltip_enableFollowList",
    },
    {
      key: "followList",
      type: "textarea",
      rows: 3,
      requires: "enableFollowList",
      titleKey: "options_followList",
      tooltipKey: "tooltip_followList",
    },
    {
      key: "followTitleList",
      type: "textarea",
      rows: 3,
      requires: "enableFollowList",
      titleKey: "options_followTitleList",
      tooltipKey: "tooltip_followTitleList",
    },
    {
      key: "enableFollowOnly",
      type: "check",
      requires: "enableFollowList",
      titleKey: "options_enableFollowOnly",
      tooltipKey: "tooltip_enableFollowOnly",
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
      type: "check",
      titleKey: "options_autoLoginEnable",
      tooltipKey: "tooltip_autoLogin",
    },
    { key: "autoLoginDupConn", type: "select", titleKey: "options_autoLoginDupConn" },
    { key: "autoLoginSkipWelcome", type: "check", titleKey: "options_autoLoginSkipWelcome" },
  ]),
  ...inSection("autologin", "options_autoLoginCredentials", null, [
    { key: "autoLoginUser", type: "text", titleKey: "options_autoLoginUser" },
    { key: "autoLoginPassword", type: "text", titleKey: "options_autoLoginPassword" },
    {
      key: "autoLoginOtpSecret",
      type: "text",
      titleKey: "options_autoLoginOtpSecret",
      tooltipKey: "tooltip_autoLoginOtpSecret",
    },
  ]),

  // ── AI ──────────────────────────────────────────────────────────
  // tooltip_ai 是整個分區的說明（裝置端推論、Chrome 148+），不是總開關這一格的 ⇒ 掛在分區上。
  ...inSection("ai", "options_ai", "tooltip_ai", [
    { key: "enableAi", type: "check", titleKey: "options_enableAi" },
  ]),
  ...inSection("ai", "options_ai_features", null, [
    { key: "enableCaptionAi", type: "check", titleKey: "options_enableCaptionAi" },
    {
      key: "enableUrlAi",
      type: "check",
      titleKey: "options_enableUrlAi",
      tooltipKey: "tooltip_enableUrlAi",
    },
  ]),

  // ── 本機設定 ────────────────────────────────────────────────────
  // tooltip_local（只存這台、不上雲）講的是整個分頁 ⇒ 掛在分區上，不掛在上班模式那一格。
  ...inSection("local", "options_local", "tooltip_local", [
    {
      key: "enableWorkMode",
      type: "check",
      titleKey: "options_enableWorkMode",
    },
    {
      key: "imageUploadToken",
      type: "text",
      // 憑證：由索引畫出時關掉瀏覽器自動填入（PrefModal.jsx#PrefIndexRows）。
      credential: true,
      titleKey: "options_imageUploadToken",
      tooltipKey: "tooltip_imageUploadToken",
    },
  ]),

  // ── 備份／同步 ──────────────────────────────────────────────────
  ...inSection("backup", "options_backupExport", "tooltip_backupExport", []),
  ...inSection("backup", "options_backupImport", "tooltip_backupImport", []),
  ...inSection("backup", "options_savedBackup", "tooltip_savedBackup", []),
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
    {
      key: "bgDebugRecord",
      type: "check",
      titleKey: "options_bgDebugRecord",
      tooltipKey: "options_bgDebugRecord_desc",
    },
  ]),
  ...inSection("about", "about_new_title", null, []),
];

// 索引項的 type＝設定頁用哪種欄位畫它（架構 review A7 第十一步，朝宣告式設定表走）：
// check＝勾選、select＝下拉、number＝數字、text＝單行文字、textarea＝名單、hotkey＝熱鍵。
// sub: true＝設定頁把它縮排畫在上層開關底下（.PrefModal__SubOptions，第十二步）。
// 守護 tests/unit/pref_field_type_index.test.js：JSX 的元件與預設值型別都要對得上。
/** @typedef {"check" | "select" | "number" | "text" | "textarea" | "hotkey"} PrefFieldType */

/**
 * min：數字欄的下限（由索引畫出的數字欄用；手寫的 PrefNumber 照舊自己帶）。
 * hintInBox：勾選列的說明畫在勾選框裡（Mantine Checkbox 的 description，緊貼標題下方），
 *   不是勾選列下面另一行灰字（PrefHint）。舊版設定頁兩種寫法並存，照原樣記下來，畫面不變。
 * shownIf：PREF_SHOWN_IF 的 id，條件不成立時設定頁整格不畫。
 * rows：名單欄（textarea）最少幾列高。
 * desktopOnly：手機版面不看這格（P100：終端機大小一組，手機一律照螢幕寬排 80 欄）⇒ 手機版面時
 *   設定頁不畫、設定搜尋也不列；設定值照留（跨裝置同步，桌機照舊用）。
 * mobileNoteKey：desktopOnly 的格子收起來時，在原位畫的一行說明（同一分區只畫第一個）；
 *   沒帶就靜靜收起（P96 滑鼠滾輪那類手機根本沒有的操作，不需要解釋）。
 * @typedef {{ key: string, type?: PrefFieldType, sub?: boolean, titleKey: string, tooltipKey?: string, requires?: string, min?: number, hintInBox?: boolean, shownIf?: string, rows?: number, desktopOnly?: boolean, mobileNoteKey?: string }} PrefIndexItem
 */

// key → 索引項（只收 kind:"pref"）。設定頁的 PrefCheckRow 從這裡拿標題與說明的文字鍵
// ⇒ 那些列的字跟搜尋結果是同一份來源，不會一邊改了另一邊沒跟上。
const PREF_ITEM_BY_KEY = new Map(
  PREF_SEARCH_ITEMS.filter((it) => it.kind === "pref").map((it) => [it.key, it]),
);

/**
 * @param {string} key pref key（同 data-pref-anchor）
 * @returns {PrefIndexItem | undefined}
 */
export function prefItem(key) {
  return PREF_ITEM_BY_KEY.get(key);
}

// 只在另一格選了某個值時才畫出來的設定（架構 review A7 第十六步）。跟 requires 不同：
// requires 是「上層關掉就反灰」，shownIf 是「選項不適用就整格不畫」（例如終端機大小選
// 「固定字型大小」時，行列數欄位根本不出現）。索引項的 shownIf 寫這張表的 id。
// wrap：連續幾格同一個條件時包進一個 <div>（舊版設定頁的寫法，照原樣保留，畫面不變）。
/** @type {Record<string, { key: string, eq?: string, ne?: string, wrap?: boolean }>} */
export const PREF_SHOWN_IF = {
  fixedTermSize: { key: "termSizeMode", eq: "fixed-term-size", wrap: true },
  fixedFontSize: { key: "termSizeMode", eq: "fixed-font-size" },
  mobileLayoutOn: { key: "mobileLayout", ne: "off" },
};

/**
 * 這一格現在要不要畫出來（沒有 shownIf、也不是 desktopOnly 的一律要）。
 * @param {string} key
 * @param {Record<string, unknown>} values
 * @param {{ mobile?: boolean }} [env] mobile＝目前是手機版面（App.mobile）
 */
export function prefShown(key, values, env = {}) {
  const it = PREF_SEARCH_ITEMS.find((x) => x.key === key);
  if (!it) return true;
  if (it.desktopOnly && env.mobile) return false;
  if (!it.shownIf) return true;
  const cond = PREF_SHOWN_IF[it.shownIf];
  if (!cond) throw new Error(`prefShown: ${key} 的 shownIf ${it.shownIf} 不在表裡`);
  const v = values[cond.key];
  if ("eq" in cond) return v === cond.eq;
  return v !== cond.ne;
}

/**
 * 某個分區由索引畫出時要畫的每一列：設定項，加上沒有 name 的可操作項（ui:…，
 * 由呼叫端用 custom 手寫），照設定頁上的順序。
 * @param {string} sectionKey
 * @returns {Array<PrefIndexItem & { kind: string }>}
 */
export function prefSectionRows(sectionKey) {
  return PREF_SEARCH_ITEMS.filter(
    (it) =>
      (it.kind === "pref" || it.kind === "ui") && it.sectionKey === sectionKey,
  );
}

/**
 * 某個分區（sectionKey＝該分區 legend 的 i18n key）的設定項，照設定頁上的順序。
 * 設定頁由索引畫出的分區（PrefModal.jsx 的 <PrefIndexRows>，架構 review A7 第十三步）就照這個順序畫。
 * @param {string} sectionKey
 * @returns {PrefIndexItem[]}
 */
export function prefSectionItems(sectionKey) {
  return PREF_SEARCH_ITEMS.filter(
    (it) => it.kind === "pref" && it.sectionKey === sectionKey,
  );
}

// 前置開關（架構 review A7 第九步）：索引項的 requires＝「這一格要那一格開著才有作用」，
// 關掉時設定頁把這一格反灰（值照舊保留）。可以一層接一層（推文列的子選項 → 推文列 → 長推文）。
// 回傳由近到遠的整條前置鏈；鏈上任一格關掉，這一格就反灰。
/**
 * @param {string} key
 * @returns {string[]}
 */
export function prefRequiresChain(key) {
  /** @type {string[]} */
  const chain = [];
  let cur = prefItem(key);
  while (cur && cur.requires) {
    if (cur.requires === key || chain.includes(cur.requires))
      throw new Error(`prefRequiresChain: ${key} 的前置開關繞成圈`);
    chain.push(cur.requires);
    cur = prefItem(cur.requires);
  }
  return chain;
}

/**
 * 前置鏈上有沒有一格是關的（＝這一格要反灰）。勾選列以外的欄位（熱鍵、下拉、文字、名單）
 * 用它：disabled={prefRequiresOff("proxyUrl", values)}。數字下拉 0 也算關（滾輪 mouseWheel）。
 * @param {string} key
 * @param {Record<string, unknown>} values
 */
export function prefRequiresOff(key, values) {
  return prefRequiresChain(key).some((k) => !values[k]);
}

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
