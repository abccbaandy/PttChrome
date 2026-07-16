# 文章列表好讀模式 — 架構（v5：封閉互動＋確定性交易）

## 核心原則（最高優先，違反＝方向錯誤）

**v5 合約（2026-07-05 拍板，取代舊 parity 合約；論證見 `docs/easy-reading-list-research.md` §2/§4）：**

1. **外觀近似**原生（24 行視窗＋游標 `●`＋鍵盤習慣近似），**不再承諾**「與原生無可感知差異」。
2. **封閉互動（2026-07-10 修訂）**：白名單＝導覽/開文/跳號/離板；**未列鍵＝一鍵切原生 passthrough＋黏性 hold**（可選 sync 腿 → enter-function-mode → queue 代送原鍵；切原生後停在原生，article/menu 情境切換才恢復好讀），T3 氣閘（同鍵二連擊）與 `[ ] =`/`v`/`/` 模擬交易退役。
3. **確定性交易**：server 互動一律 CommandQueue 交易；高風險交易尾附 `\f`（Ctrl+L，igetch 全域熱鍵→全幅重繪，協定 §2）→ 必得一幀全幅畫面，timeout 降為真異常。
4. 交易期間 render=frozen＋吞鍵＋讀取中指示。
5. **失敗顯性化**：timeout → 單獨 `\f` 探針拿全幅畫面重分類 → 恢復或 banner＋切原生。禁止靜默墜落。

舊 parity 合約（「與原生完全一致、read.c 逐格對齊」）**已廢棄**——「測試全綠 ≠ 實測穩」跨 v3/v4 兩代重現，失敗面積在素材之外，屬結構性成本。`list_window.js` 視窗數學保留但允許偏離 read.c（web 慣例優先）；`tests/unit/list_window.test.js` read.c lockstep 全枚舉與 offline「雙模 engage 比對」案＝**已退役**（M5 移除，只留行為級守護）。

## 操作分類（枚舉即合約）

| 類 | 操作 | 處置 |
|---|---|---|
| T1 本地 | ↑↓ jk／PgUp PgDn／Home End（buffer 內）／滾輪 | 零 server。視窗/游標語意＝web 慣例，不再 read.c 逐格對齊。點擊＝no-op（2026-07-08 移除點擊選取；buffer/frozen 一律吞點擊防 useMouseBrowsing 對虛擬視窗發鍵） |
| T2 列表內交易 | 開文、數字跳號、End/Home 邊界確認、`←`/q/e 離板 | 腳本交易（CommandQueue 序列化） |
| T3 一鍵切原生 passthrough（2026-07-10，取代舊氣閘/相對命令/mark/search 模擬） | `[` `]` `=`、`v`、`/`、Ctrl-P、`z`、`s`……**其餘一切未列鍵** | 單按即生效：有序號選取且 `_serverNum` 未同步→先 `native-sync-jump`（frozen＋吞鍵）→ `enter-function-mode`（原生 excursion，不變量 15 拋 cache）→ raw 代送原鍵（`native-key` 佇列命令，防 sync 落地 settle 提早 resume）＋提示「已切至原生」。Ctrl 組合/不可映射鍵不代送（事件放行原生鍵盤路徑）。**黏性 hold（`_nativeHold`）**：切原生後 clean-list settle 一律 stay（反覆 [ ] 不閃動/不誤觸 banner），只有 article（開文→文章好讀接手→返回 re-seed）或 menu（離板→重進板 engage）才恢復好讀 |
| T4 非請自來 | 水球/廣播（server 主動寫入） | 唯一自動切原生路徑：banner 明示＋氣閘 |

pref `enableEasyReadingList`（預設 off）＋`easyReadingListPrefetchCount`（預設 200，0=停背景 fill）。
三原則：**A 內容判定**（settle 只定何時評估；是什麼靠指紋謂詞，`docs/pttbbs-screen-protocol.md` §3-5）、**B 顯式狀態機**（ListSession 單一擁有者）、**C 命令序列化**（CommandQueue 單一 in-flight；typeahead 跳繪 §2）。誤判永遠往 native 降級（catch-all functionMode）。

