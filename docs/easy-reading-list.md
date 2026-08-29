# 文章列表好讀模式 — 架構（v5：封閉互動＋確定性交易）

## 核心原則（最高優先，違反＝方向錯誤）

**v5 合約（2026-07-05 拍板，取代舊 parity 合約；論證見 `docs/easy-reading-list-research.md` §1「困難點本質」／§3「BePTT 的穩定性來自哪」）：**

1. **外觀近似**原生（24 行視窗＋游標 `>`＋鍵盤習慣近似），**不再承諾**「與原生無可感知差異」。
2. **封閉互動**：白名單＝導覽/開文/跳號/離板；**未列鍵＝一鍵切原生 passthrough＋黏性 hold**（可選 sync 腿 → enter-function-mode → queue 代送原鍵；切原生後停在原生，article/menu 情境切換才恢復好讀）。**不做**氣閘（同鍵二連擊）與 `[ ] =`/`v`/`/` 的模擬交易。
3. **確定性交易**：server 互動一律 CommandQueue 交易；高風險交易尾附 `\f`（Ctrl+L，igetch 全域熱鍵→全幅重繪，協定 §2）→ 必得一幀全幅畫面，timeout 降為真異常。
4. 交易期間 render=frozen＋吞鍵＋讀取中指示。
5. **失敗顯性化**：timeout → 單獨 `\f` 探針拿全幅畫面重分類 → 恢復或 banner＋切原生。禁止靜默墜落。

**勿回頭走 parity**（「與原生完全一致、read.c 逐格對齊」）：「測試全綠 ≠ 實測穩」跨 v3/v4 兩代重現，失敗面積在素材之外，屬結構性成本（論證見 research doc §1）。`list_window.js` 視窗數學保留但允許偏離 read.c（web 慣例優先），`list_window.test.js` 只留行為級守護、不做 read.c lockstep。

## 操作分類（枚舉即合約）

| 類 | 操作 | 處置 |
|---|---|---|
| T0 忽略鍵 | `keyEventToBytes(e) == null` 的鍵：CapsLock／F1–F12／NumLock／ScrollLock／不可映射的 Ctrl+Shift 組合 | `_classifyKey` 回 keyClass `ignore` → 吞掉、**不轉態、不 preventDefault**。判準即「這個鍵交給原生鍵盤路徑會不會送出 byte」，不硬列鍵清單 |
| T1 本地 | ↑↓ jk／PgUp PgDn／Home End（buffer 內）／滾輪；read.c 同義鍵 `空白`＝`N`＝PgDn、`P`＝PgUp、`p`＝↑、`n`＝↓、`$`＝End | 零 server。視窗/游標語意＝web 慣例，不 read.c 逐格對齊（同義鍵集合本身照 read.c:858-902，**Ctrl-F/Ctrl-B 不納入**，維持 Ctrl 組合與瀏覽器快捷鍵的分界）。滑鼠 hover＝上游標底色（`term_view.onListMouseMove`，只對有文章的 body 列；**防誤觸模式開啟時只有標題欄 col≥30 給 pointer 並接受點擊，底色也只蓋那一段**，見 `docs/mouse.md`） |
| T2 列表內交易 | 開文（Enter／**左鍵單擊該列**）、數字跳號、End/Home 邊界確認、`←`/q/e 離板 | 腳本交易（CommandQueue 序列化） |
| T3 一鍵切原生 passthrough | `[` `]` `=`、`v`、`/`、Ctrl-P、`z`、`s`……**其餘一切未列鍵** | 單按即生效：有序號選取且 `_serverNum` 未同步→先 `native-sync-jump`（frozen＋吞鍵）→ `enter-function-mode`（原生 excursion，不變量 15 拋 cache）→ raw 代送原鍵（`native-key` 佇列命令，防 sync 落地 settle 提早 resume）＋提示「已切至原生」。Ctrl 組合/不可映射鍵不代送（事件放行原生鍵盤路徑）。**黏性 hold（`_nativeHold`）**：切原生後 clean-list settle 一律 stay（反覆 [ ] 不閃動/不誤觸 banner），只有 article（開文→文章好讀接手→返回 re-seed）或 menu（離板→重進板 engage）才恢復好讀 |
| T3b 貼上 | Shift+Insert／右鍵選單「貼上」／中鍵貼上 | 同 T3，但 payload 是整串：`App.onPasteDone` → `ListSession.onPaste(text)`（回 true＝已接手）→ 需要時 `native-sync-jump` → `enter-function-mode` → `native-paste` 佇列命令送出 `ansiHalfColorConv(u2b(normalizePasteText(...)))`。**PTT 收到後完全原生**：不代按 Enter、不特判 AID（`#` 仍要 Enter 才跳且只移游標不開文，協定 §8.1）；貼上內容自帶換行則照送 Enter。交易在途（opening／frozen）吞掉＋提示 |
| T4 非請自來 | 水球/廣播（server 主動寫入） | 唯一自動切原生路徑：banner 明示（水球專屬措辭）＋停在原生（黏性 hold，article/menu 才恢復好讀） |

pref `enableEasyReadingList`（預設 off）＋`easyReadingListPrefetchCount`（預設 200，0=停背景 fill）
＋`mouseWheelSmoothScroll`（預設 on，滾輪平滑捲動；滑鼠分頁，見 `docs/mouse.md`）。
三原則：**A 內容判定**（settle 只定何時評估；是什麼靠指紋謂詞，`docs/pttbbs-screen-protocol.md` §3-5）、**B 顯式狀態機**（ListSession 單一擁有者）、**C 命令序列化**（CommandQueue 單一 in-flight；typeahead 跳繪 §2）。誤判永遠往 native 降級（catch-all functionMode）。

## 檔案地圖

