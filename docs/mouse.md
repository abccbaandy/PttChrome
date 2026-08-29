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
| 標示 | `cursor_highlight.js` + `term_view.applyCursorHighlight` | 滑鼠與鍵盤共用，**唯一真相源**；來源／樣式分兩層見下方「游標列標示」，仲裁見「底色仲裁」 |

## pref schema（`pref_storage.js`）

| key | 預設 | 值域 | 說明 |
|---|---|---|---|
| `useMouseBrowsing` | `true` | bool | 總開關，管得住底下全部 |
| `mouseBrowsingHighlight` | `true` | bool | **來源層**：滑鼠停留的那一列要不要標示 |
| `keyboardCursorHighlight` | `true` | bool | **來源層**：鍵盤游標列要不要標示（UI 在「一般」分頁） |
| `cursorRowBrighten` | `true` | bool | **樣式層**：整列提亮、背景不動（UI 在「一般」分頁） |
| `cursorRowBackground` | `false` | bool | **樣式層**：整列上底色（UI 在「一般」分頁） |
| `mouseBrowsingHighlightColor` | `2` | 1..15 | 底色樣式的顏色，滑鼠與鍵盤共用（UI 在「一般」分頁） |
| `mouseLeftClick` | `true` | bool | 列表點標題開文＋文章左側退出＋自訂指標 |
| `mouseMisclickGuard` | `true` | bool | 防誤觸模式：**可點區＝底色區**的起始欄（見下方「防誤觸模式」） |
| `mouseFunctionKeys` | `true` | bool | 畫面上的功能鍵提示變成按鈕（見下方「功能鍵按鈕」） |
| `mouseMiddleClick` | `0` | 0 關閉 / 1 貼上 / 2 左方向鍵 | |
| `mouseWheel` | `1` | 0 關閉 / 1 上下頁 | |
| `mouseWheelSmoothScroll` | `true` | bool | 滾輪平滑捲動（連續位移＋緩動，畫面停得住半列），**只作用於文章列表好讀模式**（其餘畫面沒有這個選擇，見下方 render 分支表）。關掉＝該模式退回一次一頁 |

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
| 2（文章列表） | `2 < row < rows-1` 且該列非空 且 `col < 7` | `exit` | `back`（PNG） | 不上色 |
| 2 | `2 < row < rows-1` 且該列非空 | `col >= S` → `enter(row)`，否則 `none` | 可點區 `pointer` | `[S, 行尾)` |
| 4（LIST 變體） | `1 < row < rows-2`，其餘同上兩列 | 同上 | 同上 | 同上 |
| 1（MENU／看板列表） | `0 < row < rows-1` 且 `col < 7` | `exit` | `back`（PNG） | 不上色 |
| 1 | `0 < row < rows-1` | `col >= S` → `enter(row)`，否則 `none` | 可點區 `pointer` | `[S, 行尾)` |
| 3（READING） | `col < 7` | `exitArticle` | `back`（PNG） | 不上色 |
| 3 | 其餘 | `none` | `auto` | 不上色 |
| 0 / 5 / 6 | — | `none` | `auto` | 不上色 |
| **任何 pageState** | `inputPrompt`（PTT 開著輸入框） | `none` | `auto` | 不上色 |

**`inputPrompt` ＝ `term_buf.isCursorOnInputField()`**（游標所在格是**白底黑字**，且該列不是從 col 0 就反白的狀態列）：PTT 的輸入框
一律由 `mbbsd/vtuikit.c#vgetstring` 以 `VCLR_INPUT_FIELD`（`ESC[0;7m`）畫成反白欄，
並把游標 `move` 進欄內（見 `docs/pttbbs-screen-protocol.md` §5）。這種畫面只重畫最上面
一兩列，下方的列表／選單整片殘留 ⇒ `pageState` 黏著、看起來還可以點，但那一點送出的
Enter 會被輸入框吃掉（等於替使用者送出搜尋／進錯看板），左側退出帶的左方向鍵同理。
底色端由 `cursor_highlight.resolveHighlightRow` 用**同一個事實**關掉，兩邊一起動才守得住
「可點區＝底色區」。守護：`tests/unit/mouse_regions.test.js`、`cursor_highlight.test.js`、
`cursor_highlight_arbitration.test.js`、`term_buf_input_field.test.js`。