## 檔案地圖

| 物件 | 位置 |
|---|---|
| 視窗數學（read.c 移植，純函式）：`listCursorPos`/`moveListCursorWindow`/`normalizeListWindow`/`windowVisibleSequence`/`pruneListToSegment`/`labelListCursorBullet`/`LIST_FROM_TOP` | `src/js/list_window.js`（unit：`list_window.test.js`，行為級守護；read.c lockstep 已退役） |
| 純函式層：`classifyListScreen`/`classifyListBurst`/`transitionListSession`/`mergeListPage`/`flattenListBuffer`/`moveListSelection`/`visibleListIndices`/`parseBoardName`/`evictListBuffer`/`bufferEdgeNum` | `src/js/list_session.js` 上半（unit：`list_session.test.js`） |
| class `ListSession(core,view,termBuf,queue)`：狀態機＋視窗錨（`_topNum`/`_selectedNum`）＋demand＋`getWindowView` | 同檔下半；`pttchrome.js` App constructor 接線 |
| `CommandQueue`（注入 send/timer、soft/hard timeout、flush 靜默） | `src/js/command_queue.js` |
| 序號解析：`parseListArticleNum`/`isPinnedListRow`/`recoverCursorArticleNum`/`pageArticleNums` | `src/js/comment_parse.js` |
| settle snapshot | `src/js/term_buf.js` `_armSettleTimer` |
| render：redraw buffer/frozen 分支＝24 行視窗（`buildListWindowLines`＝header/footer 快取＋`getWindowView` 切片＋● 裝飾）、`accumulateListLines`（merge→evict→prune→flatten→chrome 快取）、`relabelListCursorRow` | `src/js/term_view.js` |
| 鍵盤 hook（僅 buffer/frozen；native 全直通）；滾輪：`pttchrome.js mouse_scroll` buffer 分支 → `ListSession.onWheel` | `term_view.js onKeyDown`／`pttchrome.js` |
| 測試 | offline `tests/e2e/offline/easy-reading-list.offline.spec.js`（CI gate）；live `tests/e2e/easy-reading-list.spec.js`（soak＝白名單操作輪播，新增白名單操作時同步補站）；素材 `cchat-list-nav/prompt/pinned/mark/search` |

## 視窗模型（render 層，取代舊無限捲動）