| 物件 | 位置 |
|---|---|
| 視窗數學（read.c 移植，純函式）：`listCursorPos`/`moveListCursorWindow`/`normalizeListWindow`/`windowVisibleSequence`/`pruneListToSegment`/`labelListCursor`/`LIST_FROM_TOP` | `src/js/list_window.js`（unit：`list_window.test.js`，行為級守護） |
| 純函式層：`classifyListScreen`/`classifyListBurst`/`transitionListSession`/`mergeListPage`/`flattenListBuffer`/`moveListSelection`/`visibleListIndices`/`parseBoardName`/`evictListBuffer`/`bufferEdgeNum` | `src/js/list_session.js` 上半（unit：`list_session.test.js`） |
| class `ListSession(core,view,termBuf,queue)`：狀態機＋視窗錨（`_topNum`/`_selectedNum`）＋demand＋`getWindowView` | 同檔下半；`pttchrome.jsx` App constructor 接線 |
| `CommandQueue`（注入 send/timer/onEvent、soft/hard/probe timeout、`expedite`、flush 靜默） | `src/js/command_queue.js` |
| 序號解析：`parseListArticleNum`/`isPinnedListRow`/`recoverCursorArticleNum`/`pageArticleNums` | `src/js/comment_parse.js` |
| settle snapshot | `src/js/term_buf.js` `_armSettleTimer` |
| render：redraw buffer/frozen 分支＝24 行視窗（`buildListWindowLines`＝header/footer 快取＋`getWindowView` 切片＋`>` 游標裝飾）、`accumulateListLines`（merge→evict→prune→flatten→chrome 快取）、`relabelListCursorRow` | `src/js/term_view.js` |
| 鍵盤 hook（僅 buffer/frozen；native 全直通）；滾輪：`pttchrome.jsx mouse_scroll` buffer 分支 → `ListSession.onWheel` | `term_view.js onKeyDown`／`pttchrome.jsx` |
| 測試 | offline `tests/e2e/offline/easy-reading-list.offline.spec.js`（CI gate）；live `tests/e2e/easy-reading-list.spec.js`（soak＝白名單操作輪播，新增白名單操作時同步補站）；素材 `cchat-list-nav/prompt/pinned/mark/search`（**新 `>` 游標世代**，2026-08 重錄）＋ `cchat-list-*-wide`（**舊 `●` 世代**，只被「雙支援」那一條用；勿刪，它是兩代 parser 的唯一真瀏覽器覆蓋） |

## 視窗模型（render 層，取代舊無限捲動）

- **視口＝(topNum, cursorNum) 兩個序號錨定的 24 行切片**：header 3 列＋body 20 列（`bodyRows = rows-4` = pttbbs p_lines）＋footer 1 列。`mainDisplay.scrollTop=0`、無捲動補償、無 scrollIntoView、無高亮 CSS。
- **render 的次列位移（平滑捲動）**：body 那 20 列住在 `.listBodyView`（`src/render/screen.js#_patchRows`，固定高度＋`overflow:hidden`），它的 `scrollTop` 就是 `_scrollFrac`；header/footer 留在 `#mainContainer` 直系子層（不跟著捲，也不必靠不透明背景去蓋）。停在半列時多畫一列 **overscan**（`getWindowView().overscanAbs`）補滿視口底部，放在 footer **之後**＝渲染 index 24——**footer 的 data-row 必須維持 23**（外部契約）。對齊時（frac=0）DOM 仍是 24 列，與捲動前逐字相同。golden：`tests/unit/fixtures/screen_golden/list_easy_reading_scrolled.html`＋`tests/unit/render_list_scroll.test.js`。
- 導航空間＝**過濾後序列**：`visibleListIndices`（黑名單）→ `windowVisibleSequence`（pinned 門控）。無黑名單時＝原生行空間 → 語意同構。
- 游標＝行首半形 `>`（`labelListCursor`，只蓋 cell 0＝`%7d` 的前導空格，同 server `STR_CURSOR` 畫法；ASCII 免 u2b；**不反白**——原生 lightbar 是 `UF_MENU_LIGHTBAR` 旗標非預設）。**兩代游標**：server 自 pttbbs `b9a5029f` 起畫 `>`（舊為全形 `●`，蓋 cells[0,1] 含序號最高位）——**讀 server 畫面的 parser 必須雙支援**（cassette 是舊素材，協定 §4），我們畫的假游標則一律 `>`。map 內永遠存序號欄正規化過的乾淨列（`relabelListCursorRow` 依 resolved num 重寫 cells[0,7) 為 `%7d`，一併修掉 partial-redraw 留白的高位格），游標只畫在 render-time clone。
- 鍵語意＝read.c 逐條移植（`moveListCursorWindow`）：↑↓ 視窗內只動游標、越界重錨 `top = cursor - fromTop`；PgUp/PgDn `top±B`、**游標停新頁頂**；↑ 在全域第一列 wrap 到最後一列；跳位 `fromTop=10`。
- **邊未確認的大跳走 server**（serverOp）：End→`_requestEnd`（送 `99999999\r`——jump 超過最大序號 server clamp 到 last_line 含置底，**必有回應**；單發 End 在游標已於底端時零回應必 timeout）；Home→`_requestHome`（`1\r`，序號 1 恆存在）。onDone 確認 edge → 本地套 End/Home。
- **pinned 門控**：置底列只在 `_edgeDown`（已確認板尾）時進導航序列（native：置底只存在 last page）→ 舊文區往下讀不會先看到置底文。seed/resume 時畫面含 ★ ⇒ `_edgeDown=true`。
- **缺口 prune**：序號是連續整數，`pruneListToSegment` 在 accumulate（merge→evict 後）只留 pivot 所在連續段，視窗永不跨缺口。pivot＝`session.prunePivot()`：平常＝selection；End jump 在途＝null（留最大段）；Home jump＝1。**far-jump 必設 `_prunePivotOverride`，否則 prune 會把剛抓到的目標頁丟掉**。
- demand：視窗頂/底距 buffer 邊 **< 2×bodyRows（兩頁）** 即補（方向性、chain 不跨來源 fill/key），提早補頁把 round-trip 藏在使用者到邊之前。到邊等待＝視窗 clamp、鍵 no-op＋右下「讀取中…」指示（`view.setListLoading`；prefetch onDone/markEdge 清除）。
- 退文回列表＝**re-seed**（不做逐行 parity 還原）：suspended 的 clean-list settle 走 functionMode 同規則——server 落點權威（READ_REDRAW 重繪的 getkeep top＋游標直接採用，順帶刷新推文數）；落點在緩衝內→resume-buffer 保留 maps，否則（pinned 落點 num=null／板名異）＋rebuild。resume（functionMode 出口）同＝採 native 畫面的 top+cursor。
- 滾輪＝**平滑捲動**（pref `mouseWheelSmoothScroll`，預設 on）：`mouse_scroll` → `wheel_scroll.js#wheelDeltaToPx`（÷scaleY 換內容座標）→ `onWheelScrollPx(px)` → `smooth_scroll.js` 緩動器分幀 → `_stepScroll`。狀態＝**視窗錨（列）＋次列偏移 `_scrollFrac`（px，恆在 [0, chh)）**，位置＝`top*chh + frac`。
  - 每幀兩條路徑：**沒跨列**只寫 body 視口的 scrollTop（不重繪、不重算序列——滾輪每幀都來，`_sequence()` 是 O(緩衝列數)）；**跨列**才 `scrollListWindow` 動視窗 + `_forceRedraw` + `_maybeDemand`。
  - **游標被視窗推著走**（留在視窗內，否則下一幀 `normalizeListWindow` 會以游標為準把視窗重錨回去、吃掉剛捲的距離）。游標停在置底文時往上捲不會把它拉走（選取以內容為身分）——live spec 不可用 `selectedNum` 當「捲了沒」的證據，要看 `topNum`。
  - 底端**貼齊**：`top >= maxTop`（`len-bodyRows`）時 frac 強制 0（`_setWindow` 每幀維護 `_scrollAtTop/_scrollAtBottom`），否則會露出空白。副作用：從板尾（常見的進板落點）往上捲的**第一次**會多吃掉一次對齊距離，這是「最後一列貼齊底部」的必然結果，不是換算不準。
  - 邊旗標未算過（`_scrollEdgesKnown=false`，seed 完還沒 render）⇒ 快路徑不可用，走慢路徑重算。**寧可多算也不能拿舊旗標擋捲動**。
  - 鍵盤導覽／交易／切原生／點擊一律 `_resetScroll()` 回到整列對齊（frozen 快照不該停在半列）。關掉 pref → 退回 `onWheel('pgup'|'pgdn')`＝一次一頁。兩條都是本地執行、零 byte、不轉態；frozen 吞滾輪。2026-08 滑鼠重新設計後**不再看按住哪顆鍵**，也不再有「素滾=↑↓」的映射（舊的三組 pref 已刪，見 `docs/mouse.md`）。