**左 7 欄（`EXIT_COL_END`）的退出帶三種畫面共用**，且**不看 `mouseMisclickGuard`**
（使用者 2026-08 定案）：它是一個固定手勢，不是「哪一欄算內容」的欄位判定。

`exit`（列表／選單）與 `exitArticle`（文章）**刻意是兩個常數**，雖然兩者都送
`\x1b[D`：列表好讀底下必須走 `ListSession.onMouseExitClick` → `_beginLeave`
（先 `getkeep` 同步真游標再送鍵，v5 封閉互動），文章則是 `App.onMouse_click` 直送。
分成兩個常數才逐處檢查得出來誰漏改。

退出帶的判斷**排在列範圍與 `lineEmpty` 檢查之後**，所以 header／footer 那幾列
（現在有功能鍵按鈕）不會同時是退出區 —— 「提示帶亮＝點得下去」的合約靠這個成立。

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
- **切點可能落在 DBCS 的 trail cell 上，`LinkSegmentBuilder` 自己往後推一格**。
  真的列表／選單／推文列邊界欄確實都在 ASCII 欄（列表 col 30 是 mark 欄、選單 col 8、
  推文 `contentCol` 緊接 `": "`），但 `S` 是**與內容無關的固定欄號**：列表上叫出的
  prompt（`s` 搜尋看板）畫面 pageState 黏在 2，col 30 剛好是「請輸入看板名稱(按空白鍵
  自動搜**尋**)」那個字的 trail ⇒ 切下去 `ColorSegmentBuilder` 待配對的 lead byte 被丟掉、
  trail byte 被當 ASCII 畫成 `M`，該字從 2 格縮成 1 格、整段左移、游標錯位（2026-08
  使用者回報）。修法：切點若落在 trail 上就 `+1`（整個字留在底色外）。
  守護 `tests/unit/highlight_col_dbcs.test.js`。
- `blacklistNotice` 列（原生列表的「(本文已被黑名單)」通知）**維持整列上色**：那是
  我們自己合成的文字、本來就開不了，套欄位範圍沒有意義。

### 移除的舊動作

右緣翻頁、頂列 Home、底列 End、`[`／`]`／`=` 同標題前後篇、
重新整理、同標題末篇，以及 pageState 3 的 row 0/1/2/23 特例。

**「列表左緣離開」2026-08 重新加回**（上表的 `exit`）。當初與其他 14 種一起移除的
理由是「誤觸率高又完全沒有提示」，而**提示問題已經解決** —— 提示帶（`#exitHintBand`）
＋ back 指標補上之後，滑鼠靠近左緣就看得到「這裡點下去會回上一層」。誤觸率的部分
也不同：舊版是**整個畫面每一區都有動作**，現在只有固定的左 7 欄。舊的 `mouseCursor`
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
| 左側提示帶 | `useMouseBrowsing && mouseLeftClick && region.cursor === CUR_BACK`（＝ pageState 1/2/3/4 的左 7 欄；**用 cursor 判、不逐一列舉 action**，日後新增退出動作不會漏列舉） |
| 功能鍵按鈕 | `useMouseBrowsing && mouseFunctionKeys`（`term_view._renderScreenLines` 與 `_mirrorStatusRowToFooter` 兩處各 gate 一次） |
| 防誤觸（可點區＝底色區的起始欄） | `useMouseBrowsing && mouseMisclickGuard` —— **跟著總開關走**，總開關關掉時左鍵／指標／提示帶全滅，沒有誤觸要防；設定頁那顆 checkbox 因此能與其他子項一樣 `disabled` |
| 中鍵 | `useMouseBrowsing && mouseMiddleClick !== 0` |
| 滾輪 | `useMouseBrowsing && mouseWheel !== 0` |
| 滾輪平滑捲動 | `useMouseBrowsing && mouseWheel !== 0 && mouseWheelSmoothScroll`（`resolveMouseGates` 的 `wheelSmoothScroll`；只有列表好讀分支會問這一格） |
| 連結／圖片／`[data-pusher]`／`copyOnSelect`／右鍵選單 | **不受任何滑鼠 pref 影響** |

