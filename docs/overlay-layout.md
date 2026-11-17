# 浮層版位（架構 review A8）

終端機周圍的浮層越來越多（底部推文列、下一篇卡片、文章導覽軸、雙欄閱讀、文章工具側欄、看板分頁、
首頁儀表板、手機工具列與 App Bar…），每個自己算位置、自己知道要讓誰。A8 的方向是「浮層只宣告要哪個
版位，由一個版面管理者排」；先從撞得最多的**底部堆疊**做起，一次一小步、行為不變。

## 第一步：可見內容的下緣只量一處

「終端機可見內容的下緣」＝好讀 footer 顯示中取它的上緣（footer 疊在格線最後一列，不在 `.main` 最下緣），
否則 `.main` 的下緣。量法收在 `src/js/bottom_stack.js`：

- `measureContentEdge(view)` → `{ mainRect, footerTop }`（footer 收起＝`null`；量不到版面＝`null`）
- `contentBottomOf(edge)` → 下緣（px，視窗座標）
- `stackFloorOf({ ...edge, innerHeight, keyboardInset })` → 底部堆疊的地板：內容下緣，再讓開視窗底的手機導覽列＋軟鍵盤＋safe-area（`view.keyboardInset`）

`view.lastRowDiv`（好讀 footer）只有擁有者碰得到：term_view 畫它、App 切它的顯示、bottom_stack 量它。
其他檔案讀它會被 lint 規則 `pttchrome/no-footer-direct` 擋下（`tools/lint/pttchrome_rules.mjs`）。

## 各浮層怎麼讓位

底部堆疊由下往上：手機導覽列＋鍵盤（視窗底）→ 地板（`stackFloorOf`）→ 推文列 → 下一篇卡片／導覽軸。

| 浮層 | 下緣 |
|---|---|
| 底部推文列（`comment_bar.commentBarGeometry`） | 貼在地板上（距視窗底 `innerHeight − 地板`）。列表推文模式另對齊終端機最後一列 |
| 下一篇卡片（`next_article._layout`） | `min(地板, 推文列實際上緣)` |
| 文章導覽軸（`article_nav.articleNavGeometry`） | 地板，推文列顯示中再扣推文列高 |
| 底部提示、上傳浮層、讀取中 | CSS `--term-bottom-inset`（`App._onVisualViewport` 寫） |

導覽軸原本只看內容下緣：手機 `.main` 因列高取整伸進導覽列後面約 4 px，軸跟著伸進去，推文列顯示中
還壓到推文列 4 px（offline-mobile 量到軸下緣 306、推文列上緣 302）；改用地板之後對齊。守護
`article_nav.test.js`「手機：…」、`bottom_stack.test.js`。新的底部浮層一律從 `stackFloorOf` 往上排。
