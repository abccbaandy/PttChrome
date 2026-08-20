# 滑鼠（總體設計）

2026-08 整套重新設計。動 `mouse_regions.js`／`mouse_geometry.js` 或任何滑鼠入口
（`term_buf.onMouse_move`、`pttchrome.mouse_click/middleMouse_down/mouse_scroll`、
`term_view.onListMouseMove`、`list_session.onMouseClick`）前先讀這份。

## 分層

| 層 | 檔案 | 職責 |
|---|---|---|
| 決策（純函式） | `src/js/mouse_regions.js` | 這一格是什麼動作、指標長什麼樣、可點區起始欄、各 pref gate |
| 幾何（純函式） | `src/js/mouse_geometry.js` | client x ↔ col、提示帶矩形 |
| 命中排除 | `src/js/preview_targets.js` | 「點在預覽媒體上」的選擇器 |
| 原生畫面套用 | `term_buf.onMouse_move` | 寫 `mouseAction`／`nowHighlight`／指標／提示帶 |
| 列表好讀套用 | `term_view.onListMouseMove` + `list_session.onMouseClick` | 虛擬視窗自己一套 |
| 事件入口 | `pttchrome.jsx` | `mouse_click` / `middleMouse_down` / `mouse_scroll` |
| 底色 | `cursor_highlight.js` + `term_view.applyCursorHighlight` | 滑鼠與鍵盤共用，**唯一真相源**；仲裁見下方「底色仲裁」 |

## pref schema（`pref_storage.js`）

| key | 預設 | 值域 | 說明 |
|---|---|---|---|
| `useMouseBrowsing` | `true` | bool | 總開關，管得住底下全部 |
| `mouseBrowsingHighlight` | `true` | bool | 滑鼠停留的那一列上底色 |
| `keyboardCursorHighlight` | `true` | bool | 鍵盤游標列上底色（UI 在「一般」分頁） |
| `mouseBrowsingHighlightColor` | `2` | 1..15 | 兩種底色共用（UI 在「一般」分頁） |
| `mouseLeftClick` | `true` | bool | 列表點標題開文＋文章左側退出＋自訂指標 |
| `mouseMisclickGuard` | `true` | bool | 防誤觸模式：**可點區＝底色區**的起始欄（見下方「防誤觸模式」） |
| `mouseMiddleClick` | `0` | 0 關閉 / 1 貼上 / 2 左方向鍵 | |
| `mouseWheel` | `1` | 0 關閉 / 1 上下頁 | |

### 舊 → 新 key 對照（**刻意不做遷移**）

| 舊 key | 舊值域 | 去向 |
|---|---|---|
| `mouseLeftFunction` | 0 無 / 1 Enter / 2 右方向鍵 | 刪除 → `mouseLeftClick`（行為導向，不再是按鍵層級） |
| `mouseMiddleFunction` | 0 無 / 1 Enter / 2 左方向鍵 / 3 貼上 | 刪除 → `mouseMiddleClick`（**值域不同**，1 從 Enter 變貼上） |
| `mouseWheelFunction1/2/3` | 0 無 / 1 上下行 / 2 上下頁 / 3 同標題前後篇 | 刪除 → 單一 `mouseWheel`；按住左／右鍵的兩組設定整個移除 |

不遷移的理由：語意不是一對一（左鍵從「送哪個鍵」變成「開文／退出」、滾輪從三組
變一組），寫一份遷移只會把舊值硬塞進意義不同的新格子。`readValuesWithDefault` 是
`{...DEFAULT_PREFS, ...localStorage}` 的淺層合併，殘留的舊 key 不會污染新 key，
代價只是「改過那幾項設定的人要重設一次」。守護：`tests/unit/pref_schema_mouse.test.js`。

`useMouseBrowsing` 預設從 `false` 改成 `true`：它現在也管中鍵與滾輪，維持預設關等於
把「滾輪翻頁」這個本來預設就會動的功能關掉。

## 區域決策表（`resolveMouseRegion`）

座標一律是**格子空間**（`clientToPos` 的輸出）。

`S` ＝ `clickableColStart(pageState, misclickGuard)`：防誤觸開啟時列表 30、選單 8，
其餘（含防誤觸關閉）一律 0。**可點區與底色區共用它**。

