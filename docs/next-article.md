# 讀完接著讀下一篇（`next_article.js`）

動 `next_article.js`、文末標題卡的 CSS（`css/main.css` 的 `#nextArticleCard`）前先讀。

## 是什麼

好讀文章讀到文末，最後一則推文下面留一段空白，再放一張「下一篇」標題卡（標題、推文數、作者、日期，取自列表快照）。點它就換過去讀。**捲到底不會自己換文**（L 10/19：怕看不到最底部的推文）。開關 `enableNextArticleCard`（預設開，會替使用者送鍵 ⇒ 在安全模式名單內）。

## 規則

- **下一篇＝列表順序的下一列**：原生「看完按空白」是 pmore `pmore_cmd_space` → `READ_NEXT` → read.c `read_key_handle_mode_navigation` 的 `crs_ln + 1`，不是「下一篇新文」：最後一篇的下一列是置底文，搜尋結果裡是結果的下一筆。所以卡片只認列表快照（`split_reader.listPageOf`／`mergeSnapshot`，自己留一份，不依賴雙欄閱讀的開關）裡編號正好是「這篇＋1」的那一列（列表好讀會藏起來的列：被刪的、鎖文、黑名單，都跳過，再看下一號；判準 `list_row_filter#hiddenReason`，見 `docs/list-row-filter.md`，黑名單取讀到文末那一刻的設定）。下一號沒看過（還沒載入的頁）或這篇是最後一篇（下一列是沒有編號的置底文）⇒ 不出現。
- **搜尋結果／文摘另留一份快照**：MODE_SELECT 把列表重新編號（read.c 的 remap），原生 `READ_NEXT` 在結果裡就是結果的下一筆 ⇒ 從搜尋結果進的文章，卡片取結果快照（`_subSnapshot`）的下一號。畫面看不出搜尋條件 ⇒ 新的一頁跟舊快照有任何一號對不上（作者＋主題，被刪的不算）就整份換掉（`mergeSubSnapshot`）；看到完整列表（離開過搜尋）也丟掉。完整列表的快照與它分開存，各用各的編號。
- **認不出 ⇒ 原生**：只在「好讀文章（pageState 3、`_enabled`、非 functionMode、非反向讀取中）＋已讀到文末（`easyReadingReachedPageEnd`）＋上一次看到的列表是同一板的列表（完整列表或搜尋結果）＋這篇在那份快照裡認得出來（`findCurrentNum`）」時出現。deep link 直接開的文章不出現。
- **改過標題的文章，列表≠檔頭**：PTT 的 `T`（bbs.c `edit_title`）只改 `.DIR`（`modify_dir_lite`），文章檔頭不動 ⇒ 主題永遠比不上。所以「這篇是哪一篇」主題對不上時退回「開文前游標停的那篇」作者對得上就信（`findCurrentNum` 的 hintFresh）；游標只對**看過列表之後的第一篇**可信（`split_reader.cursorHintFresh`：第一次看到的檔頭記在 `_lastList` 上，之後換成別的檔頭＝在文章裡用原生鍵換過篇，游標早已不是那篇），每次文章 settle 都要記，不只讀到文末時。落地比對同理：檔頭主題對不上就比換文途中 `<編號>⏎` 後游標停的那一列（`_nav.seen`，列表對列表）。
- **換文＝原生鍵**：完整列表走 `aid_navigation.startNum(板, 編號)`（文章內 `s<板>⏎` → `<編號>⏎` 驗游標 → `⏎` 驗落在文章）。搜尋結果走 `startSubNum(板, 編號, verify)`：`s<板>` 與 `#` 都會離開結果或被拒，所以改成文章內 `←`（pmore 結束回 i_read，仍在同一份結果；要求落在同板的子列表）→ `<編號>⏎`（read_cmd_num 只看目前列表）→ **游標那一列的作者＋主題是卡片上那篇才 `⏎`**（快照可能是上一次搜尋的；認不出就停在列表，不開錯篇）。只從證明是 READING 的 pager 出發。落地後再用作者＋主題比一次卡片上那篇（`landedOn`），不符（列表在我們沒看到時變了）就給錯誤級提示，不再送任何鍵，人留在 PTT 給的文章。閱讀紀錄 `next-article`：一律不還原（同 `split-open`）。按「←」回列表時游標就在新開的那篇（PTT 自己的游標）。
- **不寫 `#mainContainer`**：卡片是 `.main`（好讀的捲動容器）裡、`#screenRoot` 後面的 `<button>`，跟著文末一起捲；核心渲染鏈不知道它存在。第一次要顯示時才建，之後只切 `hidden`。
- **「捲到文末了沒」要扣掉卡片**：`reading_record.trailingPx(view)`（`view.nextArticleCard` 的高度＋上下 margin）。讀者停在最後一則推文、卡片還在視窗下面，也算在文末（斷線回到原處、重新整理的「黏回文末」靠它）。
- **滑鼠**：App 的滑鼠入口在 window ⇒ 卡片自己 `mousedown` preventDefault（不搶 `#t` 焦點）＋三個事件都 stopPropagation；`App._onUploadLayer` 認 `#nextArticleCard`（滾輪照常捲 `.main`，不變成點終端機）。
- **設計**：中性灰細框＋小字，不用彩色（推文區已經有原PO藍、自己綠、樓層黃，L 要求推文區不要花花綠綠）。
- **線路忙就不送**：`serializedOpHint` 有值或 CommandQueue 不閒 ⇒ 不送；換文途中卡片顯示「開啟中…」，45 秒看門狗。
- e2e：`installReplay` 預設把 `enableNextArticleCard` 關掉（累積頁尾端多一張卡片、改變捲到底的位置），live 的自動登入 prefs 也關掉；只有 `next_article.offline.spec.js` 以 `bootOffline(page, ptt, { nextArticle: true })` 打開。