- **視口＝(topNum, cursorNum) 兩個序號錨定的 24 行切片**：header 3 列＋body 20 列（`bodyRows = rows-4` = pttbbs p_lines）＋footer 1 列。DOM 固定 24 行、`mainDisplay.scrollTop=0`、無捲動補償、無 scrollIntoView、無高亮 CSS。
- 導航空間＝**過濾後序列**：`visibleListIndices`（黑名單）→ `windowVisibleSequence`（pinned 門控）。無黑名單時＝原生行空間 → 語意同構。
- 游標＝行首全形 `●`（`labelListCursorBullet`，u2b 注入兩個 Big5 bytes，蓋 cells[0,1] 同 server 畫法；**不反白**——原生 lightbar 是 `UF_MENU_LIGHTBAR` 旗標非預設）。map 內永遠存 relabel 過的乾淨列，● 只畫在 render-time clone。
- 鍵語意＝read.c 逐條移植（`moveListCursorWindow`）：↑↓ 視窗內只動游標、越界重錨 `top = cursor - fromTop`；PgUp/PgDn `top±B`、**游標停新頁頂**；↑ 在全域第一列 wrap 到最後一列；跳位 `fromTop=10`。
- **邊未確認的大跳走 server**（serverOp）：End→`_requestEnd`（送 `99999999\r`——jump 超過最大序號 server clamp 到 last_line 含置底，**必有回應**；單發 End 在游標已於底端時零回應必 timeout）；Home→`_requestHome`（`1\r`，序號 1 恆存在）。onDone 確認 edge → 本地套 End/Home。
- **pinned 門控**：置底列只在 `_edgeDown`（已確認板尾）時進導航序列（native：置底只存在 last page）→ 舊文區往下讀不會先看到置底文。seed/resume 時畫面含 ★ ⇒ `_edgeDown=true`。
- **缺口 prune**：序號是連續整數，`pruneListToSegment` 在 accumulate（merge→evict 後）只留 pivot 所在連續段，視窗永不跨缺口。pivot＝`session.prunePivot()`：平常＝selection；End jump 在途＝null（留最大段）；Home jump＝1。**far-jump 必設 `_prunePivotOverride`，否則 prune 會把剛抓到的目標頁丟掉**。
- demand：視窗頂/底距 buffer 邊 **< 2×bodyRows（兩頁）** 即補（方向性、chain 不跨來源 fill/key），提早補頁把 round-trip 藏在使用者到邊之前。到邊等待＝視窗 clamp、鍵 no-op＋右下「讀取中…」指示（`view.setListLoading`，v5/M4；prefetch onDone/markEdge 清除）。
- 退文回列表＝**re-seed**（v5/M4，`_restore` 逐行 parity 家族已退役）：suspended 的 clean-list settle 走 functionMode 同規則——server 落點權威（READ_REDRAW 重繪的 getkeep top＋游標直接採用，順帶刷新推文數）；落點在緩衝內→resume-buffer 保留 maps，否則（pinned 落點 num=null／板名異）＋rebuild。resume（functionMode 出口）同＝採 native 畫面的 top+cursor。
- 滾輪＝原生偏好映射本地執行（`mouse_scroll`：素滾=↑↓、右鍵滾=PgUp/PgDn、左鍵滾=thread→list 無意義 no-op）；frozen 吞滾輪。
- header/footer 快取：accumulate 時從「像 clean-list 的 live 幀」更新（row0 含《＋row2 含 編號 → header；底列含 文章選讀 → footer）——跳號空底列不會污染 footer 快取。

## 狀態機（reducer＝`transitionListSession`，unit 全枚舉為準）

states：`idle → active ⇄ functionMode`；`active → opening → suspended → active`。
`listRenderMode` 映射：active→buffer、opening→frozen、其餘→native。**例外：passthrough 的 sync 腿與 leave/jump 交易期間 state=functionMode 但 render=frozen**——frozen∧functionMode 時 onKeyDown 吞所有鍵（含淡出提示「指令處理中」，2026-07-10：吞鍵不得無聲）。

- idle：clean-list ∧ pref ∧ rows==24 ∧ `!buf.startedEasyReading` → active（seed＋start-fill）。engage 守門不用 `view.useEasyReadingMode`（article ER 離篇後仍 latch true）。
- active：clean-list 板名同→continue-fill；異→rebuild；article→suspended；**menu→idle cleanup**（離板可與 in-flight prefetch 的 jump 重繪交錯：jump settle 先把 functionMode 彈回 active，menu settle 若走 catch-all 進 functionMode 會因靜止畫面無下一個 settle 而卡死）；prompt/transient ∧ 無 in-flight→functionMode **＋banner**（v5/M4 失敗顯性化：`isWaterballSettle` 命中（protocol §9 底列 ◆ 指紋）→水球專屬措辭，否則通用「畫面偏離列表」；氣閘等顯式入口不出 banner——`_enterFunctionMode(facts)` 只在 facts 非 null 時顯示）；有 in-flight→stay。交易 onFail 一律 `_degradeToNative(訊息)`＝banner＋原生鏡像。
- key（active）：nav（↑↓jk/PgUp/PgDn/Home/End → read.c op）；Enter/→＝opening（selectedNum 有值→begin-open；null＝pinned→begin-open-pinned）；數字＝jump-digit（overlay 收參，M3）；`←`/q/e＝leave 交易（**先 sync-jump 同步 server 游標再送離板鍵**——pttbbs getkeep 記 REAL cursor，不 sync 則再進板落點錯，2026-07-08；`_serverNum` 快路徑同 passthrough，共用 `_enqueueCursorSyncJump`）；**其餘鍵（含 `[ ] =` `v` `/`）＝keyClass `passthrough` → `_beginNativePassthrough`：一鍵切原生＋代送**（2026-07-10；`term_keyboard.keyEventToBytes` 轉 bytes，非 ASCII 單字元 `u2b`）。
- opening：settle 等 article；timeout→functionMode 自癒；期間吞所有鍵。
- functionMode：clean-list→**`nativeHold`（passthrough/自癒/降級 excursion）時 stay 鏡像（黏性）**；無 hold（leave/jump 交易）→active（landedNum∈buffer ∧ 板名同→resume；否則＋rebuild）；article→suspended；menu→idle cleanup。**enter-function-mode（氣閘/自癒/降級——原生 excursion）在 action 層清 `_boardName`** → 回 clean-list 必走 rebuild 分支（不變量 15）；只有保留 `_boardName` 的 frozen 交易（leave/jump）可走純 resume 快路徑；passthrough 屬原生 excursion → 黏性停原生；經 article/menu 回好讀時因 `_boardName` 已清必 rebuild。
- suspended：clean-list→re-seed（resume-buffer；落點不在緩衝/板名異＋rebuild）；menu→idle。
- 任意：pref-off/斷線→cleanup。

