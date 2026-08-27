# pttbbs 畫面更新協定（server 端不變量）

來源：`3rd_script/pttbbs`（官方 github.com/ptt/pttbbs，checkout `efc21a30` 2026-08-03；
§1–§12 原以 `c1ff72df` 讀碼，2026-08 於 `efc21a30` 覆核 `pmore.c`/`more.c`/`pfterm.c` 差異純屬重構，結論不變）＝ term.ptt.cc 行為最佳近似。
用途：client 畫面偵測以**確定性規則**取代 timing heuristic。本檔全部 CONFIRMED（讀碼驗證；標 ✚ 者另經 `tests/e2e/cassettes/cchat-list.json` 實錄交叉驗證）；unknown 另標。行號隨 upstream 演進會漂，函式名為準。

**研究方法規範（強制）**：PTT 行為邏輯**一律先讀 `3rd_script/pttbbs` 原始碼**找出真實實作，**禁止**自行猜測或從錄製素材/畫面觀察反推規則——素材只用來**驗證**對 code 的理解是否有誤。反例教訓：last-read 高亮曾從實錄反推成「作者亮白＋標題紅的單列游標」模型，連修三版仍殘紅；讀 `readdoent` 十分鐘即知是 title-match 多列高亮＋作者亮白其實是 isonline（見 §10）。

**⚠ 原始碼是 Big5，用 UTF-8 grep 中文會「查無」而不是報錯**（2026-08-25 踩坑）。
`grep -rn "登入太頻繁" 3rd_script/pttbbs` 回空集合，很容易讓人下結論「這句不在開源碼裡」——
實際上它就在 `mbbsd/talk.c`。同一輪誤判也差點讓「PTT 有沒有登入頻率限制」得到相反的答案。
**中文字串一律先轉 Big5 再搜**：

```bash
grep -rlF "$(printf '登入太頻繁' | iconv -f UTF-8 -t BIG5)" --include=*.c 3rd_script/pttbbs
```

讀出來的片段要看得懂則反向轉：`sed -n '200,240p' mbbsd/talk.c | iconv -f BIG5 -t UTF-8`。
（ASCII 的識別字、函式名、`ANSI_COLOR` 這類巨集不受影響，一般 grep 即可。）

## 0. 版本對齊（先做，否則比對的是別的版本）

線上「系統資訊」畫面的欄位語意（`mbbsd/cal.c#p_sysinfo` ＋ `util/newvers.sh`）：

| 顯示欄位 | 變數 | 產生方式 |
|---|---|---|
| `https://github.com/ptt/pttbbs.git` | `build_remote` | `git config --get remote.origin.url` |
| 第 1 個 hash（如 `c1ff72df`） | `build_origin` | `git rev-parse --short origin/master`＝**build 機上的 upstream master** |
| 第 2 個 hash（如 `50372909`） | `build_hash` | `git rev-parse --short HEAD`＝PTT **私有** commit（不在公開 repo） |
| 尾綴 `M` | 同上 | `git diff --quiet` 失敗＝working tree 有未提交改動 |
| `編譯時間` | `build_time` | `date` |

⇒ **可公開對照的基準是第 1 個 hash（`build_origin`）**，不是第 2 個。比對前先
`cd 3rd_script/pttbbs && git checkout <build_origin>`；`3rd_script/` 在 `.gitignore`、非 submodule，checkout 不影響主 repo。

**wire 上的 ANSI ≠ source 的字面 escape**：PTT 編 `pfterm`（`mbbsd/Makefile` 的 `USE_PFTERM` 分支，
非 `screen.c`）。pfterm 把畫面存成 attribute 陣列，輸出時由 `mbbsd/pfterm.c#fterm_chattr`
**重新產生**最短序列，格式固定為 `ESC [ [0;] [1;] [5;] [3<fg>;] [4<bg>] m`：`0` 只在
「bold/blink 由開轉關」或「fg/bg 回到預設」時出現，且 `FTCONF_WORKAROUND_BOLD` 會在
fg＝預設(7) 時強制補印 `37`。⇒ 比對 client 的 ANSI regex 時必須先過這層，不能直接拿
source 裡的 `ANSI_COLOR(...)` 字面。實例見 §9 水球。

## 1. 輸出層機制

**PTT 編的是 `pfterm.c`，不是 `screen.c`**（`mbbsd/Makefile`：`.if $(USE_PFTERM) OBJS+=pfterm.o .else OBJS+=screen.o`）。
兩者介面相同（`refresh`/`doupdate`/`clear`/`clrtoeol`/`redrawwin`…），本節依賴的不變量**在兩者皆成立**，
差別只在 dirty 粒度與 ANSI 產生方式：

| | `screen.c`（舊） | `pfterm.c`（PTT 實跑） |
|---|---|---|
| 虛擬螢幕 | `big_picture`，每列 mode/smod/emod/len/oldlen | `FTCMAP`(字元)/`FTAMAP`(attr) 雙緩衝 + `FTD[]` dirty map |
| dirty 粒度 | **每列**一段連續區間 smod..emod | **每 cell**（可跳著送；實錄 `ESC[24;39H` 直接跳欄補印即此） |
| ANSI attribute | ESC 原樣寫進 buffer、原樣送出 | 存成 attr、輸出時由 `fterm_chattr` **重新產生**（見 §0） |
| 清到行尾 | `oldlen>len` → `o_cleol` | `derase` → `fterm_rawclreol()` |
| 結尾游標 | `rel_move(→cur_col,cur_ln)` + `oflush()` | `fterm_rawcursor()` → `fterm_rawmove_opt(ft.y,ft.x)` + `fterm_rawflush()` |

- `refresh()` → `doupdate()`：**只送 dirty 的部分**；結尾**必**把終端游標移到確定 park 位置再 flush（兩者皆是）。
- clear 家族：`clear()` 清虛擬螢幕 → 下次 refresh 全屏重繪；`clrtoeol()` 截當列；`clrtobot()` 清游標以下全部列。
  `redrawwin()` 在 pfterm ＝ flippage + clrscr + `fterm_rawclear()` + markdirty。
- 滾動 |scrollcnt| ≥ t_lines-3 也退化成全屏重繪（screen.c doupdate 開頭；pfterm 有對應的 scroll 最佳化）。

## 2. 時序不變量 → client 三推論

| 不變量 | 出處 |
|---|---|
| 等待輸入前必 refresh：`dogetch()` 在 `while(輸入buffer空)` 內先 `refresh()` 再 select | `mbbsd/io.c#dogetch` |
| flush 每次 refresh 結尾必執行；正常情況一次 `write` | pfterm `doupdate` 尾 `fterm_rawflush`／screen.c `oflush`、`common/sys/vbuf.c` |
| **typeahead 跳繪**：client 還有按鍵在途（輸入 buffer 非空）→ refresh **直接 return 不畫** | `mbbsd/pfterm.c#refresh`：`if (ft.typeahead && fterm_typeahead()) return;`（screen.c 同義） |
| 輸出 buffer 3072 bytes，快滿即中途 flush | `mbbsd/io.c`（OBUFSIZE） |
| `Ctrl-L` 是全域熱鍵：`redrawwin()+refresh()` 強制全屏重繪 | `mbbsd/io.c#igetch` switch |

推論（client 端設計依據）：
1. **一鍵一回應**：送一鍵收到的輸出＝恰一次完整畫面更新，結尾游標 park 位置確定。BBS 可當 request/response 協定用。
2. **並行送鍵必亂**：第二鍵先到 → server 跳過中間重繪，client 只看到合併後的最終畫面（中間狀態被吞）。⇒ 機器送鍵**必須序列化**（單一 in-flight，等回應驗證完成再送下一個）；使用者手打的 typeahead 無妨（最終畫面仍正確），但期間任何逐-frame 偵測都不可信。
3. **frame/封包邊界不可靠**：整頁彩繪 > 3072 必拆多個 write；WS proxy（不在 pttbbs repo，unknown）是否保留邊界未知。⇒ 「回應完成」判定靠**內容謂詞**，封包邊界最多當加速訊號。client 端 `src/js/websocket.js` 每 WS message 發一次 `data` 事件，邊界可見但勿依賴。

## 3. 看板文章列表畫面指紋 ✚

進板首繪：`clear()` 全屏（cassette 開頭 `ESC[H ESC[2J`）→ `i_read` FULLUPDATE 重建。24 列（0-indexed）：

| row | 內容 | 出處 |
|---|---|---|
| 0 | `showtitle()` 反白標題：`【title】` 從 col 0 起，右端 `看板/系列/文摘《NAME》`（`title_tail_msgs[]`＝`看板`/`系列`/`文摘`，依 MODE_SELECT/MODE_DIGEST 決定） | `mbbsd/menu.c#showtitle`；由 `readtitle()` 呼叫 `mbbsd/bbs.c` |
| 1 | 固定提示列 `[←]離開 [→]閱讀 [Ctrl-P]發表文章 [d]刪除 [z]精華區 [i]看板資訊/設定 [h]說明` | `mbbsd/bbs.c` |
| 2 | 反白表頭 `   編號    <日 期|價 格> 作  者       文  章  標  題`＋右端 `人氣:N`（vbarf ANSI_REVERSE；cassette 實測 30;47）。日期欄字樣依 LISTMODE 變動 ⇒ **只認「編號」最穩** | `mbbsd/bbs.c` vbarf |
| 3..rows-2 | entry 列，每頁 `headers_size = p_lines` 筆（24 列＝20 筆） | `mbbsd/read.c`（PARTUPDATE 內 realloc）、游標列算式 `3 + n - top`（`cursor_pos`） |
| rows-1 | feeter 反白 ` 文章選讀 `＋` (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面`；**RMAIL 是 ` 鴻雁往返 `＋` (R/y)回信 (x)站內轉寄 (d/D)刪信 (^P)寄發新信 \t(←/q)離開`**（不是「郵件選讀」） | `mbbsd/read.c` READ_REDRAW 的 `vs_footer` |

