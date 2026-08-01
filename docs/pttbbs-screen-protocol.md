# pttbbs 畫面更新協定（server 端不變量）

來源：`3rd_script/pttbbs`（官方 github.com/ptt/pttbbs，checkout `c1ff72df` 2026-06-28）＝ term.ptt.cc 行為最佳近似。
用途：client 畫面偵測以**確定性規則**取代 timing heuristic。本檔全部 CONFIRMED（讀碼驗證；標 ✚ 者另經 `tests/e2e/cassettes/cchat-list.json` 實錄交叉驗證）；unknown 另標。行號隨 upstream 演進會漂，函式名為準。

**研究方法規範（強制）**：PTT 行為邏輯**一律先讀 `3rd_script/pttbbs` 原始碼**找出真實實作，**禁止**自行猜測或從錄製素材/畫面觀察反推規則——素材只用來**驗證**對 code 的理解是否有誤。反例教訓：last-read 高亮曾從實錄反推成「作者亮白＋標題紅的單列游標」模型，連修三版仍殘紅；讀 `readdoent` 十分鐘即知是 title-match 多列高亮＋作者亮白其實是 isonline（見 §10）。

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

- 游標欄：`STR_CURSOR ">"` / `STR_CURSOR2 "●"`（`include/common.h`）。全形 `●` 蓋 cols 0-1＝序號的前導空格＋最高位（client 已知坑：截斷序號）。
- 刪除文 `iscorpse = (owner[0]=='-' && owner[1]==0)` ⇒ 作者欄是單一 `-`。
- client 對應常數：`comment_parse.js` 的 `LIST_AUTHOR_COL_START=17` / `LIST_AUTHOR_COL_END=29`（owner 內容 end-exclusive）／`LIST_TITLE_COL_START=30`（mark 起點）。**兩者差一格 padding，別混用**。
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

## 6. `\f`（Ctrl+L）確定性交易依據（v5 新增，全部 CONFIRMED）

- **igetch 全域熱鍵**：`Ctrl('L')` → `redrawwin()+refresh()` 後 `continue`（`mbbsd/io.c` igetch switch）——`\f` 永不回傳給呼叫者，等同「插入一幀全幅重繪」。`vkey()`＝`igetch()`（io.c `vkey`），故**所有走 vkey 的輸入點都吃這條**。
- **getdata/vget 中途誤送安全**：`getdata` → `vgets` → `vgetstring`（`mbbsd/stuff.c:372`→`mbbsd/vtuikit.c:1154`）主迴圈 `c = vkey()` → `\f` 在 igetch 層就被攔掉，不進輸入 buffer、不炸，且照樣觸發全幅重繪（游標 park 回輸入點）。即使未被攔，content filter `c < ' '` 也只 `bell(); continue`。
- **pmore 內安全**：pmore 主迴圈 `ch = vkey()`（`mbbsd/pmore.c:2537`）→ 同樣被 igetch 攔截全幅重繪。開文/退文交易尾附 `\f` 可行。
- **read.c 列表層再保險**：`i_read_key` 自己也有 `case Ctrl('L'): redrawwin()+refresh()`（`mbbsd/read.c:735`）。
- typeahead 交互（BePTT 實證＋§2 推論）：`指令+\f` 同送 → 中間增量重繪被跳繪吞 → client 恰見一幀全幅畫面。單獨 `\f`＝零副作用「我在哪」探針。
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