- **滑鼠（2026-08-15）**：座標一律先換成**渲染後**的列號，再經 `LIST_HEADER_ROWS`（=3）換算 body index，用 `getWindowView().body[idx]` 反查絕對索引。
  - hover → `term_view.onListMouseMove`：只有「body 區且該格非 null（非短頁補列）」才上游標底色；`cursor:pointer` 另需 `mouseLeftClick` 且落在可點區（防誤觸開＝標題欄 col≥30，關＝整列，`mouse_regions.clickableColStart`）—— **底色的範圍與可點區相同、條件不同**（底色不看 `mouseLeftClick`），與原生一致。整條路徑受總開關 `useMouseBrowsing` gate；frozen 一律清掉。**不得走 `term_buf.onMouse_move`**（那套的左緣/右緣/isLineEmpty 全依 server 真實 24 列，對虛擬視窗無意義）——`term_buf.onMouse_move` 自身也擋了 buffer/frozen。
  - 左鍵單擊 → `ListSession.onMouseClick(renderRow, col)`（防誤觸開啟時 col 落在標題欄外直接 return）：寫回序號錨（`_selectedNum`／`_selectedPinnedKey`）→ `_forceRedraw`（frozen 快照要帶著新游標，否則畫面凍在點擊前那列）→ 走鍵盤同一條 reducer（`open`／`open-pinned`）＋ `_beginOpen`。**永遠不得放行到 `App.onMouse_click`**：那條依 `buf.mouseAction` 與 server 幾何直送 `\x1b[A`×N+`\r`，座標不對應（開錯文）且繞過 CommandQueue。非 active／frozen 時吞掉＋提示（吞掉不得無聲）。守護：`tests/unit/list_click_open.test.js`、`easy-reading-list.offline.spec.js`「滑鼠單擊…」。
- header/footer 快取：accumulate 時從「像 clean-list 的 live 幀」更新（row0 含《＋row2 含 編號 → header；底列含 文章選讀 → footer）——跳號空底列不會污染 footer 快取。

## 狀態機（reducer＝`transitionListSession`，unit 全枚舉為準）

states：`idle → active ⇄ functionMode`；`active → opening → suspended → active`。
`listRenderMode` 映射：active→buffer、opening→frozen、其餘→native。**例外：passthrough 的 sync 腿與 leave/jump 交易期間 state=functionMode 但 render=frozen**——frozen∧functionMode 時 onKeyDown 吞所有鍵（含淡出提示「指令處理中」——**吞鍵不得無聲**）。

- idle：clean-list ∧ pref ∧ rows==24 ∧ `!buf.startedEasyReading` → active（seed＋start-fill）。engage 守門不用 `view.useEasyReadingMode`（article ER 離篇後仍 latch true）。
- active：clean-list 板名同→continue-fill；異→rebuild；article→suspended；**menu→idle cleanup**（離板可與 in-flight prefetch 的 jump 重繪交錯：jump settle 先把 functionMode 彈回 active，menu settle 若走 catch-all 進 functionMode 會因靜止畫面無下一個 settle 而卡死）；prompt/transient ∧ 無 in-flight→functionMode **＋banner**（失敗顯性化：`isWaterballSettle` 命中（protocol §9 底列 ◆ 指紋）→水球專屬措辭，否則通用「畫面偏離列表」；顯式入口不出 banner——`_enterFunctionMode(facts)` 只在 facts 非 null 時顯示）；有 in-flight→stay。交易 onFail 一律 `_degradeToNative(訊息)`＝banner＋原生鏡像。
- key（active）：nav（↑↓jk/PgUp/PgDn/Home/End → read.c op）；Enter/→＝opening（selectedNum 有值→begin-open；null＝pinned→begin-open-pinned）；數字＝jump-digit（overlay 收參）；`←`/q/e＝leave 交易（**先 sync-jump 同步 server 游標再送離板鍵**——pttbbs getkeep 記 REAL cursor，不 sync 則再進板落點錯；`_serverNum` 快路徑同 passthrough，共用 `_enqueueCursorSyncJump`）；**其餘鍵（含 `[ ] =` `v` `/`）＝keyClass `passthrough` → `_beginNativePassthrough`：一鍵切原生＋代送**（`term_keyboard.keyEventToBytes` 轉 bytes，非 ASCII 單字元 `u2b`）。
- opening：settle 等 article；timeout→functionMode 自癒；期間吞所有鍵。
- functionMode：clean-list→**`nativeHold`（passthrough/自癒/降級 excursion）時 stay 鏡像（黏性）**；無 hold（leave/jump 交易）→active（landedNum∈buffer ∧ 板名同→resume；否則＋rebuild）；article→suspended；menu→idle cleanup。**enter-function-mode（passthrough/自癒/降級——原生 excursion）在 action 層清 `_boardName`** → 回 clean-list 必走 rebuild 分支（不變量 15）；只有保留 `_boardName` 的 frozen 交易（leave/jump）可走純 resume 快路徑；passthrough 屬原生 excursion → 黏性停原生；經 article/menu 回好讀時因 `_boardName` 已清必 rebuild。
- suspended：clean-list→re-seed（resume-buffer；落點不在緩衝/板名異＋rebuild）；menu→idle。
- 任意：pref-off/斷線→cleanup。

