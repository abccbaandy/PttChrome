import { i18n } from "../../js/i18n";
import { quickSearchLabel } from "../../js/quick_search";

// 右鍵／長按選單的項目清單（純資料）。桌機畫成 Mantine Menu（DropdownMenu.jsx），手機
// 畫成 bottom sheet（ContextSheet.jsx）——兩邊共用這一份，順序與出現條件只有一個真相源。
// 項目在哪些條件下出現的說明見各段註解；出現條件的旗標由 index.jsx 算好傳進來。
//
// entry：
//   { type: "item", key, label, preview?, disabled?, right?, className?, onClick(e) }
//   { type: "divider", key }
// preview：複製類選項的第二行（「按下去實際會複製什麼」，context_menu_items.copyPreviews）。
export function buildContextMenuEntries(p) {
  const out = [];
  const item = (key, label, onClick, extra) =>
    out.push({ type: "item", key, label, onClick, ...(extra || {}) });
  const divider = (key) => out.push({ type: "divider", key });
  const previews = p.previews || {};
  const quickSearchItems = p.quickSearchItems || [];

  // 黑名單快速新增：右鍵落在作者/標題區塊才出現（見 index.js onContextMenu 的
  // 區塊判定）。作者已在黑名單 → 反灰顯示「已在黑名單」不給點（不隱藏，避免
  // 看起來像選項壞掉）。
  if (p.normalEnabled && p.authorBlacklistId)
    item(
      "addAuthorBlacklist",
      p.authorBlacklistExists
        ? `'${p.authorBlacklistId}' ${i18n("cmenu_authorBlacklistExists")}`
        : `${i18n("cmenu_addAuthorBlacklist")} '${p.authorBlacklistId}'`,
      (e) => p.onMenuSelect("addAuthorBlacklist", e),
      { disabled: !!p.authorBlacklistExists },
    );
  if (p.normalEnabled && p.titleBlacklistText)
    item(
      "addTitleBlacklist",
      i18n("cmenu_addTitleBlacklist"),
      p.onTitleBlacklistClick,
    );
  // 「前已讀後未讀」：只在列表好讀模式、右鍵落在有序號的文章列時出現
  // （判定在 list_session.markReadTargetAtRow）。不加確認對話框 ——
  // 原生 PTT 的 prompt 由我們代打，後果只能靠這行字說清楚。
  if (p.normalEnabled && p.markReadTarget)
    item("markReadUnread", i18n("cmenu_markReadUnread"), (e) =>
      p.onMenuSelect("markReadUnread", e),
    );
  if (
    p.normalEnabled &&
    (p.authorBlacklistId || p.titleBlacklistText || p.markReadTarget)
  )
    divider("d-blacklist");
  if (p.selEnabled) {
    item("copy", i18n("cmenu_copy"), (e) => p.onMenuSelect("copy", e), {
      right: "Ctrl+C",
    });
    item("copyAnsi", i18n("cmenu_copyAnsi"), (e) =>
      p.onMenuSelect("copyAnsi", e),
    );
  }
  if (p.normalEnabled)
    item("paste", i18n("cmenu_paste"), (e) => p.onMenuSelect("paste", e), {
      right: "Shift+Insert",
    });
  // 快速搜尋：一層平鋪，每項自帶關鍵字（像 Chrome 原生的右鍵搜尋）。清單與
  // 適用條件（任意文字／純數字）由 index.jsx 現讀偏好算出，這裡只負責排。
  quickSearchItems.forEach((qs) =>
    item(
      "qs-" + qs.id,
      `${quickSearchLabel(qs)} '${p.quickSearchQuery || ""}'`,
      (e) => p.onQuickSearchSelect(qs, e),
      { className: "DropdownMenu__QuickSearch" },
    ),
  );
  if (p.urlEnabled) {
    item("openUrlNewTab", i18n("cmenu_openUrlNewTab"), (e) =>
      p.onMenuSelect("openUrlNewTab", e),
    );
    item(
      "copyLinkUrl",
      i18n("cmenu_copyLinkUrl"),
      (e) => p.onMenuSelect("copyLinkUrl", e),
      { preview: previews.copyLinkUrl, copy: true },
    );
  }
  // 游標下的連結指向某一篇文章時多給兩個選項。獨立成一塊而不是掛進上面的
  // urlEnabled：ptt.cc 文章網址走 urlEnabled、好讀模式的文章代碼連結走
  // normalEnabled（它的 href 是佔位符，不算 URL），兩邊共用同一塊才不必寫兩份。
  if (p.contextArticle) {
    item(
      "copyArticleAid",
      i18n("cmenu_copyArticleAid"),
      (e) => p.onMenuSelect("copyArticleAid", e),
      { preview: previews.copyArticleAid, copy: true },
    );
    item(
      "copyArticleDeepLink",
      i18n("cmenu_copyArticleDeepLink"),
      (e) => p.onMenuSelect("copyArticleDeepLink", e),
      { preview: previews.copyArticleDeepLink, copy: true },
    );
  }
  divider("d-main");
  if (p.normalEnabled) {
    item(
      "selectAll",
      i18n("cmenu_selectAll"),
      (e) => p.onMenuSelect("selectAll", e),
      {
        right: "Ctrl+A",
      },
    );
    // 複製本篇文章的 deep link（外部程式貼上後點開即跳回這篇）。只在
    // 文章畫面出現：要靠 Q 資訊框才問得出本篇的 AID。
    if (p.articleLinkEnabled)
      item(
        "copyArticleLink",
        i18n("cmenu_copyArticleLink"),
        (e) => p.onMenuSelect("copyArticleLink", e),
        { preview: previews.copyArticleLink, copy: true },
      );
    // 長推文一鍵發送：打一大段話，自動依 PTT 單則上限分段依序推出。
    // 只在文章畫面出現（要按得到 X），總開關 enableLongPush 預設開。
    if (p.longPushEnabled)
      item("longPush", i18n("cmenu_longPush"), p.onLongPushClick);
    // 兩個小幫手是小眾功能，**預設不顯示**（enableInputHelper /
    // enableLiveArticleHelper，設定→一般→右鍵選單），手法同下面的圖片上傳。
    if (p.inputHelperEnabled)
      item("inputHelper", i18n("cmenu_showInputHelper"), p.onInputHelperClick);
    if (p.liveArticleHelperEnabled)
      item(
        "liveArticleHelper",
        i18n("cmenu_showLiveArticleHelper"),
        p.onLiveArticleHelperClick,
      );
    // 圖片上傳（urusai）。拖放與 Ctrl+V 是主要入口，這兩項給「不方便
    // 拖曳」與「想插入之前傳過的圖」的情況；跟著總開關 enableImageUpload。
    if (p.imageUploadEnabled) {
      item("uploadImage", i18n("cmenu_uploadImage"), (e) =>
        p.onMenuSelect("uploadImage", e),
      );
      item("uploadHistory", i18n("cmenu_uploadHistory"), (e) =>
        p.onMenuSelect("uploadHistory", e),
      );
    }
    divider("d-tools");
  }
  item("settings", i18n("cmenu_settings"), p.onSettingsClick);
  return out;
}
