# 讀完接著讀下一篇（`next_article.js`）

動 `next_article.js`、文末標題卡的 CSS（`css/main.css` 的 `#nextArticleCard`）前先讀。

## 是什麼

好讀文章讀到文末，最後一則推文下面留一段空白，再放一張「下一篇」標題卡（標題、推文數、作者、日期，取自列表快照）。點它就換過去讀；桌機也可以在文末停一下再繼續往下捲，手機可以再往上拉。**捲到底不會自己換文**（L 10/19：怕看不到最底部的推文；L 10/21 再確認：要保留每篇文章的獨立性）。開關 `enableNextArticleCard`（預設開，會替使用者送鍵 ⇒ 在安全模式名單內）。

## 規則

- **下一篇＝列表順序的下一列**：原生「看完按空白」是 pmore `pmore_cmd_space` → `READ_NEXT` → read.c `read_key_handle_mode_navigation` 的 `crs_ln + 1`，不是「下一篇新文」：最後一篇的下一列是置底文，搜尋結果裡是結果的下一筆。所以卡片只認列表快照（`split_reader.listPageOf`／`mergeSnapshot`，自己留一份，不依賴雙欄閱讀的開關）裡編號正好是「這篇＋1」的那一列（列表好讀會藏起來的列：被刪的、鎖文、黑名單，都跳過，再看下一號；判準 `list_row_filter#hiddenReason`，見 `docs/list-row-filter.md`，黑名單取讀到文末那一刻的設定）。
- **接不下去 ⇒ 終點卡，不是不出現**（L 10/21：什麼都沒有會以為功能壞了）。認得出這篇、卻找不到下一篇時，卡片換成不能點的虛線框（`data-end`，`aria-disabled`）：
  - `last`「已無下一篇」：這篇之後列表就結束了。盡頭的認法（`split_reader#listPageOf` 的 `endNum`）：read.c 的列表是捲動視窗（`read_move_cursor` 的 base），置底文（bottom_count）恆排在所有編號文章後面，超過 last_line 的列畫成空白 ⇒ 最後一列有編號的文章下面緊接著置底文或空列，它就是最後一篇。編號文章排到畫面最底一列 ⇒ 看不出來（`null`）。快照記住看過的盡頭，之後出現更大的編號（新文章）就作廢（`mergeSnapshot`）。`listEndsAfter`：從下一號到盡頭每一號都看過（而且都被跳過）才算。
  - `unknown`「已到文末」：下一號在還沒看過的列表頁（最常見：這篇是列表頁的最底一列）。卡片請人回列表往下翻，翻過之後這裡就會出現下一篇。
  - 認不出這篇（deep link、沒看過列表、別的板…）仍然整張不出現。
