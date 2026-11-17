// @ts-check
// 新功能介紹（P71）每一條的「⚙ 設定」：README 功能名稱 → 設定頁上對應的項目。
//
// **這個檔不可 import pref_search.js**：首頁儀表板是開站必載的，pref_search 會把兩份語系檔整包拖進
// 首屏（tests/unit/lazy_modal_chunks.test.js 守）。分頁在按下去時才由 ContextMenu 動態載入索引查。
//
// 值是設定搜尋索引（pref_search.js#PREF_SEARCH_ITEMS）的 key：pref 名稱、`ui:…` 或 `section:…`，
// 也就是設定頁的 data-pref-anchor；按下去＝打開設定頁、切到那個分頁、捲到那一項並短暫高亮
// （跟指令面板挑設定項同一條 prefJump）。
// null ＝這個功能沒有對應的開關（一律開著、只有右鍵／按鍵入口、或是平台本身），不放按鈕。
//
// **README 每加一條功能就要在這裡補一列**（key 或 null 都行，但不能漏）：
// tests/unit/whats_new_settings.test.js 掃真的 README 守；改功能名稱也要跟著改這裡。
import { isAndroidApp } from "./android_bridge";
import { sshSupported } from "./ssh/ssh_transport";
/** @type {Record<string, string | null>} */
export const FEATURE_SETTING = {
  // 📖 閱讀文章
  好讀模式: "enableEasyReading",
  "Ctrl+F 搜全文": "easyReadingBrowserFind",
  推文篩選: "enableCommentFilter",
  新推文標記: "markNewComments",
  推文樓層編號: "showFloorNumbers",
  同作者連續推文合併: "mergeSameAuthorComments",
  推文區塊行距: "commentBlockSpacing",
  "高亮原 PO／自己／點選推文者": "highlightAuthorComments",
  讀完接著讀下一篇: "enableNextArticleCard",
  文章工具側欄: "enableArticleTools",
  文章導覽軸: "enableArticleNav",
  底列顯示讀到哪: "easyReadingFooterProgress",
  開燈: "showLightsOnButton",
  翻譯漫畫圖文並排: "showMergeCaptionButton",
  "圖文並排 AI 校正（實驗性，需 Chrome）": "enableCaptionAi",
  // 📋 看板與文章列表
  首頁儀表板: "enableHomeDashboard",
  離線文章: "enableSavedArticles",
  "最近讀過／稍後閱讀": "enableRecentArticles",
  看板分頁: "enableBoardTabs",
  寬螢幕雙欄閱讀: "enableSplitReading",
  "文章列表好讀模式（實驗性）": "enableEasyReadingList",
  "看板列表平滑捲動（實驗性）": "enableBoardListSmoothScroll",
  列表原生捲動: "mouseWheelSmoothScroll",
  操作完自動切回好讀: "enableListNativeAutoResume",
  "右鍵「此篇以前已讀、以後未讀」": null,
  設為全部已讀: null,
  右鍵時標出選中的文章: "highlightMenuTarget",
  已讀文章低亮: "dimReadArticles",
  有新文章的看板一眼看得出來: "boardListUnreadMark",
  快速捲動把手: "enableListFastScroll",
  跳到第一篇未讀: "unreadJumpKey",
  跳過進板畫面: "skipBoardEntryScreen",
  重新整理: "refreshKeyIntercept",
  // 🚫 黑名單與關注
  "帳號／標題黑名單": "blacklist",
  右鍵快速加入: null,
  關注名單: "enableFollowList",
  // 🖼️ 圖片
  "自動開圖／影片預覽": "enablePicPreview",
  圖片倍率可調: null,
  "單張轉灰階／原生圖片右鍵": null,
  圖片載入代理: "useImgurProxy",
  // 🔗 連結
  自動修復斷掉的連結: "enableAutoFixUrl",
  更聰明的自動連結: "enableBareDomainLink",
  "@帳號連到 X": "enableXMentionLink",
  "Steamgifts 代碼連結": null,
  "文章代碼（AID）一鍵跳文": "aidNavBackKey",
  "文章分享連結（deep link）": "deepLinkCopyKey",
  "右鍵複製文章代碼／分享連結": null,
  連結沿用既有分頁: "deepLinkHandoffNotify",
  // ✍️ 推文與發文
  長推文一鍵發送: "enableLongPush",
  推文實況: "enableLiveArticleHelper",
  底部推文列: "enableCommentBar",
  編輯器輸入框: "enableEditorInput",
  拖曳貼圖上傳: "enableImageUpload",
  搜尋彈窗: "searchKeyOpensModal",
  推文數常用門檻: "searchPushPresets",
  搜尋狀態列: "enableSearchStatus",
  水球收件匣: "enableMessageInbox",
  快速搜尋: "section:options_quickSearchCustom",
  // ⌨️ 操作
  指令面板: "enableCommandPalette",
  滑鼠操作重新設計: "useMouseBrowsing",
  邊緣點擊翻頁: "mouseEdgePaging",
  功能鍵提示可直接點: "mouseFunctionKeys",
  "「按任意鍵繼續」點一下就關": null,
  "瀏覽器「上一頁」＝退出文章": "mouseBackNav",
  "Alt（Mac 為 Option）＝ PTT 的 Ctrl": null,
  "把滑鼠交給 PTT（預設關閉）": "mouseServerReport",
  說明選單好讀: "enableHelpMenuPopup",
  // 🎨 外觀
  "暗色／淺色主題": "ui:theme",
  游標列標示: "cursorRowBrighten",
  游標不重複: "autoHideBlinkCursor",
  上班模式: "enableWorkMode",
  提示音: "enableBell",
  狀態提示可關閉: "showStatusHints",
  // 🔌 連線
  "自動登入／2FA 自動填入": "autoLogin",
  "內建 Proxy 連線": "useProxy",
  連線失敗診斷: null,
  "SSH 連線": "connectionProtocol",
  連線保持與斷線偵測: "antiIdleTime",
  斷線重連回到原處: "reconnectResume",
  開站回到上次的地方: "resumeLastPlace",
  "UTF-8 連線（實驗性）": "connectionEncoding",
  // 📱 手機
  "手機版面（Android Chrome）": "mobileLayout",
  手機選單收起動態看板: "mobileMenuBannerCollapse",
  手機看板捷徑: "mobileBoardTools",
  手機信箱捷徑: "mobileMailListTools",
  手機精華區卡片: "mobileEssenceCards",
  手機文摘標示: "mobileDigestStatus",
  手機提問選項: "mobilePromptChoices",
  手機開鍵盤輸入: "mobilePromptKeyboard",
  手機按任意鍵繼續: "mobileAnyKeyContinue",
  手機選取文字: "mobileSelectTextPage",
  手機折行保留縮排: "mobileHangIndent",
  手機文章內找字: "mobileFindInArticle",
  手機文章工具收進更多: "mobileFloatToolsInMore",
  手機編輯器存檔: "mobileEditorSave",
  "Android App": "enableNotifications",
  "Android App 自動更新": null,
  "一鍵登出並關閉 App": null,
  行動網路省流量開圖: "tapToLoadImagesOnMobileData",
  // ⚙️ 設定與其他
  偏好設定雲端同步: "section:options_sync",
  "設定匯出／匯入": "section:options_backupExport",
  設定搜尋: null,
  快捷鍵一覽: null,
  更新後的新功能介紹: "showWhatsNew",
  "安全模式：全部用原生": "nativeSafeMode",
  右鍵選單精簡: "enableInputHelper",
  "Debug 錄製模式": "bgDebugRecord",
  "AI agent 操作（實驗性）": null,
};

