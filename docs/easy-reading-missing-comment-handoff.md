# 交接：好讀模式「第一則推文消失」bug（未修，root cause 已定位）

STATUS: `root cause CONFIRMED (實機 ERDBG)`, `fix NOT applied (回歸風險，待決定解法)`
DATE: 2026-06-06。本 session 已修的相關 bug 見文末「已完成」。

## 症狀
好讀模式（`enableEasyReading`）下，文章**第一則推文消失**（尤其箭頭 `→` 推文），且後續推文樓號因此整體少 1。
- 重現樣本：`Stock M.1780735101`（AID `#1g8znzQ3`，標題「黃仁勳喊話增產成功！SK海力士揭中長期擴」）。
  第一則 `→ BlueBird5566: 才生2個也在增產成功  06/06 16:38` 不見，`→ galleon2000`(16:39) 變成第 1 樓。
- 原生模式（好讀關）正常——這是好讀**跨頁拼接**獨有問題。

## Root cause（CONFIRMED）
`src/js/term_view.js#populateEasyReadingPage`（:764）的跨頁去重，在「內文→第一則推文」邊界 **`beginIndex` 多跳 1 列**，
把第一則推文當成「已顯示過的重疊內容」跳掉。

### 機制
好讀逐頁累積：每翻一頁，PTT 重新顯示上一頁底部數列（重疊），去重要算出要跳過的 buffer 列數 `beginIndex`：
```
beginIndex = numRows = Σ pageWrappedLines[i] for i in [result.rowIndexStart, actualRowIndex]   // :784-788
appendRows(buf.lines.slice(beginIndex, -1))                                                      // :803
```
- `result.rowIndexStart` = PTT 狀態列「目前顯示: 第 N~ 行」的 N（PTT 邏輯行號，wrapped 算 1 行）。
- `actualRowIndex` / `pageWrappedLines` = 好讀自己的邏輯行累積計數。
- 去重正確的前提：好讀的 `actualRowIndex` 必須與 PTT「第 N 行」對齊。

**`actualRowIndex` 多算了 1**，源頭是**首頁的 `i==4` hack**（:820）：
```js
for (var i = 0; i < this.buf.rows-1; ++i) {
  if (i == 4 || i > 0 && this.buf.isTextWrappedRow(i-1)) {  // 強制把 buffer 第 4 列當第 3 列的 wrapped 續行
    this.buf.pageWrappedLines[this.actualRowIndex] += 1;     //   → 不 ++actualRowIndex
  } else { this.buf.pageWrappedLines[++this.actualRowIndex] = 1; }
}
this.appendRows(this.buf.lines.slice(0, -1), ...);           // 但 append 了全部 23 列（含第 4 列）
```
首頁 append 23 個 DOM 列（rows 0–22），但只計 22 個邏輯行（第 4 列被併入第 3 列、不增 `actualRowIndex`）。
此 hack 假設「標頭分隔線(───)+空白 合併成一個 wrapped 邏輯行」（註解見 :770-771，2015 為防『下一頁重複第一列』而加）。
SK 那篇標頭佈局不符該假設 → 邏輯行計數與實際 append 的 DOM 列差 1 → 在後續某頁邊界 `beginIndex` over-skip 1 列。

### 實機證據（ERDBG，已移除的暫時 log）
SK M.1780735101，46% 那頁：
```
rowIndexStart=32  preActualRowIndex=42  numRows=11  beginIndex=11   (pageWrappedLines 全 1)
SKIPPED buffer rows 0..10:
  ... "9:※ 文章網址:...M.1780735101..."  "10:→ BlueBird5566: 才生2個也在增產成功  06/06 16:38"   ← 被跳過
APPEND from row 11: "→ galleon2000 : 增產是利多嗎?  06/06 16:39" ...                              ← 從這才開始
```
去重算「邏輯行 32~42 已顯示」(11 列)，但 BlueBird=邏輯行 42 其實**沒被真正累積過**（只在這頁第一次出現）。
即 `actualRowIndex=42` 比真實多 1（前頁 `i==4` 偏移累積而來）。正確 `beginIndex` 應為 10（從 BlueBird 開始 append）。

