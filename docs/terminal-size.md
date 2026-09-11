# 終端機大小（`termSizeMode`）與版面置中

設定頁「外觀 → BBS 終端機大小」的兩個模式、它們送給 PTT 的東西、以及畫面為什麼是
現在這個位置。動 `term_size.js` / `term_view.setTermFontSize` / `calcTermSizeFromFont`
或任何「畫面靠左/置中」的念頭之前先讀這份。

## 1. pref schema

| key | 預設 | 生效模式 | 說明 |
|---|---|---|---|
| `termSizeMode` | `"fixed-term-size"` | — | `fixed-term-size` \| `fixed-font-size` |
| `termSize` | `{cols:80, rows:24}` | fixed-term-size | 使用者指定的欄/列數，原樣送 NAWS（UI 無 clamp） |
| `fontFitWindowWidth` | `false` | fixed-term-size | 把字體拉大來補滿畫面（CSS transform scale） |
| `fontSize` | `20`（px） | fixed-font-size | 字級；列數由它與視窗高度反推 |
| `bbsMargin` | `0` | 兩者 | → `view.bbsViewMargin`，疊在垂直位移上 |

分派點只有一個：`App.onValuesPrefChange`（`pttchrome.jsx`）。**不走逐 key 的
`onPrefChange`** ⇒ 測試要改這組 pref 得呼叫 `onValuesPrefChange(整份值)`，
`ptt.applyPrefs` 對它無效。

## 2. 兩個模式＝誰是自變數

| | 自變數 | 因變數 | 視窗 resize |
|---|---|---|---|
| `fixed-term-size` | cols/rows | 字級（`fontResize` 試到塞不下為止，字高恆偶數 px） | 即時重算字級 |
| `fixed-font-size` | 字級 | rows（`calcTermSize`；**cols 恆 80**） | 500ms debounce 後重新 NAWS |

`fixed-font-size` 的觀感差異就是「一頁更多列」：`rows = floor(視窗高 / 字級)`，
預設字級 20 ⇒ 可視高 > 480px 就 > 24 列。

## 3. PTT 端事實（CONFIRMED，讀 pttbbs，勿再猜）

- client 兩個模式都會送 telnet NAWS：`App.setTermSize` → `conn.sendNaws(cols, rows)`
  （`telnet.js#sendNaws`，RFC 1073）。協商入口是 server 先 `DO NAWS`，client 回
  `WILL NAWS` + 一筆 SB（`pttchrome.jsx` 的 `doNaws` handler）。
- server **真的支援 resize**：`mbbsd/term.c:48-75` `term_resize()`
  `h_crop = MAX(24, MIN(100, h))`、`w_crop = MAX(80, MIN(200, w))` ⇒ **80–200 欄、
  24–100 列**，超出範圍直接被夾。之後 `b_lines = t_lines-1`、`p_lines = t_lines-4`
  —— 本專案的 `_bodyRows() = rows - 4` 就是對著 `p_lines` 寫的。
- `term_resize` 只做 `redrawwin() + refresh()`：**重送既有 screen buffer**，不會叫
  應用層用新的 `b_lines` 重畫。所以在使用中改大列數，**當下那一頁不會變多**，要等
  下一次畫面重畫（翻頁／重進看板）才看得到效果。這不是 client 的 bug。
- 加寬欄數對閱讀**沒有收益**：文章內文本來就只有 ~78 欄，加寬只是右側留白；會變的
  只有列表標題欄（`bbs.c:745` 的 `t_columns-34`、`board.c:1526` 的 `t_columns-68`）。

## 4. LOCKED：欄數恆 80

`term_size.js#TERM_COLS`。`fixed-font-size` 曾經依視窗寬反推
（`max(80, min(200, floor(2*(width-10)/fontSize)))`）—— 1280px 視窗、字級 20 會算出
**127 欄**。兩個後果：

1. 終端機幾乎與視窗同寬，而 PTT 只畫 ~80 欄 ⇒ 右側幾十欄恆為空白，畫面看起來**靠左**
   （這就是「佈局都從左上開始排」的真正來源，不是置中沒做）；
2. 本專案的欄位解析（`comment_parse` 的列表欄位常數、黑名單比對、`mouse_regions`
   的區域表）全是照 80 欄寫的，寬版列表沒有任何驗證。

守護：`tests/unit/term_size.test.js`、`tests/e2e/offline/term_size.offline.spec.js`。

## 5. LOCKED：水平置中是 `align="center"` 做的，不要疊第二套

`pttchrome.jsx` 建構子：

```js
this.BBSWin.setAttribute("align", "center");
```

這個 deprecated 的 HTML 屬性在 Chrome 會算成 `text-align: -webkit-center`（Firefox
`-moz-center`），而那個值**會連 block 子元素一起置中** —— 一般的 `text-align: center`
做不到，所以它不能被「現代化」成 `text-align: center` 就算了。垂直置中則是
`setTermFontSize` 寫的 `marginTop`（`term_size.js#termLayoutOffsets`）。

兩個實測後果，都寫在 code 的 LOCKED 註記裡：

- **在 `.main` 上再寫一次 marginLeft ＝ 雙重置中**：1280px 視窗、終端機寬 1210px 時，
  box 會落在 52.5px 而不是 35px（自己寫的 35 先吃掉，剩下的 35 再被 `-webkit-center`
  平分）。2026-09-11 實作置中時踩過這個坑，才發現置中早就有了。
- **縮放模式依賴這個置中**：`mouse_geometry.gridOriginX` 的縮放分支用
  `(innerWidth - chw*cols*scaleX)/2` 推格線原點，成立前提就是「layout box 置中 ＋
  `transform-origin: center`」。改成貼左，退出提示帶（`#exitHintBand`）會整條跑掉。

配套的另一半是 `setTermFontSize` 裡的 `mainDisplay.style.textAlign = 'left'`：
`-webkit-center` 會繼承到子孫，那行是用來擋住它的，**兩者是一組**。

## 6. 列數不再限 24

兩個列表功能的 engage 條件從 `rows === 24` 放寬為 `rows >= 24`
（`list_session._engageEligible`、`board_list_session._engageEligible`）。原本那道門檻
是 v1 的保守 bypass，但整條管線的幾何早就是 `buf.rows` 推導的，沒有對 24 的實質依賴。

後果（2026-09-11 修掉）：選「固定字體大小」時列數必定 > 24 ⇒ **文章列表好讀**與
**看板列表平滑捲動**一起靜默失效，右鍵選單的**「設定前已讀後未讀」**也跟著消失
（它要 `listSession.markReadTargetAtRow`，session 沒 active 就回 null）。整個過程沒有
任何提示，使用者只會看到「勾了設定沒反應」。

回歸守護：`tests/unit/list_session.test.js`、`tests/unit/board_list_session.test.js`、
`tests/unit/list_mark_read.test.js` 各一條 `rows: 40` 的 case。