改版前 `middleMouse_down` 與 `mouse_scroll` 完全不看 `useMouseBrowsing`，「關掉滑鼠
瀏覽」只關得掉一半。守護：`tests/unit/mouse_gating.test.js`、
`tests/e2e/offline/mouse.offline.spec.js`。

滾輪關閉時 `mouse_scroll` **直接 return，不 preventDefault**（語意＝我們完全不碰）。

**平滑捲動的三段換算**（列表好讀專用；其他畫面走上面那兩條）：

1. `src/js/wheel_scroll.js#wheelDeltaToPx`（純函式）——認 `deltaMode`：0 像素／1 列
   （Firefox 滑鼠滾輪送的是**列**，只看 deltaY 幾乎不動）／2 頁。
2. **座標系**：wheel 給的是**螢幕**像素，而視窗較矮時整個終端機被 `scaleY` 縮放過
   （`term_view.setTermFontSize`）⇒ `App.mouse_scroll` 除以 scaleY 換成**內容像素**，
   之後所有數字（`chh`、次列偏移、body 視口的 scrollTop）都在內容座標系。漏掉這一步
   會捲太多／太少。
3. `src/js/smooth_scroll.js` 的緩動器把距離分幀吃掉（指數趨近，~120ms 收斂），每幀
   交給 `ListSession._stepScroll`。

**次列位移的座標契約**：畫面可以停在半列上（body 視口的 scrollTop = frac），所以
`App.clientToPos` 對 body 區的列號要補回 frac，否則點擊與底色會標到上一列。視口底部
露出的那一小條是 **overscan 列，渲染 index 24**（不是 3+20=23，那是 footer 的列號），
`onListMouseMove`／`ListSession.onMouseClick` 都認這個值 ⇒ 「可點範圍＝標示範圍」在
半列狀態下仍成立。
守護：`tests/unit/wheel_scroll.test.js`、`tests/unit/smooth_scroll.test.js`、
`tests/unit/render_list_scroll.test.js`。
原生模式沒有可捲距離（`#BBSWindow` 是 `fixed; overflow:hidden`，`.main` 的高度就是
內容高），所以放行不會造成怪異捲動。

## 游標列標示：來源層 × 樣式層（2026-08-26）

兩層**正交**，`applyCursorHighlight` 各問一次：

| 層 | 問題 | 函式 | pref |
|---|---|---|---|
| 來源 | 哪一列 | `resolveHighlightRow` | `mouseBrowsingHighlight` / `keyboardCursorHighlight`（＋ `lastMover` 仲裁） |
| 樣式 | 畫什麼 | `cursorHighlightClasses` | `cursorRowBrighten` / `cursorRowBackground` |
| 寬度 | 從第幾欄畫起 | `highlightColStart` | `mouseMisclickGuard`（＝可點區，見上） |

樣式層回一個 **class 字串**，可能是多個 class（`"cursorBrighten b2"`）：

- 兩種樣式**可以同時開**，不是二選一。
- 兩種都關 ⇒ 回 `""`，`applyCursorHighlight` 直接送 `NO_CURSOR_HIGHLIGHT`
  （不是送一個沒有樣式的 class，否則 Screen 會為看不見的變化重畫）。
- 多 class 表示 `Screen._toggleRowClass` **必須拆 token**：`classList.add("a b")`
  會噴 `InvalidCharacterError`，整條標示鏈就地掛掉。守護
  `tests/unit/cursor_highlight_fastpath.test.js`。

### 提亮樣式（`cursorRowBrighten`，預設開）