## 關鍵不變量（違反即復發）

1. **零內容 settle 不驅動轉移**：`_onScreenSettled` 開頭 `changedRows.size===0 → return`（本地 `_forceRedraw` 也 re-arm settle）。
2. **`_settleChangedRows` 只在 server 寫入點 add**（統一走 `_touchRows`），不可掛 `lineChangeds`。`needUpdate` 已於 2026-08 去 sticky ⇒ `lineChangeds` 現在**是**真的 dirty 集合，但視窗與語意都不對：它由 `term_view.redraw` 清除（一個 settle 視窗可跨多次 redraw），而且本地強制重繪（`lineChangeds.fill(true)`）會餵它，混進去就是 2b 的「按住 nav 鍵永遠不 settle」。
2b. **settle timer 只由 server 活動 re-arm**（`_serverActivity`：`_touchRows`＋游標 escape 的 posChanged；notify 的 changed 分支 gated）。本地 `_forceRedraw` 不得推遲 pending settle——否則按住 nav 鍵（~30ms 一次重繪）永遠不 settle → queue expect 餓死 → prefetch timeout →「按住 PgUp 無效」＋ markEdge 假邊界（置底文顯示異常的來源）。守護：`settle_gating.test.js`。
3. **跳號回應 settle 底列是空的**（classify=transient 永不 clean-list）→ jump 類 expect 用「park 在 entry 區 col≤1 ∧ 游標列=目標序號」。`_requestEnd` 落點可為置底列（cursorRowNum null 也接受）；**prefetch 向下翻頁腿同理**：真板尾 PgDn 游標落置底列（cursorRowNum null ∧ clean-list）＝`{edge, landed:null}`，不可 miss——miss 的 hard timeout 會讓 \f 探針回應變無主 settle → catch-all 誤降級「畫面偏離列表格式」。向上腿 null 仍 false（置底只在板尾）。另有三道放寬，皆為「板尾/完成幀的無主 settle 不得誤降級」：
   - (a) `classifyListScreen` 板尾短頁規則——編號列 <3 時，若游標列本身是列表形（編號/loose/置底/刪除）∧ entry 區每個非空列都是列表形 → 仍 clean-list（板尾最後一頁可能只剩 1 列編號＋置底＋空白；舊 `●` 游標蓋掉最高位時僅 loose 可讀，新 `>` 游標 strict/loose 同值——**loose 仍須 strip `>`**，否則此規則失效、板尾無主 settle 全數誤降級）。
   - (b) prefetch 翻頁腿 expect 第二道防線——facts 非 clean-list 但 park（entry 區 col≤1）∧ cursorRowNum 相對 base 位移確定 → 照收 moved/edge（null 在 transient 幀不得判 edge，等探針幀）。
   - (c) **consumed 標記**——`queue.onSettle` 回傳 `'done'|'miss'|null`，settle event 帶 `consumed`，active 的 prompt/transient catch-all 對 consumed settle 一律 stay（完成當下 inFlightKind 已 post-account 成 null，板尾 edge 探針幀＝jump-park 後底列空的 transient，會被當無主 settle 誤降級 functionMode＋黏性 hold）。miss 也算 consumed（onFail 自己善後，否則 catch-all double-banner）。
   守護：`list_session.test.js`「板尾短頁」×3、「transient 幀但 park 指紋」、「被完成指令消費的 settle」（真 CommandQueue 全鏈）＋reducer 枚舉 consumed case＋`command_queue.test.js` onSettle 回傳三態。