## 候選解法（依風險排序）
1. **內容比對校正 `beginIndex`（建議先試，風險中）**：算完 `beginIndex` 後、`appendRows` 前，用「已累積的最後一列」
   驗證去重邊界。最後累積列文字 = `rowToText(buf.pageLines[buf.pageLines.length-1])`（此時 pageLines 尚未 concat 本頁）。
   若 `rowToText(buf.lines[beginIndex-1]) !== lastAcc` 且 `rowToText(buf.lines[beginIndex-2]) === lastAcc` → `beginIndex--`。
   只在算錯時校正。**坑**：空白列／重複內容會誤判，需 guard（跳過空白列、要求非空才比對）。`rowToText` 已 import。
2. **改寫成純內容比對的跨頁去重（最穩，工程較大）**：不靠 `rowIndexStart`/`pageWrappedLines` 算術，直接比對新頁頂端
   數列 vs 已累積 `pageLines` 尾端，找實際重疊量。需處理空白列/重複列；改動面大、要回歸測現有正常文章。
3. **修/移除 `i==4` hack 使其與 PTT 行號對齊（風險高）**：該 hack 是為防「下一頁重複第一列」，移除可能讓**其他**文章
   改成「重複顯示」。除非能正確建模 PTT 對標頭(作者/標題/時間/───)的行號計數，否則別動。

→ 任何改動都會影響**所有**文章的好讀去重，務必廣泛回歸：用下方重現法跑 5 篇樣本 + 數篇最新文章，確認
   **既不掉列也不重複**，且樓號連續。

## 重現／除錯法
1. e2e 連真 PTT（已設 env `PTT_USER/PTT_PASS`，）。`yarn test:e2e`（webServer 自動起 dev server）。
2. 導航到特定文章：進板後 `/` 標題搜尋關鍵字 → Enter 跳到該篇 → Enter 開啟（AID 跳轉亦可）。樣本：
   | 板 | AID | 標題關鍵字 | bug |
   |---|---|---|---|
   | Stock | #1g8znzQ3 (M.1780735101) | 黃仁勳喊話增產成功 | 推文不見（本案） |
   | C_Chat | #1g8zMyd2 (M.1780733372) | 瀨戶環奈 | ※編輯（已修） |
   | Stock | #1g8zQM7M (M.1780733590) | 台股這波暴漲 | 內文混雜（已修） |
   | C_Chat | #1g8zDLQ1 (M.1780732757) | 伊馮 | 空白處（已修） |
3. 暫時 instrumentation（用過已移除，需要時重加）：`populateEasyReadingPage` 內 `if (window.__ERDBG) {...}` 印
   `rowIndexStart / actualRowIndex / beginIndex / atLastPage / buf.getRowText 各列 / SKIPPED / APPEND first`。
   debug spec：`addInitScript` 設 `window.__ERDBG=true` + `enableEasyReading/showFloorNumbers`，開文章後多按 `Space` 累積，
   dump `#mainContainer > span[type="bbsrow"]` 的 `floor 徽章 / textContent / innerHTML`，並 `attachConsole` 收 ERDBG。
   （本 session 的 `tests/e2e/debug-floor.spec.js` 已刪，git 歷史可參考；或照上述重建。）

## 關鍵檔案／行
- `src/js/term_view.js`：`populateEasyReadingPage`（:764）；去重算術（:780-790）；`i==4` hack（:820）；`appendRows`（:843）。
- `src/js/string_util.js#parseStatusRow`：解析「第 N~M 行 / X%」→ `rowIndexStart` 等。
- `src/js/term_buf.js#isTextWrappedRow`：判定 buffer 某列是否為上一列的折行續行（去重所依賴）。

## 本 session 已完成（已修並驗證，勿重複）
- **floor bleed（樓層主因）**：`appendRows` `var floor;`→`var floor = undefined;`。修好空白處/※編輯/內文被標樓層。
- **偵測時間戳**：`COMMENT_RE` 結尾要求 `COMMENT_TIME_RE`（`string_util.js`），修內文推文格式被當真推文（M.1780738427）。
- **parsePushInitText 收緊**：安全強化（非本 bug 修法，見上）。
- 測試：`tests/unit/comment_parse.test.js` + `tests/unit/fixtures/*.txt`（5 篇）；`tests/e2e/enhance.spec.js` 徽章列時間戳斷言。
- 文件：`docs/enhanced-addon.md` 踩坑 #9/#10/#11。
