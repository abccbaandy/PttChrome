# 推文篩選：只看這個人／只看原 PO

pref `enableCommentFilter`，預設開。只改顯示、一個 byte 都不送 ⇒ 不在安全模式名單。

## 使用

好讀文章裡長按（桌機右鍵）一則推文，選單多兩項：「只看這個人的推文 'id'」「只看原 PO 的推文」（解析不到原PO 就只有前者）。生效後：

- 推文區只留那個人的推文；其他連續的推文收成一條細線「略過 N 則」。
- 上緣置中一條橫幅「只顯示 xxx 的推文 ✕」，按 ✕ 還原；篩選生效時選單只給「顯示全部推文」。
- 內文不受影響；樓號照原本的數（不重編）。
- 只活在那一篇：換文章、重進同一篇（`_articleInstanceId` 變了）就清掉；離開文章或切回原生時不生效，橫幅收起。

## 實作

| 層 | 位置 | 做什麼 |
|---|---|---|
| 狀態 | `term_view.js` `setCommentFilter`／`clearCommentFilter`／`activeCommentFilter`／`onCommentFilterChange` | `{ userid, op, articleId }`；只在 `useEasyReadingMode && pageState === 3` 且 articleId 相同時生效。enhance 帶 `commentFilter: userid \| null`（進 `annotationsKey`） |
| 判定 | `comment_parse.js#isFilteredOut` | 不是那個人的推文 ⇒ `hidden: true, filtered: true`（跟黑名單同一套 hidden ⇒ 好讀 `dropHidden` 整列移除）。黑名單照黑名單（不帶 filtered）。新格式推文的 `│` 續行跟著標頭 |
| 收成細線 | `screen_annotations.js#applyCommentFilterSkips` | 一串連續 hidden 列的第一列標 `filterSkip: N`（N＝被篩掉的則數，不含續行、不含黑名單）。只寫 `result[row]`，已經是同一個數就不換物件 |
| 前沿 | `annotationFrontier` 的 `filter` 選項 | 尾端那串被藏列（含空白列）下一頁還會變長 ⇒ 整串留給下一幀重算。`annotationsAreRowIndependent` 不用改（READING 本來就排除） |
| 合併 | `computeAnnotations` | 篩選中不做「連續同作者推文合併」：留下來的全是同一人，會被併成一整塊、而且跨過「略過」 |
| 畫面 | `render/screen.js#buildFilterSkipNode` | `dropHidden` 時 `filterSkip` 那一列畫成 `div.commentFilterSkip`（**不是 bbsrow**：選取複製、閱讀紀錄、量測找 bbsrow 的都直接略過） |
| 橫幅 | `components/CommentFilterBar` | 非 modal、不搶 `#t` 焦點；`App._onUploadLayer` 認 `isCommentFilterBarTarget` |
| 捲動 | `term_view._filterAnchor`／`_restoreFilterAnchor` | 設定時把點的那一列（被篩掉就往後找最近看得到的）放回原本的螢幕位置；清掉時錨在視窗頂端那一列 |

守護：`tests/unit/comment_filter.test.js`、`tests/unit/screen_annotations_frontier.test.js`（加了兩組帶篩選的隨機文章：逐頁 append 與全量重算逐列相同）、`tests/e2e/offline/comment_filter.offline.spec.js`（真右鍵 → 選單 → 篩選 → ✕ 還原、零送鍵）。