4. demand 只朝移動方向。
5. pinned map key＝`pinnedRowKey`（author|title）；`_pinnedKeyAt` 必須同函式。游標停置底列（有★）仍收錄、游標格還原空白（`blankListCursorMark`，依 `row[0].isLeadByte` 判 1 格（`>`）或 2 格（`●`））；無★游標列排除。**loose-parse guard**：`parseListArticleNumLoose`（**只 strip 游標標記 `●`/`>` ＋空白、不 strip `★`**，之後有行首數字）非 null 的列永不進 pinned map——mid-response 幀（jump 回應寫入中）游標標記可畫在非 cur_y 列，該列 num 無法回推＋作者欄有效會誤檔成置底，標記未還原永久殘留（●52880 污染 bug）。**不得 strip `★`**：★ 之後緊接推文數欄，常為純整數（`★    4 …`、`★   35 …`——無 m/M/=/+ 標記的公告），strip ★ 會露出推文數→pinned 列被誤判成編號列而排除→該公告固定消失（使用者實測「部分置底文固定消失」）；★ 天生屏蔽推文數（`^(\d+)` 不 match 仍以 ★ 開頭的列）。守護：`comment_parse.test.js`（純數字推文數→null）＋`list_accumulate.test.js`（純數字推文數置底列收錄）。
5b. **frozen 讓位 pageState 3**（redraw list 分支條件 `pageState !== 3`）。
5c. **預讀＝錨定命令對或鏈式單腿**：首次＝jump 到 `bufferEdgeNum(方向)` → PgUp/PgDn；同方向連補＝`_chainState={dir,lastLanded}` 跳過 jump 直送翻頁（moved/edge 判準改以 lastLanded 為基準——PgDn 落新頁**頂**、anchor 在新頁**底**，用 anchor 等值判 edge 會誤判）。**鏈失效點必須齊全**（漏一個＝錯位翻頁）：所有 flush 呼叫點、任何非 prefetch enqueue（End/Home/open/passthrough）、無 in-flight 的 server settle（`_onScreenSettled` 在 `queue.onSettle` **前**檢查）、seed/rebuild/resume/cleanup、markEdge、noteEvicted。錨定失敗 onFail flush。回退開關＝`_chainState` 恆 null。offline 門控支援省略的同位置 jump（replay.js「先餵 jump 回應再餵翻頁」分支）。
6. 選取以序號為身分；pinned 選取以標題 key；**視窗頂同理以 `_topNum` 錨定**——prepend/evict 不動視窗（PgUp 不被新文往下擠的機制）。
7. 預讀 timeout＝良性到邊；開文 timeout＝functionMode 自癒；flush 靜默（**flush 不觸發 onFail → `_prunePivotOverride` 要在 flush 出口手動重置**）。timeout 一律只是 **\f 探針觸發器**（`command_queue.js`），非訊號（**勿再引入 RTT 自適應 timeout**）。**交易前導用 `flushPending`（保留 in-flight 配對，序列化排隊）**；全量 `flush` 只准在退原生鏡像路徑（`_enterFunctionMode`/`_handoffArticle`/`_cleanup`）——flush 掉 in-flight 會讓在線回應變無主 settle、提早滿足下一交易的 expect（live race）。prefetch anchor onFail 用 `flushPendingKind('prefetch')`，不誤殺排隊中的交易。
7b. **凍結延遲必須有界**（2026-08「畫面停住、顯示處理中，過一陣子才復原」）。三道，缺一即復發：
   - **`_timedOut` 的探針分支只重新武裝 soft**（`probeTimeoutMs` 預設 2000），**不得 `_armBoth`**——舊碼在探針時重給一份完整 hard ⇒ 單一命令最壞 2×hard（~20s）。hard 是送出當下就定死的絕對截止。上限＝`max(hard, soft+probe)`。
   - **前景交易凍結畫面時要 `queue.expedite(250)` 催 in-flight 的背景 prefetch**（`_expediteBackground`，只對 `kind` 以 `prefetch` 開頭者；`_freezeForTransaction`/`_beginOpen`/`_beginOpenPinned` 三處）。`_freezeForTransaction` 只 `flushPending`（不變量 7 禁止 flush in-flight）⇒ 交易只是排進 pending，畫面卻已 frozen＋吞鍵，得等背景 prefetch 走完整個 soft/hard 預算才送出第一個 byte（連按翻頁後開文／離板必踩）。`expedite` 只縮短 soft → 觸發既有 `\f` 探針（必有回應），**刻意不提前 `_finish`**（提前 finish＝無主 settle，正是不變量 7 的 live race）。
   - **全面快速失敗預算**（2026-08-25）：PTT 正常 RTT 約 90ms＋`SETTLE_MS` 50ms，超過這個量級的沉默就該馬上問一次，而不是坐等秒級 timeout。列表側具名常數（`list_session.js`）：`CMD_PROBE_AFTER_MS=250`（soft＝探針觸發器）、`CMD_PROBE_WINDOW_MS=600`、`CMD_HARD_MS=1200`；背景 prefetch 同樣 250/600 但 `PREFETCH_HARD_MS=1500`。**例外：`native-key`／`native-paste` 維持 `NATIVE_PASSTHROUGH_MS=3000`**——它們不凍畫面（原生鏡像已在畫面上），唯一職責是撐住 functionMode 的 settle 吸收直到自己的回應落地，砍短就是 state churn。舊的「縮 soft 會提高 markEdge 假邊界風險」由不變量 7g 的完整幀守門抵銷。
   守護：`command_queue.test.js`「探針不得重新武裝 hard」「expedite …不提前 finish」＋`list_session.test.js`「背景 prefetch 在線時開文」＋`list_command_budget.test.js`（表格式：每一腿的預算與 \f 契約）。
7c. **frozen 看門狗＝「無進展」計時**（`_armFrozenWatchdog`，`FROZEN_WATCHDOG_MS=2500`，**每完成一腿（`queue.onSettle` 回 `'done'`）就重新武裝**，`_freezeForTransaction`/`_beginOpen`/`_beginOpenPinned` 武裝，只 `_cleanup` 拆）：任何「回呼從未觸發」或「reducer 對該事件無轉移」的路徑都會永久 frozen＝畫面永遠不重繪＋全吞鍵。已知洞：`_openFailed` 的 `open-timeout` 只有 `opening` 有轉移，其他狀態 `return stay` ⇒ actions 空。到期若仍 frozen／opening → `_degradeToNative('指令逾時…')`。不在 frozen 時＝no-op ⇒ 不需在每個解凍點清除。**改成「有進展就重算」是把 12s 砍到 2.5s 的前提**：`_beginOpenPinned` 一次交易可能排十幾腿（每列一個 `open-pinned-step`），固定絕對上限會誤殺合法的多腿開文。
7d. **「讀取中…」膠囊的擁有權**：`_moveSelection` 在到邊且 queue 非 idle 時 `_setLoading(true)`，**其 serverOp 出口 `_requestEnd`/`_requestHome` 的 onDone 與 onFail 都必須 `_setLoading(false)`**——onDone 會設 `_edgeUp/_edgeDown`，之後不再重新評估該分支 ⇒ 膠囊永久卡在右下角直到開文／切原生／離板。↑ 在 buffer 頂端的 wrap 語意就會送 `jump-end`，極易踩到。
7e. **共用 queue 的 `flush()` 靜默會洩漏別人的旗標**：`CommandQueue` 由 ListSession 與 `AidNavigation` 共用，list 的 `_cleanup`/`_enterFunctionMode`/`_handoffArticle`/斷線都 `flush()`（不呼叫 onFail）⇒ in-flight 的 AID 命令被丟掉、`aidNavigation.active` 永遠 true ⇒ `term_view.onKeyDown` 吞掉**全部**鍵盤並一直閃「AID 跳文中」，無法自行復原。修法＝命令層 opt-in 的 `onFlushed`（flush 對其他命令仍靜默）。守護：`aid_navigation.test.js`。
7f. **診斷**：`CommandQueue` 的 `opts.onEvent` 接到 `app.debugRecorder?.log('queue.'+name, info)`（`pttchrome.jsx`），info 帶 `{kind, sinceSentMs, pendingLen, probed}`。recorder 預設 null＝零成本；下次回報卡住時請對方按 Debug 錄製鈕重現，時間軸直接指出哪個 kind 卡住、多久、done/miss/timeout。
7g. **跳號腿一律 `fullRepaint: true`，且 miss 只能由完整幀定讞**（2026-08-25「開文偶發凍四秒」）。兩半缺一不可：
   - **零回應跳號**：跳到真游標**已經所在**的序號時畫面零差異 ⇒ server 送 0 bytes ⇒ `term_buf` 的 settle timer 只由 server 活動 re-arm（不變量 2b）⇒ 沒 settle ⇒ expect 永不被評估，只能苦等軟逾時。錄製檔 `ptt-debug-20260825-105701#t=12562`：prefetch 錨定腿剛把游標跳到 2381，open-jump 又跳 2381 ⇒ 凍 4094ms（其中 4002ms 純空等）。→ **keys 形如 `<數字>\r` 的每一腿都必須 `fullRepaint: true`**（目前八腿：`open-jump`、`open-pinned-jump`、`jump-number`、`jump-end`、`jump-home`、`prefetch-anchor-*`、`native-sync-jump`、`leave-sync-jump`），另加 `open-pinned-end`（游標已在底部時 End 同樣零回應）。**expect 不變**：協定 §6 M1——`redrawwin` 重繪的是 server 虛擬螢幕「現狀」，跳號後底列仍空 ⇒ 永遠不會變成 clean-list，park 指紋（不變量 3）仍是唯一判準。**翻頁腿（`prefetch-up/down`）刻意不掛**：有動的翻頁本來就確定性回應，附 \f 只是流量×2；`native-key`／`native-paste` 也不掛（bytes 是使用者任意輸入，且 §8.2 明訂 `view_postinfo` 這類交易不可帶 `fullRepaint`）。
   - **`isCompleteFrame` 守門**（`command_queue.js` 可注入，預設 `() => true`；`pttchrome.jsx` 注入 `changedRows.size >= rows`）：探針從 4000ms 提前到 250ms 之後，「探針送出後的下一個 settle 就是探針的答案」不再成立——慢速連線上指令自己的真回應常常晚於探針才到，而**部分幀不是「我在哪」的答案**。沒這道守門，那種幀會被判定讞 miss → 常態誤降級原生。判準來源：\f 的 `redrawwin` 回應固定以 `ESC[H ESC[2J` 開頭，而 `term_buf` 的 erase-display `case 2` 走 `_touchRows(0, rows-1)` ⇒ 全螢幕清除必然讓 `changedRows` 涵蓋所有列。非完整幀改用**探針窗**重新武裝並計數，上限 `MAX_PROBE_EXTENSIONS=1`（最壞 ≈ 250+600+600，仍在 2500ms 看門狗之內，沒有無限延長的路）。守門失效的退路是 hard timeout → `onFail('timeout')`，只可能把 miss 延後到硬上限，**不可能卡死**。
   守護：`list_command_budget.test.js`（跳號腿 \f 契約＋真 CommandQueue 的零回應重現）、`command_queue.test.js`「isCompleteFrame…」一組。