## 關鍵不變量（違反即復發）

1. **零內容 settle 不驅動轉移**：`_onScreenSettled` 開頭 `changedRows.size===0 → return`（本地 `_forceRedraw` 也 re-arm settle）。
2. **`_settleChangedRows` 只在 server 寫入點 add**（統一走 `_touchRows`），不可掛 `lineChangeds`。
2b. **settle timer 只由 server 活動 re-arm**（`_serverActivity`：`_touchRows`＋游標 escape 的 posChanged；notify 的 changed 分支 gated）。本地 `_forceRedraw` 不得推遲 pending settle——否則按住 nav 鍵（~30ms 一次重繪）永遠不 settle → queue expect 餓死 → prefetch timeout →「按住 PgUp 無效」＋ markEdge 假邊界（置底文顯示異常的來源）。守護：`settle_gating.test.js`。
3. **跳號回應 settle 底列是空的**（classify=transient 永不 clean-list）→ jump 類 expect 用「park 在 entry 區 col≤1 ∧ 游標列=目標序號」。`_requestEnd` 落點可為置底列（cursorRowNum null 也接受）；**prefetch 向下翻頁腿同理**：真板尾 PgDn 游標落置底列（cursorRowNum null ∧ clean-list）＝`{edge, landed:null}`，不可 miss——miss 的 hard timeout 會讓 \f 探針回應變無主 settle → catch-all 誤降級「畫面偏離列表格式」（2026-07-08 live）。向上腿 null 仍 false（置底只在板尾）。**（2026-07-11 錄製檔）兩道板尾放寬**：(a) `classifyListScreen` 板尾短頁規則——編號列 <3 時，若游標列本身是列表形（編號/loose/置底/刪除）∧ entry 區每個非空列都是列表形 → 仍 clean-list（板尾最後一頁可能只剩 1 列編號＋置底＋空白，游標 ● 蓋掉最高位時僅 loose 可讀；否則板尾任何無主 settle 必降級且無法自癒）；(b) prefetch 翻頁腿 expect 第二道防線——facts 非 clean-list 但 park（entry 區 col≤1）∧ cursorRowNum 相對 base 位移確定 → 照收 moved/edge（null 在 transient 幀不得判 edge，等探針幀）。守護：`list_session.test.js`「板尾短頁」×3＋「transient 幀但 park 指紋」。**(c) consumed 標記（2026-07-14 錄製檔）**：expect 收腿之外，完成幀本身的 settle 也要護——`queue.onSettle` 回傳 `'done'|'miss'|null`，settle event 帶 `consumed`，active 的 prompt/transient catch-all 對 consumed settle 一律 stay（完成當下 inFlightKind 已 post-account 成 null，板尾 edge 探針幀＝jump-park 後底列空的 transient，會被當無主 settle 誤降級 functionMode＋黏性 hold；整板一頁 re-seed 後 prefetch 必中）。miss 也算 consumed（onFail 自己善後，catch-all 會 double-banner）。守護：`list_session.test.js`「被完成指令消費的 settle」（真 CommandQueue 全鏈）＋reducer 枚舉 consumed case＋`command_queue.test.js` onSettle 回傳三態。
4. demand 只朝移動方向。
5. pinned map key＝`pinnedRowKey`（author|title）；`_pinnedKeyAt` 必須同函式。游標停置底列（有★）仍收錄、● 兩格還原空白；無★游標列排除。**loose-parse guard**：`parseListArticleNumLoose`（**只 strip `●`＋空白、不 strip `★`**，之後有行首數字）非 null 的列永不進 pinned map——mid-response 幀（jump 回應寫入中）● 可畫在非 cur_y 列，該列 num 無法回推＋作者欄有效會誤檔成置底，bullet 未還原永久殘留（●52880 污染 bug）。**不得 strip `★`**：★ 之後緊接推文數欄，常為純整數（`★    4 …`、`★   35 …`——無 m/M/=/+ 標記的公告），strip ★ 會露出推文數→pinned 列被誤判成編號列而排除→該公告固定消失（使用者實測「部分置底文固定消失」）；★ 天生屏蔽推文數（`^(\d+)` 不 match 仍以 ★ 開頭的列）。守護：`comment_parse.test.js`（純數字推文數→null）＋`list_accumulate.test.js`（純數字推文數置底列收錄）。
5b. **frozen 讓位 pageState 3**（redraw list 分支條件 `pageState !== 3`）。
5c. **預讀＝錨定命令對或鏈式單腿**：首次＝jump 到 `bufferEdgeNum(方向)` → PgUp/PgDn；同方向連補＝`_chainState={dir,lastLanded}` 跳過 jump 直送翻頁（moved/edge 判準改以 lastLanded 為基準——PgDn 落新頁**頂**、anchor 在新頁**底**，用 anchor 等值判 edge 會誤判）。**鏈失效點必須齊全**（漏一個＝錯位翻頁、v4 bug 3 復發）：所有 flush 呼叫點、任何非 prefetch enqueue（End/Home/open/relative）、無 in-flight 的 server settle（`_onScreenSettled` 在 `queue.onSettle` **前**檢查）、seed/rebuild/resume/cleanup、markEdge、noteEvicted。錨定失敗 onFail flush。回退開關＝`_chainState` 恆 null。offline 門控支援省略的同位置 jump（replay.js「先餵 jump 回應再餵翻頁」分支）。
6. 選取以序號為身分；pinned 選取以標題 key；**視窗頂同理以 `_topNum` 錨定**——prepend/evict 不動視窗（PgUp 不被新文往下擠的機制）。
7. 預讀 timeout＝良性到邊；開文 timeout＝functionMode 自癒；flush 靜默（**flush 不觸發 onFail → `_prunePivotOverride` 要在 flush 出口手動重置**）。（v5/M1 起）timeout 一律只是 **\f 探針觸發器**（`command_queue.js`），非訊號；`adaptiveTimeoutMs` 已刪。**交易前導用 `flushPending`（保留 in-flight 配對，序列化排隊）**；全量 `flush` 只准在退原生鏡像路徑（`_enterFunctionMode`/`_handoffArticle`/`_cleanup`）——flush 掉 in-flight 會讓在線回應變無主 settle、提早滿足下一交易的 expect（live race）。prefetch anchor onFail 用 `flushPendingKind('prefetch')`，不誤殺排隊中的交易。
8. CommandQueue timer 要包 wrapper（Illegal invocation）。
9. `_renderScreenLines` list 分支傳 `{pageState:2}`；**dropHidden=false**（黑名單已在 `visibleListIndices` 前置過濾，視窗切片本來就不含隱藏列）。
10. `visibleListIndices` 與 `Screen#computeAnnotations` PAGE_LIST 分支同規則——**此同步只在好讀列表視窗（`enhance.listEasyReading` 為 true）成立**：好讀視窗刪除文＋黑名單無條件隱藏（`isDeletedListRow`＝作者欄 `-`；刪除文開文永無 article → 必 wedge，故比照黑名單隱藏）。**原生模式（無 listEasyReading）刻意分歧**：刪除文原生顯示（不隱藏不反黑）、黑名單改渲染成被刪除樣式通知列「（本文已被黑名單） <作者>」（`blacklistNoticeText`；作者＋標題黑名單皆適用；全形括號＋raw 前綴保留游標 ● → 不歪不位移）。`listEasyReading` **只在 term_view 的 buffer/frozen 視窗 render 呼叫傳入**（`:442`/`:446`）；native／functionMode 鏡像**不傳** → 走原生規則（通知列），故「好讀暫時切回原生」與純原生一致（不再變回反黑）。守護：`screen_dropHidden.test.js`（雙模）＋`row_render.test.js`（通知列渲染＋forceWidth）＋`comment_parse.test.js`（`blacklistNoticeText` raw 前綴/全形括號）。
12. **（2026-07-10 改版）非白名單鍵＝keyClass `passthrough` → `_beginNativePassthrough`**：reducer 先轉 functionMode（sync 腿在途吸收 settle＋frozen 吞鍵——非 native！閃現原生一幀＝黑名單/刪除文裸露），有序號選取且 ≠`_serverNum` 時先 `_enqueueCursorSyncJump('native-sync-jump')`（jump＋key **不可同 tick 直送**：pttbbs typeahead 跳繪，協定 §2），onDone/onFail 皆 `_enterFunctionMode`＋raw 代送原鍵（onFail 也送＝顯性降級，原生鏡像所見即所得）。**`_serverNum` 快路徑**沿用：選取＝`_serverNum`（seed/re-seed/resume facts、prefetch 落地都會教；native 出走/article/探針 fail＝null）→ 免 sync 腿零 round-trip 直切。pinned/無選取＝免 sync 直切＋代送。Ctrl 組合/不可映射鍵＝不代送、事件放行原生鍵盤。舊 relative 配對（`_beginRelative`/`_enqueueRelativeKey`/`_resumeAfterRelative`）、mark/search 模擬、airlock 二連擊皆已刪除。守護：`list_keys.test.js`。
13. `relabelListCursorRow` 只在 cell 2 起有數字（● 真的蓋到數字）時回填 prefix；短序號（`/` 搜尋結果）● 蓋的是 padding，必須填空白——否則序號末兩位灌進行首並存進 map（污染跨頁殘留）。
11. edge 確認（markEdge/_requestEnd）後要 `_forceRedraw`——pinned 門控開啟需要重繪才可見。
15. **原生 excursion＝cache 失效**：`_enterFunctionMode` 一律清 `_boardName`（與 `_serverNum=null` 對稱）——原生任意鍵可改寫清單內容/序號空間（Z/a/A/`/` 的 MODE_SELECT 皆獨立序號空間，協定 §8），回 clean-list 若板名同＋落點恰在舊 buffer 內走純 resume 會把舊條目 merge 進新清單（movie 板多輪搜尋混雜、點舊序號開文 jump expect 永不中→timeout，2026-07-10）。守護：`list_keys.test.js`「native excursion 一律拋棄 cache」（含反向守護：leave 交易 resume 不 rebuild）。passthrough 走 `_enterFunctionMode` → 自動涵蓋。
16. **last-read 紅列＝normalize-on-store＋decorate-on-render**（2026-07-16）：server 的「上次閱讀」標紅（作者欄 `1;37`＋標題區 `1;31`）是 server-side cursor，只在重繪幀內移動——off-frame 的紅列 clone 若存進 map 永不失效（兩篇同時紅）。規則同 ● bullet：map 永存去紅列（`normalizeLastReadListRow`，accumulate 唯一入口；mark＋推文數欄 [8,12) 豁免保留綠/黃/爆色）、`_lastReadNum` frame-taught（`isLastReadStyledListRow` 雙條件命中→`noteLastRead`；漏抓=fail-safe 維持現狀）、render 對命中列 clone 重上色（`paintLastReadListRow`，`buildListWindowLines`）。生命週期：seed/rebuild/cleanup 重置 null（重置在 `_forceRedraw` **前**，seed 幀即重教）；resume/handoff 保留。守護：`list_accumulate.test.js`（殘留紅測試＋欄位豁免＋●共存＋render 三案）、`list_session.test.js` 生命週期。
14. **T2 輸入 overlay（`promptListInput`）鍵收束要焦點無關**：input.focus() 在 setTimeout，focus 生效前的 Esc/Enter 落在 `#t`、被全域 handler 的 overlay 守門整個忽略（防鍵漏 server）→ overlay 卡死。修法＝overlay 期間掛 window **capture** keydown：Esc/Enter 直接 finish、其他鍵導焦點回 input（`term_view.js`；soak 站 7 曾穩定踩中）。