// 設定頁上依平台不畫的項目（PrefModal.jsx 連線分頁）：按了開得到設定頁卻找不到那一項 ⇒ 不放按鈕。
//   useProxy：Android App 連線固定走原生前景服務，整組 proxy 設定不畫。
//   connectionProtocol：Android App 不畫；瀏覽器沒有 WebCrypto（非 secure context）也不畫。
/** @type {Record<string, (env: { android: boolean, ssh: boolean }) => boolean>} */
const HIDDEN_ON = {
  useProxy: (env) => env.android,
  connectionProtocol: (env) => env.android || !env.ssh,
};

function currentEnv() {
  return { android: !!isAndroidApp(), ssh: !!sshSupported() };
}

/**
 * 功能名稱 → 設定搜尋索引的 key；沒有對應開關、這個平台的設定頁不畫那一項、或不認得的名稱 ⇒ null。
 * @param {string} name
 * @param {{ android: boolean, ssh: boolean }} [env] 測試注入；省略＝讀目前環境
 * @returns {string | null}
 */
export function settingKeyFor(name, env) {
  const key = Object.prototype.hasOwnProperty.call(FEATURE_SETTING, name)
    ? FEATURE_SETTING[name]
    : null;
  if (!key) return null;
  const hidden = HIDDEN_ON[key];
  return hidden && hidden(env || currentEnv()) ? null : key;
}