8. CommandQueue timer 要包 wrapper（Illegal invocation）。
9. `_renderScreenLines` list 分支傳 `{pageState:2}`；**dropHidden=false**（黑名單已在 `visibleListIndices` 前置過濾，視窗切片本來就不含隱藏列）。
10. `visibleListIndices` 與 `screen_annotations#computeAnnotations` PAGE_LIST 分支同規則——**此同步只在好讀列表視窗（`enhance.listEasyReading` 為 true）成立**：好讀視窗刪除文＋黑名單無條件隱藏（`isDeletedListRow`＝作者欄 `-`；刪除文開文永無 article → 必 wedge，故比照黑名單隱藏）。**原生模式（無 listEasyReading）刻意分歧**：刪除文原生顯示（不隱藏不反黑）、黑名單改渲染成被刪除樣式通知列「（本文已被黑名單） <作者>」（`blacklistNoticeText`；作者＋標題黑名單皆適用；全形括號＋raw 前綴保留游標標記 → 不歪不位移）。`listEasyReading` **只在 term_view 的 buffer/frozen 視窗 render 呼叫傳入**（`:442`/`:446`）；native／functionMode 鏡像**不傳** → 走原生規則（通知列），故「好讀暫時切回原生」與純原生一致（不再變回反黑）。守護：`screen_dropHidden.test.js`（雙模）＋`row_render.test.js`（通知列渲染＋forceWidth）＋`comment_parse.test.js`（`blacklistNoticeText` raw 前綴/全形括號）。
12. **非白名單鍵＝keyClass `passthrough` → `_beginNativePassthrough`**：reducer 先轉 functionMode（sync 腿在途吸收 settle＋frozen 吞鍵——非 native！閃現原生一幀＝黑名單/刪除文裸露），有序號選取且 ≠`_serverNum` 時先 `_enqueueCursorSyncJump('native-sync-jump')`（jump＋key **不可同 tick 直送**：pttbbs typeahead 跳繪，協定 §2），onDone/onFail 皆 `_enterFunctionMode`＋raw 代送原鍵（onFail 也送＝顯性降級，原生鏡像所見即所得）。**`_serverNum` 快路徑**沿用：選取＝`_serverNum`（seed/re-seed/resume facts、prefetch 落地都會教；native 出走/article/探針 fail＝null）→ 免 sync 腿零 round-trip 直切。pinned/無選取＝免 sync 直切＋代送。Ctrl 組合＝不代送、事件放行原生鍵盤（`bytes == null` 分支自 2026-08 起**只服務 Ctrl 組合**）。**勿再為個別鍵寫模擬交易**（relative 配對／mark／search 模擬都試過並移除）。守護：`list_keys.test.js`。
12b. **剪貼簿鍵不得進 passthrough，貼上不得裸送**（2026-08「AID 文章碼要貼兩次」）。兩半缺一即復發：
   - `onKeyDown` 的剪貼簿早退除了 Ctrl-C/A/V/X，**必須含 Shift+Insert**（app 自己的 i18n `alert_pasteShortcutText` 就是叫使用者用它）。它不是 ctrl 組合 ⇒ 舊碼落 `passthrough` → `_beginNativePassthrough` 的 **`e.preventDefault()` 會取消瀏覽器的貼上預設動作** ⇒ `#t` 收不到 `paste` 事件、`App.onDOMPaste` 永不觸發，PTT 只收到 `keyEventToBytes` 產出的 `\x1b[2~`。畫面切原生卻沒貼上任何東西，使用者得貼第二次（那次才成功——此時 `listRenderMode` 已是 native、hook 根本不被呼叫）。**純 `Insert`（無 shift）維持 passthrough**。
   - 貼上本身要走 `ListSession.onPaste`（T3b）而非 `view.onTextInput` 裸送：裸送會與 in-flight prefetch/jump 競態（typeahead，協定 §2），且 buffer 模式渲染的是累積清單 ⇒ **PTT 畫的 prompt 看不見**，要等某個 settle 觸發 catch-all 才現形。使用者讀成「沒反應」再貼一次 → AID 被 append 進同一個 prompt（`#1gIeu-3A1gIeu-3A` → 找不到文章）。
   - 正規化規則放 `string_util.normalizePasteText`（`term_view.onTextInput` 與 `onPaste` 共用），兩條路徑必須送出**逐 byte 相同**的內容；`CommandQueue` 的 send 綁 raw `conn.send`（不做 u2b）⇒ `onPaste` 自行 `u2b`＋`ansiHalfColorConv`，順序照 `telnet.js#convSend`。
   守護：`list_keys.test.js`（Shift+Insert 放行＋純 Insert 反向）、`list_paste.test.js`（sync 腿／快路徑／降級／吞鍵有提示／回傳值／bytes 等值）、`string_util.test.js`（normalizePasteText）、`easy-reading-list.offline.spec.js`（真瀏覽器一次貼上只送一次、無 `\x1b[2~`）。
   文章好讀同源缺口：`_onKeyDown` 只對 `e.key.length === 1` 進 functionMode，貼上不是按鍵 ⇒ prompt 被長頁蓋住。修在 `App.onPasteDone`（送出前先 `easyReading._enterFunctionMode()`）。