## 手機：捲到底再往上拉（`pull_next_article.js`）

L 同意的版本是「點標題卡**或**拉過門檻」。手機上的「往下捲」是手指往上推，所以這裡叫「往上拉」。

- **為什麼用觸控事件**：跟下拉重整（`docs/screen-refresh.md`）是同一個例外。瀏覽器的 overscroll 沒有任何入口告訴頁面「使用者在底部又拉了一段」，而觸控事件有完整相位（手指還在／放開了），所以能做到「拉過門檻、放手才生效」「拉回去就取消」。監聽是被動的（`passive`＋capture），從不 `preventDefault`，所以捲動、Android 原生的 overscroll 拉伸效果、點擊都照舊，我們只在放手那一下決定要不要開。**不碰滾輪**：WheelEvent 沒有相位（觸控板慣性的尾巴分不出使用者是不是還在拉），桌機只有點卡片。
- **起手條件**：手機版面、不在選字模式、沒有 modal、單指、卡片顯示中且不在開啟中，而且觸控點底下的 `.main` **已經捲到底**（`atScrollBottom`，內容比視窗短也算）。從工具列、App Bar、sheet、對話框、輸入框或卡片本身起手都不算（點卡片走 click）。
- **門檻**：直接用下拉重整的 `pullState`（阻尼 0.5、門檻 64px、斜拉取消），方向鏡像。拉的途中卡片的字跟著變：沒過門檻是「下一篇・再往上拉」，過了是「放開開啟下一篇」（`next_article.setPull`，卡片掛 `data-pull`）。放手時過門檻才 `open()`，沒過、拉回去、斜拉、中途捲離底部都只把字還原。
- 開關沿用 `enableNextArticleCard`：卡片不出現，拉的手勢也就不存在。

## 測試

unit：`next_article.test.js`（下一列的認法、何時出現、換文與失敗、落地比對、忙碌、看門狗、閱讀紀錄、預設與安全模式、搜尋結果的快照與換文）、`aid_navigation.test.js` 的 `startSubNum`、`next_article_dom.test.js`（真瀏覽器：卡片的位置、點擊不外洩、`trailingPx` 與 atBottom）、`pull_next_article.test.js`（往上拉的起手條件、門檻、拉回取消、卡片字樣）。offline e2e：`next_article.offline.spec.js`（卡片排在文末之後、真滑鼠點卡片只送 `s<板>⏎`、搜尋結果的卡片送 `←` 再跳結果裡的編號、最後一篇與 pref 關不出現）、`mobile_next_article.offline.spec.js`（offline-mobile，CDP 真觸控：沒過門檻不送鍵、拉過門檻放手送 `s<板>⏎`）。