entry 列欄位（`readdoent`，`mbbsd/bbs.c`）——逐欄依 printf 序列推出的 0-indexed 螢幕欄位：

| cols | 來源 | 內容 |
|---|---|---|
| 0-6 | `prints("%7d", num)` | 序號；**置底文**改印 `"  " ANSI "  ★ "`＝同寬 7 cells（★ 在 cols 4-5） |
| 7 | 字面 `" "` | |
| 8 | `"%c"` type | ` `/`+`/`~`/`*`/`#`/`m`/`M`/`=`/`!`/`s`/`S`/`D` |
| 9-10 | `ESC "[0;1;3%4.4s"` 的**後 2 字** | 推文數（`爆`/`XX`/數字；前 2 字被吃進 ANSI 序列） |
| 11-16 | `prints("%-6.5s", ent->date)`（`IS_LISTING_MONEY` 則 `" ---- "`／`"%5d "`） | 日期／金額 |
| 17-29 | `prints("%-13.12s", ent->owner)` | 作者（內容 ≤12 字 ⇒ 切片用 [17,29)；col 29 恆為 padding） |
| 30-31 | `outs(mark)` | `□`/`R:`/`轉`/`鎖`/`ˇ`（2 cells） |
| 32 | `outc(' ')` | |
| 33- | title | `w = t_columns - 34` |

- **游標欄（兩代，`include/common.h`）**：

  | | 字串 | 佔用 | 蓋掉 | 欄位位移 |
  |---|---|---|---|---|
  | 新（**現行**） | `STR_CURSOR ">"` | cell 0 | `%7d` 的前導空格（6 位序號完整可見） | 無（半形） |
  | 舊 | `STR_CURSOR2 "●"` | cells 0-1 | 前導空格＋**最高位數字** | 左移 1（`rowToText` 折疊 DBCS） |

  切換點＝`b9a5029f` **cleanup(cursor): Always do CURSOR_ASCII**（2026-08-11）：廢除 `UF_CURSOR_ASCII` 使用者旗標，全站強制 ASCII 游標（`stuff.c#cursor_show` 一律 `outs(STR_CURSOR)`；看板列表 `psb.c#psb_default_cursor` 同步；`cursor_clear` 也從 `STR_UNCUR2`「兩格空白」改成 `STR_UNCUR`「一格」）。
  **client 必須兩代都認**：`tests/e2e/cassettes/*.json` 是舊 server 錄的 raw bytes（offline e2e 是 CI gate）。解析 server 畫面＝雙支援（`comment_parse.js` 的 `LIST_CURSOR_WIDE`/`LIST_CURSOR_ASCII` 區塊）；我們自己畫的假游標＝一律 `>`（`list_window.js#labelListCursor`）。
- 同批 cleanup 對 client **無**影響：`ea31f725`（DBCS 旗標強制開，只動 server 輸入端）、`202f3324`（modmark 旗標移除，`~` 改一律顯示，col 8 type 字元集合不變）、`b6f93ffa`（LIVERIGHT）。
- 刪除文 `iscorpse = (owner[0]=='-' && owner[1]==0)` ⇒ 作者欄是單一 `-`。
- client 對應常數：`comment_parse.js` 的 `LIST_AUTHOR_COL_START=17` / `LIST_AUTHOR_COL_END=29`（owner 內容 end-exclusive）／`LIST_TITLE_COL_START=30`（mark 起點）。**兩者差一格 padding，別混用**。
- **置底文只出現在板尾頁**：`get_records_and_bottom`（`mbbsd/read.c` ~1052）當 `n >= headers_size` **或 `MODE_SELECT|MODE_DIGEST`** 走純 `get_records` 不含置底。⇒ 非板尾頁、`/` 篩選清單、文摘模式**必無**置底列。

## 4. burst 特徵（一次按鍵回應動了哪些列）

| 操作 | 髒列集合 | 出處 |
|---|---|---|
| 同頁游標上下 | **恰 2 列**：舊列＋新列，各只動 col0 起始的游標欄（`cursor_clear` 印 1 格空白／`cursor_show` 印 1 格 `>`；舊版各 2 格） | `mbbsd/read.c:183-185`、`mbbsd/stuff.c:217,235` |
| 翻頁（跨頁移動/PgUp/PgDn） | `move(3,0)+clrtobot()` → row3..rows-1 全重畫（含 feeter；fall-through PART_REDRAW→READ_REDRAW）；**row0-2 不動** | `mbbsd/read.c:1172-1231` |
| 標題列變更（進板/回板/`s` 跳板） | TITLE_REDRAW 或 FULLUPDATE：row0-2 一併重畫 | 同上（FULLUPDATE `(*dotitle)()` fall-through） |
| 開文（進 pmore） | 先 `clear()` → 全屏重繪，底列變 pmore 狀態列 | `mbbsd/pmore.c:2320,2363` |
| 文章內翻頁 | pmore 自管；底列狀態列 `  瀏覽 第 %d/%d 頁 (%d%%)`（單頁版 :2137）＋`目前顯示: 第 %02d~%02d 行` | `mbbsd/pmore.c:2130,2137,2166` |
| 文章返回列表 | i_read 收 FULLUPDATE → row0-2＋row3..rows-1 全重建 | `mbbsd/read.c:1172-` |
| prompt（`/` 搜尋、數字跳號…） | 畫在底列附近，游標 park 在輸入點；結束後 dirty 更新還原 | `mbbsd/read.c`（各 key handler）＋vget 系 |
| **數字跳號完成後** ✚ | prompt 行被清掉、**底列留空**（feeter「文章選讀」要到**下一個**回應才重畫）；游標 park 在目標 entry 列 col≤1 | `tests/e2e/cassettes/cchat-list-nav.json` jump step 實錄（settle 畫面末列全空）。client 端 open-jump 完成判定因此**不能**等 clean-list，改用 park＋目標序號（`list_session.js#_beginOpen`） |

## 5. 游標 park 位置（page fingerprint）

每次回應結尾（doupdate 末 `rel_move`）游標必停在：
- **文章列表**：游標列（entry 區內）**col 0**（`cursor_show` 印完 `>` 後 `move(row, column)`，column 恆 0，stuff.c:214-222）。舊 `●` 版是 `move(row, column+1)`＝col 1 ⇒ client 判準一律寫 **`col ≤ 1`**，兩代通吃（`list_session.js` 共 8 處）。
- **pmore 文章**：底部狀態列。
- **prompt**：底列輸入點。
⇒ `park 在 entry 區` vs `park 在底列` 是「乾淨列表 vs 文章/prompt」的廉價判別式。client 端 settle 時的 `term_buf.cur_x/cur_y` 即 park 位置（settle 已定義為內容＋游標皆靜，`src/js/term_buf.js` `_armSettleTimer` 前註解）。

### 5.1 輸入框指紋（`vgetstring`，CONFIRMED @ vtuikit.c:1211-1240）

所有輸入點（`getdata`／`namecomplete`／推文／`y-N` 詢問）都走 `vgetstring`，它每次重畫欄位：
`outs(VCLR_INPUT_FIELD)` → `vfill(len, 0, buf)` → `outs(ANSI_RESET)` → `move(line_ansi, col_ansi + rt.icurr)`。
`VCLR_INPUT_FIELD` ＝ `ANSI_COLOR(0;7)` ＝ `ESC[0;7m`（`include/vtuikit.h:37`）⇒ 反白欄，且**游標必定 park 在欄內**。
⇒ client 判別式：**游標所在格是白底黑字 ＝ 畫面正在等使用者輸入**（`term_buf.isCursorOnInputField`，
消費端見 `docs/mouse.md`「區域決策表」的 `inputPrompt`）。

**判斷必須用實際顯色（`getFg()===0 && getBg()===7`），不可以讀 `ch.invert`**：畫面不是 mbbsd 直接吐的 ANSI，
中間隔了 `mbbsd/pfterm.c` 這層 framebuffer（自己算最省的輸出）。2026-08 實測 term.ptt.cc：搜尋看板的輸入欄送的是
`fg=0/bg=7`（13 格 ＝ `IDLEN+1`，與 `namecomplete` 的 `len` 對得上），`invert` 旗標**從來不會被設起來** ——
照 `vtuikit.c` 的 `ESC[0;7m` 去讀 `invert` 的第一版 unit 全綠、線上完全沒生效。同一輪實測的其他畫面：
列表表頭／`【 搜尋全站看板 】`標題是 `fg=0/bg=7` 但**從 col 0 反白到行尾**（故要第二個條件），
列表狀態列 `fg=4/bg=6`、pmore 文章底部狀態列 `fg=7/bg=4`、推文輸入欄 `fg=7/bg=0` ⇒ 都不會誤判。
守護：`tests/e2e/search_prompt.spec.js`（live，這條只有連真 PTT 量得到）。