- **搜尋結果／文摘另留一份快照**：MODE_SELECT 把列表重新編號（read.c 的 remap），原生 `READ_NEXT` 在結果裡就是結果的下一筆 ⇒ 從搜尋結果進的文章，卡片取結果快照（`_subSnapshot`）的下一號。畫面看不出搜尋條件 ⇒ 新的一頁跟舊快照有任何一號對不上（作者＋主題，被刪的不算）就整份換掉（`mergeSubSnapshot`）；看到完整列表（離開過搜尋）也丟掉。完整列表的快照與它分開存，各用各的編號。
- **認不出 ⇒ 原生**：只在「好讀文章（pageState 3、`_enabled`、非 functionMode、非反向讀取中）＋已讀到文末（`easyReadingReachedPageEnd`）＋上一次看到的列表是同一板的列表（完整列表或搜尋結果）＋這篇在那份快照裡認得出來（`findCurrentNum`）」時出現。deep link 直接開的文章不出現。
- **改過標題的文章，列表≠檔頭**：PTT 的 `T`（bbs.c `edit_title`）只改 `.DIR`（`modify_dir_lite`），文章檔頭不動 ⇒ 主題永遠比不上。所以「這篇是哪一篇」主題對不上時退回「開文前游標停的那篇」作者對得上就信（`findCurrentNum` 的 hintFresh）；游標只對**看過列表之後的第一篇**可信（`split_reader.cursorHintFresh`：第一次看到的檔頭記在 `_lastList` 上，之後換成別的檔頭＝在文章裡用原生鍵換過篇，游標早已不是那篇），每次文章 settle 都要記，不只讀到文末時。落地比對同理：檔頭主題對不上就比換文途中 `<編號>⏎` 後游標停的那一列（`_nav.seen`，列表對列表）。
- **換文＝原生鍵**：完整列表走 `aid_navigation.startNum(板, 編號, done, verify)`（文章內 `s<板>⏎` → `<編號>⏎` 驗游標 → **游標那一列是卡片上那篇（`split_reader.snapshotCursorVerify`：同編號、沒刪、作者＋主題、發文日期；同一人同一串的原文／回文身分一樣，落地那頁有兩列以上同身分時還要編號 ±1 的鄰居跟快照對得上）才 `⏎`** → 驗落在文章）。完整列表的編號是位置：快照之後有人刪文／搬文，同一個編號就是別篇，開下去會把別篇記成讀過（已讀、最近讀過、新推文紀錄），落地才比對就收不回來。搜尋結果走 `startSubNum(板, 編號, verify)`：`s<板>` 與 `#` 都會離開結果或被拒，所以改成文章內 `←`（pmore 結束回 i_read，仍在同一份結果；要求落在同板的子列表）→ `<編號>⏎`（read_cmd_num 只看目前列表）→ **游標那一列的作者＋主題是卡片上那篇才 `⏎`**（快照可能是上一次搜尋的；認不出就停在列表，不開錯篇）。只從證明是 READING 的 pager 出發。落地後再用作者＋主題比一次卡片上那篇（`landedOn`），不符（列表在我們沒看到時變了）就給錯誤級提示，不再送任何鍵，人留在 PTT 給的文章。閱讀紀錄 `next-article`：一律不還原（同 `split-open`）。按「←」回列表時游標就在新開的那篇（PTT 自己的游標）。
- **不寫 `#mainContainer`**：卡片是 `.main`（好讀的捲動容器）裡、`#screenRoot` 後面的 `<button>`，跟著文末一起捲；核心渲染鏈不知道它存在。第一次要顯示時才建，之後只切 `hidden`。
- **卡片的位置：接在最後一列內容下面、捲到底時在 footer／推文列上面**。`#mainContainer` 的尾端有一段空白：推文少的文章 pmore 把剩下的列畫成空白、好讀 footer 的 `paddingBottom`、底部推文列的 `::after`（`html.commentBarShown`）。卡片若單純排在它後面，推文少就得捲一段才看得到；而那兩段保留空白在卡片「前面」，捲到底時 fixed 的推文列反而壓在卡片上。所以 `_layout` 量兩個事實寫成 CSS 變數，margin 交給 `main.css #nextArticleCard` 算：`--next-pull-up`＝尾端空白（`trailingBlankPx`：最後一個有內容的節點下緣量到 `#mainContainer` 下緣；空白列＝只有空白字、沒有圖、底色全是 `b0`，有底色的空白算內容；`position: fixed／absolute` 的節點不算——`render/screen.js` 把浮動工具 `.floatTools` 跟列掛在同一層，它是視窗座標，算進去卡片會被拉到文章中間）⇒ 上 margin 變負的，卡片往上蓋住空白；`--next-bottom-inset`＝`.main` 下緣被蓋掉多高（footer 上緣、推文列 `state.bottom` 算出的上緣、`view.keyboardInset`＝手機底部導覽列＋軟鍵盤，取最高的那個；手機的 `.main` 會延伸到導覽列後面幾 px，只加固定列高會差那幾 px）⇒ 下 margin 讓出它們。這一類「浮層蓋住文末」由 e2e `bottom_overlay`／`mobile_bottom_overlay` 以功能組合矩陣通用守護（`tests/e2e/helpers/overlay_guard.js`）。重量時機：卡片顯示、每次 settle 的下一幀（內容變了高度沒變）、`#mainContainer` 的 ResizeObserver（補頁、預覽、字級、推文列的 `::after` 由 React effect 晚一步加上）、推文列 `onChange`。整張卡片縮進空白裡就不佔捲動高度 ⇒ `trailingPx` 下限 0。
- **換文途中不閃原生畫面：遮罩**（L 10/21）。換文是真的走一趟原生鍵，`aid_navigation._begin` 讓好讀進 functionMode 鏡像原生 ⇒ 不蓋的話會閃過原生文章頁與列表。`#nextArticleVeil` 是 body 底下 `position: fixed`、對齊 `.main` 矩形的不透明層，**在 `startNum`／`startSubNum` 之前**蓋上（start 同步就進 functionMode，先蓋才不會有一幀漏出去）；上面放下一篇的標題，從卡片目前的位置滑到頂端（像把下一篇捲上來，`prefers-reduced-motion` 不滑）。收法：失敗、start 沒接 ⇒ 馬上拿掉（人要看得到 PTT 給的原生畫面與錯誤提示，認不出 ⇒ 原生）；成功 ⇒ 等好讀接手新文章（`pageState 3`、`_enabled`、非 functionMode，每次 settle 都問）下一幀再淡出，最多等 2.5 秒。它不攔任何渲染、不碰 `#mainContainer`，只是蓋在上面；滑鼠事件同卡片不往 window 傳（`isNextArticleTarget` 兩個都認）。**不是無限捲動**：新文章仍是獨立的一頁，從頂端開始讀。
- **「捲到文末了沒」要扣掉卡片**：`reading_record.trailingPx(view)`（`view.nextArticleCard` 的高度＋上下 margin）。讀者停在最後一則推文、卡片還在視窗下面，也算在文末（斷線回到原處、重新整理的「黏回文末」靠它）。
- **滑鼠**：App 的滑鼠入口在 window ⇒ 卡片自己 `mousedown` preventDefault（不搶 `#t` 焦點）＋三個事件都 stopPropagation；`App._onUploadLayer` 認 `#nextArticleCard`（滾輪照常捲 `.main`，不變成點終端機）。
- **設計**：中性灰細框＋小字，不用彩色（推文區已經有原PO藍、自己綠、樓層黃，L 要求推文區不要花花綠綠）。
- **線路忙就不送**：`serializedOpHint` 有值或 CommandQueue 不閒 ⇒ 不送；換文途中卡片顯示「開啟中…」，45 秒看門狗。
- e2e：`installReplay` 預設把 `enableNextArticleCard` 關掉（累積頁尾端多一張卡片、改變捲到底的位置），live 的自動登入 prefs 也關掉；只有 `next_article.offline.spec.js` 以 `bootOffline(page, ptt, { nextArticle: true })` 打開。