## 已知限制

rows≠24 不 engage。點擊＝no-op（2026-07-08 移除 M2 點擊選取——只移選取不開文被判無用；`pttchrome.js mouse_click` 在 buffer/frozen 吞掉點擊，不放行 useMouseBrowsing）。MODE_SELECT（`/` 搜尋清單）＝`_selectMode` 子狀態（M3）：序號空間獨立（協定 §8），進出各強制 rebuild（`_boardName=null`）；**退出落點＝帳號已讀進度，非進 select 前位置**（協定 §8 live 事實）——fill 只向上，退回後 buffer 可能整段低於進板頁；**seed／rebuild 落點頁不滿版（下方空白列）時自動 demand-down 補頁**（共用 `_demandDownIfWindowShort`；`_seed` 2026-07-09 補上——初次進版落在看板中段時下方空白不補頁、且向下 prefetch 的 markEdge 不觸發→`_edgeDown` 停 false→置底文整條被門控隱藏；`_rebuild` 2026-07-07。滿版落點**不得**探測——板尾零回應 PgDn 的 timeout→`\f` 探針會與 hard timeout race 出無主 settle → 誤入 functionMode，live 實測）。（`/` 搜尋 2026-07-10 起走 passthrough 原生打字，convSend 自帶 u2b；passthrough 代送的非 ASCII 單字元同樣先 `u2b`。）