**列表上叫出的 prompt 不改變 `pageState`（client 推論，CONFIRMED 讀碼）**：`mbbsd/board.c#search_local_board`
（`s`／`Ctrl-S` 搜尋看板）只 `move(0,0); clrtoeol()` 後印兩列 prompt，下方列表整片殘留 ⇒ row 0 不再是整列
反白、最後一列非空 ⇒ `term_buf.setPageState` 每個分支都不命中，而它**沒有 reset 分支** ⇒ 沿用前一幀的
`pageState`（列表 2）。任何「這個畫面是不是列表／選單」的判斷都不可以只看 `pageState`，要再問 §5.1 的輸入框指紋。

## 6. `\f`（Ctrl+L）確定性交易依據（v5 新增，全部 CONFIRMED）

- **igetch 全域熱鍵**：`Ctrl('L')` → `redrawwin()+refresh()` 後 `continue`（`mbbsd/io.c` igetch switch）——`\f` 永不回傳給呼叫者，等同「插入一幀全幅重繪」。`vkey()`＝`igetch()`（io.c `vkey`），故**所有走 vkey 的輸入點都吃這條**。
- **getdata/vget 中途誤送安全**：`getdata` → `vgets` → `vgetstring`（`mbbsd/stuff.c:372`→`mbbsd/vtuikit.c:1154`）主迴圈 `c = vkey()` → `\f` 在 igetch 層就被攔掉，不進輸入 buffer、不炸，且照樣觸發全幅重繪（游標 park 回輸入點）。即使未被攔，content filter `c < ' '` 也只 `bell(); continue`。
- **pmore 內安全**：pmore 主迴圈 `ch = vkey()`（`mbbsd/pmore.c:2537`）→ 同樣被 igetch 攔截全幅重繪。開文/退文交易尾附 `\f` 可行。
- **read.c 列表層再保險**：`i_read_key` 自己也有 `case Ctrl('L'): redrawwin()+refresh()`（`mbbsd/read.c:735`）。
- typeahead 交互（BePTT 實證＋§2 推論）：`指令+\f` 同送 → 中間增量重繪被跳繪吞 → client 恰見一幀全幅畫面。單獨 `\f`＝零副作用「我在哪」探針。
- **推論（2026-08-15 live 實錯）：`\f` 關不掉任何「按任意鍵」**。`pressanykey()`＝`vmsg(NULL)` 的 `do { i = vkey(); } while (i == 0)`——`\f` 在 `system_key_hook`（`io.c:196-203`）就回 `KEY_INCOMPLETE`，`vkey()` 對它 `continue`（`io.c:432-434`），**那個 byte 根本不會成為一個「鍵」**。拿它當關框鍵的後果是**整串位移一格**：框沒關掉 → 下一個字元被拿去關框 → 剩下的字串被 pager／列表當快捷鍵逐鍵吃掉（實錯：`\f` + `sC_Chat\r` → `s` 關框、`h` 開說明、`a` 跳作者下一篇，人直接跑到別篇文章）。要關 pressanykey 一律用**空白鍵**。
- **零回應跳號（CONFIRMED，2026-08-25 live 錄製）：跳號到真游標「已經所在」的那一列 ⇒ 畫面零增量 ⇒ server 送 0 bytes。** 證據 `ptt-debug-20260825-105701#t=12562`：t=10151 的 prefetch 錨定腿已送過 `2381\r` 把游標停在 2381，t=12562 的 open-jump 又送同一個 `2381\r` → 整整 4002ms 一個 byte 都沒有，直到 client 的軟逾時探針才問出答案。**這不是「server 偶發抽風」，是可重現的協定行為**（PTT 只送畫面差異）。⇒ client 端所有 `<數字>\r` 交易一律尾附 `\f`（見 `src/js/list_session.js` 的跳號腿與 `docs/easy-reading-list.md` 不變量 7g）；同理，任何「目標可能等於現況」的鍵（End 於底端、Home 於頂端）都屬同一類。
- `\f` 不取代 settle：全幅重繪仍拆包（OBUFSIZE 3072），settle 判「何時看」、`\f` 保證「必有得看」。
- **重要限制（M1 實測，cchat-list-nav `\f` 版卷）：`redrawwin` 重繪的是 server 虛擬螢幕「現狀」，不會推進畫面狀態**——跳號完成後 server 虛擬螢幕的底列本來就空（§4 ✚：feeter 要到下一個 PARTUPDATE 才重畫），`跳號+\f` 的全幅重繪底列**仍空**＝classify 仍 transient、永非 clean-list。⇒ jump 落點判定必須維持 park 指紋（§4/§5），「jump 尾附 `\f` 換 clean-list expect」不成立。`\f` 的真實價值＝**零回應情境的確定性化**：timeout 探針（強制產生一幀可判定畫面）、相對命令 miss（`鍵+\f` 保證有回應）。

## 7. `v` 已讀設定交易（`b_mark_read_unread`，CONFIRMED）

`mbbsd/bbs.c:4223`（鍵表 flag 1）：
- 畫面：`move(b_lines-4,0); clrtobot()` → 空行＋提示行「設定已讀未讀記錄 (注意: …'~')」→ `getdata(b_lines-1, 0, "設定所有文章 (U)未讀 (V)已讀 (W)前已讀後未讀 (Q)取消？[Q] ", ans, 3, LCECHO)`。
- **prompt 指紋**：底 4 列被清、b_lines-3 起提示文字、游標 park 在底列 prompt 輸入點。
- **LCECHO＝`VGET_LOWERCASE` 多字元 getdata（`stuff.c:340`），單字元後必須送 `\r` 收尾**；空輸入（直接 `\r`）＝取消（default 分支）。
- 完成後 `return FULLUPDATE` → server 自行全幅重繪＝交易天生確定性收尾，**免附 `\f`**。W 以游標文章檔名時間戳（`filename+2`）為分界；時間戳無效時 `vmsg`（按任意鍵 prompt）——client 送 `\r` 收掉再等 FULLUPDATE。
- **交易以 server 真游標為基準** ⇒ client 交易形＝`跳選取序號\r`（sync-jump，park 指紋）→ `v` → expect prompt → `u/v/w/\r`。本地導航零網路、真游標停在上次互動處——漏掉 sync-jump 腿，W 分界會是舊游標位置（v5/M4 實錯）。

## 8. MODE_SELECT（`/` 搜尋）交易進出對（CONFIRMED）

- 進入：`/` → `select_read(locmem, RS_KEYWORD)`（`mbbsd/read.c:811-813`；舊記的 `:776` 現在是 Ctrl-H 的 `RS_NEWPOST`，行號會漂、以函式名為準）→ `getdata(b_lines, 0, "搜尋標題: ", …, DOECHO)`（Enter 收尾；空字串→`READ_REDRAW` 回原列表）→ 命中 count>0：`currmode |= MODE_SELECT` ＋ `NEWDIRECT`（全幅重建搜尋清單，序號空間獨立、無置底，見 §3）；count==0：`READ_REDRAW`（回原列表全幅重繪，底列 vmsg 類訊息）。
- 已在 MODE_SELECT 再 `/`＝「增加條件」疊加篩選。
- **退出：`q`／`e`／`←`**（`read.c:712-725`）→ `board_select()` 回主 directory ＋ `NEWDIRECT` 全幅重建主列表；**top=crs-p_lines+1（游標在視窗底列）**。
- **退出落點 = 帳號已讀進度，非進 select 前位置**（live CONFIRMED 2026-07-06，C_Chat 三次重測落點恆定於同一舊序號）：`crs_ln=refer` 的 refer 解析回主列表時採該板閱讀進度。⇒ client 不得假設退回畫面含進板時取樣的最新序號（re-seed 後 fill 只向上，buffer 可能整段低於進板頁）；測試判準用「序號回到主空間（> select 清單 max）」。
- **select 清單 row0 指紋**：板名前綴由「看板」變「**系列**《板名》」（live CONFIRMED）——可做輔助指紋，但主要區分仍靠 client 自身交易狀態。

## 8.1 `#` AID 搜尋交易（`select_by_aid`，CONFIRMED）

`mbbsd/read.c:366-481`；入口 `i_read_key` 的 `case '#'`（`read.c:766-768`）。**不走 `read_comms[]` onekey 表**（`bbs.c` 表中 35 號為 `{0,NULL}`）⇒ 一般/mail/man/digest 各模式一律生效。