12c. **送不出 byte 的鍵不得進 passthrough**（2026-08「按 Caps Lock/F2 畫面跑掉」；與 12b 同型，該處是 Shift+Insert）：`_classifyKey` 開頭 `keyEventToBytes(e) == null → keyClass 'ignore'`（吞掉、不轉態、**不 preventDefault**——F12 開發者工具／CapsLock 的 OS 行為留給瀏覽器）。舊碼把 CapsLock／F1–F12／NumLock／ScrollLock／不可映射 Ctrl+Shift 全歸 passthrough → 落 `bytes == null` 分支 → **跳過 cursor sync 腿直接 `_enterFunctionMode()`**：畫面瞬間換成 server 真實 24 行（本地導覽零網路，真游標通常停在背景 prefetch 的遠處頁面）＝畫面跑掉，外加黏性 hold＋拋 cache（不變量 15），而 server 從頭到尾沒動——該分支假設的「事件放行後原生鍵盤路徑會送出去」對這些鍵不成立（`TermKeyboard._onKeyDown` 對 KeyMap miss 且 `key.length !== 1` 一律回 false）。判準必須綁 `keyEventToBytes`（＝送出路徑本身），**不可改成硬列鍵清單**（會與送出路徑漂移）。文章好讀的同源守門是 `e.key.length === 1`（`easy_reading.js`）。同批修的還有白名單缺 read.c 導覽同義鍵（`空白`/`N`/`P`/`n`/`p`/`$` 原本落 passthrough，翻頁被當成切原生）。守護：`list_keys.test.js`（dead keys／同義鍵等價／Ctrl-P 反向）、`easy-reading-list.offline.spec.js`。

13. `relabelListCursorRow` ＝**依 resolved num 把 cells[0,7) 重寫成 `%7d` 右對齊**（pttbbs `readdoent` 的 `prints("%7d", num)`），且對**每一列編號列**都跑（不只游標列）。一次覆蓋三種污染：(a) 兩代游標蓋格；(b) partial-redraw 留白的高位格（`"  51281"` ← 351281——`pageArticleNums` 的 monotonicity repair 只修 `nums` 不修 cell；舊全形 `●` 佔兩格剛好蓋住此瑕疵，換半形 `>` 後露出成「> 51281」）；(c) 短序號（`/` 搜尋結果 531 → `"    531"`）。**勿再回頭用 prefix 拼接**——舊法會把序號末兩位灌進行首並存進 map（污染跨頁殘留）。
11. edge 確認（markEdge/_requestEnd）後要 `_forceRedraw`——pinned 門控開啟需要重繪才可見。
15. **原生 excursion＝cache 失效**：`_enterFunctionMode` 一律清 `_boardName`（與 `_serverNum=null` 對稱）——原生任意鍵可改寫清單內容/序號空間（Z/a/A/`/` 的 MODE_SELECT 皆獨立序號空間，協定 §8），回 clean-list 若板名同＋落點恰在舊 buffer 內走純 resume 會把舊條目 merge 進新清單（症狀：多輪搜尋後清單混雜、點舊序號開文 jump expect 永不中→timeout）。守護：`list_keys.test.js`「native excursion 一律拋棄 cache」（含反向守護：leave 交易 resume 不 rebuild）。passthrough 走 `_enterFunctionMode` → 自動涵蓋。
16. **last-read 高亮＝title-match（pttbbs 真實邏輯）＋normalize-on-store＋decorate-on-render**：真實邏輯在 `3rd_script/pttbbs/mbbsd/bbs.c` `readdoent`——`strcmp(currtitle, subject_ex(title))==0` 的**每一列**都塗 `1;3c`（c 依該列自身 title_type：`□`=1紅 `R:`=3黃 `轉`=6青 `鎖`=5紫 `ˇ`=2綠），範圍 mark→行尾、**不含 author 欄**；author 亮白 `1;37`＝`isonline`（作者在線），與 last-read 無關；currtitle per-login 全域、讀完文即設 subject。⇒ **同主題多列同亮是正常行為**，單一列號游標模型必然殘紅（勿再回頭做 `_lastReadNum`）。現行模型：map 永存去色列（`normalizeLastReadListRow`；**雙豁免＝[8,12) 推文數欄 ＋ [17,29) 作者欄**——`paintLastReadListRow` 只重畫 [29,)，作者欄若被壓回預設就再也還原不了 isonline 亮白）；session 記 **`_lastReadTitle`**（`subjectOfListRow`＝title 區去 mark＋防禦性 loop 剝 `Re:`/`Fw:`，＝pttbbs `subject_ex` 等價）；教學雙路——frame-taught（`isLastReadStyledListRow` 命中 fg∈{1,2,3,5,6}→`noteLastRead(subject)`）＋**主動教學**（`_beginOpen`/`_beginOpenPinned` 開文成功 onDone 直教，堵 partial 幀無樣式列的洞）；render（`buildListWindowLines`）對 subject 命中的**每列** clone 重上 `paintLastReadListRow`（色＝`listRowMarkFg` 由該列自身 mark 推，author 欄不動；subject 以 `row._subject` memoize）。生命週期：只有 cleanup 歸零；seed/rebuild/resume 一律保留（currtitle 全域、title 與序號空間無關，新幀自動重教）。守護：`list_accumulate.test.js`（殘留＋欄位豁免＋游標共存＋同主題多列紅黃並亮＋換篇退色＋isonline 不誤觸＋**isonline＋last-read 同列作者亮白保留（accumulate/游標實況/render 三面）**＋subject/markFg 純函式）、`list_session.test.js` 生命週期。
14. **T2 輸入 overlay（`promptListInput`）鍵收束要焦點無關**：input.focus() 在 setTimeout，focus 生效前的 Esc/Enter 落在 `#t`、被全域 handler 的 overlay 守門整個忽略（防鍵漏 server）→ overlay 卡死。修法＝overlay 期間掛 window **capture** keydown：Esc/Enter 直接 finish、其他鍵導焦點回 input（`term_view.js`；soak 站 7 曾穩定踩中）。
17. **無編號列的 clean-list 幀不得驅動 seed／rebuild／resume**（2026-08-20 錄製檔 `20260820-015809`「列表好讀卡在一頁、PgUp 沒反應」）：進板時 pttbbs getkeep 還原的閱讀位置若剛好在板尾，`readdoent` 只畫得出那幾列**置底文**就 `clrtobot`（該幀 entry 區零編號列，但通過不變量 3a 的板尾短頁放寬 → 判 clean-list）。seed 之後 `listLineNums` 全 null ⇒ `bufferEdgeNum` 回 null ⇒ **錨定式 prefetch 的每一條腿都在 `_enqueuePrefetch` 的 `base == null` 靜默 return**（`_startFill`／`_maybeFill`／`_maybeDemand` 全走這裡），`_requestEnd` 的 `anchor == null` 同理，`_demandDownIfWindowShort` 又被「畫面有 ★ ⇒ `_edgeDown=true`」擋掉。使用者端的症狀＝導覽鍵在那兩三列裡原地打轉、**零網路、零重繪、連「讀取中…」膠囊都不亮**（`_moveSelection` 的 `!queue.idle` 不成立），唯一逃生口是 Home 的 `serverOp`；切原生（flush＋鏡像）或進出文章（re-seed）才會恢復——正是回報的三個現象。
   修法＝reducer 事件帶 `hasNumberedRow`（`hasNumberedEntryRow(facts)`，單點推導自 `facts.nums`；**勿改成由 `_collectFacts` 預先塞進 facts**——呼叫端會手組 facts）：idle 不 engage、functionMode／suspended 的 clean-list 一律 stay 鏡像原生、active 板名同 stay／板名異 `enter-function-mode`。停在原生無風險：使用者原生翻一頁就拿到有編號的幀，下一個 settle 自動 engage。
   **與不變量 3a 的分界**：3a 放寬的是「板尾最後一頁只剩 1 列編號＋置底＋空白」，**編號列 ≥1 是底線**；分類器本身**不動**（改它會讓板尾無主 settle 回頭誤降級）。`_enqueuePrefetch` 的無錨點分支另留一則 `listSession.noAnchor` 診斷（不變量 7f），下次同型卡死可直接在錄製檔看到。守護：`list_session.test.js`「無編號列的 clean-list 幀…」三條（分類器不變／落點只有置底文不 engage／板尾 1 列編號仍 engage）＋ reducer 全枚舉的 `hasNumberedRow:false` 四列。

