# pttbbs 畫面更新協定（server 端不變量）

來源：`3rd_script/pttbbs`（官方 github.com/ptt/pttbbs，checkout `c1ff72df` 2026-06-28）＝ term.ptt.cc 行為最佳近似。
用途：client 畫面偵測以**確定性規則**取代 timing heuristic。本檔全部 CONFIRMED（讀碼驗證；標 ✚ 者另經 `tests/e2e/cassettes/cchat-list.json` 實錄交叉驗證）；unknown 另標。行號隨 upstream 演進會漂，函式名為準。

## 1. 輸出層機制

- 虛擬螢幕 buffer + 每列 dirty 追蹤（`mbbsd/screen.c` 頂部 `big_picture`，每列 mode/smod/emod/len/oldlen）。
- `refresh()` → `doupdate()`：**只送 dirty lines**（各列 `rel_move` 到 smod 起點、輸出 smod..emod、oldlen>len 時 `o_cleol`）；結尾**必** `rel_move(→cur_col,cur_ln)` 把終端游標移到確定 park 位置，再 `oflush()`（screen.c `doupdate` 尾段）。
- clear 家族：`clear()`(screen.c:419) 清虛擬螢幕＋設 docls → 下次 refresh 走 `redrawwin()`(:240) 全屏重繪；`clrtoeol()`(:434) 截當列；`clrtobot()`(:505) 清游標以下全部列。
- 滾動 |scrollcnt| ≥ t_lines-3 也退化成全屏重繪（doupdate 開頭）。

## 2. 時序不變量 → client 三推論

| 不變量 | 出處 |
|---|---|
| 等待輸入前必 refresh：`dogetch()` 在 `while(輸入buffer空)` 內先 `refresh()` 再 select | `mbbsd/io.c:416,422` |
| `oflush()` 每次 refresh 結尾必執行；正常情況一次 `write` | screen.c doupdate 尾、`common/sys/vbuf.c` `vbuf_write` |
| **typeahead 跳繪**：client 還有按鍵在途（輸入 buffer 非空）→ refresh **直接 return 不畫** | `mbbsd/screen.c:15,290-298,310` |
| 輸出 buffer 3072 bytes，快滿即中途 flush | `mbbsd/io.c:6(OBUFSIZE),139` |
| `Ctrl-L` 是全域熱鍵：`redrawwin()+refresh()` 強制全屏重繪 | `mbbsd/io.c:530-532`（igetch 內） |

推論（client 端設計依據）：
1. **一鍵一回應**：送一鍵收到的輸出＝恰一次完整畫面更新，結尾游標 park 位置確定。BBS 可當 request/response 協定用。
2. **並行送鍵必亂**：第二鍵先到 → server 跳過中間重繪，client 只看到合併後的最終畫面（中間狀態被吞）。⇒ 機器送鍵**必須序列化**（單一 in-flight，等回應驗證完成再送下一個）；使用者手打的 typeahead 無妨（最終畫面仍正確），但期間任何逐-frame 偵測都不可信。
3. **frame/封包邊界不可靠**：整頁彩繪 > 3072 必拆多個 write；WS proxy（不在 pttbbs repo，unknown）是否保留邊界未知。⇒ 「回應完成」判定靠**內容謂詞**，封包邊界最多當加速訊號。client 端 `src/js/websocket.js` 每 WS message 發一次 `data` 事件，邊界可見但勿依賴。

## 3. 看板文章列表畫面指紋 ✚

進板首繪：`clear()` 全屏（cassette 開頭 `ESC[H ESC[2J`）→ `i_read` FULLUPDATE 重建。24 列（0-indexed）：

| row | 內容 | 出處 |
|---|---|---|
| 0 | `showtitle()` 反白標題：板主/活動看板名/`看板《NAME》` | `mbbsd/menu.c:92`；由 `readtitle()` 呼叫 `mbbsd/bbs.c:577` |
| 1 | 固定提示列 `[←]離開 [→]閱讀 [Ctrl-P]發表文章 [d]刪除 [z]精華區 [i]看板資訊/設定 [h]說明` | `mbbsd/bbs.c:578` |
| 2 | 反白表頭 `   編號    日 期 作 者       文  章  標  題`＋右端 `人氣:N`（vbarf ANSI_REVERSE；cassette 實測 30;47） | `mbbsd/bbs.c:594` |
| 3..rows-2 | entry 列，每頁 `headers_size = p_lines` 筆（24 列＝20 筆） | `mbbsd/read.c`（PARTUPDATE 內 realloc）、游標列算式 `3 + n - top`（read.c:183-185） |
| rows-1 | feeter 反白 ` 文章選讀 `＋`(y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面`（RMAIL 則為 ` 郵件選讀 `） | `mbbsd/read.c:1226,1229` `vs_footer` |