- prompt：`getdata(b_lines, 0, "搜尋" AID_DISPLAYNAME ": #", aidc, 20, DOECHO)` ⇒ 底列全文 **`搜尋文章代碼(AID): #`**（`AID_DISPLAYNAME` 見 `include/common.h:151`）。尾端 `#` **印死在 prompt 裡**，非使用者輸入。
- `DOECHO`＝`VGET_DEFAULT` → `vgets`/`vgetstring`（`vtuikit.c:1150`）：**Enter 收尾**；ESC 或空字串＝取消（`move(b_lines,0); clrtoeol(); return FULLUPDATE`）。buffer len 20 ⇒ 實收上限 19 bytes。
- 輸入前處理（`read.c:394-399`）：strip 前置空白與**一個** `#` ⇒ 送 `#1gIeu-3A` 與 `1gIeu-3A` 等價。`aidc2aidu()` 遇非法字元回 0。
- **成功（`read.c:477-481`）：`*pnew_ln = n+1; move(b_lines,0); clrtoeol(); return DONOTHING;`** ⇒ **只把游標移到目標序號、不重繪清單、不自動開文**。畫面指紋與「數字跳號」完全相同（底列留空）⇒ **client 直接沿用 §4 ✚ 的 park 判定**，不可等 clean-list。
- 失敗（`read.c:464-475`）：`move(21,0); clrtobot(); move(22,0)` ＋ `不合法的文章代碼(AID)，請確定輸入是正確的` / `找不到這個文章代碼(AID)，可能是文章已消失，或是你找錯看板了` ＋ `pressanykey()` ＋ `FULLUPDATE`。
- 拒絕分支：MODE_SELECT（搜尋清單中）或 RMAIL → `此狀態下無法使用搜尋文章代碼(AID)功能` ＋ `pressanykey()`。**推論：`/` 搜尋清單裡不可能直接 `#` 跳文，跳轉與返回都必須先用 `s<board>` 離開 MODE_SELECT**（`s` 走 `do_select()`→`enter_board()`，currmode 重來）。
- **跨模式跳轉會產生二段式畫面更新**：命中處與目前模式不符（一般↔文摘）時設 `*pdefault_ch = KEY_TAB; return DONOTHING;`——server **自己補按一個 TAB**，下一圈 `i_read_key` 用它跑 `board_digest()` 切模式 ⇒ client 會看到「prompt 消失」與「全幅切換清單」兩段。
- 文章內（pmore）按 `#`：`more.c:108-112` → `RET_SELECTAID` → `read.c:1018-1024` 先退出 pmore 回列表再開同一個 prompt，收尾強制 `FULLUPDATE`（與列表內的 `DONOTHING` 不同）。
- **死碼警告**：`mbbsd/aids.c` 的 `do_search_aid()`（支援 `AID@BOARDNAME` 跨板語法）整段包在 `#ifdef NEW_AIDS` 內，而 `NEW_AIDS` 全 repo 無任何定義 ⇒ **真正跑的只有 `read.c#select_by_aid`，不支援 `@板名`**。勿照那段實作 client。
- **只搜 currboard**：`select_by_aid` 依序找 `<currboard>/.DIR.bottom`、`.DIR`、`fn_mandex`，全都是**目前看板**的檔案 ⇒ 跨板一定要先 `s<board>`。另註 `read.c:404` 自帶 FIXME：置底文若沒列在 `.DIR.bottom` 這段會搜不到（實測 Test 板的置底公告 AID 搜尋直接失敗）⇒ **client 不可假設任何一篇文章的 AID 都跳得到**。
- **per-board 游標記憶（getkeep）＝「返回原看板」可行的根據（CONFIRMED）**：`i_read` 在 `NEWDIRECT`（第一次進入該目錄）呼叫 `getkeep(currdirect, …)`（`read.c:1171`），而 `getkeep`（`read.c:105`）以 board path 的 hash 查既有 entry，**命中就沿用舊的 `crs_ln`**（`read.c:128-139`）；儲存結構是不斷追加的 link block（`KEEPSLOT=10` 一塊，滿了 malloc 下一塊），**session 內永不淘汰**。`board.c:1976` 的 `getkeep(buf, head, tmp+1)` 只在 entry 不存在時才用未讀位置當預設值，不會覆寫既有的。⇒ `s<原板>` 回去時游標仍停在離開時那一列。
  - **推論（單一例外）**：同板的 `#<aid>` 跳轉會覆寫該板的 `crs_ln`，所以「靠 getkeep 回原文」在**原板 == 目標板**時不成立（client 端 `nav_history.chooseAnchor` 據此讓 board 級錨點作廢）。
- client 對照：`src/js/aid_navigation.js`（點 AID 連結的四段式交易＋返回時的反向重放）、`src/js/nav_history.js`（錨點三級：aid / num＋subject 驗證 / board）與列表好讀的貼上 passthrough（`list_session.js#onPaste`）——後者刻意**不**代按 Enter、不特判 AID，讓上述原生行為原樣呈現。

## 8.2 `Q` 文章資訊框交易（`view_postinfo`，CONFIRMED）

**唯一能問出「我現在這篇的 AID」的原語**——`#` 只能用 AID 去找文章，反向要靠這個。是 AID 返回錨點的資料來源（`aid_navigation._enqueueOriginAid`）。

- 觸發：列表 `Q`（`bbs.c:4410` onekey 表 → `view_postinfo`）；**文章內（pmore）`Q` 也可以**（`more.c:70` → `RET_DOQUERYINFO` → `bbs.c:2376`），會**先退出 pmore 回列表**再疊資訊框。無 `currstat` 閘門（與 `s`/`#` 不同）。
- 畫面：以游標列為基準疊一個 `┌─…┐`／`└─…┘` 方框（`bbs.c:3650-3690` 決定 `area_l`；游標偏下時整框上移），內容定版 `bbs.c:3697-3705`：
  `│ 文章代碼(AID): #<8碼AIDc> (<板名>) [ptt.cc] <標題截斷>`，其後可有 `│ 文章網址: https://…`（`QUERY_ARTICLE_URL`）、金錢／匿名／投票列。
  `AID_DISPLAYNAME` = `include/common.h:154`。`currboard` 為空時板名印中文「不明」。
- **本篇無合法 AID（`fn2aidu()<=0`）時只印一根 `│`**（`bbs.c:3707`）⇒ client 不可假設一定讀得到。
- **AIDc ⇄ 檔名 `M.<v1>.A.<v2>` 完全可逆、可離線算**（`mbbsd/aids.c`：`fn2aidu`/`aidu2aidc`/`aidc2aidu`/`aidu2fn`）。位元佈局、64 字表、`%03X` 等細節**內嵌在 `src/js/aid_codec.js` 的檔頭**（逐行標了 aids.c 行號），此處不重抄。看板名不在 AIDc 裡 ⇒ 短碼還原成完整網址一定得外部提供看板。
  - 因此 client 有**免費**取得「本篇 AID」的第二條路：讀本文的 `※ 文章網址: https://www.ptt.cc/bbs/<Board>/<檔名>.html` 再換算，不必按 `Q`（`aid_navigation.findLocalPostAid`）。守則與取捨見 `docs/deep-link.md`「本篇 AID 的兩條取得路徑」。
  - **同板轉錄被擋**（`bbs.c:2097`「同板不需轉錄。」）⇒ 「網址裡的看板 ≠ 目前看板」足以判定那行是轉錄帶進來的**原文**網址。
- **MODE_SELECT 下數值仍正確**：`view_postinfo` 讀的是 `fhdr->filename`（篩選清單的 record 帶的是真實檔名），不碰 `bbs.c:3732` 註記會亂掉的 `multi`。
- **收尾 `pressanykey()`（`bbs.c:3773`）＝ `vmsg(NULL)`（`proto.h:636`／`vtuikit.c:439-455`）吃掉正好一個鍵**，然後 `FULLUPDATE`。
  - **框畫在「剛離開的文章畫面」上**（`view_postinfo` 用 `grayout()` 壓灰背景），要等 `pressanykey` 收掉後才由 `read_post` 的 `return FULLUPDATE` 重繪**列表** ⇒ 框在時 client 看到的底色仍是文章。
  - client 三條硬規則：
    ① 這個交易**不可帶 `fullRepaint`**：判定一律靠內容，多送一個 `\f` 只會讓 settle 幀的意義變模糊。
    ② **關框的鍵不可以是 `\f`**（見 §6 末條：Ctrl-L 送不到 handler，框關不掉，下一個字元會被拿去關框，剩下的板名就被 pager 當快捷鍵吃掉），也**不可以是 `←`**（外漏到列表會直接離板）。現用**空白鍵**：外漏到列表或 pager 都只是翻頁，對後續的 `s<board>` 無影響。
    ③ `pressanykey` 的回傳值有一個特例：`r == 'Q'` 會切換金錢排序模式（`bbs.c:3774-3781`）⇒ 關框鍵不可用 `Q`。

## 9. 水球/廣播指紋（T4 非請自來，CONFIRMED）

- 路徑：SIGUSR2 → `write_request`（`mbbsd/mbbsd.c`）→ `show_call_in` → `outmsg`（`mbbsd/kaede.c`）＝ `move(b_lines - msg_occupied, 0); clrtoeol(); outs(msg)`。
- source 字面（`show_call_in`）：
  - 一般 `ANSI_COLOR(1;33;46) "★%s" ANSI_COLOR(37;45) " %s " ANSI_RESET`
  - PLAY_ANGEL（MSGMODE_TOANGEL）`ANSI_COLOR(1;37;46) "★%s" …`（同結構）
  - **字元是 `★`（Big5 `A1B9`）不是 `◆`** — 舊版本檔寫成 ◆ 是錯的；`string_util.js#parseWaterball` 用 ★ 才是對的。
- **wire 上的實際 byte**（經 §0 的 pfterm 重寫）：`ESC[1;33;46m★userid` `ESC[0;1;37;45m 訊息 ESC[m`。
  第二段之所以是 `0;1;37;45` 而非 source 的 `37;45`：fg 回到預設 7 觸發 `fterm_chattr` 的 reset，
  再由 `FTCONF_WORKAROUND_BOLD` 補印 `37`。尾端的 `ESC[K` 只有新訊息比前一則**短**時才會送 ⇒ 不可當必要條件。
