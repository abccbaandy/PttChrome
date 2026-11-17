# 浮層版位（架構 review A8）

終端機周圍的浮層越來越多（底部推文列、下一篇卡片、文章導覽軸、雙欄閱讀、文章工具側欄、看板分頁、
首頁儀表板、手機工具列與 App Bar…），每個自己算位置、自己知道要讓誰。A8 的方向是「浮層只宣告要哪個
版位，由一個版面管理者排」；先從撞得最多的**底部堆疊**做起，一次一小步、行為不變。

## 第一步：可見內容的下緣只量一處

「終端機可見內容的下緣」＝好讀 footer 顯示中取它的上緣（footer 疊在格線最後一列，不在 `.main` 最下緣），
否則 `.main` 的下緣。量法收在 `src/js/bottom_stack.js`：

- `measureContentEdge(view)` → `{ mainRect, footerTop }`（footer 收起＝`null`；量不到版面＝`null`）
- `contentBottomOf(edge)` → 下緣（px，視窗座標）

`view.lastRowDiv`（好讀 footer）只有擁有者碰得到：term_view 畫它、App 切它的顯示、bottom_stack 量它。
其他檔案讀它會被 lint 規則 `pttchrome/no-footer-direct` 擋下（`tools/lint/pttchrome_rules.mjs`）。

## 各浮層怎麼讓位（現況）

| 浮層 | 下緣怎麼算 | 讓誰 |
|---|---|---|
| 底部推文列（`comment_bar.commentBarGeometry`） | 距視窗底 `max(innerHeight − 內容下緣, keyboardInset)` | 手機底部導覽＋軟鍵盤（`view.keyboardInset`）。列表推文模式另對齊終端機最後一列 |
| 下一篇卡片（`next_article._layout`） | `min(內容下緣, innerHeight − keyboardInset, 推文列實際上緣)` | footer、推文列（用它自己的 `state.bottom`）、手機導覽＋鍵盤 |
| 文章導覽軸（`article_nav.articleNavGeometry`） | `內容下緣 − 推文列高`（推文列顯示中） | footer、推文列；**不看** `keyboardInset`，推文列用「內容下緣往上一列高」推算而不是它實際的位置 |
| 底部提示、上傳浮層、讀取中 | CSS `--term-bottom-inset`（`App._onVisualViewport` 寫） | 手機工具列＋鍵盤 |

三種算法在桌機一般情形結果相同；導覽軸跟另外兩個不同的地方只在「`.main` 延伸到手機導覽列後面幾 px」
（手機列高取整）與「`.main` 下緣超出視窗」時才看得出來。下一步把導覽軸改成跟下一篇卡片同一條規則
（`min(內容下緣, innerHeight − keyboardInset, 推文列上緣)`），手機上軸的下緣會短幾 px，要先截圖確認。
