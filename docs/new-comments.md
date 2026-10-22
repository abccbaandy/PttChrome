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
- **設計**：中性灰，不用彩色（推文區已經有原PO藍、自己綠、樓層黃，L 要求推文區不要花花綠綠）。小字要看得清：字級 ≥ 列字的 0.7、淺灰對黑底對比 ≥7:1、整行落在列的 `margin-top` 留白裡。推文間距（`.commentSpacing`）的 `margin-top` 選擇器比較具體，`.newCommentsStart` 要有一條同等具體的選擇器壓過它，否則留白被蓋回 0.55em、小字疊到上一列（offline e2e 守）。

## 列表的 +N（pref `listNewPushCount`，預設開）

讀完過的文章，在文章列表上推文數旁多一個小框「+N」。一樣一個 byte 都不送，不在安全模式名單內。

- **列表的推文數不是推文則數**：pttbbs `post.c` 改 `.DIR` 的 recommend 是推 +1、噓 -1、→ 不變（上下限 ±100）；`bbs.c#readdoent` 只在 1～99 畫數字，100 以上「爆」，0 與 -1～-10 畫空白，更低是「X…」。所以讀完時另外記下這篇的**推噓分**（`CommentScanner.score`，跟樓層同一個數法，只算 meta 列之後的），N＝列表的數字 − 讀完時的分數，> 0 才顯示。列表上是爆／空白／X／鎖文 ⇒ 不顯示（不精確）。
- **列表沒有 AID**：紀錄多存作者（檔頭，小寫）＋主題（`long_push_anchor.subjectKey`，去掉 Re:／Fw:），列表那一列用 `listRowIdentity` 比（標題被截成 … 也認），同一板裡對到**剛好一筆**才算；同作者同主題讀過好幾篇、轉錄文（檔頭是原作者）、改過標題的文章都對不上 ⇒ 不顯示。舊格式紀錄（只有推文數）不參與。
- **紀錄共用**：`markNewComments` 或 `listNewPushCount` 任一個開著就在讀完時記。
- **已知誤差**：板主刪推文、作者編輯掉推文時，文章裡數到的分數比 `.DIR` 少，那篇會一直多出幾分。只會多標、不會送鍵。
- **標註層**：term_view 在文章列表（pageState 2）問 `newComments.listBadge(看板)`，得到 `{ key, fn }`：`listNewPushKey` 進 `annotationsKey`（紀錄原文或看板一變就換，列表好讀走 `rowIdentityStable`，不進 key 的話讀完回列表節點會被原封沿用），`listNewPushFor` 逐列查表放進 `listNewPush`（只看該列自己的文字 ⇒ 逐列獨立）。
- **渲染**：原生／桌機列（`row.js`）80 欄格線沒有空位 ⇒ 只在最後 5 格是空白時，把徽章掛在 bbsline 的最後、`position: absolute` 用 static position（第 80 格之後）再往左平移自己的寬，不佔格線、不撐寬；標題寫到最後幾格就不畫。手機卡片（`list_card.js`）放在標題行最前面。字一律在 `data-new-push`＋`::after`，不會被選取／複製；沒有 +N 的列輸出不變（golden 不受影響）。

## 測試

unit：`list_new_push.test.js`（推噓分、列表數字的精確值、比對規則、紀錄格式、listBadge 的 key 與 pref）、`list_new_push_render.test.js`（真瀏覽器：列尾疊放不撐寬、放不下不畫、卡片位置）、`new_comments.test.js`（數法、紀錄存讀與上限、讀完才記、重開找列、換文章、反向讀取、functionMode、pref 關、`applyNewCommentsMark` 的標法、`annotationsKey`）。offline e2e：`new_comments.offline.spec.js`（stock-huang：第一次不標且讀完記下 49；預存 40 ⇒ 第 41 則上緣有線且不蓋上一列、跳到新推文只捲視口不送鍵；沒有新推文不標）。
