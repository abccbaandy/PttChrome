// 設定索引（設定頁每一格的鍵名、分頁、分區、型別、文字鍵、前置開關、顯示條件）：**葉模組**。
//
// 從 pref_search.js 抽出來（架構 review A7「設定表單一來源」）：這裡只放資料與查表函式，
// **不准 import 語系檔或 i18n**（守護 tests/unit/pref_schema_leaf.test.js）——之後要把預設值、
// 安全模式名單、上雲與否併進同一張表，pref_storage（開站就載）才 import 得動它而不把整份
// 語系字串拉進主 bundle。比對／排序（要讀語系字串）留在 pref_search.js，它照舊 re-export
// 這裡的所有東西，呼叫端不用改。
//
// key 的命名規則、索引與設定頁的關係見 pref_search.js 檔頭。
import { IMAGE_PROXY_SITES } from "./image_proxy";

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
  historyImportFile:
    "隱藏的 <input type=file>，不是設定項；入口是閱讀紀錄的匯入按鈕（已由 section:options_historyBackup 代表）",
  syncReadLater:
    "只在登入雲端同步後才畫出來（沒登入就沒東西可同步），搜尋跳不到；由 section:options_sync 代表",
  "quickSearchBuiltin-":
    "動態產生，內容取自 quick_search.js#BUILTIN_QUICK_SEARCH，會隨清單變動；由 section:options_quickSearchBuiltin 代表",
};

// DEFAULT_PREFS 裡**刻意**沒有索引項的設定（架構 review A7「三份清單對得起來」）。
// 其餘每個預設值都要有索引項：新增設定忘了進索引 ⇒ 設定頁畫不出來、搜尋找不到、
// 也沒有型別可以檢查。值是理由；守護 tests/unit/pref_schema_lists.test.js。
export const PREF_DEFAULTS_NOT_INDEXED = {
  syncReadLater:
    "只在登入雲端同步後才畫出來，見 PREF_SEARCH_EXEMPT_NAMES；由 section:options_sync 代表",
  easyReadingListPrefetchCount:
    "列表／看板列表背景先抓幾列的內部調校值，設定頁沒有這一格",
  mouseBrowsingHighlightColor:
    "色票列（一排顏色鈕）沒有 name，由索引的 ui:highlightColor 代表",
  quickSearchDisabled:
    "快速搜尋內建列的勾選狀態（存成被關掉的 id 清單），由 section:options_quickSearchBuiltin 代表",
  quickSearchCustom:
    "快速搜尋自訂列（動態多列），由 section:options_quickSearchCustom 代表",
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
      key: "searchPushPresets",
      type: "check",
      titleKey: "options_searchPushPresets",
      tooltipKey: "tooltip_searchPushPresets",
    },
    {
      key: "searchRecentBoards",
      type: "check",
      titleKey: "options_searchRecentBoards",
      tooltipKey: "tooltip_searchRecentBoards",
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
      key: "mobileArticleInfo",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileArticleInfo",
      tooltipKey: "tooltip_mobileArticleInfo",
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
      key: "mobileDigestStatus",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileDigestStatus",
      tooltipKey: "tooltip_mobileDigestStatus",
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
      key: "mobileClassRootCards",
      type: "check",
      shownIf: "mobileLayoutOn",
      titleKey: "options_mobileClassRootCards",
      tooltipKey: "tooltip_mobileClassRootCards",
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
    { key: "enableQuoteCollapse", type: "check", titleKey: "options_enableQuoteCollapse" },
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
    { key: "autoLogin", type: "check", titleKey: "options_autoLoginEnable" },
    // noAutofill：Chrome 曾把這顆 Select 的內層 input 當成「帳號欄」配對到下面的密鑰欄，
    // 跳出「使用者名稱：刪除其他連線 (Y)」的假儲存提示 ⇒ 關掉自動填入。
    {
      key: "autoLoginDupConn",
      type: "select",
      titleKey: "options_autoLoginDupConn",
      noAutofill: true,
    },
    { key: "autoLoginSkipWelcome", type: "check", titleKey: "options_autoLoginSkipWelcome" },
  ]),
  // tooltip_autoLogin（帳密交給密碼管理員的警告）是整組憑證的說明，不是開關那一格的 ⇒ 掛在分區上。
  ...inSection("autologin", "options_autoLoginCredentials", "tooltip_autoLogin", [
    {
      key: "autoLoginUser",
      type: "text",
      titleKey: "options_autoLoginUser",
      credential: true,
    },
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
  ...inSection("backup", "options_historyBackup", "tooltip_historyBackup", []),
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