## 素材再錄

`$env:RECORD_MODE='list'; $env:RECORD_BOARD='C_Chat'; $env:RECORD_NAME='cchat-list-nav'; $env:RECORD_LIST_SCRIPT='nav'; yarn record:cassette`（guest 滿加 `RECORD_ALLOW_LOGIN=1`）。
pinned 卷＝`RECORD_NAME='cchat-list-pinned' RECORD_LIST_SCRIPT='pinned'`（要求該板置底 ≥3 篇）。
mark 卷＝`RECORD_NAME='cchat-list-mark' RECORD_LIST_SCRIPT='mark'`；search 卷＝`RECORD_NAME='cchat-list-search' RECORD_LIST_SCRIPT='search'`（T2 交易，M3；需 `RECORD_ALLOW_LOGIN=1`＋帳密）。
nav 腳本＝10 step（start/jump/pageup/jump/pageup/jump/open/back/jumpsame/pageup）。重放門控 map 在 `tests/e2e/helpers/replay.js#replayListCassette`（**jump/jumpsame 按 step.num 精確比對**）。offline 編排與 runtime 決策耦合：改 fill/demand 邏輯時 spec 內 prefetchCount／按鍵序列要重算（例：視窗 demand 觸發比舊選取邊距早——PgUp 一次即觸發，spec 只按一次就吃掉一對錨定命令，見 spec 內註解）。