## 已知限制

rows≠24 不 engage。MODE_SELECT（`/` 搜尋清單）＝`_selectMode` 子狀態：序號空間獨立（協定 §8），進出各強制 rebuild（`_boardName=null`）；**退出落點＝帳號已讀進度，非進 select 前位置**（協定 §8 live 事實）——fill 只向上，退回後 buffer 可能整段低於進板頁；**seed／rebuild 落點頁不滿版（下方空白列）時自動 demand-down 補頁**（共用 `_demandDownIfWindowShort`）——不補頁時，初次進版落在看板中段會導致向下 prefetch 的 markEdge 不觸發→`_edgeDown` 停 false→置底文整條被門控隱藏；**滿版落點不得探測**——板尾零回應 PgDn 的 timeout→`\f` 探針會與 hard timeout race 出無主 settle → 誤入 functionMode（live 實測）。（`/` 搜尋走 passthrough 原生打字，convSend 自帶 u2b；passthrough 代送的非 ASCII 單字元同樣先 `u2b`。）

## 素材再錄

`$env:RECORD_MODE='list'; $env:RECORD_BOARD='C_Chat'; $env:RECORD_NAME='cchat-list-nav'; $env:RECORD_LIST_SCRIPT='nav'; yarn record:cassette`（guest 滿加 `RECORD_ALLOW_LOGIN=1`）。
pinned 卷＝`RECORD_NAME='cchat-list-pinned' RECORD_LIST_SCRIPT='pinned'`（要求該板置底 ≥3 篇）。
mark 卷＝`RECORD_NAME='cchat-list-mark' RECORD_LIST_SCRIPT='mark'`；search 卷＝`RECORD_NAME='cchat-list-search' RECORD_LIST_SCRIPT='search'`（需 `RECORD_ALLOW_LOGIN=1`＋帳密）。
**素材世代**：主名四卷（`cchat-list-{nav,pinned,mark,search}`）是 2026-08-12 重錄的**新 `>` 游標**世代，所有 offline 測試預設吃它們；`-wide` 四卷是重錄前的**舊 `●`** 世代，改名保留，只被「舊 ● 游標素材仍能 engage（雙支援）」那一條測試使用。重錄時**只換主名、不要動 `-wide`**——那是 `parseListArticleNum`/`parseListArticleNumLoose`/`serverCursorWidth` 三處兩代分支的唯一真瀏覽器覆蓋（實測：拿掉 loose 的 `●` strip，該條就會在 listLen=20 餓死）。
nav 腳本＝10 step（start/jump/pageup/jump/pageup/jump/open/back/jumpsame/pageup）。重放門控 map 在 `tests/e2e/helpers/replay.js#replayListCassette`（**jump/jumpsame 按 step.num 精確比對**）。offline 編排與 runtime 決策耦合：改 fill/demand 邏輯時 spec 內 prefetchCount／按鍵序列要重算（例：視窗 demand 觸發比舊選取邊距早——PgUp 一次即觸發，spec 只按一次就吃掉一對錨定命令，見 spec 內註解）。
