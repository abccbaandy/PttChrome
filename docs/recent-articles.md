# 最近讀過＋稍後再讀（`recent_articles.js`）

動 `recent_articles.js`、首頁儀表板的文章兩區、指令面板的文章項目、右鍵選單的「稍後再讀」前先讀。

## 是什麼

pref `enableRecentArticles`，預設開。

- **最近讀過**：讀過的文章自動記下（最多 `RECENT_ARTICLES_LIMIT`＝30 篇，新的在前）。
- **稍後再讀**：文章裡右鍵／長按 →「稍後再讀」（游標下是別篇的文章連結時，收的是那一篇）；已經收了就改給「從稍後再讀移除」。最多 `READ_LATER_LIMIT`＝50 篇。
- **文章列表上的稍後再讀**（P53）：列表好讀裡右鍵／長按一列 →「稍後再讀」。見下面「列表的稍後再讀」。
- 首頁儀表板多兩區「稍後再讀」「最近讀過」（各列 `HOME_ARTICLE_LIMIT`＝8 篇，稍後再讀每列有 ✕）；指令面板（F4）空白時列 5 篇（稍後再讀在前），打字比對標題或板名。點了就開回那篇。

## 規則

- **記的時候一個 byte 都不送**：文章身分＝看板＋AID，取自 `aid_navigation.findLocalPostAid`（只讀文末「※ 文章網址:」那一列，不按 `Q`）。讀不到網址列就不記：好讀長文還沒捲到文末網址列、轉錄文（網址是原文的）、站內信／精華區（沒有看板）。標題取 `view._articleTitle`。
- 同一篇讀很久只記一次；離開文章（pageState 不是 3）再進來，排回最前面。
- **開回去走既有入口**：`deepLinkController.request({ board, aid })`，跟指令面板貼文章網址同一條（登入前暫存、AID 跳文、閱讀紀錄 `deep-link-jump`／`aid-jump`、忙碌提示都由那條負責）。`request` 不收 ⇒ 提示「現在開不了這篇」。首頁儀表板與指令面板的文章項目都走 `open`（不直接呼叫 `request`）。
- **落地不閃「已跳至 #AID」**：`open` 帶 `{ quietLanding: true }`，AID 跳文成功落地時只收掉「跳至…」進度提示（`aid_navigation._landHint` → `term_view.hideListHint`），文章出現就是回應；讀到一半的那篇頂端另有「接著上次讀到的地方」，兩張疊在內文上只是噪音。跳文失敗的提示照舊；等登入（`'pending'`）那條、貼網址、外部連結都照舊閃。
- 紀錄在 localStorage `pttchrome.recentArticles.v1`（`{ recent: [...], later: [...] }`，每筆 `{ board, aid, title, at }`），不寫 prefs、不上雲。每次讀 `state` 都比對 storage 原文（別的分頁寫的讀得到）。
- 從連結收的稍後再讀沒有標題（畫面上只有 AID），先顯示 `#AID`，讀到那篇時補上。
- 只是清單與入口：記的時候不送鍵、開回去是使用者按的 ⇒ 不在安全模式名單內。

## 列表的稍後再讀（`list_session.readLaterAt`）

列表的列沒有 AID（AID 來自檔名，列表不顯示）⇒ **這是唯一會送鍵的入口**：替使用者在那一列按 `Q`
（bbs.c#view_postinfo 資訊框）讀 AID，再送空白關框。依 upstream：框是 pressanykey、之後 `return FULLUPDATE`，
**在列表裡只是重畫列表、游標不動**（文章裡按 Q 才會離開文章，那是 `deep_link_controller` 的「複製本篇連結」）。

- 出現條件：`enableRecentArticles` 開、列表好讀接手（active＋buffer）、那一列有編號（置底文、header、空白列不給）、
  `enableListNativeAutoResume` 開（關掉時那條路游標同步失敗會照送，Q 落在別列就收錯篇）。原生列表沒有這一項。