- **client 指紋**：無 in-flight ∧ 非使用者觸發的 settle，髒列集合 ⊆ {底列}（msg_occupied>0 時上移一列），且該列以反白 `★` 帶 `1;33;46`／`1;37;46` 色起頭。dogetch 等待中即時觸發（`io.c`），可出現在任何畫面。

## 10. last-read 高亮（readdoent title-match，CONFIRMED）

- 條件（`mbbsd/bbs.c` `readdoent:830`）：`strcmp(currtitle, subject_ex(ent->title)) == 0` → **同 subject 的每一列都亮**（多列同亮＝正常；實錄 20260717-224420 t=1937 兩列同紅）。
- `currtitle`：per-login 全域（`mbbsd/var.c:137` 初始空），讀完文章設 `subject(fhdr->title)`（bbs.c:2424，緊接 `brc_addlist`）；回文時也設（bbs.c:1678/1696）。跨看板都比對。
- `subject_ex`（`common/bbs/string.c:58`）：**loop** 剝 case-insensitive `Re:`/`Fw:` 前綴（各可跟一個空白）。列表顯示的標題已是剝完的。
- 顏色：`ANSI_COLOR(1;3c)`，c＝該列自身 title_type（bbs.c:735-752）：`□`=1紅、`R:`=3黃、`轉`=6青、`鎖`=5紫、`ˇ`=2綠。範圍 mark→行尾（special=1 → 行尾才 RESET），**不含作者欄**。
- **作者欄亮色與 last-read 無關**：`isonline`（作者在線上）→ 作者名 `ANSI_COLOR(1)` 亮（bbs.c:815-823；lightbar 使用者旗標則 36 青）。
- client 對應：`src/js/list_session.js` `_lastReadTitle`／`subjectOfListRow`／`paintLastReadListRow`；不變量見 `docs/easy-reading-list.md` #16。

## 11. client parser ↔ 官方格式字串對照（2026-08 全面反查，CONFIRMED）

`src/js/` 這批「讀畫面文字反推狀態」的 parser，逐條對 `c1ff72df` 驗過。回歸守護在
`tests/unit/string_util.test.js`（每個 case 註明出處）、`comment_parse.test.js`、
`auto_login_logic.test.js`、`easy_reading_logic.test.js`。

| client | 官方出處 | 契約 |
|---|---|---|
| `parseStatusRow` | `pmore.c#mf_display_footer` ＋ `more.c#common_pmore_footer_handler` | part1 `"  瀏覽 第 %1d[/%1d] 頁 (%3d%%) "`（頁碼**無位數上限**，實錄已見 540/540）；part2 `" 目前顯示: 第 %02d~%02d 行"`／**`" 顯示範圍: %d~%d 欄位, %02d~%02d 行"`（`mf.xpos>0` 左右捲動）**；**part3 完全不比對**——它會整段消失（見 §13 P5），要求它會讓整列失配 → 掉出 pageState 3 → 好讀累積頁被清空。`bpref.oldstatusbar` 的 `"  瀏覽 P.%d(%d%%)  "` 目前**不支援**（非預設） |
| `parseListRow` | `menu.c#show_status` | `"[%d/%d 星期XX %d:%02d]"` ＋ `"%-14s"`（today_is，**緊接 `]` 無空格**）＋ `" 線上%d人, 我是%s"` ＋ `"\t[呼叫器]%s "`；呼叫器狀態 5 種＝`var.c#str_pager_modes`：關閉／打開／拔掉／防水／好友 |
| `parseWaterball` | `mbbsd.c#show_call_in` | 見 §9 |
| `parsePushInitText`（消費者：`image_upload.js`） | `bbs.c#recommend`／`angel.c` | `您覺得這篇文章 `；`FormatCommentString` 的輸入 prompt「→ id:」**無行尾時間戳** |
| `comment_parse.COMMENT_RE` | `comments.c#FormatCommentString`＋`common/bbs/names.c#is_validuserid` | `<attr><推/噓/→><空格>ESC[33m<id>ESC[m:<msg 補到 maxlength>ESC[m<tail>`；id 長度 **2..IDLEN(12)**、首 isalpha 其餘 isalnum；`BRD_ALIGNEDCMT` 時 id 以 `%-*s` 補到 12 寬（故 `:` 前可有空格）；tail＝`[%15s ]MM/DD HH:MM`（`Cdate_mdHM` ＝ `"%m/%d %H:%M"`，IP 僅 `BRD_IPLOGRECMD`／guest） |
| `comment_parse` 列表欄位 | `bbs.c#readdoent` | 見 §3 欄位表 |
| `auto_login` | `mbbsd.c` 登入迴圈＋`include/common.h` | prompt `請輸入代號，或以 guest 參觀，或以 new 註冊: `(DOECHO)／`MSG_PASSWD "請輸入您的密碼: "`(NOECHO)／`您想刪除其他重複登入的連線嗎？[Y/n] `(LCECHO)／`您要刪除以上錯誤嘗試的記錄嗎? [Y/n] `(`vans`→`vgets`，**都要 `\r`**)。失敗出口＝`ERR_PASSWD "密碼不對喔！…"`、`ERR_UID "這裡沒有這個人啦！"`（`is_validuserid` 失敗，**不會再問密碼**）、`抱歉，此帳號已設定為只能使用安全連線(如ssh)登入。` |
| `easy_reading.reachedPageEnd` | `pmore.c` FOOTER1 配色 | VIEWALL `ANSI_COLOR(37;44)`＝fg7/bg4（＝看完）；VIEWNONE `33;45`；一般 `34;46` |
| `term_buf.isTextWrappedRow` | `pmore.c` `MFDISP_WRAP_INDICATOR ANSI_COLOR(0;1;37) "\\"` | 80 欄下 `maxcol = 77`（`dispw = DBCS_HEADERWIDTH(79) = 78`）⇒ indicator 落在 **col 78**（ASCII 斷行）或 **col 77**（DBCS 跨界被回退擦掉 lead byte）；顏色 fg7/bright/bg0。TRUNC 用 `>`、WNAV 用 `<`，不可混 |
| `term_buf.setPageState` | `vtuikit.h`／`edit.c`／`angel.c` | `VMSG_PAUSE " 請按任意鍵繼續 "`；`請按 空白鍵 繼續`＝`angel.c` 的新手提示；編輯器底列＝`vs_footer(" 編輯文章 ", " (^Z/F1)說明 (^P/^G)插入符號/範本 (^X/^Q)離開\t…")`（「編輯文章」後**兩個空格**） |
| `term_keyboard` | `common/sys/vtkbd.c`＋`include/vtkbd.h` | `ESC[A/B/C/D`→`KEY_UP+(c-'A')`；`ESC[1~`→HOME、`ESC[2~`→INS、`ESC[3~/4~/5~/6~`→`KEY_DEL+(c-'3')`＝DEL/END/PGUP/PGDN（`vtkbd.h` 註明 "must follow vt220 ordering"）。全部對上 |
| `aid_parse` | `mbbsd/aids.c#aidu2aidc` | 字母表 `0-9A-Za-z-_`（64 字），產出**恆 8 字**；反向 `aidc2aidu` 不限長度但畫面上只會出現產生端形式 |
| `symbol_table.js` | — | **不適用**：是 client 端 Unicode→顯示寬度分類表（1/2＝強制全形、3＝壞 DBCS），與 server 邏輯無關 |

## 11.1 推文列欄位寬度與輸入上限（2026-08 CONFIRMED）

用途：判斷「這則推文是不是被輸入欄截斷」——結論是**畫面上判不出來**，故
`comment_merge.js` 不再猜續行（見 `docs/enhanced-addon.md`）。此處只留欄寬事實本身。

| 項目 | 出處 | 值 |
|---|---|---|
| 內容欄寬 `maxlength` | `bbs.c#recommend` | `78 - 3(lead) - 6(date) - 1(space) - 6(time) - strlen(myid)`；`BRD_IPLOGRECMD` 或 guest 再 `-15` |
| 行組成 | `comments.c#FormatCommentString` | `type(2) + " " + id + ":" + %-maxlength(msg) + tail`；tail＝`" MM/DD HH:MM"`，IP 板為 `"%15s MM/DD HH:MM"`（IP **右對齊 15 欄**） |
| 可輸入位元組上限 | `vtuikit.c#vgetstring` | 插入條件 `iend+1 < len` ⇒ 上限 `maxlength-1`；全形另需 `len - iend >= 3`（2 bytes + NUL） |
| 線上實測（term.ptt.cc） | 本次 debug 錄製（AI_Art／Stock／IpComment fixture） | `':'` 後多一格（§12 已知差異）⇒ 內容欄 = `[3+len(id)+2, 66)`；IP 板 = `[…, 51)`；時間戳固定 col **67..77**，全行 78 欄 |

推論（勿再重算）：`剩餘欄位數 = 66 - 內容尾欄`（IP 板 `51 - 內容尾欄`）。全形塞得下需剩 ≥3；
但**實測「作者剛好寫滿」與「被截斷」同形**（AI_Art M.1785606011 三連推第 2 則內容 50 bytes
＝ 10 字 id 的理論上限 `61-10-1`），所以此數字只能當「上界」用，不能反推作者意圖。