| pageState | 條件 | action | cursor | 底色範圍 |
|---|---|---|---|---|
| 2（文章列表） | `2 < row < rows-1` 且該列非空 | `col >= S` → `enter(row)`，否則 `none` | 可點區 `pointer` | `[S, 行尾)` |
| 4（LIST 變體） | `1 < row < rows-2`，其餘同上 | 同上 | 同上 | 同上 |
| 1（MENU／看板列表） | `0 < row < rows-1` | `col >= S` → `enter(row)`，否則 `none` | 可點區 `pointer` | `[S, 行尾)` |
| 3（READING） | `col < 7` | `exitArticle` | `back`（PNG） | 不上色 |
| 3 | 其餘 | `none` | `auto` | 不上色 |
| 0 / 5 / 6 | — | `none` | `auto` | 不上色 |

**依據**（不臆測，出處在 `3rd_script/pttbbs`）：

- 列表欄位＝`mbbsd/bbs.c#readdoent` 的 printf 序列：序號 `%7d` 佔 0-6（置底文的
  `★` 版型也剛好 7 格）、空格 7、type 8、推文數 9-10、日期 `%-6.5s` 11-16、
  作者 `%-13.12s` 17-29、mark 30-31、標題 33-。常數在 `comment_parse.js`
  （`LIST_TITLE_COL_START = 30`），判斷用 `listColRegion(col)`。
- **看板列表刻意不套欄位限制**：`mbbsd/board.c#show_brdlist` 每列至少四種版型
  （`NBRD_LINE` 分隔線、`NBRD_FOLDER` 目錄、`IN_CLASSROOT()` 的 10 空格前綴、
  一般看板列），沒有共用的標題欄起點可校準。維持整列 `col > 7`。
- **`realignListColumns` 絕不可套在滑鼠 col 上**：那是文字空間的 DBCS 折疊補償
  （`rowToText` 把兩格併一個字元），格子空間沒有位移。

## 防誤觸模式（`mouseMisclickGuard`，預設開）

**合約：可點區＝底色區**（使用者 2026-08 定案）。唯一真相源是
`mouse_regions.clickableColStart(pageState, guard)`，底色端經
`cursor_highlight.highlightColStart({ mode, pageState, misclickGuard })` 委派它。

| | 文章列表／選單 | 文章推文列（pusher 高亮） |
|---|---|---|
| 開 | 只有標題（選項）欄可點，底色也只蓋那一段 | 只有內容文字可點（該列的 `contentCol`） |
| 關 | 整列可點、整列上底色 | 整列可點（＝改版前的行為） |

- **推文列的欄位不是全畫面共用**：`contentCol` 由 `comment_parse.annotateComment`
  逐列算（`推 id: ` 的長度隨 id 變），經 `Row` 輸出成 `data-pusher-col`，
  `App.mouse_click` 讀它。文章頁**不上 hover 底色**（維持原樣），所以那裡只有可點區。
- **底色不分 `lastMover`**：鍵盤游標與滑鼠 hover 共用同一個寬度。兩種光棒不一樣長
  只會讓人以為畫面壞了。
- 2026-08 之前是「整列上底色、只有標題欄可點」，兩者刻意不一致 —— 代價是使用者
  無從得知邊界在哪；現在那條底色本身就是「這裡點得下去」的提示。
- **部分寬度底色的 DOM**：`highlightClass` 掛在 block 級的 `bbsline` span 上就是滿版，
  所以 `S > 0` 時改掛在一個「從第 S 欄包到行尾」的 span 上（`LinkSegmentBuilder`
  的 `_flushHighlightWrap`，比照 `.commentByAuthor` 的欄位範圍包裝）。三種範圍都是
  「到行尾」⇒ **只有開邊界、沒有關邊界**。那個 span 另帶一個無樣式的識別 class
  `.cursorHighlight`：`b1..b15` 同時也是 ANSI 背景色 class，光看顏色分不出光棒與
  「這格本來就有底色」（狀態列就有 b6，`easy-reading-list.offline.spec.js` 踩過）。
- 邊界欄都落在 ASCII 欄（列表 col 30 是 mark 欄、選單 col 8、推文 `contentCol` 緊接
  `": "`），不會切在 DBCS 的 trail cell 上。
- `blacklistNotice` 列（原生列表的「(本文已被黑名單)」通知）**維持整列上色**：那是
  我們自己合成的文字、本來就開不了，套欄位範圍沒有意義。

### 移除的舊動作