還原 pttbbs `e18a7182` 的 `grayout(row,row+1,GRAYOUT_COLORBOLD)`＝整列 `FTATTR_BOLD`
/ `ESC[1m`（前景提亮一階、**背景不變**）。考證與官方中文名見
`docs/pttbbs-screen-protocol.md` §11.4 —— 簡單說：官方詞彙的「光棒」專指**有底色**的
`UF_CURSOR_STANDOUT`，圓點 `●` 是另一個 flag `UF_CURSOR_LEGACY`（只換符號、無高亮），
無底色提亮那個實驗品已於 `814adde3` 移除。

實作全在 CSS（`css/color.css` 的 `.cursorBrighten`）：

- 「提亮一階」＝把 `q0..q7` 換成 `q8..q15` 的色值 —— 與 `TermChar.getFg()` 的
  `bright ? fg+8 : fg` 同語意，不必動渲染鏈。
- **絕對不可以用 `font-weight`**：等寬格線字重一變整列位移、`.wpadding` 的寬度契約
  （`term_view.fixedResize` 直接掃 DOM 改它）跟著壞。同 `main.css` 的 `.fnKey` 禁令。
  demo／原始碼直覺都會想加，守護在 `tests/unit/cursor_row_brighten.test.js`。
- 已經是 `q8..q15` 的字沒有更亮的一階（原始碼是再疊 `FTATTR_BLINK`＝閃爍，太吵不採用）
  ⇒ 改用整列 `text-shadow` 微發光（完全不參與 layout）。
- 上班模式（`.work-mode-active`）**必須有自己一組**：與 `.cursorBrighten .qN` 同
  specificity (0,2,0)，靜音調色盤在檔案後面 ⇒ 不寫就整個蓋掉。

### 底色樣式預設為什麼開新 key，而不是把 `keyboardCursorHighlight` 翻成 `false`

`readValuesWithDefault` 是 `{...DEFAULT_PREFS, ...localStorage}` 淺層合併，而
`PrefModal.onCloseClick` 每次關閉**整包 `writeValues`** ⇒ 任何開過一次設定頁的人
localStorage 裡已經有舊 key 的舊值，翻預設對他們**完全無效**。開新 key 是唯一能讓既有
使用者也拿到新預設的做法（本 repo 刻意沒有 pref 遷移機制，見上方「舊 → 新 key 對照」）。
守護：`tests/unit/pref_schema_cursor_row.test.js`。

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
| 列表好讀（buffer/frozen） | `term_view.onListMouseMove(row, col)` | 左 7 欄 → `list_session.onMouseExitClick()`；其餘 → `list_session.onMouseClick(row, col)` | 預設 `listSession.onWheelScrollPx(px)`（平滑）；`mouseWheelSmoothScroll` 關 → `listSession.onWheel('pgup'/'pgdn')` |

列表好讀分支在 `App.mouse_click` 的 `preventDefault()` 是**無條件**的（即使滑鼠功能
整組關掉）：那個畫面是我們自己組的，不能讓瀏覽器預設行為對它動作。pref gate 只包住
「要不要真的開文」。

## 點擊優先權（`App.mouse_click` 左鍵分支，由上而下）

**先決條件（這張表描述不到的一層）：元素層的 listener 永遠比 window handler 早跑。**
`App.mouse_click` 掛在 `window` 上，而 `a.aidLink` / `a.fnKey` 的 click listener 掛在
元素自己身上 ⇒ **下面第 1、2 條守門攔不到它們**。這兩種連結因此必須各自守：
`aid_navigation.js` 靠 `if (this.active) return;`，功能鍵靠 `App.onFunctionKey` 開頭的
`modalShown` / `aidNavigation.active` / `commandQueue.inFlightKind` 三道（見下方
「功能鍵按鈕」）。新增任何元素層 listener 時同理。

