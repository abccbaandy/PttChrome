# 最近讀過＋稍後再讀（`recent_articles.js`）

動 `recent_articles.js`、首頁儀表板的文章兩區、指令面板的文章項目、右鍵選單的「稍後再讀」前先讀。

## 是什麼

pref `enableRecentArticles`，預設開。

- **最近讀過**：讀過的文章自動記下（最多 `RECENT_ARTICLES_LIMIT`＝30 篇，新的在前）。
- **稍後再讀**：文章裡右鍵／長按 →「稍後再讀」（游標下是別篇的文章連結時，收的是那一篇）；已經收了就改給「從稍後再讀移除」。最多 `READ_LATER_LIMIT`＝50 篇。
- 首頁儀表板多兩區「稍後再讀」「最近讀過」（各列 `HOME_ARTICLE_LIMIT`＝8 篇，稍後再讀每列有 ✕）；指令面板（F4）空白時列 5 篇（稍後再讀在前），打字比對標題或板名。點了就開回那篇。

## 規則

- **記的時候一個 byte 都不送**：文章身分＝看板＋AID，取自 `aid_navigation.findLocalPostAid`（只讀文末「※ 文章網址:」那一列，不按 `Q`）。讀不到網址列就不記：好讀長文還沒捲到文末網址列、轉錄文（網址是原文的）、站內信／精華區（沒有看板）。標題取 `view._articleTitle`。
- 同一篇讀很久只記一次；離開文章（pageState 不是 3）再進來，排回最前面。
- **開回去走既有入口**：`deepLinkController.request({ board, aid })`，跟指令面板貼文章網址同一條（登入前暫存、AID 跳文、閱讀紀錄 `deep-link-jump`／`aid-jump`、忙碌提示都由那條負責）。`request` 不收 ⇒ 提示「現在開不了這篇」。
- 紀錄在 localStorage `pttchrome.recentArticles.v1`（`{ recent: [...], later: [...] }`，每筆 `{ board, aid, title, at }`），不寫 prefs、不上雲。每次讀 `state` 都比對 storage 原文（別的分頁寫的讀得到）。
- 從連結收的稍後再讀沒有標題（畫面上只有 AID），先顯示 `#AID`，讀到那篇時補上。
- 只是清單與入口：記的時候不送鍵、開回去是使用者按的 ⇒ 不在安全模式名單內。

## 還沒做

- 開回去捲到上次讀到的位置：AID 跳文落地在文章開頭；`new_comments` 的「以下是新推文」與「跳到新推文」照常可用。
- 列表上的「稍後再讀」：文章列表的列沒有 AID（要按 `Q` 才問得到，會離開列表），這版只在文章裡收。
- 「之後新推文 +N」：要重開那篇才數得到，儀表板不顯示；開回去時由 `new_comments` 標出新推文。
- 被刪的文章：AID 跳文會提示找不到，清單不會自動移除（稍後再讀可以按 ✕）。

## 測試

unit：`recent_articles.test.jsx`（清單規則、只在讀得到網址列時記、同一篇只記一次、pref 關、稍後再讀切換與補標題、開回去走 deep link、指令面板排序與比對、右鍵目標與選單項目、儀表板兩區）。offline e2e：`recent_articles.offline.spec.js`（stock-huang 讀完記下、真右鍵稍後再讀零送鍵、列表 F4 點文章走 AID 跳文）。