列表左緣離開、右緣翻頁、頂列 Home、底列 End、`[`／`]`／`=` 同標題前後篇、
重新整理、同標題末篇，以及 pageState 3 的 row 0/1/2/23 特例。舊的 `mouseCursor`
是 0..14 的數字、同時兼任「長什麼樣」與「點了做什麼」，改名 `mouseAction` 是刻意的
（漏改的地方會變 `undefined` 而不是靜默走進錯的 case）。

**舊 `case 0` 也送左方向鍵** —— 那就是「文章裡隨手點一下就跳出去」的來源。新版
`none` 一定什麼都不做。

## Gating 表（`resolveMouseGates`）

| 入口 | 條件 |
|---|---|
| 底色 | `useMouseBrowsing && mouseBrowsingHighlight`（在 `resolveHighlightRow` 的 `mouseEnabled`，**不要再加第二層**）；滑鼠與鍵盤誰贏另見「底色仲裁」 |
| 指標圖示 | `useMouseBrowsing && mouseLeftClick` |
| 左鍵動作 | `useMouseBrowsing && mouseLeftClick` |
| 左側提示帶 | `useMouseBrowsing && mouseLeftClick && pageState === 3` |
| 防誤觸（可點區＝底色區的起始欄） | `useMouseBrowsing && mouseMisclickGuard` —— **跟著總開關走**，總開關關掉時左鍵／指標／提示帶全滅，沒有誤觸要防；設定頁那顆 checkbox 因此能與其他子項一樣 `disabled` |
| 中鍵 | `useMouseBrowsing && mouseMiddleClick !== 0` |
| 滾輪 | `useMouseBrowsing && mouseWheel !== 0` |
| 連結／圖片／`[data-pusher]`／`copyOnSelect`／右鍵選單 | **不受任何滑鼠 pref 影響** |

改版前 `middleMouse_down` 與 `mouse_scroll` 完全不看 `useMouseBrowsing`，「關掉滑鼠
瀏覽」只關得掉一半。守護：`tests/unit/mouse_gating.test.js`、
`tests/e2e/offline/mouse.offline.spec.js`。

滾輪關閉時 `mouse_scroll` **直接 return，不 preventDefault**（語意＝我們完全不碰）。
原生模式沒有可捲距離（`#BBSWindow` 是 `fixed; overflow:hidden`，`.main` 的高度就是
內容高），所以放行不會造成怪異捲動。

## 底色仲裁（誰最後動誰贏）

`resolveHighlightRow` 收一個 `lastMover`（`'mouse'` | `'keyboard'`），狀態由
`term_view`（`_highlightMover` / `_highlightMode` / `_lastCursorRow`）維護：

| 事件 | 怎麼判 |
|---|---|
| 滑鼠移動 | 明講：`applyCursorHighlight('mouse')`。來源只有兩處 —— `term_view.onListMouseMove`、`term_buf.setHighlight`（**且 row >= 0**） |
| 鍵盤游標移動 | 沒有事件可掛（游標是 server 畫的）⇒ 以「鍵盤游標列變了」推導：`mode` 相同且 `kbRow !== _lastCursorRow` |

規則：`lastMover === 'keyboard'` **且該畫面真的有鍵盤游標列**時鍵盤贏，其餘沿用「滑鼠優先」。
後半段的守門是刻意的 —— 鍵盤底色關掉、或文章頁（native pageState 3）本來就沒有游標列，
不能因為「剛剛按過鍵」就讓 hover 底色整個消失。

三個坑，改這段前先看：

- **`row < 0`（`clearHighlight`）不算滑鼠移動**：`term_buf.notify` 每個重畫幀都呼叫它，
  當成滑鼠移動的話鍵盤永遠搶不到底色。
- **比對 `mode` 是必要的**：native 的 `buf.cur_y` 與 listBuffer 的虛擬游標列是兩套列號，
  模式切換造成的列號變動不是使用者移動游標。
- **`onListMouseMove` 的同列早退只在滑鼠本來就持有底色時成立**（`wasMouse`）：
  鍵盤剛搶走時，即使 hover 列沒變也要重新套用，否則在同一列內晃滑鼠拿不回來。

歷史坑：改成仲裁之前是「滑鼠恆勝」（`mouseEnabled && mouseRow >= 0` 就回 hover 列），
而滑鼠列是**黏著狀態** —— 列表好讀的 `_listHoverRow` 沒有任何一處會在鍵盤操作時清掉
⇒ 滑鼠停過一次之後底色就釘死在那一列（原生只因 `notify` 順手 `clearHighlight` 而在
「有重畫的幀」看起來正常，純游標移動的幀一樣卡住）。