## 同主題的上一篇／下一篇（P28，子開關 `nextArticleSameSubject`，預設開）

- **是什麼**：卡片下面一列（`#nextThreadRow`，卡片的下一個兄弟節點，同樣住在 `.main`、不寫 `#mainContainer`），最多兩顆按鈕「‹ 同主題上一篇」「同主題下一篇 ›」。把 pmore 的 `[`／`]` 變成看得到的卡片；**不送 `[`／`]`**，換文跟卡片走同一條 `open(target)`（startNum／startSubNum、遮罩、落地比對、閱讀紀錄 `next-article`）。
- **認法（`sameSubjectEntryFrom`）**：原生是 read.c`#thread(RELATE_NEXT／PREV)`：從這篇往後（往前）逐列找 `subject()`（去掉 Re:／Fw:）相同的第一篇，置底文當 EOF。這裡只看同一份快照（完整列表或搜尋結果，跟卡片同一份）：從這篇往該方向**連續看過**的列裡找主題相同（`subjectMatches`，列表主題可能被截成 …）的第一篇；中間缺一號＝那一列沒看過、可能就是同主題 ⇒ 不列（不憑空送 `]`）。被刪的、`list_row_filter#hiddenReason` 擋的跳過。同主題下一篇正好就是「下一篇」⇒ 不重複列。終點卡照樣可以列同主題上一篇。
- **版面**：有這一列時卡片掛 `data-thread`，下 margin 改小；捲到底要讓位（`--next-bottom-inset`）的改由這一列吃（`_layout` 兩邊都寫）。`reading_record.trailingPx` 連這一列一起扣（`view.nextThreadRow`）。手機往上拉不從這一列起手（`pull_next_article#ignoredTarget`）。

## 往下拉：手機往上拉、桌機停一下再往下捲（`pull_next_article.js`）

L 同意的版本是「點標題卡**或**拉過門檻」，而且**一捲到底不能就換文**。手機上的「往下捲」是手指往上推，所以那邊叫「往上拉」。兩條入口都只改卡片的字與底下的進度條（`next_article.setPull(pull, progress)`，卡片掛 `data-pull`＋CSS 變數 `--next-pull`），終點卡不接。

### 手機：捲到底再往上拉（`installPullNextArticle`）