程式化推導（`comment_merge.commentContentCells` 回傳的 `fieldEnd`，勿寫死 66/51）：時間戳固定
11 欄寬 ⇒ `fieldEnd = ipFound ? timeStart-16 : timeStart-1`（tail 為 27／12 欄），id 長度、IP 板、
guest 都自動吃到。「寫滿」＝內容 exclusive 尾端 `>= fieldEnd-1`（`maxlength-1` 上限；容一格是因為
commentd／官方 App／bot 不走 `vgetstring`，可填滿整欄）。

**這個「寫滿」只可當必要條件，不可當判決**——上一段已證同形。唯一有在用它的是
`url_wrap.js`（跨行連結接合），那裡真正的判別力來自「斷點兩側併起來是合法 URL（TLD 允許清單）」，
寬度只負責排除「作者根本沒寫滿、只是分兩則講話」。散文續行**仍然判不出來，勿再嘗試**。

## 11.2 登入頻率限制與擋人機制（2026-08-25，開源碼部分 CONFIRMED）

起因：整輪 live e2e 連跑兩次，測試帳號被 PTT 擋住（`tests/e2e/README.md`）。以下區分
「開源碼裡真的有的」與「PTT 私有的」，因為兩者的處置完全不同。

### 開源碼裡有的（CONFIRMED，可讀出確切數字）

**a. 登入頻率 — `daemon/utmpd/utmpserver3.c#action_frequently(uid)`**（每 uid 計數，回 0/1/2）：

| 條件 | 回傳 | 意義 |
|---|---|---|
| 距上次登入 **≤ 3 秒** | 2 | reject |
| 同一分鐘內 **> 10 次** | 2 | reject |
| 同一小時內 **> 60 次** | 2 | reject |
| 同一分鐘內 **> 3 次** | 1 | delay |
| 同一小時內 **> 20 次** | 1 | delay |
| 其餘 | 0 | 放行 |

計數器是**掛鐘分/時的桶**（跨分、跨時整批歸零），不是滑動視窗 ⇒ 剛好跨過整點的兩次爆量不會被合併計算。
整段包在 `#ifdef NOFLOODING` 內（巨集名與語意相反，別被誤導）。

**b. reject 的畫面 — `mbbsd/talk.c`（res==2）**：`outs("登入太頻繁, 為避免系統負荷過重, 請稍後再試\n")`
→ `log_usies("REJECTLOGIN")` → `sleep(30); exit(0)`。**連線等同已死、按鍵無效**，client 只能重連
（`tests/e2e/helpers/login_flow.js` 的 `throttled` 分支就是依這條做 30 秒退避重連）。
另註同檔：非真登入路徑（`!do_login`）自己 `sleep(3)`，註解直說「utmpserver usually treat 3 seconds as flooding」。

**c. 密碼錯誤次數 — `LOGINATTEMPTS = 3`**（`include/config.h`）：
`daemon/logind/logind.c#auth_fail` 與 `mbbsd/mbbsd.c` 各自數，超過就 goodbye 斷線。
這條數的是**錯誤嘗試**，與「成功登入太多次」無關，別混為一談。

**d. IP 黑名單** `~bbs/etc/banip.conf`（`common/bbs/banip.c`，支援單 IP／CIDR／range／萬用字元）
與**全站封鎖檔** `FN_BAN`（`logind.c:1457`，存在即畫 ban 畫面）。

**e. 容量閘門**（非濫用）：`regular_check()` 的 CPU 過載／人數過多／guest 名額，見 §11 的登入表。

### PTT 私有的（**不在**開源碼裡）

實錄畫面：

```
[PTT DDoS/BOT 偵測系統] 偵測到連線異常/不當連續登入行為！
帳號 xxx 已被暫時禁止登入。
[PTT DDoS/BOT 偵測系統] 帳號 xxx 有疑似不當連續登入行為所以暫停連線。
```

`3rd_script/pttbbs` 全樹查無 `DDoS`（ASCII）、也查無 Big5 的「不當連續登入」「暫停連線」
「禁止登入」⇒ 這是 PTT 站方自有的防濫用層（對照 §0：線上「系統資訊」的第 2 個 hash 就是
PTT 私有 commit，不在公開 repo）。**觸發門檻無從得知**，但**解除規則畫面自己寫了**：

```
[PTT DDoS/BOT 偵測系統] 帳號 xxx 有疑似不當連續登入行為所以暫停連線。

由於本站近日有大量廣告信皆來自於機器人自動帳號，即日起會偵測不當連線。
本系統為獨立動態偵測連線，與BBS內帳號權限無關，無法申請手動解除鎖定，
也不會告知暫停時限。

在停止使用機器人或行為不正常的App（部份App需要關閉自動登入）、
無任何登入行為之後最多12小時後會恢復。
注意在暫停期間若持續嘗試登入會被視為機器人，將無限期延長暫停時間。
```

三條硬事實（**全部與 mbbsd 的 `action_frequently` 不同層**，別套用上表的數字去推算）：

| 事實 | 後果 |
|---|---|
| 「無任何登入行為之後最多 12 小時」 | 計時從**最後一次登入行為**重新起算；掛著自動登入的一般瀏覽也會一直重置它 |
| 「持續嘗試登入…將無限期延長」 | 這是唯一一種「再試一次」嚴格劣於「什麼都不做」的失敗模式 |
| 「無法申請手動解除鎖定」 | 沒有申訴管道，也不會告知剩餘時間 |

「部份App需要關閉自動登入」等於直接點名 client 端的自動登入功能（本專案的
`src/js/auto_login.js`、e2e 的兩條開站自動登入 spec）＝最容易被判定成機器人的行為模式。

⇒ client／測試端唯一能做的兩件事：
1. **少登入**。開源碼的數字給了下界：同一分鐘 >3 次就已經進入 delay，>10 次 reject；
   同一小時 >20 次 delay。live e2e 因此把整輪登入次數壓到 **1 次共用 session ＋ 2 條
   本質在測開站自動登入的 spec**（`tests/e2e/helpers/fixtures.js`，守護
   `tests/unit/e2e_login_budget.test.js`）。
2. **一偵測到就整輪停手**，而不是重試——重試會無限期延長封鎖。
   `tests/e2e/helpers/bot_block.js`（偵測純函式＋跨 worker 閂鎖），守護 `tests/unit/e2e_bot_block.test.js`。
   實測效果（2026-08-25，封鎖期間跑整輪 live）：**只送出 1 次登入嘗試、整輪 8.6 秒結束**，
   其餘 26 條在開 browser context 之前就被閂鎖擋掉。對照沒有閂鎖時的同一情境：9 次登入嘗試、6 分鐘。

## 11.3 推文互動序列（`bbs.c#recommend`，2026-08-26 CONFIRMED）

§11.1 只講**已完成**的推文列長什麼樣；這一節是「怎麼推」——長推文一鍵發送
（`src/js/long_push*.js`）與圖片上傳插入位置（`src/js/image_upload.js`）的共同依據，
兩者共用 `src/js/push_screen.js#classifyPushScreen`。消費端守護：`tests/unit/push_screen.test.js`
（每個字串一個 case）、`long_push_flow.test.js`（鍵序）。

進入點：`bbs.c` 的 `read_comms[]` `{1, recommend} // 'X'`（`'%'` 同）；文章內按 X 走
`more.c` → `RET_DORECOMMEND` → `read_post` 的 `recommend(ent, fhdr, direct); return FULLUPDATE;`。
`needitem=1` ⇒ 游標必須在文章列上；`recommend()` **不移動游標**，所以列表與文章按 X
推的是同一篇。

| 步 | server（底列＝`b_lines`，提示畫在 `b_lines-1`） | client 送什麼 |
|---|---|---|
| 0 | 擋人 `vmsg`/`vmsgf`：`" ◆ "`＋訊息，右靠 `" [按任意鍵繼續]"`（`vtuikit.h` `VMSG_MSG_PREFIX`／`VMSG_MSG_FLOAT`） | **任一真按鍵**（`vmsg` 是 `do{i=vkey();}while(i==0)`；`\f` 被 `io.c#system_key_hook` 吃掉，同 §6 的 pressanykey 坑） |
| 1a | 型別選單 `您覺得這篇文章 1.值得推薦 2.給它噓聲 3.只加→註解 [1]? `；`BRD_NOBOO` 板**不印 `2.`**，`3.` 仍是 3 | **單一 byte** `1`/`2`/`3`。`type = vkey()` ⇒ **不可帶 `\r`**（`\r` 會被下一個 `getdata` 當 Enter 吃掉 → 空內容 → 整則靜默取消）。非數字一律 `RECTYPE_DEFAULT`＝推 |
| 1b | `作者本人, 使用 → 加註方式`（`is_file_owner`） | 不送鍵，直接進步驟 3 |
| 1c | `時間太近, 使用 → 加註方式`（`now - lastrecommend < 90`，**寫死 90 秒**；`lastrecommend` 是 `recommend()` 的 `static`＝整個 mbbsd session 共用，跨看板跨文章，只在推文**成功**後更新） | 同上 |
| 2 | 選配警告橫幅（匿名／外站轉信板、`/`搜尋等特殊列表模式），佔 `b_lines-1`/`-2` | 不需輸入 |
| 2.5 | `要使用小天使匿名推文嗎？ [Y/n]: `（`HAS_ANGEL && PERM_ANGEL && BRD_ANGELANONYMOUS`，`vans`→`vgets`） | `n\r`。**空 Enter ＝ 匿名 YES** |
| 3 | 內容輸入列 `<型別符> <id>:` ＋ `maxlength` 格反白欄（§11.1） | Big5 內容 ＋ `\r`；**空字串＝取消整則**（`if (!getdata(...)) return FULLUPDATE;`） |
| 4 | 確認列 …` 確定[y/N]:`（"確定"前的空格是格式的一部分） | `y\r`。`sizeof(ans)==2` ⇒ 只吃一個字元，原始碼的 `:w`／`zz` 分支**打不進去**（死碼） |
| 5 | 寫檔 → `return FULLUPDATE` | — |