- 進入：`/` → `select_read(locmem, RS_KEYWORD)`（`mbbsd/read.c:776`）→ `getdata(b_lines, 0, "搜尋標題: ", …, DOECHO)`（Enter 收尾；空字串→`READ_REDRAW` 回原列表）→ 命中 count>0：`currmode |= MODE_SELECT` ＋ `NEWDIRECT`（全幅重建搜尋清單，序號空間獨立、無置底，見 §3）；count==0：`READ_REDRAW`（回原列表全幅重繪，底列 vmsg 類訊息）。
- 已在 MODE_SELECT 再 `/`＝「增加條件」疊加篩選。
- **退出：`q`／`e`／`←`**（`read.c:712-725`）→ `board_select()` 回主 directory ＋ `NEWDIRECT` 全幅重建主列表；**top=crs-p_lines+1（游標在視窗底列）**。
- **退出落點 = 帳號已讀進度，非進 select 前位置**（live CONFIRMED 2026-07-06，C_Chat 三次重測落點恆定於同一舊序號）：`crs_ln=refer` 的 refer 解析回主列表時採該板閱讀進度。⇒ client 不得假設退回畫面含進板時取樣的最新序號（re-seed 後 fill 只向上，buffer 可能整段低於進板頁）；測試判準用「序號回到主空間（> select 清單 max）」。
- **select 清單 row0 指紋**：板名前綴由「看板」變「**系列**《板名》」（live CONFIRMED）——可做輔助指紋，但主要區分仍靠 client 自身交易狀態。

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
| `parseStatusRow` | `pmore.c#mf_display_footer` ＋ `more.c#common_pmore_footer_handler` | part1 `"  瀏覽 第 %1d[/%1d] 頁 (%3d%%) "`（頁碼**無位數上限**，實錄已見 540/540）；part2 `" 目前顯示: 第 %02d~%02d 行"`／**`" 顯示範圍: %d~%d 欄位, %02d~%02d 行"`（`mf.xpos>0` 左右捲動）**；part3 五種變體（含 RMAIL 的 `(y)回信`）。`bpref.oldstatusbar` 的 `"  瀏覽 P.%d(%d%%)  "` 目前**不支援**（非預設） |
| `parseListRow` | `menu.c#show_status` | `"[%d/%d 星期XX %d:%02d]"` ＋ `"%-14s"`（today_is，**緊接 `]` 無空格**）＋ `" 線上%d人, 我是%s"` ＋ `"\t[呼叫器]%s "`；呼叫器狀態 5 種＝`var.c#str_pager_modes`：關閉／打開／拔掉／防水／好友 |
| `parseWaterball` | `mbbsd.c#show_call_in` | 見 §9 |
| `parseReplyText` | `bbs.c#reply_post`（三種互斥分支）＋`more.c`／`edit.c` | `▲ 回應至 (F)看板 (M)作者信箱 (B)二者皆是 (Q)取消？[F] `／**`▲ 回應至 (F)看板 (Q)取消？[F] `（無寄信權限）**／`▲ 無法回應至看板。 改回應至 (M)作者信箱 (Q)取消？[Q] `／`把這篇文章收入到暫存檔？[y/N] `／`請選擇暫存檔 (0-9)[0]: ` |
| `parsePushInitText` | `bbs.c#recommend`／`angel.c` | `您覺得這篇文章 `；`FormatCommentString` 的輸入 prompt「→ id:」**無行尾時間戳** |
| `parseReqNotMetText` | `bbs.c` `vmsgf("未達看板發文限制: %s")`＋`vtuikit.c#vshowmsg` | vmsg 前綴 `VMSG_MSG_PREFIX " ◆ "`；右側浮動 `VMSG_MSG_FLOAT " [按任意鍵繼續]"` |
| `comment_parse.COMMENT_RE` | `comments.c#FormatCommentString`＋`common/bbs/names.c#is_validuserid` | `<attr><推/噓/→><空格>ESC[33m<id>ESC[m:<msg 補到 maxlength>ESC[m<tail>`；id 長度 **2..IDLEN(12)**、首 isalpha 其餘 isalnum；`BRD_ALIGNEDCMT` 時 id 以 `%-*s` 補到 12 寬（故 `:` 前可有空格）；tail＝`[%15s ]MM/DD HH:MM`（`Cdate_mdHM` ＝ `"%m/%d %H:%M"`，IP 僅 `BRD_IPLOGRECMD`／guest） |
| `comment_parse` 列表欄位 | `bbs.c#readdoent` | 見 §3 欄位表 |
| `auto_login` | `mbbsd.c` 登入迴圈＋`include/common.h` | prompt `請輸入代號，或以 guest 參觀，或以 new 註冊: `(DOECHO)／`MSG_PASSWD "請輸入您的密碼: "`(NOECHO)／`您想刪除其他重複登入的連線嗎？[Y/n] `(LCECHO)／`您要刪除以上錯誤嘗試的記錄嗎? [Y/n] `(`vans`→`vgets`，**都要 `\r`**)。失敗出口＝`ERR_PASSWD "密碼不對喔！…"`、`ERR_UID "這裡沒有這個人啦！"`（`is_validuserid` 失敗，**不會再問密碼**）、`抱歉，此帳號已設定為只能使用安全連線(如ssh)登入。` |
| `easy_reading.reachedPageEnd` | `pmore.c` FOOTER1 配色 | VIEWALL `ANSI_COLOR(37;44)`＝fg7/bg4（＝看完）；VIEWNONE `33;45`；一般 `34;46` |
| `term_buf.isTextWrappedRow` | `pmore.c` `MFDISP_WRAP_INDICATOR ANSI_COLOR(0;1;37) "\\"` | 80 欄下 `maxcol = 77`（`dispw = DBCS_HEADERWIDTH(79) = 78`）⇒ indicator 落在 **col 78**（ASCII 斷行）或 **col 77**（DBCS 跨界被回退擦掉 lead byte）；顏色 fg7/bright/bg0。TRUNC 用 `>`、WNAV 用 `<`，不可混 |
| `term_buf.setPageState` | `vtuikit.h`／`edit.c`／`angel.c` | `VMSG_PAUSE " 請按任意鍵繼續 "`；`請按 空白鍵 繼續`＝`angel.c` 的新手提示；編輯器底列＝`vs_footer(" 編輯文章 ", " (^Z/F1)說明 (^P/^G)插入符號/範本 (^X/^Q)離開\t…")`（「編輯文章」後**兩個空格**） |
| `term_keyboard` | `common/sys/vtkbd.c`＋`include/vtkbd.h` | `ESC[A/B/C/D`→`KEY_UP+(c-'A')`；`ESC[1~`→HOME、`ESC[2~`→INS、`ESC[3~/4~/5~/6~`→`KEY_DEL+(c-'3')`＝DEL/END/PGUP/PGDN（`vtkbd.h` 註明 "must follow vt220 ordering"）。全部對上 |
| `aid_parse` | `mbbsd/aids.c#aidu2aidc` | 字母表 `0-9A-Za-z-_`（64 字），產出**恆 8 字**；反向 `aidc2aidu` 不限長度但畫面上只會出現產生端形式 |
| `symbol_table.js` | — | **不適用**：是 client 端 Unicode→顯示寬度分類表（1/2＝強制全形、3＝壞 DBCS），與 server 邏輯無關 |

## 12. 版本與未知

- 以 §0 的 `build_origin`（`c1ff72df`）讀碼；PTT 實跑的是私有 commit `50372909`，差異不可見。`#ifdef`（COLORIZED_SAFEDEL、COLORDATE 等）影響著色不影響行列結構。
- unknown：ws.ptt.cc 的 WS proxy 是否保留 server write 邊界（proxy 不在本 repo）。
- unknown：私有 commit 與 upstream 的實際差異。已知線索一則——水球第二段顏色（§9）推得線上應為 `ANSI_COLOR(1;37;45)`，upstream 字面是 `ANSI_COLOR(37;45)`；推文列 `:` 與內容間的一格空白同樣是 upstream 字面（`":%-*s"`）沒有、實錄有 ⇒ client 兩種都收。
- 大字型 term（rows≠24）：`p_lines`/`b_lines` 相對式全部成立，但 client 端規則需寫成 rows-relative；未實測。
