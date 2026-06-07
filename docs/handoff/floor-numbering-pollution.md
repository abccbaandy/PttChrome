# 交接：樓層編號 — 簽名檔/內文「假推文」污染（未修，待真實 ANSI 資料）

STATUS: `unresolved`。需先抓真實 ANSI 才能定可靠判斷信號。
DATE: 2026-06-07。

## 症狀
好讀/原生開 `showFloorNumbers` 時，文章**內文或簽名檔裡偽裝成推文格式的列**（`推/噓/→ id: … MM/DD HH:MM`，
含**假時間戳**）被 `comment_parse.js#COMMENT_RE` 當真推文計入樓層 → 真實推文樓號**接續**這些假推文，不是從 1 起算。

重現樣本：`C_Chat #1g8zcjhj`（標題「辨識能力測試」）。版面：
```
推1..推6   ← 內文/簽名檔的假推文（在 `--` / ※發信站 之上）
--
※ 發信站: ...
※ 文章網址: ...
→7 joy82926 ...   ← 真實推文（應為第 1 樓）
→8 error405 ... / ※ 編輯: ... / →9 / 推10 / 推11
```
期望：真實推文 joy82926 = 第 1 樓。使用者認可的目標行為 = **假推文也可計數，但真實推文從 1 起算**（同 BePTT）。

## 已排除的修法（都不可靠）
- **純文字 + 時間戳**：假推文也帶假時間戳 → 分不出。`COMMENT_RE` 已要求結尾 `COMMENT_TIME_RE`，仍中招。
- **ANSI 顏色**：該文假推文連顏色都被作者用 ANSI 複製（截圖確認），與真推文視覺一致 → 顏色也分不出。
  （`TermChar` 有逐字 `fg/bg/bright`，`annotateComment` 呼叫端 Screen.js/term_view.js 都拿得到 `line` TermChar[]，
  若未來信號需顏色，可從這裡取，不必只靠 `rowToText`。）
- **`※ 發信站`/`※ 文章網址` meta 邊界 reset**：使用者明確否決——`Test #1g9GI-Zh` 無這幾行但 BePTT 照常正常；
  且 BePTT 不靠任何狀態列/此類標記。對「無 meta 行的文章」無法重置（惟那類文章通常也無假推文，實務影響小）。

## 下一步（建議）
1. **抓真實 ANSI 對照**：read-only e2e 連真 PTT，開 `#1g8zcjhj`（辨識能力測試）與一篇正常文章，dump 每列**逐字
   fg/bg/bright + 欄位位置 + 文字**（不要只 dump 文字）。比對假推文列 vs 真推文列，找出穩定差異（候選：IP 欄位
   是否存在/對齊、整列顏色 pattern、推文區是否為文章尾端連續區塊…）。e2e helper 見 `tests/e2e/helpers/ptt.js`，
   讀畫面用 `buf.getRowText`／DOM；逐字屬性需 `window.__app.buf.lines[r][c]` 取 `.fg/.bg/.bright/.ch/.isLeadByte`。
2. 找到信號後，邏輯放 `comment_parse.js`（兩渲染路徑共用），加 `tests/unit/comment_parse.test.js` 回歸 + fixture。
   現有 fixture 格式：`label\ttext`，`C`=推文 / `N`=非推文（`tests/unit/fixtures/*.txt`）；可能需擴充 label 表達「假推文」。

## BePTT 參考（已反編譯 `3rd_script/BePTT` 7.0.9，package `tw.ystudio.beptt`）
- 連**同一個** `wss://ws.ptt.cc/bbs`（+ PTT 機房 IP fallback）telnet gateway，逐頁讀帶 ANSI 色的 Big5 終端機畫面。
- **不解析 PTT 狀態列**（無「目前顯示/瀏覽 第 N 頁」字串）。okhttp+Jsoup（`www.ptt.cc/bbs`、`/api/boardlist`）僅輔助。
- 使用者實測：BePTT 對假推文也計數但真實推文從 1 起算（值得參考的目標行為）；其確切判斷演算法**無法**從混淆 dex
  逐行確證（單字母類名，3×8MB dex）。
- 反編譯重做法：`uv` 建 venv → `pip install androguard`（4.1.4）；`from loguru import logger; logger.remove()` 關 debug；
  `from androguard.misc import AnalyzeDex`；`dx.find_strings(regex)` + `s.get_xref_from()`。**注意**：dex 內 Big5 中文字串經
  MUTF-8 解碼會損壞、無法完美還原；ASCII 識別字（class/method/CSS 選擇器如 `.push-userid`）正常。
