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
  // 連續兩條分隔線只留一條（手機把整段工具項搬去「更多」後，那段可能是空的）。
  const divider = (key) => {
    const last = out[out.length - 1];
    if (last && last.type === "divider") return;
    out.push({ type: "divider", key });
  };
  const previews = p.previews || {};
  const quickSearchItems = p.quickSearchItems || [];

  // 黑名單快速新增：桌機右鍵落在作者/標題區塊才出現；手機卡片長按整張都算，兩項
  // 一起出現（context_menu_items.listBlacklistTargets）。作者已在黑名單 → 反灰顯示「已在黑名單」不給點（不隱藏，避免
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
  // 看板列表「<板名> 設為已讀」：作用在右鍵／長按的那一列（board.c 的 `v` 只認游標所在
  // 那個看板），所以桌機手機都放這裡，不放手機「更多」。判定在 board_mark_read.targetAtRow。
  if (p.normalEnabled && p.boardMarkReadTarget)
    item(
      "boardMarkRead",
      `'${p.boardMarkReadTarget.name}' ${i18n("cmenu_boardMarkRead")}`,
      (e) => p.onMenuSelect("boardMarkRead", e),
    );
  // 「設為全部已讀」：文章列表（列表好讀與原生都可，判定在 mark_all_read.available）。
  // 手機不放這裡：在工具列「更多」（MobileToolbar）。
  const markAllRead = p.normalEnabled && p.markAllReadEnabled && !p.mobile;
  if (markAllRead)
    item("markAllRead", i18n("cmenu_markAllRead"), (e) =>
      p.onMenuSelect("markAllRead", e),
    );
  if (
    p.normalEnabled &&
    (p.authorBlacklistId ||
      p.titleBlacklistText ||
      p.markReadTarget ||
      p.boardMarkReadTarget ||
      markAllRead)
  )
    divider("d-blacklist");
  // 回覆這則推文（推文列預填 → 與帳號）：放在推文那一段的最前面。出現條件在 index.jsx
  //（推文列看得到＋開關＋是帳號）。
  if (p.replyCommentTarget)
    item(
      "replyComment",
      `${i18n("cmenu_replyComment")} '${p.replyCommentTarget}'`,
      (e) => p.onMenuSelect("replyComment", e),
    );
  // 手機推文卡片：長按就能複製整則推文（推文第一個字貼著螢幕左緣，選取把手拉不過去）。
  // 出現與否＝預覽算不算得出來（context_menu_items 的 copyComment／copyCommentAll），
  // 與連結／選取旗標無關：長按推文裡的網址也照樣給。
  if (previews.copyComment)
    item(
      "copyComment",
      i18n("cmenu_copyComment"),
      (e) => p.onMenuSelect("copyComment", e),
      { preview: previews.copyComment, copy: true },
    );
  if (previews.copyCommentAll)
    item(
      "copyCommentAll",
      i18n("cmenu_copyCommentAll"),
      (e) => p.onMenuSelect("copyCommentAll", e),
      { preview: previews.copyCommentAll, copy: true },
    );
  if (p.replyCommentTarget || previews.copyComment || previews.copyCommentAll)
    divider("d-comment");
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
    // 全選、圖片上傳兩項：手機搬到工具列「更多」（p.mobile ＝ ContextSheet 畫的）。
    if (!p.mobile)
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
    if (p.imageUploadEnabled && !p.mobile) {
      item("uploadImage", i18n("cmenu_uploadImage"), (e) =>
        p.onMenuSelect("uploadImage", e),
      );
      item("uploadHistory", i18n("cmenu_uploadHistory"), (e) =>
        p.onMenuSelect("uploadHistory", e),
      );
    }
    divider("d-tools");
  }
  // 指令面板（pref enableCommandPalette，預設開）：快捷鍵之外的入口，手機長按也有。
  if (p.commandPaletteEnabled)
    item(
      "commandPalette",
      i18n("cmenu_commandPalette"),
      p.onCommandPaletteClick,
      p.commandPaletteKey && !p.mobile
        ? { right: p.commandPaletteKey }
        : undefined,
    );
  item("settings", i18n("cmenu_settings"), p.onSettingsClick);
  return out;
}
