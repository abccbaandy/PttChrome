# 看板列表平滑捲動（`choose_board` 的好讀捲動）

pref `enableBoardListSmoothScroll`（預設 `false`）。實作 `src/js/board_list_session.js`
＋純解析層 `src/js/board_list_parse.js`；渲染借 `src/render/screen.js` 的 `.listBodyView`
視口（與文章列表好讀同一套）。**動這三個檔或 `term_view` 的看板列表分支前先讀本文。**

先備知識：`docs/easy-reading-list.md`（文章列表好讀 v5 合約、捲動模型）、
`docs/pttbbs-screen-protocol.md`（§2 typeahead／§6 `\f` 交易）、`docs/mouse.md`。

---

## 1. 範圍（CONFIRMED，由 footer 指紋決定）

`show_brdlist` 的三種畫面在 **footer 文案**上完全可分辨（`board.c:1279-1290` 的三元式，
輸入是 `yank_flag`/`class_bid`）。這就是判準，不必另外推測。

| 畫面 | 進入方式 | footer 片段（指紋） | engage？ |
|---|---|---|---|
| 我的最愛（含子目錄） | 主功能表 `F` → `class_bid=0` + `LIST_FAV()` | `(a)增加看板` | ✅ `fav` |
| 分類看板子分類 | 【分類看板】選一類 → `class_bid>1` | `(m)加入/移出最愛` ＋ `(s)進入已知板名` | ✅ `class` |
| 全部看板／熱門看板 | 最愛按 `y`／`TopBoards()` | `(m)加入/移出最愛` ＋ `(y)只列最愛` | ❌ `all`（上萬列，evict 體感未驗） |
| 「新文章」模式 | 任一看板列表按 `c` | 同上三者之一 | ❌ `newflag` |
| 分類看板**根** | 主功能表 `C`（`class_bid==1`） | 無 footer（不走 `clsflag` 分支） | ❌ 指紋不命中（row0 是【分類看板】） |

判序（`classifyBoardListScreen`）：row0 以 `【看板列表】` 開頭 **且** footer 含「選擇看板」
為前提 → row2 是「編號」還是「總數」（`board.c:1338`，畫面自己就分得出 newflag，
不必攔 `c` 鍵）→ footer 變體（**`(y)只列最愛` 要先於 `(m)加入/移出最愛` 判**，兩者
都以 `(m)` 開頭）→ 游標停在 body 且該列有編號。

⚠ **guest 沒有我的最愛**：`choose_board` 開頭 `if (!cuser.userlevel) LIST_BRD();`
（`board.c:1665`）⇒ guest 按 `F` 落到「全部看板」。offline cassette 只能錄分類子分類。

---

## 2. PTT 端事實（讀 `3rd_script/pttbbs` 確認，CONFIRMED，勿再猜）

讀碼備忘：該 repo 是 **Big5**，`grep` 要加 `-a`，搜中文先 `iconv -f UTF-8 -t BIG5`，
讀片段 `| iconv -c -f BIG5 -t UTF-8`。