1. `modalShown`
2. `aidNavigation.active`
3. 讀清 `SkipMouseClick`
4. **`closest('a')`** —— 連結、AID 連結、**功能鍵按鈕**（`a.fnKey`）
5. **`closest(PREVIEW_CLICK_SELECTOR)`** —— 內嵌預覽
6. `getSelection().isCollapsed`
7. `closest('[data-pusher]')` —— 推文者高亮（防誤觸開啟時還要 `col >= data-pusher-col`；**欄位不合不 return**，讓下面的左側退出帶接手）
8. `listRenderMode` buffer/frozen 分支
9. `useMouseBrowsing` gate
10. `mouseLeftClick` gate
11. `checkClass` / `menuitem` / `skipMouseClick`
12. `onMouse_click(e)`

**功能鍵用 `<a>` 是刻意的**：第 4 條的早退讓它自動贏過所有滑鼠瀏覽分支
（含左 7 欄的退出帶）⇒ 加這個功能時 `App.mouse_click` 一行都不用改。守護在
`tests/unit/screen_fnkeys_render.test.js`（標籤名一旦被改成 `span`，功能鍵會靜默
變成「點了就退出文章／開錯文」）。

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

## 功能鍵按鈕（`mouseFunctionKeys`，預設開）

把畫面上的 `[←]離開 [→]閱讀 [Ctrl-P]發表文章 [d]刪除 …` 與
` 文章選讀  (y)回應(X)推文(^X)轉錄 …` 變成可點的 `<a class="fnKey">`，點一下＝送出
那個按鍵。

**只認單一按鍵。** `(=[]<>)`（同標題前後篇）、`(/?a)`（搜尋）、`(v/V)`（已讀／未讀）、
`(R/y)`、`[↑↓]` 這種多鍵組一律維持純文字：取第一個會送錯鍵（`v` 標已讀 vs `V` 標未讀、
`d` 刪一封 vs `D` 刪範圍），違反「PTT 邏輯不准猜」。

| 層 | 檔案 | 職責 |
|---|---|---|
| 解析（純函式） | `src/js/footer_keys.js` | `parseFunctionKeys(chars)` → `[{startCol, endCol, keyBytes, label}]`；`functionKeyRows(pageState, rows)` → 要掃哪幾列 |
| 標註 | `screen_annotations.js#applyFunctionKeys` | 把結果掛進 `result[row].fnKeys`（**只寫 `result`，不碰 `base`**） |
| 渲染 | `render/link_segment.js` | `a.fnKey` 分支，開/關邊界與 mention 同一套舞步 |
| 送鍵漏斗 | `App.onFunctionKey(bytes, label)` | 唯一入口，形狀比照 `onPasteDone` |
| 決策（純函式） | `src/js/function_key_plan.js` | `functionKeyClickPlan({bytes, mode})` |

**pttbbs 校準**（逐條查證，非畫面反推）：

- `mbbsd/bbs.c:663` `readtitle()`：`showtitle()` 佔 row 0，緊接 `outs("[←]離開 …")`
  ⇒ 提示列在 **row 1**
- `mbbsd/board.c:1330`：看板列表同樣在 row 1
- `mbbsd/vtuikit.c:722` `vs_footer()`：一律 `move(b_lines, 0)` ⇒ **最後一列**；
  `(` / `)` 有獨立配色，是「一個按鍵」的視覺約定
- `mbbsd/pmore.c:2195`：文章 footer part3 ＝ `(h)按鍵說明 ` ＋ `←[q]離開 `
  （`←` 是裸的沒括號 ⇒ 依規則不可點；相鄰的 `[q]` 可點且同義，`pmore.c:2548` 兩者
  都是 `flExit = 1`）

⇒ `functionKeyRows`：pageState 1/2/4 → `[1, rows-1]`；3 → `[rows-1]`；其餘 → `null`。

### 幾個不可以踩的地方

- **解析吃 `TermChar[]`，不吃 `rowToText` 的產物**：`rowToText` 把 DBCS 的 lead+trail
  兩格折成一個字元 ⇒ 文字 index ≠ 格子 col，而 footer 一列有十幾個全形字、偏移是
  **累加**的。且 `]` = `0x5D` **落在 Big5 trail byte 範圍內**，對裸位元組跑 regex 會
  誤命中。走專案既有慣例：逐格走 `chars`、`isLeadByte` 就跳兩格。
  `realignListColumns` 同樣不可用（見上方「區域決策表」的依據）。
