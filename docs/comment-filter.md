# 推文篩選：只看這個人／只看原 PO／只看推文或噓文

pref `enableCommentFilter`，預設開。只改顯示、一個 byte 都不送 ⇒ 不在安全模式名單。

## 使用

好讀文章裡長按（桌機右鍵）一則推文，選單多幾項：「只看這個人的推文 'id'」「只看原 PO 的推文」（解析不到原PO 就沒有這項）、「只看推文」「只看噓文」（P39）。生效後：

- 推文區只留那個人（或那一種：推／噓；→ 兩種都收）的推文；其他連續的推文收成一條細線「略過 N 則」。
- 新格式推文（`[N] id … │`）看不出推／噓 ⇒ 只看推／噓時不收（認不出就不動）。
- 點「略過 N 則」⇒ 就地展開那幾則（淡色顯示，黑名單照藏），細線變成「收起 N 則」留在原位（手指下不跳）；再點收回。展開狀態跟著篩選走：換篩選、清掉、換文章都歸零。
- 上緣置中一條橫幅，是一排切換鈕「全部｜推｜噓｜原 PO」（P41；原PO 解析不到就沒有「原 PO」），目前那顆亮著，點別顆直接換、不用先還原再長按重選；「全部」＝還原。「只看這個人」時最前面多一顆亮著的帳號鈕（那個人就是原 PO ⇒ 亮「原 PO」）。切換時錨在視窗頂端那一列（同還原）。
- 每顆切換鈕後面帶則數（P44）：點了之後看得到幾則。數的是好讀已載入的推文，範圍同樓層（過了「※ 發信站／文章網址」那一列才算，內文裡引用的推文長相不算）；推／噓只數舊格式，全部／原 PO／帳號連新格式一起數；黑名單的人不算。還沒讀到文末（或反向讀取中）標「12+」。推文區還沒出現 ⇒ 不標數字。讀到文末還是 0 則的推／噓／原 PO 鈕變淡（P46，`comment_filter.js#emptyChipHintKey`、`data-empty`＋`aria-disabled`），點了只閃一句「這篇沒有噓文」（`view.flashListHint`）、不切過去；「全部」、帳號鈕、亮著的那顆、還沒讀完的「0+」都照常。篩選生效時選單只給「顯示全部推文」。
- 內文不受影響；樓號照原本的數（不重編）。
- 只活在那一篇：換文章、重進同一篇（`_articleInstanceId` 變了）就清掉；離開文章或切回原生時不生效，橫幅收起。

## 實作

| 層 | 位置 | 做什麼 |
|---|---|---|
| 狀態 | `term_view.js` `setCommentFilter`／`setCommentTypeFilter`／`clearCommentFilter`／`activeCommentFilter`／`onCommentFilterChange` | `{ key, userid, type, op, articleId }`；只在 `useEasyReadingMode && pageState === 3` 且 articleId 相同時生效。enhance 帶 `commentFilter: key \| null`（進 `annotationsKey`）：key＝帳號，或 `'type:推'`／`'type:噓'`（`COMMENT_TYPE_FILTER_PREFIX`；帳號只有英數，不會撞到 `:`） |
| 判定 | `comment_parse.js#isFilteredOut` | 不是那個人（type 篩選：不是那一種）的推文 ⇒ `hidden: true, filtered: true`（跟黑名單同一套 hidden ⇒ 好讀 `dropHidden` 整列移除）。黑名單照黑名單（不帶 filtered）。新格式推文的 `│` 續行跟著標頭 |
| 收成細線 | `screen_annotations.js#applyCommentFilterSkips` | 一串連續 hidden 列的第一列標 `filterSkip: N`（N＝被篩掉的則數，不含續行、不含黑名單）。只寫 `result[row]`，已經是同一個數就不換物件 |
| 展開 | `applyCommentFilterSkips(result, expanded, texts)`＋`term_view.toggleCommentFilterSkip` | 一串的 key＝第一列文字（`filterSkipKey`；不用列號，反向讀取會往中間插列）。enhance `commentFilterExpanded`（進 `annotationsKey`）列出點開的 key；展開的串裡被篩掉的列改成 `hidden: false, filterShown: true`（仍算同一串），第一列標 `filterExpanded: N`。render 把第一列包進 `div.commentFilterExpandedHead`（細線＋列本身，佔位盒掛外層），`filterShown` 的節點加 `.commentFilterShown`（淡色）。細線是 `<button>`（App 滑鼠入口的 `isOwnControlTarget` 擋掉推文高亮／邊緣翻頁），不寫 `type` 屬性（消費端用 `[type]` 認 bbsrow） |
| 前沿 | `annotationFrontier` 的 `filter` 選項 | 尾端那串被藏列（含空白列）下一頁還會變長 ⇒ 整串留給下一幀重算。`annotationsAreRowIndependent` 不用改（READING 本來就排除） |
| 合併 | `computeAnnotations` | 篩選中不做「連續同作者推文合併」：留下來的全是同一人，會被併成一整塊、而且跨過「略過」 |
| 畫面 | `render/screen.js#buildFilterSkipNode` | `dropHidden` 時 `filterSkip` 那一列畫成 `div.commentFilterSkip`（**不是 bbsrow**：選取複製、閱讀紀錄、量測找 bbsrow 的都直接略過） |
| 橫幅 | `components/CommentFilterBar` | 切換鈕 `data-filter`（all／push／boo／op／user）＋`aria-pressed`（`activeFilterChip`）；呼叫 `setCommentTypeFilter(type)`／`setCommentFilter(author, true)` 不帶列號 ⇒ `_applyCommentFilter` 錨在 `_topRowNode`。非 modal、不搶 `#t` 焦點；`App._onUploadLayer` 認 `isCommentFilterBarTarget` |
| 則數 | `comment_parse.js#FilterChipCounter`（黑名單比對只准在 comment_parse）＋`term_view.commentFilterCounts` | 逐列餵累積頁文字（只餵新長出來的列；首列變了、變短、黑名單換了、反向讀取中 ⇒ 從頭數），回 `{ counts: { all, push, boo, op, user }, complete }`；橫幅在 `buf` 的 `screenSettled` 時重畫一次、render 時現數。一個 byte 都不送 |
| 捲動 | `term_view._filterAnchor`／`_restoreFilterAnchor` | 設定時把點的那一列（被篩掉就往後找最近看得到的）放回原本的螢幕位置；清掉時錨在視窗頂端那一列 |

守護：`tests/unit/comment_filter.test.js`、`tests/unit/comment_filter_type.test.jsx`（P39）、`tests/unit/comment_filter_counts.test.jsx`（P44）、`tests/unit/screen_annotations_frontier.test.js`（加了兩組帶篩選的隨機文章：逐頁 append 與全量重算逐列相同）、`tests/e2e/offline/comment_filter.offline.spec.js`（真右鍵 → 選單 → 篩選 → 橫幅切換 → 「全部」還原、零送鍵）。