**1a / 1b / 1c 是 `if / else if / else` 互斥**：client 必須讀畫面才知道要不要送型別鍵。
在 1b/1c 送 `1` ⇒ 那個 1 直接變成推文內容。**第 2 則起 90 秒內一定走 1c**（板主
`MODE_BOARD` 除外），這是連續推文最容易炸的地方。

冷卻與擋人訊息全集（都是步驟 0 的 ◆ 橫幅）：

| 訊息 | 出處／條件 | 等得到嗎 |
|---|---|---|
| `本板禁止快速連續推文，請再等 %d 秒` | `BRD_NOFASTRECMD`，`bp->fastrecommend_pause` 板主可設 5–240s | ✅ 秒數在訊息裡 |
| `本文已過長, 禁止快速連續推文, 請再等 %d 秒` | 文章 >100KiB，**固定 10 秒** | ✅ |
| `冷靜一下吧！ (限制 %d 分 %d 秒)` | `check_cooldown`，`BRD_COOLDOWN` | ✅ |
| `對不起，您的文章或推文間隔太近囉！ (限制 %d 分 %d 秒)` | `check_cooldown`，`REJECT_FLOOD_POST`（看板人數 vs 已發文次數，門檻表 `{4000,1, 2000,2, 1000,3, -1,10}`） | ✅ |
| `對不起，您被設退文！ (限制 %d 分 %d 秒)` | `posttimesof(usernum)==0xf` | ❌ 懲罰狀態，等完照樣擋 |
| `系統禁止短時間內大量推文` | 同一「分鐘桶」>**60** 則 | ❌ 無秒數 |
| `抱歉, 禁止推薦` | `BRD_NORECOMMEND`／檔名首字 `L`／`FILE_MARKED&&FILE_SOLVED` | ❌ |
| `無法推文: %s` | `!CheckPostPerm2()` 或 guest；`%s` 全集見 `cache.c#postperm_msg`（含水桶的 `使用者不可發言(尚有%d天)`） | ❌ |
| `本板推文限定管理人員使用。` | `BN_ONLY_OP_CAN_ADD_COMMENT`（`#ifdef`） | ❌ |
| `本文已刪除` | `SAFE_ARTICLE_DELETE` | ❌ |
| `未達看板發文限制: %s` | `get_board_restriction_reason`（登入次數／退文篇數） | ❌ |
| `檔案太大, 無法繼續推文, 請另撰文發表` | 文章 >5MiB | ❌ |
| `錯誤: 資料庫連線異常，無法寫入。請稍候再試。` | `USE_COMMENTD` 寫入階段 | ❌ |

其他事實：連署板（`BRD_VOTEBOARD`／`FILE_VOTE`）的 X 轉去 `do_voteboardreply()`＝**完全不同的
UI**，不在推文流程內。`MAX_RECOMMENDS(100)` 只影響列表上的計數顯示（`爆`／`X%d`），不擋推文。
上游**沒有**「是否要繼續推文」之類的續推詢問。

- unknown（§12）：`recommend()` 一律 `return FULLUPDATE` ⇒ 上游讀碼的結論是推完**回文章列表**，
  但線上是私有 commit，實測可能仍停在文章。`long_push_session` 對兩種落地都免疫（列表按 X 推的
  是同一篇），只在「落在列表且起點是文章」時補一個 `\r` 回去。
- unknown：`vgetstring` 畫的反白欄是 `ESC[0;7m`（fg0/bg7），與 §5.1 記的 fg7/bg0 相左。故
  **不採用「數反白格反推 `maxlength`」**，改用 §11.1 的公式 ＋ 畫面上推文列有無 IP 欄。

## 11.4 游標標示：`cursor_show()` 的兩套 flag（2026-08-26 全部 CONFIRMED @ `mbbsd/stuff.c`）

**別把「圓點」與「光棒」混為一談**——它們是**兩個獨立的 user flag**，官方中文名在
`[U] 個人設定 → 個人化設定`（`mbbsd/user.c#Customize`，字串在 `user.c:477-486`）：

| 官方中文（現行） | flag（`include/uflags.h`） | 做的事 |
|---|---|---|
| `使用舊式實心圓游標●` | `UF_CURSOR_LEGACY` `0x04000000` | **只換符號** `STR_CURSOR`(`>`) → `STR_CURSOR2`(`●`)。本身沒有任何整列高亮 |
| `使用光棒式游標` | `UF_CURSOR_STANDOUT` `0x01000000` | `grayout(row,row+1,GRAYOUT_STANDOUT)` ＝整列**有底色**（前景/背景反轉） |

現行 `cursor_show()`（`mbbsd/stuff.c:211-227`）：

```c
void cursor_show(int row, int column) {
    move(row, column);
    if (!HasUserFlag(UF_CURSOR_LEGACY)) { outs(STR_CURSOR);  move(row, column);     }
    else                                { outs(STR_CURSOR2); move(row, column + 1); }
    if (HasUserFlag(UF_CURSOR_STANDOUT)) grayout(row, row+1, GRAYOUT_STANDOUT);
}
```
`STR_CURSOR2 = "●"`（Big5 `0xA1 0xB4`，佔兩格；`STR_UNCUR2` 是兩個空白）。
呼叫點：`menu.c:615`、`psb.c:47`（Favorite／看板清單）、`read.c:176,187`、`stuff.c#cursor_key`。

### `grayout` 的四個 level（`mbbsd/pfterm.c:2281-2345`）

```c
case GRAYOUT_COLORBOLD:  grayout_shift(y, end, 1, FTATTR_BOLD, FTATTR_BLINK);   // 提亮一階
case GRAYOUT_COLORNORM:  grayout_shift(y, end, 0, FTATTR_BOLD, FTATTR_BLINK);   // 還原
case GRAYOUT_STANDOUT:   grayout_apply(y, end, FTATTR_BLINK, 0); ft.standout=1; // 反轉
case GRAYOUT_STANDEND:   grayout_apply(y, end, 0, FTATTR_BLINK); ft.standout=0;
```
`STANDOUT` 是「借 BLINK 位元」再由 `fterm_chattr()`（`pfterm.c:1786-1794`）在
`ft.standout` 時把 `FTATTR_BLINK` 重新解讀成 `FTATTR_REVERSE` ⇒ **有底色**。
`COLORBOLD` 走的是 `FTATTR_BOLD`（`ESC[1m`）⇒ 前景提亮一階、**背景不變**。

### 時間線（六個 commit 全部驗過 `git show`）

| commit | 日期 | 做的事 |
|---|---|---|
| `e18a7182` | 2013-01 | `Enable experimental lightbar menu system` — 加 `UF_MENU_LIGHTBAR 0x01000000`，`cursor_show()` 在該 flag 下畫 `●` ＋ `grayout(..,GRAYOUT_COLORBOLD)`＝**圓點 ＋ 無底色整列提亮**。UI 字串 `"(實驗性)啟用光棒選單系統"` |
| `b9a5029f` | 2026-08-11 | `cleanup(cursor): Always do CURSOR_ASCII` — 「36% 使用者沒開，維護兩套 UI 太痛」；刪 `STR_CURSOR2`、廢 `UF_CURSOR_ASCII` |
| `814adde3` | 2026-08-12 | `cleanup(menu): Remove the experimental lighbar menu` — 「只有 0.6% 使用者」；`UF_MENU_LIGHTBAR` 與那段 `COLORBOLD` 一起消失 |
| `640a074f` | 2026-08-13 | `feat(cursor): Re-enable the legacy cursor` — 以新 flag `UF_CURSOR_LEGACY` 復活 `●`（理由：圓點可減輕閃爍游標造成的視覺疲勞）。**此時仍無整列高亮** |
| `ebee1706` | 2026-08-14 | `feat(pfterm): Add standout() and GRAYOUT_STANDOUT` |
| `33290148` | 2026-08-14 | `feat(user) Add UF_CURSOR_STANDOUT` — 「真正的光棒游標系統」，回收 `0x01000000` |

⇒ **「無底色整列提亮」在現行 PTT 已無對應選項**（2013 的實驗品，2026-08-12 移除）。
官方詞彙裡的「光棒」自 `33290148` 起專指**有底色**那個。

### 對本 client 的意義

server 送的是編碼後的 ANSI，client 看不到 flag，只看得到結果。本專案把這兩種樣式做成
自己的 pref（`cursorRowBrighten` / `cursorRowBackground`，見 `docs/mouse.md`）：

- 「提亮一階」在本專案是既有的色彩模型：`TermChar.getFg()` ＝ `bright ? fg+8 : fg`，
  與 `ESC[1m` 同語意 ⇒ CSS 只要把 `q0..q7` 換成 `q8..q15` 的色值（`css/color.css`
  的 `.cursorBrighten`）。**不可以用 `font-weight`**（等寬格線會整列位移）。