- **「掃哪幾列」由 `term_view` 交進 `enhance.functionKeyRows`，不由標註層推導**：
  好讀累積長頁的 `lines` 是 `buf.pageLines`（數千列），`lines.length - 1` 是內文最後
  一行而不是狀態列。`term_view._renderScreenLines` 只在 `!ov.stableRows` 時算它 ⇒
  累積長頁的兩條分支永不拿到這個欄位，增量快取零風險。
- **`annotationsKey` 一定要含 `functionKeyRows` 與 `onFunctionKey`**：列表好讀視窗走
  `rowIdentityStable`，`render/screen.js` 的節點重用條件是
  `rowIdentityStable || !changedRows.has(row)` ⇒ **`changedRows` 根本不參與判斷**。
  漏了它，切 pref 後 row 1／row 23 的節點會被無條件沿用（按鈕該出現不出現、該消失
  不消失），直到視窗捲動換掉那些列物件為止。回歸鎖：`screen_dirty_rows.test.js`
  的兩條 `REGRESSION`。
- **`onFunctionKey` 的引用必須穩定**（`pttchrome.jsx` 啟動時指派一次，與 `onAidClick`
  並排）：它同時是 `annotationsKey.refs` 的成員與 `render/screen.js` outerHTML 節點
  重用的前提。每幀新建箭頭函式會讓整份標註快取每幀失效，長文直接回到 O(n²)。
  同理 `onClick` 閉包**只能捕捉靜態資料**（`keyBytes` / `label`）—— 捕捉逐幀狀態的話
  重建出來的節點會因 outerHTML 相同而被丟棄、留下**舊閉包**（「按鈕點了送到上一幀
  的東西」，完全看不出來）。
- **`a.fnKey` 不得插入任何文字節點**（`title` 屬性不算）：`term_view.countCol` 遞迴
  累加 `u2b(textContent).length` 來反查選取的 col，多一個字就整列錯位。
- **`href="#"` 一定要 `preventDefault`**：本 app 用 URL hash 做 deep link
  （`docs/deep-link.md`），漏掉會塞垃圾 hash 甚至觸發跳文解析。
- **CSS 只能改 `background` / `text-decoration` / `outline`**：`font-weight` 或
  `padding` 一變就位移等寬格線，破壞 `.wpadding` 的寬度契約；且**不得宣告任何
  `user-select`**（`tests/unit/css_user_select.test.js`）。
- **`mergeCommentRun` 合併推文分支刻意不傳 `fnKeys`**：那條路的 chars 是
  `comment_merge.buildMergedCommentChars` 重組的新序列，原列 col 範圍全部失效
  （它對 `mentions`/`aids` 也改用 `m.*`）。功能鍵列永遠不是推文列。

### 送鍵漏斗 `App.onFunctionKey`

順序固定（漏一步都會壞）：

1. `modalShown` → return（元素層 listener 早跑，`mouse_click` 攔不到，見上方優先權表）
2. `aidNavigation.active` → 提示後 return
3. `listSession.onFunctionKey(bytes)` 回 true → 它接手了（v5 封閉互動，見下）
4. `functionKeyClickPlan` → 文章好讀時**先** `_enterFunctionMode()` 再送 byte
5. `commandQueue.inFlightKind` → 提示後 return
6. `view._send(bytes)`

第 4 步是關鍵：PTT 會開 prompt（`(y)回應` / `(X)推文` / `(h)說明`），但好讀的累積
長頁原封不動 ⇒ **使用者看不到輸入框**。`docs/easy-reading.md` 的「貼上驅動」與
「IME 驅動」補過同一個洞兩次，滑鼠點功能鍵是第三個入口。

`←`（`\x1b[D`）例外：走 `stopEasyReading()`，與鍵盤 ArrowLeft 同一條路
（`easy_reading._onKeyDownProcessUI` 的 `case 'ArrowLeft'`），否則離開文章時會先閃
一下原生 24 列。