- **為什麼用觸控事件**：跟下拉重整（`docs/screen-refresh.md`）是同一個例外。瀏覽器的 overscroll 沒有任何入口告訴頁面「使用者在底部又拉了一段」，而觸控事件有完整相位（手指還在／放開了），所以能做到「拉過門檻、放手才生效」「拉回去就取消」。監聽是被動的（`passive`＋capture），從不 `preventDefault`，所以捲動、Android 原生的 overscroll 拉伸效果、點擊都照舊，我們只在放手那一下決定要不要開。
- **起手條件**：手機版面、不在選字模式、沒有 modal、單指、卡片顯示中（有下一篇）且不在開啟中，而且觸控點底下的 `.main` **已經捲到底**（`atScrollBottom`，內容比視窗短也算）。從工具列、App Bar、sheet、對話框、輸入框或卡片本身起手都不算（點卡片走 click）。
- **門檻**：直接用下拉重整的 `pullState`（阻尼 0.5、門檻 64px、斜拉取消），方向鏡像。拉的途中卡片的字跟著變：沒過門檻是「下一篇・再往上拉」，過了是「放開開啟下一篇」，進度條＝位移／門檻。放手時過門檻才 `open()`，沒過、拉回去、斜拉、中途捲離底部都只把字還原。

### 桌機：捲到底、停一下、再往下捲（`installWheelNextArticle`）

- **難處**：WheelEvent 沒有相位。一路轉滾輪捲到底的那一串、觸控板慣性的尾巴，到底之後還會繼續送 wheel ⇒ 直接累積「到底後的位移」就等於一捲到底就換文。
- **用「手勢」切開**（純函式 `wheelPullStep`）：相隔 `WHEEL_GESTURE_GAP_MS`（250ms）以上的 wheel 才算新手勢（慣性、連續轉滾輪的間隔都遠小於它），**只有起手時就已經停在底部**的手勢累積往下的位移，過 `WHEEL_THRESHOLD_PX`（480px，滑鼠約 4～5 格）就 `open()`。捲到底的那一串起手時不在底部 ⇒ 整串（連同慣性）都不算，一定要停下來再捲。往上捲、中途離開底部 ⇒ 歸零；`WHEEL_IDLE_RESET_MS`（700ms）沒動靜 ⇒ 歸零、卡片字樣還原。慢慢一格一格捲（每格隔 250～700ms）累積照樣接得起來。
- **「起手在底部」要排除合成器先捲**：passive wheel listener 執行時，合成器可能已經把這一下捲完（`tests/e2e/README.md` 實測）⇒ 光看 `atScrollBottom` 會把「捲到底的那一下」當成起手在底部。所以 capture 監聽 `.main` 的 scroll 記下上一次停的位置，這一下之前位置已經變了（`moved`）就不算。
- 監聽在 window capture、被動、從不 `preventDefault`：捲動照舊由瀏覽器做。只認游標底下的 `.main`（雙欄閱讀左欄、文章工具側欄上的滾輪不算）；有 modal、Ctrl＋滾輪（縮放）、水平主導（`swipe_gesture#isHorizontalWheel`）、AID 跳文中都不接。
- 開關沿用 `enableNextArticleCard`：卡片不出現，兩種手勢也就不存在。

## 測試

unit：`next_article.test.js`（下一列的認法、列表盡頭與終點卡、何時出現、換文與失敗、落地比對、忙碌、看門狗、閱讀紀錄、預設與安全模式、搜尋結果的快照與換文）、`aid_navigation.test.js` 的 `startSubNum`、`next_article_layout.test.js`（真瀏覽器＋main.css：推文少不用捲就看得到、捲到底不被推文列／footer 蓋住、推文列出現收起跟著讓位、有底色的空白列不蓋）、`next_article_dom.test.js`（真瀏覽器：卡片的位置、點擊不外洩、`trailingPx` 與 atBottom、終點卡、遮罩在 start 之前蓋上／失敗馬上拿掉／好讀接手才淡出）、`pull_next_article.test.js`（往上拉的起手條件、門檻、拉回取消、卡片字樣與進度條）、`wheel_next_article_step.test.js`（`wheelPullStep`：捲到底那一串與慣性不算、停一下才算、合成器先捲、往上取消、閒置歸零）、`wheel_next_article.test.js`（真瀏覽器：滾輪累積與卡片字樣、各種不接的情況）。offline e2e：`next_article.offline.spec.js`（卡片排在最後一列內容之後、推文列開著時推文少不用捲且不被蓋、長文捲到底卡片在推文列上面、真滑鼠點卡片只送 `s<板>⏎`、搜尋結果的卡片送 `←` 再跳結果裡的編號、終點卡兩種、換文全程遮罩蓋著原生列表、真滾輪停一下再捲過門檻才送 `s<板>⏎`、pref 關不出現）、`mobile_next_article.offline.spec.js`（offline-mobile，CDP 真觸控：沒過門檻不送鍵、拉過門檻放手送 `s<板>⏎`）。