- 已經是 `q8..q15` 的字沒有更亮的一階可去（原始碼是再疊 `FTATTR_BLINK`），本專案改用
  整列 `text-shadow` 微發光，不採用閃爍。
- 游標**符號**（`>` / `●`）是 PTT 帳號端設定，client 不偽造 server 沒送的字元。

## 12. 版本與未知

- 以 §0 的 `build_origin`（`c1ff72df`）讀碼；PTT 實跑的是私有 commit `50372909`，差異不可見。`#ifdef`（COLORIZED_SAFEDEL、COLORDATE 等）影響著色不影響行列結構。
- unknown：ws.ptt.cc 的 WS proxy 是否保留 server write 邊界（proxy 不在本 repo）。
- unknown：私有 commit 與 upstream 的實際差異。已知線索一則——水球第二段顏色（§9）推得線上應為 `ANSI_COLOR(1;37;45)`，upstream 字面是 `ANSI_COLOR(37;45)`；推文列 `:` 與內容間的一格空白同樣是 upstream 字面（`":%-*s"`）沒有、實錄有 ⇒ client 兩種都收。
- 大字型 term（rows≠24）：`p_lines`/`b_lines` 相對式全部成立，但 client 端規則需寫成 rows-relative；未實測。

## 13. pmore 分頁不變量（文章好讀模式的確定性依據，2026-08 全部 CONFIRMED @ efc21a30）

用途：把「文章好讀模式」的翻頁／累積從逐幀啟發式（內容比對＋比對率 guard＋sticky 旗標）
換成 request/response 交易。client 對應 `src/js/easy_reading.js`、`term_view.accumulatePageLines`、
`comment_parse.classifyPageTransition`；守護見該段末的測試清單。

| # | 不變量 | 出處 |
|---|---|---|
| P1 | PageDown ＝ `mf_forward(mf.dispedlines - 1)` ⇒ **下一頁 `S' == 上一頁 E`**；末頁被 `maxdisps` 夾住則 `S' < E`。**`S' > E` 在單次 PageDown 下不可能** | `pmore.c#PMORE_UINAV_FORWARDPAGE`(2234)、`mf_forward`(1026)、`mf_determinemaxdisps` |
| P2 | footer part2 的 `第 S~E 行` 是**檔案行號**；`dispedlines` 只在 `!wrapping && dispe < end` 遞增 ⇒ 不含 wrap 續列、不含 EOF 後空列 ⇒ **顯示列數 ≥ (E-S+1)** | `mf_display`(1476)、`mf_display_footer` |
| P3 | `progress = (dispe-start)*100/len` 且 `len == end-start`（`mf_postattach`）⇒ **`progress==100` ⟺ `mf_viewedAll()`（整數除法剛好等價）**；已 viewedAll 時 PageDown 直接 `return`，**PTT 零回應** | `mf_display_footer`(2046)、`mf_viewedAll`(1081)、`PMORE_UINAV_FORWARDPAGE`(2245) |
| P4 | client 尚有按鍵在途 → `refresh()` 直接 return **不畫** ⇒ **兩個 PageDown 同時在途＝中間那頁的畫面永遠不會送出來（內容永久掉）** | `pfterm.c#refresh`(798)；§2 |
| P5 | footer part3 **會整段不印**，兩層來源：`mf_display_footer` 印完 part2 後 `if (avail <= 0) return;`（連 footer_handler 都不呼叫）；`common_pmore_footer_handler` 最後 `else while (width-- > w) outc(' ');`（連 VERYSHORT 都塞不下）。觸發條件＝part1+part2 太寬（多位數頁碼／六位數行號／xpos 的「顯示範圍」分支） | `pmore.c#mf_display_footer`、`more.c`(461) |
| P6 | 每次回應結尾游標 park 在 `(rows-1, cols-1)`；footer 是 **per-cell patch**（實錄 `ESC[24;11H3 ESC[24;37H44~66 ESC[24;80H`）⇒ **半畫幀的 footer 是上一頁的舊值**，游標也還沒 park | `pfterm.c#fterm_rawcursor`(2144)、`tests/e2e/cassettes/stock-end.json` step2 |
| P7 | **goto-line 是確定性的絕對定位**：`:` → `pageMode = (ch != ':') == 0` → `getdata_buf(b_lines-1, 0, PMORE_MSG_GOTO_LINE「跳至第幾行: 」, buf, 8, DOECHO)` → `i = atoi(buf)` → `if (i-- > 0) mf_goto(i)` → `mf.disps = mf.start; mf.lineno = 0; mf_forward(N-1)` ⇒ 送 `:N\r` 後 **footer 的 `S` 恰為 N**（超過末頁被 `maxdisps` 夾住只會更小）。`;` 與 `1`-`9` 走**頁**模式。輸入緩衝 **8 bytes**。prompt 期間底部列是 `跳至第幾行: `，**不匹配 footer 格式** | `pmore.c` goto 區塊（`case '1'..'9'/';'/':'`）、`mf_goto`(1067)、`PMORE_MSG_GOTO_LINE`(147) |
| P8 | **畫面沒變就零 bytes**：`refresh` 走 `doupdate` 逐 cell diff，結尾 `fterm_rawcursor` → `fterm_rawmove_opt`（已在該位置則不輸出）⇒ **已在第 1 行時再送 Home（`mf_goTop`）可能完全沒有回應**。任何以 Home 當 request/response 交易的路徑都要先確認 `S > 1` | `pfterm.c#doupdate`／`fterm_rawmove_opt`、`mf_goTop`(1046) |

client 端推論（改這段 code 前先讀）：

1. **翻頁＝單一 in-flight 交易**（P4）。ack ＝頁面簽章（`S~E`）改變；在看到新簽章前一律不得再送。
   快路徑（`_onViewUpdated`）與 settle 路徑（`_onScreenSettled`）**必須共用同一個 gate**
   （`nextPageDownDecision`）。舊版只有 settle 有去重，快路徑記下簽章卻不檢查 → 同頁重複送 → 掉頁。
2. **累積只在完整回應幀**（P6）：`cur_y === rows-1 && cur_x === cols-1`。半畫幀只重畫不累積，
   否則舊 footer 的行號會寫進 `_accEndRow`，之後整條去重都建在錯的基準上。
3. **到底判定用 `pagePercent === 100`**（P3），不是 footer 首格顏色——per-cell dirty 更新下，
   單一格的顏色比讀百分比脆弱（顏色僅留作 fallback）。
4. **掉頁可判定**（P1）：`statusStart > accEndRow + 1` ⇒ 中間整頁沒收到。自癒優先用
   **goto-line 精準跳回**（P7）：送 `:` + `_accEndRow` + `\r`，落地幀的 `S == accEndRow`
   ＝ P1 正常翻頁的形狀，走既有 continuation/append 路徑、已累積的內容一列都不用丟。
   Home 從頭重讀降為最後手段（超長文重讀整篇就是使用者回報的「讀到一半跳回第一頁」）。
   **goto prompt 期間底部列不匹配 footer**（P7）⇒ 那一幀的 `pageState` 可能不是 3，而
   `term_view.redraw` 每幀都寫 `prevPageState` ⇒ 落地幀會命中 `prevPageState !== 3 → rebuild`
   **從中段重建累積頁**。必須用 `buf.easyReadingHealInFlight` 顯式封住 rebuild 與 settle teardown。
4b. **retry 的時間基準是「自己送鍵後多久」，不是「畫面靜止」**（P4 的另一面）：settle 計時器
   由**送鍵之前**抵達的畫面 arm，長文 render 慢時 callback 會落到送鍵之後 ⇒ 誤判掉包 →
   補送 → P4 → 真的掉一頁。而且 `_armSettleTimer` 只由伺服器活動 re-arm ⇒ 真掉鍵時**不會再有
   settle**，所以 grace 必須配一個 client 自己的 watchdog，不能只靠 settle。
5. **parser 不可要求 part3**（P5）。
6. **強制重繪一律走 `term_buf.notify()`**，不可直接 `view.redraw()`：`updateCharAttr()` 只在
   notify 裡跑，它是 Big5 lead byte 標上 `isLeadByte` 的地方。settle 可能落在「bytes 已到、
   30ms notify 計時器還沒跑」之間，此時直接 redraw 會把未轉碼的列 clone 進 `pageLines`，
   `rowToText` 得到原始 Big5（`¡°` 而非 `※`）→ 下一頁比對不上 → 重疊算成 0 → 重疊列被貼兩次。

守護：`tests/unit/string_util.test.js`（P5 的三種無 part3 形狀）、`comment_parse.test.js`
（`classifyPageTransition` 四種轉移、`decideAccumulateBranch` 的 complete/gap）、
`easy_reading_logic.test.js`（`nextPageDownDecision` 的 grace 決策表、watchdog、快路徑去重、
goto 自癒與有界升級、補畫走 notify）、
`replay_fixture.test.jsx`（實錄素材的 P1/P2 不變量）、
`tests/e2e/offline/easy-reading.offline.spec.js`（`dropSteps` 模擬 P4 吞頁 → `answerGoto` 驗
精準自癒且不重建累積頁；`splitFrames` 模擬 P6 半畫幀 → 內容完整、每頁只送一次 PageDown；
`ezsoft-longpost.json` 150 頁長文連續累積＋每頁成本不隨長度成長的曲線斷言）。