**刻意不用 `easy_reading._send`**：它 `_wireBusy()` 時直接**丟棄**（那是給狀態機自己
送的鍵設計的，丟了只是少翻一頁）。使用者按下去的按鈕被靜默吞掉是 bug，所以漏斗
自己判那兩個條件並**給提示**。

送鍵一律 `view._send`（內含 `if (this.conn)`）：**不用 `_convSend`**（會做 u2b 轉碼，
對控制序列無意義）、**不用 `setBBSCmd`**（那是翻頁語意的分派器）、**絕不用
`this.view.conn.send`**（`view.conn` 只在 `App.onConnect` 被設）。

### 列表好讀的 `ListSession.onFunctionKey(bytes)`

回 `true` ＝我接手了。合約與 `onPaste` 同形：

| 狀態 | 行為 |
|---|---|
| `_renderMode === 'native'` | 回 `false`，交給一般路徑 |
| `opening` | 提示「開啟文章中，請稍候…」後回 `true` |
| `functionMode` + `frozen` | 提示「指令處理中，請稍候…」後回 `true` |
| 白名單（`←` leave／方向鍵 nav／`→`・Enter open） | 走 reducer 既有的 `_beginLeave` / `_moveSelection` / `_beginOpen` |
| 其餘 | `_beginPassthroughBytes(bytes)`：切原生 ＋ 經 CommandQueue 送出（**永不靜默**） |

`_classifyBytes` **刻意獨立於 `_classifyKey`，不要合併**：後者認 `q`/`e`/`j`/`k` 這些
**字元**為導覽鍵（那是使用者按下的按鍵），而 byte 層看到的 `'q'` 就只是 `'q'`。
合併會把「按鍵」與「送位元組」兩種語意攪在一起。

### 文章好讀的 footer overlay

`#easyReadingLastRow` 是**唯一不經 `computeAnnotations`** 的渲染路徑
（`term_view._mirrorStatusRowToFooter` → `term_ui.renderOverlayRow` 的第 4 參數），
所以它自己呼叫 `parseFunctionKeys`。它沒有 `pointer-events:none` ⇒ 點得到；每次都整個
`replaceChildren` 重建，listener 隨舊節點丟掉，無洩漏。

## 左側退出提示帶（`#exitHintBand`）

- 是 `term_view` 自有的獨立 div，掛在 `#BBSWindow` 底下、`.main` **之後**。不放
  `Screen`／`#mainContainer`：`.main` 是好讀長頁的捲動容器，放裡面會跟著內容捲走；
  三種 render 分支要行為一致；原生模式 Screen 每幀 re-render，hover 布林不該進
  renderer 的狀態。先例見 `term_ui.js` 的 `#easyReadingLastRow`。
- **座標契約：只能與 `App.clientToPos` 同源**。`clientToPos` 的欄位數學已抽到
  `mouse_geometry.colFromClientX`，帶子用同一份的 `exitBandRect`。專案裡另有
  `term_view.convertMN2XYEx` 一套原點公式（多了 `+10` 與 `bbsViewMargin`），用錯就
  差十幾個像素 ⇒ 帶子亮著卻點不到。往返守護在 `tests/unit/mouse_geometry.test.js`
  與 `mouse.offline.spec.js` 的「提示帶右緣＝可點區右緣」。