`term_buf.notify` 的 `if (this.changed) clearHighlight()` **刻意保留**：它同時清
`mouseAction`/`mouseActionRow`，點擊正確性依賴它。

## 三種 render 分支各由誰處理

| 分支 | 移動 | 點擊 | 滾輪 |
|---|---|---|---|
| 原生 24 列 | `term_buf.onMouse_move` | `App.onMouse_click`（依 `buf.mouseAction`） | `setBBSCmd('doPageUp'/'doPageDown')` |
| 好讀文章長頁 | 同上（`clientToPos` 把 row clamp 進 0..rows-1） | 同上 + `easyReading._onMouseClick` 先收狀態機 | **early return，交給瀏覽器捲動** |
| 列表好讀（buffer/frozen） | `term_view.onListMouseMove(row, col)` | `list_session.onMouseClick(row, col)` | `listSession.onWheel('pgup'/'pgdn')` |

列表好讀分支在 `App.mouse_click` 的 `preventDefault()` 是**無條件**的（即使滑鼠功能
整組關掉）：那個畫面是我們自己組的，不能讓瀏覽器預設行為對它動作。pref gate 只包住
「要不要真的開文」。

## 點擊優先權（`App.mouse_click` 左鍵分支，由上而下）

1. `modalShown`
2. `aidNavigation.active`
3. 讀清 `SkipMouseClick`
4. **`closest('a')`** —— 連結
5. **`closest(PREVIEW_CLICK_SELECTOR)`** —— 內嵌預覽
6. `getSelection().isCollapsed`
7. `closest('[data-pusher]')` —— 推文者高亮（防誤觸開啟時還要 `col >= data-pusher-col`；**欄位不合不 return**，讓下面的左側退出帶接手）
8. `listRenderMode` buffer/frozen 分支
9. `useMouseBrowsing` gate
10. `mouseLeftClick` gate
11. `checkClass` / `menuitem` / `skipMouseClick`
12. `onMouse_click(e)`

第 4、5 條是「文章裡的可點擊物件優先」的實作，順序不可調換：文章模式的第 0-6 欄
現在是退出手勢，而連結與內嵌預覽圖都可能落在那幾欄（預覽圖甚至是整寬區塊、起點
就在第 0 欄，而且走的是 `Screen` 的事件委派 `onClick`，不是 `<a>` 的子孫 ⇒ 第 4 條
攔不到）。

第 7 條的欄位條件是 2026-08 補的：`data-pusher` 掛在**整列**的 `bbsrow` span 上，
而這一條走在滑鼠瀏覽 gate 之前 ⇒ 推文列的 cols 0-6 一律被 pusher 高亮吃掉，
**退出手勢在整個推文區失效**（使用者回報）。修法是「命中但欄位不合就繼續往下走」，
不是把這條往後移（連結／預覽仍必須贏過它）。

**`closest('a')` 不可退回「只看 parentElement」**：連結內部最深可到
`a > span > span`（`LinkSegmentBuilder` 的 `TwoColorWord` / `ForceWidthWord`，
DBCS 雙色字），只找一層在那種字上會漏判。同一個 bug 在
`components/ContextMenu/index.jsx` 也有一份（雙色連結按右鍵時「複製連結網址」整組
消失），2026-08 一併修掉。

### 順序陷阱：先取值再交給好讀

`App.onMouse_click` 必須在呼叫 `easyReading._onMouseClick(e)` **之前**把
`buf.mouseAction` / `mouseActionRow` 取下來：那條路徑會 `stopEasyReading()` →
`buf.notify()` → `clearHighlight()` 把 `mouseAction` 清成 `none`。改版前這個順序
沒事，只是因為舊的 `case 0`（＝被清掉的狀態）也送左方向鍵，剛好跟離開同義。

## 左側退出提示帶（`#exitHintBand`）

- 是 `term_view` 自有的獨立 div，掛在 `#BBSWindow` 底下、`.main` **之後**。不放
  `Screen`／`#mainContainer`：`.main` 是好讀長頁的捲動容器，放裡面會跟著內容捲走；
  三種 render 分支要行為一致；原生模式 Screen 每幀 re-render，hover 布林不該進
  React state。先例見 `term_ui.jsx` 的 `#easyReadingLastRow`。