entry 列欄位（`readdoent`，`mbbsd/bbs.c:641-840`）：
- 序號欄 `%7d`（bbs.c:788）；**置底文**序號欄改為黃色 `★`（Big5 `A1B9`，bbs.c:777-782）。
- 游標欄：`STR_CURSOR ">"` / `STR_CURSOR2 "●"`（`include/common.h:233-234`）。全形 `●` 蓋序號最高位（client 已知坑：截斷序號）。
- 之後推文數（著色 2 字）、日期或金額、作者 `%-13.12s`、標題。
- **置底文只出現在板尾頁**：`get_records_and_bottom`（`mbbsd/read.c` ~1052）當 `n >= headers_size` **或 `MODE_SELECT|MODE_DIGEST`** 走純 `get_records` 不含置底。⇒ 非板尾頁、`/` 篩選清單、文摘模式**必無**置底列。

## 4. burst 特徵（一次按鍵回應動了哪些列）

| 操作 | 髒列集合 | 出處 |
|---|---|---|
| 同頁游標上下 | **恰 2 列**：舊列＋新列，各只動 col0 起始的游標欄（`cursor_clear`/`cursor_show`） | `mbbsd/read.c:183-185`、`mbbsd/stuff.c:217,235` |
| 翻頁（跨頁移動/PgUp/PgDn） | `move(3,0)+clrtobot()` → row3..rows-1 全重畫（含 feeter；fall-through PART_REDRAW→READ_REDRAW）；**row0-2 不動** | `mbbsd/read.c:1172-1231` |
| 標題列變更（進板/回板/`s` 跳板） | TITLE_REDRAW 或 FULLUPDATE：row0-2 一併重畫 | 同上（FULLUPDATE `(*dotitle)()` fall-through） |
| 開文（進 pmore） | 先 `clear()` → 全屏重繪，底列變 pmore 狀態列 | `mbbsd/pmore.c:2320,2363` |
| 文章內翻頁 | pmore 自管；底列狀態列 `  瀏覽 第 %d/%d 頁 (%d%%)`（單頁版 :2137）＋`目前顯示: 第 %02d~%02d 行` | `mbbsd/pmore.c:2130,2137,2166` |
| 文章返回列表 | i_read 收 FULLUPDATE → row0-2＋row3..rows-1 全重建 | `mbbsd/read.c:1172-` |
| prompt（`/` 搜尋、數字跳號…） | 畫在底列附近，游標 park 在輸入點；結束後 dirty 更新還原 | `mbbsd/read.c`（各 key handler）＋vget 系 |
| **數字跳號完成後** ✚ | prompt 行被清掉、**底列留空**（feeter「文章選讀」要到**下一個**回應才重畫）；游標 park 在目標 entry 列 col≤1 | `tests/e2e/cassettes/cchat-list-nav.json` jump step 實錄（settle 畫面末列全空）。client 端 open-jump 完成判定因此**不能**等 clean-list，改用 park＋目標序號（`list_session.js#_beginOpen`） |

## 5. 游標 park 位置（page fingerprint）

每次回應結尾（doupdate 末 `rel_move`）游標必停在：
- **文章列表**：游標列（entry 區內）col≈1（`cursor_show` 印完游標符後 move 回 column+1，stuff.c:217-233）。
- **pmore 文章**：底部狀態列。
- **prompt**：底列輸入點。
⇒ `park 在 entry 區` vs `park 在底列` 是「乾淨列表 vs 文章/prompt」的廉價判別式。client 端 settle 時的 `term_buf.cur_x/cur_y` 即 park 位置（settle 已定義為內容＋游標皆靜，`src/js/term_buf.js` `_armSettleTimer` 前註解）。

## 6. 版本與未知

- 以 HEAD 讀碼；term.ptt.cc 實跑版本未知但此區域程式碼古老穩定。`#ifdef`（COLORIZED_SAFEDEL、COLORDATE 等）影響著色不影響行列結構。
- unknown：ws.ptt.cc 的 WS proxy 是否保留 server write 邊界（proxy 不在本 repo）。
- 大字型 term（rows≠24）：`p_lines`/`b_lines` 相對式全部成立，但 client 端規則需寫成 rows-relative；未實測。