| 事實 | 出處 |
|---|---|
| 版型：`showtitle` row0 → 熱鍵列 row1 → `vbarf` 欄位列 row2 → body row 3..22（`myrow=2; while (++myrow < b_lines)`，b_lines=23、p_lines=20）→ `vs_footer` 在 row 23 | `board.c:1306-1364`、`var.c:297-299` |
| **分頁對齊**：`head = (num / p_lines) * p_lines` ⇒ 頁永遠是 `[0,20) [20,40) …`，**跨頁零重疊** | `board.c:1710-1716` |
| 序號欄 `prints("%7d", head)`（head 已 ++）⇒ **編號＝1-based 絕對位置**，可直接當 merge key／跳號目標 | `board.c:1374,1390,1427,1462` |
| 游標＝`cursor_key(3 + num - head, 0)` → 半形 `>` 後 move 回同格。`%7d` 右對齊 ⇒ `>` 只蓋前置空白，**永遠不蓋數字** | `board.c:1717-1720`、`stuff.c:214-251` |
| `search_num` 把 `clen > max` 夾到 `max`（＝brdnum），之後 `brdlist_foot()` **重畫 footer** ⇒ 跳號落地幀是完整的看板列表（與 read.c 不同，那邊底列會留空） | `stuff.c:189-208`、`board.c:1843-1845` |
| newflag 時 `%7d` 印的是 `B_TOTAL`（文章總數）；群組板／無權限板印 `%7s` 空白 | `board.c:1462-1466`、`1376,1425,1471` |
| 無權限板：`prints("%7d", head)` **緊接** `prints("X%c …")` ⇒ 數字後面沒有空白 | `board.c:1427-1435` |
| `num` 是 **`static int`** ⇒ 游標位置跨進出保留（等同 read.c 的 getkeep 語意） | `board.c:1646` |
| Enter 的三種落點：一般看板 → `Read()`；目錄／群組看板 → 遞迴 `choose_board`（新的編號空間）；**分隔線（`NBRD_LINE`）與無權限板 → switch 直接 break，零回應** | `board.c:1928-2018` |

### 2.1 ⚠ 導覽鍵會 wrap（與 read.c 不同，設計的承重點）

`choose_board` 的 switch 刻意用 fall-through 做 wrap（`board.c:1751-1840`）：