- **座標契約：只能與 `App.clientToPos` 同源**。`clientToPos` 的欄位數學已抽到
  `mouse_geometry.colFromClientX`，帶子用同一份的 `exitBandRect`。專案裡另有
  `term_view.convertMN2XYEx` 一套原點公式（多了 `+10` 與 `bbsViewMargin`），用錯就
  差十幾個像素 ⇒ 帶子亮著卻點不到。往返守護在 `tests/unit/mouse_geometry.test.js`
  與 `mouse.offline.spec.js` 的「提示帶右緣＝可點區右緣」。
- 幾何在 `term_view.setTermFontSize` 尾巴寫（全專案唯一的幾何 sink）；高度由 CSS 給
  （`top:0; height:100%`，`#BBSWindow` 是 `position:fixed` 的定位容器）。帶子不參與
  `.main` 的 transform，所以寬度自己乘 `scaleX`（`cellWidth` 已處理）。
- **`pointer-events: none` 是硬需求不是保險**：少了它，左側 7 欄的連結與內嵌預覽圖
  全部點不到（`e.target` 變成帶子，`closest('a')` 一律落空）。
- **不可宣告任何 `user-select`**（Firefox 上最外層的非 auto 值會沿 frame 鏈壓過子層，
  見 `#BBSWindow` 的註解與 `tests/unit/css_user_select.test.js`）。
- 關掉的時機（漏一個就會留殘影）：`term_buf.onMouse_move`／`clearHighlight`、
  `term_view.onListMouseMove`、`App.onPrefChange` 的兩個開關、`App.setModalOpen`、
  window `blur`。

## 自訂滑鼠指標

只剩一顆 `src/cursor/back.png`（離開文章），其餘 10 個 PNG 已刪。

**歷史坑**：舊的 `mouseCursorMap` 每一筆都寫成 `` `url(${x} 0 6,auto` `` —— **少一個
右括號**。依 CSS Syntax，`url(` 之後出現空白且下一個字元不是 `)` 會產生
bad-url-token，整條 `cursor` declaration 直接被丟棄。也就是說那 11 顆自訂指標從
React 改寫以來**從未生效過**（只有 `pointer`/`default`/`auto` 有作用），「文章左側
可以退出」因此一直沒有任何提示。`cursorCss` 有一條括號平衡的回歸鎖
（`tests/unit/mouse_regions.test.js`）。

## 測試

| 檔案 | 鎖什麼 |
|---|---|
| `tests/unit/mouse_regions.test.js` | 區域決策表逐格 + `clickableColStart` + 防誤觸關閉時整列可點 + `cursorCss` 括號平衡 |
| `tests/unit/mouse_geometry.test.js` | 帶子右緣 ↔ 可點區右緣往返（三組幾何） |
| `tests/unit/mouse_gating.test.js` | 總開關關掉 ⇒ 中鍵與滾輪也關 |
| `tests/unit/cursor_highlight.test.js` | 底色決策表 + `lastMover` 仲裁（含鍵盤底色關／文章頁的回退）+ `highlightColStart` |
| `tests/unit/row_render.test.jsx` | 部分寬度底色的 DOM（包裝 span 的範圍／`data-pusher-col`） |
| `tests/unit/comment_parse.test.js` | `contentCol`（推文內容起始欄） |
| `tests/unit/cursor_highlight_arbitration.test.js` | `applyCursorHighlight` 的來源判定：鍵盤搶得走、滑鼠拿得回、模式切換不算移動 |
| `tests/unit/list_hover_gating.test.js` | 列表 hover 的三個 gate、底色 vs pointer 條件不同 |
| `tests/unit/list_click_open.test.js` | 列表點擊的標題欄限制 |
| `tests/unit/pref_modal_mouse_tab.test.jsx` | 設定分頁的欄位、預設值、子項 disabled、選項值域 |
| `tests/unit/pref_schema_mouse.test.js` | 新 key 齊備、舊 key 已移除、殘值不復活 |
| `tests/unit/i18n_parity.test.js` | 兩語系 key 集合一致 |
| `tests/e2e/offline/mouse.offline.spec.js` | 提示帶／pointer-events／像素對齊／優先權／總開關／推文列可點區（防誤觸三態） |
| `tests/e2e/offline/easy-reading-list.offline.spec.js` | 列表好讀的底色左緣＝標題欄、切防誤觸後回到整列 |
| `tests/e2e/offline/wheel_stuck_button.offline.spec.js` | 按鍵旗標卡死的三條路徑 |
