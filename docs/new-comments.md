# 新推文標記（`new_comments.js`）

動 `new_comments.js`、`screen_annotations.applyNewCommentsMark`、`.newCommentsStart` 的 CSS 前先讀。

## 是什麼

重開讀過的文章時，上次讀完之後才出現的第一則推文上緣畫一條中性灰細線，右邊一行小字「以下是新推文」；浮動工具面板（右下「⋯」）多一顆「跳到新推文」，點了只捲好讀的視口。開關 `markNewComments`（預設開；一個 byte 都不送 ⇒ 不在安全模式名單內）。

## 規則

- **一個 byte 都不送**：推文數取自好讀累積頁（`buf.pageLines`）；文章身分＝看板＋AID（`aid_navigation.findLocalPostAid`，只讀文末的網址列，不按 `Q`）。紀錄在 localStorage `pttchrome.newComments.v1`（`{ "<板小寫>/<AID>": [推文數, 時間] }`，最多 `NEW_COMMENTS_LIMIT` 篇，超過丟最久的），不寫 prefs、不上雲。
- **只在好讀讀到文末才記**（`easyReadingReachedPageEnd`、非 functionMode、非反向讀取）：沒讀完不算看過。記下的是這一刻的推文數；這一次閱讀的標線照舊標在開文時讀到的位置（`_seen` 整段閱讀期間不變）。
- **推文的數法＝樓層的數法**：`CommentScanner` 用 `comment_parse.FloorCounter`（BePTT 演算法），只算過了「※ 發信站／文章網址」那一列之後的推文 ⇒ 內文裡的假推文不算，記的與找的對得上。新格式推文（`│` 內容列）目前不算 ⇒ 那種文章不標（認不出 ⇒ 不動）。
- **反向讀取（End）**：新頁插在中間、列號會位移 ⇒ 掃描作廢、不標不記，接合完成後從頭重掃。
- **標註層**：term_view 只在畫好讀累積頁（`stableRows` 且 `lines === buf.pageLines`）時呼叫 `newComments.rowFor(lines)`，結果放 `enhance.newCommentsRow`（進 `annotationsKey`，一篇文章從 null 翻成某一列最多一次 ⇒ 那一幀全量重算）。`applyNewCommentsMark` 只寫 `result[row]`：被合併進同作者推文塊的列標在塊的第一列；黑名單藏起來的列往後找第一則看得到的。之後前沿快路徑沿用的前綴是已經標好的物件，前沿之後每幀重標 ⇒ `annotationFrontier`／`annotationsAreRowIndependent` 不必改。
- **渲染**：`row.js`／`comment_card.js` 在那一列加 class `newCommentsStart` 與 `data-new-comments`（小字，i18n `new_comments_divider`）；CSS 用列的 `margin-top` 留空、`::before` 畫線＋小字（不會被選取／複製）。golden 快照不受影響（沒有標的列輸出不變）。
- **設計**：中性灰，不用彩色（推文區已經有原PO藍、自己綠、樓層黃，L 要求推文區不要花花綠綠）。

## 測試

unit：`new_comments.test.js`（數法、紀錄存讀與上限、讀完才記、重開找列、換文章、反向讀取、functionMode、pref 關、`applyNewCommentsMark` 的標法、`annotationsKey`）。offline e2e：`new_comments.offline.spec.js`（stock-huang：第一次不標且讀完記下 49；預存 40 ⇒ 第 41 則上緣有線且不蓋上一列、跳到新推文只捲視口不送鍵；沒有新推文不標）。
