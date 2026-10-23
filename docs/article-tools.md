# 文章工具側欄（`article_tools.js`）

動 `article_tools.js`、`components/ArticleTools` 前先讀。

## 是什麼

好讀讀文章時，終端機右邊的空白處放一條側欄：本篇 AID 與網址（一鍵複製）、推文統計（推／噓／→，新格式推文另計）、「提到你」（內容提到自己帳號的推文，點一則捲過去；帳號與開關同推文列的「我」標示：`view._selfId`＋`highlightSelfComments`，判準 `comment_parse.mentionsUser`）、推文者排行（點一個人＝只列他的推文，點一則就捲到那一列）、本篇圖片牆（預設收著，展開才下載縮圖，點縮圖捲到那一列）。開關 `enableArticleTools`（預設開）；側欄可以收起成右緣的把手（`pttchrome.articleTools.collapsed.v1`，只記在這個瀏覽器）。

## 規則

- **一個 byte 都不送**：資料全取自好讀的累積頁（`buf.pageLines`，用 `buf.getRowText(r, 0, cols, acc)` 讀），跳到某列＝捲好讀的視口（`easy_reading.scrollToArticleRow` → `_scrollToPageRow`，量畫出來的 `[srow]` 節點、先 `renderChunksAround`），AID 只用免費的網址列（`aid_navigation.findLocalPostAid`，不按 Q）。它不改原生畫面、不攔鍵，所以**不在**安全模式名單內，也不經閱讀紀錄。
- **只在好讀文章裡**：pageState 3＋`easyReading._enabled`＋不在 functionMode＋累積頁非空。原生 pmore 手上只有眼前這一屏，統計會是錯的 ⇒ 不出現。好讀往下讀、累積頁長大時增量重算（只讀新列）；首列變了或累積頁變短（換文章、從頭重讀）就整份重來，選中的人不在新文章裡就取消。
- **推文的讀法**：舊格式 `agent_parse.parseCommentLine`（`comment_parse.parseComment` 的版面，已對過 pttbbs），新格式 `parseModernCommentLine`，緊接的 `│` 列接成同一則的內容。作者取檔頭（`parseArticleHeader`，小寫），推文者大小寫不分。
- **圖片**：一列裡的網址逐條判（不跨列；被折行的長網址縮圖會載入失敗，`onError` 換下一個候選，全失敗整格收掉）。imgur 單張先試 `m` 縮圖再試原圖、twimg 先試 `name=small`，再接 `image_proxy` 的候選（代理設定照用）；相簿、tenor 分享頁、影片、svg 不收；同網址只收一次，最多 `IMAGE_LIMIT` 張。
- **只用空白處**：與雙欄閱讀的左欄同一套（`split_reader.paneWidthFor`），寬度是 `window.innerWidth − view.mainDisplay` 右緣，放不下就不出現，不推動、不縮小終端機（`docs/terminal-size.md` LOCKED；L 已選定「只用空白處」，見 `docs/split-reader.md`）。手機不出現。
- **不是 modal**：焦點留在 `#t`，鍵盤照常操作文章。滑鼠：側欄在 `#BBSWindow` 外，`_onUploadLayer` 認 `#articleTools` 放過（滾輪捲側欄，不變成文章翻頁）；按鈕 mousedown `preventDefault`＋stopPropagation。
- e2e：`installReplay` 預設把 `enableArticleTools` 關掉（寬視窗的好讀文章右邊多一欄浮層，會擋掉落在那裡的滑鼠），live 的自動登入 prefs 也關掉；只有 `article_tools.offline.spec.js` 以 `bootOffline(page, ptt, { articleTools: true })` 打開。

## 測試

unit：`article_tools.test.js`（網址與縮圖候選、推文統計與排行、新格式推文、圖片上限、AID → 網址、何時出現、累積頁長大與換文章、選人、跳列、複製與失敗、收起記憶）、`article_tools_ui.test.jsx`（外殼照 state 畫、按鈕接到控制器、縮圖候選依序試、不搶焦點、滑鼠不外洩）。offline e2e：`article_tools.offline.spec.js`（stock-huang：1920×960 放得下且不蓋終端機、推文數等於素材的 golden、點一則推文捲到那一列且不送鍵、滾輪捲側欄不捲文章、收起與展開、窄視窗／原生 pmore／pref 關不出現）。

## 文章導覽軸（`article_nav.js`）

好讀文章終端機右緣一條細軸（`components/ArticleNav`，pref `enableArticleNav` 預設開；桌機與手機都有，不需要側邊空白）。

| 項目 | 規則 | 理由 |
|---|---|---|
| 資料 | 同側欄：累積頁文字 → `analyzeArticle`（第一則推文、提到我、圖片）＋ `newComments.rowFor`（第一則新推文）。標記位置＝列號 / 累積頁總列數（`navMarks`） | 一個 byte 都不送；還沒讀進來的部分不在軸上，照現有的往下捲／End 補 |
| 出現 | 同推文列：pageState 3＋好讀開著＋不在 functionMode＋累積頁非空；pref 關、原生 pmore 不出現 | 認不出 ⇒ 原生 |
| 位置 | 疊在 `.main` 最右 14px，從 `.main` 頂到可見內容下緣（好讀 footer 上緣，推文列顯示中再扣列高，`articleNavGeometry`） | 不推動終端機（`docs/terminal-size.md` LOCKED）；控制器建在推文列之後，同一個 settle 讀得到推文列的新狀態 |
| 目前看到哪 | 元件直接讀 `.main` 的 scrollTop／clientHeight／scrollHeight（scroll 事件，rAF 合併） | 不必經 settle |
| 點／拖 | pointer capture；按在「推」那一格＝`easyReading.scrollToArticleRow(第一則推文)`（精準），其他地方＝`scrollToFraction`（那個比例落在視窗中間） | 只捲視口 |
| 手機 | 終端機佔滿螢幕寬，軸會疊在推文時間的最後一個字上 ⇒ 比照原生捲軸：平常 `opacity: 0`＋`pointer-events: none`，捲動後 1.5 秒內與拖曳中才出現 | 推文時間照常點得到 |
| 浮層矩陣 | `overlay_guard` 的 ALLOWED 有 `#articleNav`（捲軸式細軸，蓋到的只是最後一列的右端）；`bottom_overlay`／`mobile_bottom_overlay` 的 COMBOS 有 `commentBar+nextArticle+articleNav` | 跟別的浮層疊在一起時仍要驗 |

測試：`tests/unit/article_nav.test.js`（標記、幾何、出現條件、跳列／拖曳）、`tests/e2e/offline/article_nav.offline.spec.js`（貼右緣、點「推」跳到第一則推文、真滑鼠拖曳、不送鍵、原生 pmore／pref 關不出現）、`mobile_article_nav.offline.spec.js`（平常隱藏不接觸控、捲動後出現、tap「推」）。