- **測試裡量座標一律走 `tests/e2e/helpers/layout.js`**（`waitPreviewsSettled` /
  `waitRectStable` / `assertElementUnder` / `stableCommentRow` / `plainLeftEdge`）。
  好讀長頁的行內預覽是延遲載入的佔位盒，`scrollIntoView` 本身就會觸發載入 ⇒ 捲完立刻量
  的 rect 之後還會位移，點下去落在別的元素上，斷言退化成沉默的 0。本機 fixture 圖秒回
  所以測不出來，要靠 `yarn test:e2e:offline:adverse` 逼出來。靜態守護
  `tests/unit/e2e_layout_settle.test.js`；細節見 `docs/offline-replay-testing.md`。
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
- **列表好讀的 hover 也會亮它**（`term_view.onListMouseMove` 的退出帶分支，2026-08
  加回「列表左緣離開」時補上）。那條路**不走** `term_buf.onMouse_move`，兩邊各有一份
  判斷，改其中一邊要看另一邊。

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
| `tests/unit/cursor_row_brighten.test.js` | 樣式層四種組合 + `color.css` 契約（提亮＝q(n+8)、**無 font-weight**、無 background、上班模式有自己一組） |
| `tests/unit/pref_schema_cursor_row.test.js` | 兩個樣式 pref 的預設值 + 既有使用者也拿得到新預設 |
| `tests/unit/cursor_highlight_fastpath.test.js` | 快路徑：多 class 搬家、空 cls 不噴 `InvalidCharacterError` |
| `tests/e2e/offline/cursor_row_brighten.offline.spec.js` | 真 CSS：提亮列的實際顏色＝q(n+8)、背景仍透明；切樣式即時生效 |
| `tests/unit/row_render.test.js` | 部分寬度底色的 DOM（包裝 span 的範圍／`data-pusher-col`） |
| `tests/unit/comment_parse.test.js` | `contentCol`（推文內容起始欄） |
| `tests/unit/cursor_highlight_arbitration.test.js` | `applyCursorHighlight` 的來源判定：鍵盤搶得走、滑鼠拿得回、模式切換不算移動 |
| `tests/unit/list_hover_gating.test.js` | 列表 hover 的三個 gate、底色 vs pointer 條件不同 |
| `tests/unit/list_click_open.test.js` | 列表點擊的標題欄限制 |
| `tests/unit/pref_modal_mouse_tab.test.jsx` | 設定分頁的欄位、預設值、子項 disabled、選項值域 |
| `tests/unit/pref_schema_mouse.test.js` | 新 key 齊備、舊 key 已移除、殘值不復活 |
| `tests/unit/i18n_parity.test.js` | 兩語系 key 集合一致 |
| `tests/unit/footer_keys.test.js` | 功能鍵解析：單鍵可點／多鍵組不可點／具名鍵 byte／**DBCS 欄位換算**／`functionKeyRows` |
| `tests/unit/screen_fnkeys_render.test.js` | `a.fnKey` 的屬性、`onClick`、與部分底色共存、沒給 `fnKeys` 時 DOM 逐字不變 |
| `tests/unit/function_key_click_plan.test.js` | 文章好讀先進 functionMode／`←` 走 stopEasyReading |
| `tests/unit/list_function_key.test.js` | 列表好讀的 `onFunctionKey` / `onMouseExitClick`（白名單走 reducer、其餘 passthrough、忙碌時給提示） |
| `tests/unit/screen_dirty_rows.test.js` | 切 pref 後按鈕真的出現／消失（`annotationsKey` 的回歸鎖，兩條分支各一） |
| `tests/unit/mouse_dblclick_skip.test.js` | 第二次 mousedown 不得 `preventDefault`（雙擊選字） |
| `tests/unit/fixtures/screen_golden/list_native_fnkeys.html`／`article_footer_fnkeys.html` | 整列 DOM 快照（含多鍵組維持純文字） |
| `tests/e2e/offline/mouse.offline.spec.js` | 提示帶／pointer-events／像素對齊／優先權／總開關／推文列可點區（防誤觸三態）／**列表左側退出帶** |
| `tests/e2e/offline/function_keys.offline.spec.js` | 三條 render 分支各自都接上了、點了真的送鍵、切 pref 立即生效 |
| `tests/e2e/offline/selection.offline.spec.js` | 雙擊選詞／三擊選行（**必須跑 offline-firefox**） |
| `tests/e2e/offline/easy-reading-list.offline.spec.js` | 列表好讀的底色左緣＝標題欄、切防誤觸後回到整列 |
| `tests/e2e/offline/wheel_stuck_button.offline.spec.js` | 按鍵旗標卡死的三條路徑 |