| 鍵 | 行為 |
|---|---|
| `PgUp`/`P`/`b` | `if (num) num -= p_lines;` 否則 **fall through 到 `KEY_END`** ⇒ 第一項按 PgUp 瞬移板尾 |
| `PgDn`/`空白`/`N` | `num == brdnum-1` ? **`num = 0`** : `num += p_lines` ⇒ 最後一項按 PgDn 回捲第 1 頁 |
| `↑`/`p`/`k` | `if (num-- <= 0) num = brdnum-1` |
| `↓`/`n`/`j` | `if (++num < brdnum) break;` 否則 fall through `num = 0` |
| `End`/`$` | `num = brdnum-1`；`Home`/**`0`** | `num = 0` |

**本地游標照 web 慣例夾住，不照抄 wrap**（2026-09-02 使用者拍板）。守護在
`board_list_session.test.js`「本地導覽（游標夾住…）」那組。

---

## 3. 為什麼抓頁**不用** PgUp/PgDn（與文章列表的最大差異）

文章列表好讀的每次 prefetch 是「錨點跳號 → PgUp/PgDn」兩腿。看板列表改成**一腿跳號**：

- 編號＝絕對位置且分頁對齊 ⇒ 跳到 `緩衝邊界 ± 1`，server 自己會把 `head` 對齊到含它的那一頁。
- `search_num` 的夾值讓同一腿順便探邊：**往下跳一號卻停在原地就是板尾**
  （`boardListFetchVerdict`），不必第二腿、也不必處理 §2.1 的 wrap。
- 一次 round-trip（非鏈式時文章列表要兩次）。

代價：跳號腿一律 `fullRepaint`（附 `\f`）——目標與真游標同頁時 PTT 零回應，
而 `term_buf` 只在有活動時起 settle 計時器（協定 §6，同 `list_session` 的每一條跳號腿）。

`_edgeUp` 另有免費來源：`bufferEdgeNum(nums,-1) === 1` ⇒ 目標會是 0，直接判定上緣、零 byte。

---

## 4. 架構

### 4.1 兩個 session、一個旗標、一條佇列

`buf.listRenderMode`（`native`|`buffer`|`frozen`）**共用**——它已是十幾個消費端的分岔點
（滑鼠座標換算、左鍵、滾輪、游標高亮、`term_buf.onMouse_move`…），開第二個旗標＝每個
消費端寫兩次判斷。兩種畫面互斥，共用安全。

但兩個 session 都掛在 `screenSettled` 上，**同一幀**可能一邊 engage、另一邊收攤
（進板：ListSession engage、BoardListSession 收攤；離板：反過來）。故加兩層所有權，
都在 `src/js/list_render_owner.js`：

| 層 | 欄位／函式 | 規則 |
|---|---|---|
| 畫面 | `buf.listRenderOwner` ＋ `defineOwnedRenderMode` | 寫 buffer/frozen ＝宣告所有權；寫 native ＝**只釋放自己持有的**；讀 ＝別人持有時回 `'native'` |
| 佇列 | 命令 kind 的 `BRD_CMD_PREFIX`（`'brd-'`） | 各自的 settle handler 只在 in-flight 是自己的命令時才 `queue.onSettle`（兩邊的 facts 形狀不同，判錯是靜默的） |
| 收攤 | `queue.flushKind('brd-')` | **不得**用 `flush()`：整條 flush 會殺掉對方剛排進去的 prefetch |

⇒ **兩個 listener 誰先跑都得到同一個結果**。守護 `tests/unit/list_render_owner.test.js`、
`command_queue.test.js` 的 flushKind 那組。

`App.activeListSession()`（`pttchrome.jsx`）是「現在誰在畫列表」的**唯一真相源**，
七個分派點（鍵盤／貼上／IME／功能鍵／左鍵／滾輪／捲動事件／render 分支）一律走它；
`term_view` 這一側收斂在模組層純函式 `listOwnerOf(core)`。

**建構順序有意義**：`boardListSession` 排在 `listSession` **之後**（`pttchrome.jsx`），
於是「進板」那一幀 ListSession 先 engage、我們後收攤，收攤的 `flushKind` 才不會撞到它。

### 4.2 緩衝與渲染

| 項目 | 位置 |
|---|---|
| 緩衝 | `buf.brdListLines` / `buf.brdListLineNums`（**獨立**於 `listLines`，否則兩邊 cleanup 互踩） |
| 累積 | `term_view.accumulateBoardListLines`（`_brdNumMap`，編號當 key、整列覆蓋） |
| 視窗 | `term_view.buildBoardListWindowLines`（header 3 ＋ 整段序列 ＋ footer） |
| 序列 | ＝整份緩衝（無黑名單過濾、無置底門控）⇒ 位置就是索引 |
| 上限／連續段 | 共用 `evictListBuffer` / `pruneListToSegment`（key 換成看板編號） |
| 捲動數學 | 共用 `js/list_scroll.js`（`topPosFromScrollTop`/`anchorScrollTop`/`revealScrollTop`/`revealPlan`…） |
| 渲染輸出 | 共用 `_listWindowLines` / `_listCursorRow`（`clientToPos`／游標底色／複製選取都讀它） |

**enhance 的 `pageState` pin 成 1（MENU）且不帶 `listEasyReading`／`inListContext`**：
`computeAnnotations` 的 `PAGE_LIST` 分支會對每一列跑 `parseListAuthor` ＋黑名單比對，
而看板列的「作者欄」（cols 17-28）落在板名尾巴＋類別上，誤命中就**整個看板消失**。
pin 1 只跑 `applyFunctionKeys`，而 `functionKeyRows(1,n) === functionKeyRows(2,n)`
⇒ 功能鍵按鈕零損失。滑鼠的欄位規則讀的是 `buf.pageState`（在看板列表仍是 2），不受影響。
守護 `tests/unit/board_list_render.test.js`（含「誤用 pageState 2 就會整列隱藏」的對照組）。

### 4.3 狀態機（`transitionBoardListSession`，純 reducer）

`idle` → `active` ⇄ `functionMode`；`active` → `opening`。（**沒有 `suspended`**：
離開看板列表就收攤，不跨畫面保留緩衝。）

| 狀態 | 事件 | 結果 |
|---|---|---|
| idle | settle `brdlist` ＋ engageEligible | active：`seed` + `start-fill` |
| active | settle `brdlist` 同變體 | `continue-fill` |
| active | settle `brdlist` 換變體 | `rebuild`（編號空間換了） |
| active | settle `article-list` / `menu` | idle：`cleanup` |
| active | settle 其他（含 `brdlist-other`） | 交易在飛／剛被消費 → stay；否則 functionMode：`enter-native`＋banner |
| active | key nav / open / leave / passthrough | move-selection / opening+begin-open / opening+begin-leave / functionMode |
| functionMode | settle `article-list` / `menu` | idle：`cleanup`（黏性原生只有情境變換才放開） |
| functionMode | 其他 settle | stay（繼續鏡像） |
| opening | 任何 settle | stay（落地由 queue 的 expect 判） |
| 任何 | `pref-off` | idle：`cleanup` |

#### 背景填充要**雙向**（2026-09-03 live 實測）

`choose_board` 的 `num` 是 static ⇒ PTT 記得上次離開的位置，**進來常常直接落在最後一頁**。
只往下填的話那一腿一次就撞到板尾（`search_num` 夾值），背景填充就此結束 —— 實測
`buffered=4`、視口 20 列、上面整份清單要等使用者自己按 ↑ 才補得回來。
`_maybeFill` 因此是「先往下、下面到邊了再往上」，而且**視口還沒填滿時無條件補**
（那不是預抓，是這一頁本身畫不滿）；`_enqueueFetch` 判到 edge 之後也要再叫一次
`_maybeFill` 才換得了方向。回歸守護在 `board_list_session.test.js`。

### 4.4 交易

| 交易 | 序列 | expect |
|---|---|---|
| 抓頁 `brd-fetch-up/down` | `<base±1>\r` ＋ `\f` | 停在 body 且有編號 → `boardListFetchVerdict` 判 edge |
| End `brd-jump-end` | `99999999\r` ＋ `\f` | 同上（search_num 夾到 brdnum ⇒ 順便確認板尾） |
| Home `brd-jump-home` | `1\r` ＋ `\f` | cursorNum === 1 |
| 跳號 `brd-jump-number` | `<n>\r` ＋ `\f` | 停在 body → `rebuild`（落點可能離緩衝很遠） |
| 游標同步 `brd-*-sync-jump` | `<sel>\r` ＋ `\f` | cursorNum === sel |
| 進看板 `brd-open-board` | `\r` | **任何 settle**；onDone → `_reset()` |
| 回上層 `brd-leave` | `\x1b[D` | 同上 |
| passthrough `brd-native-key/paste/input` | 原鍵／Big5 bytes | 同上（畫面已是原生鏡像） |

「進看板／回上層一律 `expect: () => true` + onDone 收攤」是刻意的：落點有三種
（文章列表／另一份看板列表／主功能表·分類根），在 expect 裡窮舉遠比「收攤後讓
**同一個 settle** 的 reducer 依內容重新決定」脆弱。收攤後 state 回 `idle`，
`_settleEvent` 讀到的 `inFlightKind` 已是 null ⇒ 是看板列表就當場重新 seed，
是文章列表就由 ListSession 接手（它的 handler 在同一輪已經跑過）。

### 4.5 鍵盤白名單（枚舉即合約）

同義鍵照 `board.c:1751-1840`，**與 read.c 有兩處不同**：PgUp 多一個 `b`、`0` 是 Home；
離開只有 `←`/`q`（**沒有 `e`**）。開是 `Enter`/`→`/`r`/`l`。`1-9` 走本地浮層收集跳號。
Ctrl 組合與其餘一切 → passthrough（切原生鏡像＋代送，黏性）。
送不出 byte 的鍵（F1/CapsLock…）→ `ignore`，判準是 `keyEventToBytes(e) == null` 本身。

---

## 5. 不變量

- **I1 所有權**：畫面／佇列／收攤三層都要 owner-aware（§4.1）。新增分派點一律走
  `App.activeListSession()`，不要自己讀 `buf.listRenderMode` 再猜是誰。
- **I2 單一線上鍵**：共用 `App.commandQueue`，禁止自建；命令一律 `brd-` 前綴。
- **I3 wrap-aware**：本地游標夾住 ≠ 不用管 wrap。**若日後改回用 PgUp/PgDn 抓頁**，
  邊界判定必須重寫（§2.1）：落點朝反方向大幅位移 ⇒ 判 edge 且**丟棄該落點**。
- **I4 newflag**：兩道防線缺一不可 —— 指紋層看 row2 是「編號」還是「總數」；
  `c` 鍵本來就在 passthrough 名單裡（切原生後緩衝作廢）。
- **I5 零回應的 Enter**：分隔線（`NBRD_LINE`）與禁入／隱板列，PTT 一個 byte 都不回
  ⇒ **必須在本地擋掉**（`isBoardListSeparatorRow` / `isBoardListBlockedRow`），
  送出去只會凍畫面到逾時。
- **I6 離開範圍即退回原生**：每個 settle 都重跑指紋，一旦不是 `fav`/`class`
  就切原生鏡像／收攤，**不可沿用舊緩衝繼續畫**（編號空間已換）。
- **I7 golden 快照**：改 `render/screen.js` 或列輸出必跑 `render_dom_equivalence.test.js`。
- **I8 `view.conn`**：送資料一律走 queue／`view._send()`，禁止 `this.view.conn.send(...)`。

---

## 6. 測試

| 層 | 檔 | 蓋什麼 |
|---|---|---|
| unit（純函式） | `tests/unit/board_list_parse.test.js` | 指紋三變體／CLASSROOT・文章列表・主功能表必須不命中／newflag 不 engage／逐列編號（含禁入列數字後接 `X`）／抓頁目標與 edge 判定 |
| unit（session） | `tests/unit/board_list_session.test.js` | reducer 轉移表、鍵盤白名單、游標夾住（三條 wrap 回歸）、抓頁與探邊、Enter 的本地守門、離開、佇列所有權 |
| unit（累積） | `tests/unit/board_list_accumulate.test.js` | 編號 key／整列覆蓋／`>` 要被 `%7d` 蓋回／跨頁零重疊／header・footer 快取不被 prompt 污染／視窗組裝與補列 |
| unit（渲染） | `tests/unit/board_list_render.test.js` | `bodyStart:3`、header・footer 不進視口、**pageState 必須 pin 成 1**（附對照組） |
| unit（所有權） | `tests/unit/list_render_owner.test.js`、`command_queue.test.js` | 兩個 listener 誰先跑結果相同；`flushKind` 只清自己的 |
| live e2e | `tests/e2e/board_list_scroll.spec.js` | 真瀏覽器＋真 PTT：接管、視口建得起來、捲得動（header 不動）、End/Home 真的移動選取、`←` 收攤、`v` 切原生。走共用 session，**零額外登入** |

live spec 的兩條硬規則（踩過才寫的）：
1. 主功能表的字母鍵只是**移動游標**，要 `F` 之後再 `Enter` 才進得去（menu.c 的 hotkey 語意）。
2. 導覽類斷言前一定要等 `commandQueue.idle`：抓頁在飛時 `_requestEnd`/`_requestHome`
   會靜默 early-return，否則測試會在「什麼都沒發生」上綠掉（2026-09-03 實測：
   End 按下去選取沒動，斷言卻過了）。

**offline e2e 尚未錄製**：`RECORD_MODE=brdlist` 只能錄「分類看板子分類」（guest 沒有
我的最愛，§1；而我的最愛是個人偏好清單，不可入 repo）。分類子分類是站台公開內容、
guest 可達，footer 變體與我的最愛只差一句文案 ⇒ 渲染／捲動路徑覆蓋度等價。
細節見 `docs/offline-replay-testing.md`。

---

## 7. 未做（明確的 out of scope）

- 「全部看板」「熱門看板」：上萬列，`MAX_LIST_ROWS=300` 的 evict 體感未驗。
- resume 舊緩衝：目前每次進入重新 seed（`y`/`c`/`/`／進出分類都會換掉整個編號空間）。
  要做的話指紋要能分辨「同一份清單」（footer 變體 ＋ row1 ＋ brdnum 推估）。
- 背景 prefetch 的頁數上限目前寫死 3 頁（`FILL_MAX_PAGES`），與文章列表共用
  `easyReadingListPrefetchCount` 當目標列數。