- 凍結交易（跟「前已讀後未讀」同一條 `_beginLandingTransaction`）：必要時先跳號同步真游標 → `Q`（**不尾附 \f**，
  會被 pressanykey 當成關框）→ 認出資訊框（`aid_navigation.postInfoAnswer`）才送空白 → 關框落地＝乾淨的列表就回好讀。
  框沒出現 ⇒ 逾時切原生、**不送空白**（列表上的空白是翻頁）。框裡沒有 AID ⇒ 照樣關框、提示沒收。
- 只收不移（開選單時還不知道是哪一篇）：已經在清單裡 ⇒ 提示「已經在稍後再讀裡」。標題取列表那一列（`data-list-title`）。
- 閱讀紀錄 `read-later-list`：一律回原處。
- 會送鍵 ⇒ 安全模式下列表好讀本身不接手，這一項自然不出現。

## 接著上次讀到的地方

pref `resumeRecentArticles`（設定 → 一般，在「最近讀過／稍後再讀」下面），預設開；只捲視口 ⇒ 不在安全模式名單內。

- **記**：好讀文章的捲動停下來 `RESUME_SAMPLE_MS` 後量一次（`samplePosition`），量法＝閱讀紀錄的文章量測（`term_view.currentLineIndex`，量節點、帶列內比例），寫進「最近讀過」那一筆的 `line`。只改那一筆、不換順序、不通知清單的聽眾。讀到文末（`atBottom`）或還在第一列 ⇒ 拿掉 `line`（下次從頭；新推文由 `new_comments` 標）。`noteRead` 重讀一次不洗掉 `line`。
- **不量的時候**：畫面還沒靜止（`buf._settleTimer`，離開文章那一幀的重畫也會觸發捲動、scrollTop 歸零）、不在文章、好讀沒接手或在原生鏡像、好讀的一次性還原還沒落地（視口在頂端不代表讀到那裡）、`view._articleInstanceId` 不是記下網址列的那一篇。
- **開回去**：`open` 收到 `'navigating'` 且那一筆有 `line` 才等落地（`'pending'` 等登入的不接）。`nextResumeStep`：跳文還在跑／還沒換成新的一篇／好讀還沒接手 ⇒ 等；落地那篇（`aid_navigation.currentPostAid`：網址列或跳文落地記下的那篇）＝要開的這篇 ⇒ `easy_reading.requestScrollRestore(line)`（累積到位才捲，使用者按鍵就作廢）；別篇、認不出、超過 `RESUME_ARM_MS` ⇒ 不動。
- **頂端提示**：`#recentResume`「接著上次讀到的地方｜回到開頭」，`RESUME_TOAST_MS` 後收、離開文章就收。「回到開頭」＝`easy_reading.cancelScrollRestore`＋捲回頂端。滑鼠事件不外傳（`App._onUploadLayer` 認 `isRecentResumeTarget`）。debug 錄製檔記 `recentArticles.resume`（apply／drop）。

## 還沒做

- 原生列表（列表好讀關掉）與置底文上的「稍後再讀」。
- 「之後新推文 +N」：要重開那篇才數得到，儀表板不顯示；開回去時由 `new_comments` 標出新推文。
- 被刪的文章：AID 跳文會提示找不到，清單不會自動移除（稍後再讀可以按 ✕）。

## 測試

unit：`recent_articles.test.jsx`（清單規則、只在讀得到網址列時記、同一篇只記一次、pref 關、稍後再讀切換與補標題、開回去走 deep link、指令面板排序與比對、右鍵目標與選單項目、列表的列問到 AID 才收／只收不移、儀表板兩區、接著上次讀到的地方的記與不記／落地決策／回到開頭）。offline e2e：`recent_articles.offline.spec.js`（stock-huang 讀完記下、真右鍵稍後再讀零送鍵、列表 F4 點文章走 AID 跳文、scn-deep-link 真往返開回讀到一半的那篇並捲到上次那一列、真滾輪記回位置）；`list_read_later.offline.spec.js`（upstream 產的 post_info 畫面，真右鍵：只送 Q 與空白、收進那一篇、全程不切原生）。unit `list_read_later.test.js`（序列、框沒出現不送空白、背景補頁在線上一律先同步）。
