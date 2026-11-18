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
| 底部提示、讀取中、跳到未讀進度卡、回到上次的地方、上傳卡片 | `bottom_stack.aboveStackCss(px)`：`--term-bottom-inset`（`App._onVisualViewport` 寫）＋px 與推文列上緣（`--bottom-stack-clear`，推文列寫）＋8 取較高者 |

導覽軸原本只看內容下緣：手機 `.main` 因列高取整伸進導覽列後面約 4 px，軸跟著伸進去，推文列顯示中
還壓到推文列 4 px（offline-mobile 量到軸下緣 306、推文列上緣 302）；改用地板之後對齊。守護
`article_nav.test.js`「手機：…」、`bottom_stack.test.js`。新的底部浮層一律從 `stackFloorOf` 往上排。

## 左右空白：量過，先不做版位管理

雙欄閱讀左欄、文章工具側欄、導覽軸、推文列、下一篇卡片全開，offline 桌機版面量 8 種視窗
（1280×800、1366×768、1440×900、1600×900、1920×900、1920×1080、2560×1080、2560×1440）：
- **兩兩都沒有重疊**，側欄也沒有蓋到終端機。左欄＝左邊空白 − 8px、側欄＝右邊空白 − 18px，都是貼視窗邊的整高欄。
- 側欄只在終端機左右的空白夠寬才出現：16:9 的視窗（1920×1080、2560×1440）終端機字級撐滿寬度、左右只剩 75～85px，兩欄都不出現；
  1920×900 剩 235／245px、2560×1080 剩 395／405px 才出現。
- 導覽軸刻意疊在終端機最右一欄（設計如此，不算撞）。

左右兩欄各自只讀「自己那一側的空白」，彼此、跟底部堆疊都沒有共用的邊界 ⇒ 沒有實際衝突可解，
不做左右的版位管理。新加會佔左右空白的浮層時，照樣加進 `bottom_overlay`／`mobile_bottom_overlay` 的 `COMBOS`
（側欄組合只在 1920 寬跑）。

## 頂緣：量過，只有「只看關注」鈕蓋到字

C_Chat 列表好讀（cchat-list-nav）開看板分頁、關注名單有人，桌機 1280×800／1920×900、手機各量一次：
- 看板分頁整條疊在終端機第 1 列（原生按鍵提示列）上，不蓋標題列與表頭（設計如此，`board_tabs.offline.spec.js` 守）。
- **只看關注鈕疊在標題列最右邊，蓋住「看板《板名》」的後半**（1280 寬只剩「《C_Ch」）。浮層彼此不重疊，蓋到終端機字的只有它；
  要不要移位是畫面改動，寫成提案 P108 等使用者決定。搜尋狀態列蓋在標題列右段「系列《板》」上是刻意的（docs/article-search.md）。
- 手機：看板分頁住在 App Bar 裡（設計如此），只看關注在「更多」裡，沒有頂緣衝突。

頂緣三個浮層各自寫死位置（搜尋狀態列與只看關注鈕靠 CSS `body:has(#searchStatus)` 讓一排），數量少、規則簡單，
暫不收進版位管理。

## 第三步：貼視窗底的提示讓開推文列

底部提示這類浮層以前只讓開 `--term-bottom-inset`（手機底部導覽＋軟鍵盤），多留的 48px 剛好是手機推文列
（40px）＋8px。桌機推文列貼在好讀 footer 上緣，離視窗底 54px 以上 ⇒ 提示整個疊在輸入框上（offline 1920×900
量到重疊 34px）。現在推文列每次狀態變了就把「上緣離視窗底多遠」寫進 `<html>` 的 `--bottom-stack-clear`
（沒畫＝0，`bottom_stack.stackClearOf`／`publishStackClear`），提示的 `bottom` 取
`max(--term-bottom-inset + px, --bottom-stack-clear + max(8, px − 40))`：沒有推文列、或手機（推文列上緣＝導覽上緣＋40）
都跟以前同一個位置；疊在一般提示上面那層（88）照舊比提示高 40。CSS 檔裡寫死的同一條式子由 `bottom_stack.test.js`
對照；e2e `bottom_overlay`／`mobile_bottom_overlay`「底部提示不疊在推文列上」。
