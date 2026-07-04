# 文章列表好讀模式 — 架構（原生視窗仿真）

## 核心原則（最高優先，違反＝方向錯誤）

**好讀列表的使用體驗必須與原生模式完全一致，唯一差異＝黑名單列（及後續隱藏功能）被隱藏；無黑名單生效時，兩模式應無可感知差異。**
所有體驗決策以 pttbbs `mbbsd/read.c` 語意為準（`3rd_script/pttbbs`），**不自創互動模型**（無限捲動 DOM／綠色高亮條／scrollIntoView 皆為已廢棄的錯誤方向）。逐步比對守護：`tests/unit/list_window.test.js`（read.c 參考模擬器 lockstep）＋ offline「雙模 engage 比對」案。

pref `enableEasyReadingList`（預設 off）＋`easyReadingListPrefetchCount`（預設 200，0=停背景 fill）。
三原則：**A 內容判定**（settle 只定何時評估；是什麼靠指紋謂詞，`docs/pttbbs-screen-protocol.md` §3-5）、**B 顯式狀態機**（ListSession 單一擁有者）、**C 命令序列化**（CommandQueue 單一 in-flight；typeahead 跳繪 §2）。誤判永遠往 native 降級（catch-all functionMode）。

## 檔案地圖

| 物件 | 位置 |
|---|---|
| 視窗數學（read.c 移植，純函式）：`listCursorPos`/`moveListCursorWindow`/`normalizeListWindow`/`windowVisibleSequence`/`pruneListToSegment`/`labelListCursorBullet`/`LIST_FROM_TOP` | `src/js/list_window.js`（unit：`list_window.test.js`，含 read.c 參考模擬器全枚舉） |
| 純函式層：`classifyListScreen`/`classifyListBurst`/`transitionListSession`/`mergeListPage`/`flattenListBuffer`/`moveListSelection`/`visibleListIndices`/`parseBoardName`/`evictListBuffer`/`bufferEdgeNum` | `src/js/list_session.js` 上半（unit：`list_session.test.js`） |
| class `ListSession(core,view,termBuf,queue)`：狀態機＋視窗錨（`_topNum`/`_selectedNum`）＋demand＋`getWindowView` | 同檔下半；`pttchrome.js` App constructor 接線 |
| `CommandQueue`（注入 send/timer、soft/hard timeout、flush 靜默） | `src/js/command_queue.js` |
| 序號解析：`parseListArticleNum`/`isPinnedListRow`/`recoverCursorArticleNum`/`pageArticleNums` | `src/js/comment_parse.js` |
| settle snapshot | `src/js/term_buf.js` `_armSettleTimer` |
| render：redraw buffer/frozen 分支＝24 行視窗（`buildListWindowLines`＝header/footer 快取＋`getWindowView` 切片＋● 裝飾）、`accumulateListLines`（merge→evict→prune→flatten→chrome 快取）、`relabelListCursorRow` | `src/js/term_view.js` |
| 鍵盤 hook（僅 buffer/frozen；native 全直通）；滾輪：`pttchrome.js mouse_scroll` buffer 分支 → `ListSession.onWheel` | `term_view.js onKeyDown`／`pttchrome.js` |
| 測試 | offline `tests/e2e/offline/easy-reading-list.offline.spec.js`（CI gate，含雙模比對）；live `tests/e2e/easy-reading-list.spec.js`；素材 `cchat-list-nav/prompt/pinned` |

## 視窗模型（render 層，取代舊無限捲動）

- **視口＝(topNum, cursorNum) 兩個序號錨定的 24 行切片**：header 3 列＋body 20 列（`bodyRows = rows-4` = pttbbs p_lines）＋footer 1 列。DOM 固定 24 行、`mainDisplay.scrollTop=0`、無捲動補償、無 scrollIntoView、無高亮 CSS。
- 導航空間＝**過濾後序列**：`visibleListIndices`（黑名單）→ `windowVisibleSequence`（pinned 門控）。無黑名單時＝原生行空間 → 語意同構。
- 游標＝行首全形 `●`（`labelListCursorBullet`，u2b 注入兩個 Big5 bytes，蓋 cells[0,1] 同 server 畫法；**不反白**——原生 lightbar 是 `UF_MENU_LIGHTBAR` 旗標非預設）。map 內永遠存 relabel 過的乾淨列，● 只畫在 render-time clone。
- 鍵語意＝read.c 逐條移植（`moveListCursorWindow`）：↑↓ 視窗內只動游標、越界重錨 `top = cursor - fromTop`；PgUp/PgDn `top±B`、**游標停新頁頂**；↑ 在全域第一列 wrap 到最後一列；跳位 `fromTop=10`。
- **邊未確認的大跳走 server**（serverOp）：End→`_requestEnd`（送 `99999999\r`——jump 超過最大序號 server clamp 到 last_line 含置底，**必有回應**；單發 End 在游標已於底端時零回應必 timeout）；Home→`_requestHome`（`1\r`，序號 1 恆存在）。onDone 確認 edge → 本地套 End/Home。
- **pinned 門控**：置底列只在 `_edgeDown`（已確認板尾）時進導航序列（native：置底只存在 last page）→ 舊文區往下讀不會先看到置底文。seed/resume 時畫面含 ★ ⇒ `_edgeDown=true`。
- **缺口 prune**：序號是連續整數，`pruneListToSegment` 在 accumulate（merge→evict 後）只留 pivot 所在連續段，視窗永不跨缺口。pivot＝`session.prunePivot()`：平常＝selection；End jump 在途＝null（留最大段）；Home jump＝1。**far-jump 必設 `_prunePivotOverride`，否則 prune 會把剛抓到的目標頁丟掉**。
- demand：視窗頂/底距 buffer 邊 **< 2×bodyRows（兩頁）** 即補（方向性、chain 不跨來源 fill/key），提早補頁把 round-trip 藏在使用者到邊之前。到邊等待＝視窗 clamp、鍵 no-op（體感＝native 等 server）。
- restore（退文章）＝native getkeep：還原 `(_restoreTopNum, _restoreNum/_restorePinnedKey)`，畫面與離開前逐行相同（offline 有 diff 案）。resume（functionMode 出口）＝採 native 畫面的 top+cursor。
- 滾輪＝原生偏好映射本地執行（`mouse_scroll`：素滾=↑↓、右鍵滾=PgUp/PgDn、左鍵滾=thread→list 無意義 no-op）；frozen 吞滾輪。
- header/footer 快取：accumulate 時從「像 clean-list 的 live 幀」更新（row0 含《＋row2 含 編號 → header；底列含 文章選讀 → footer）——跳號空底列不會污染 footer 快取。

## 狀態機（reducer＝`transitionListSession`，unit 全枚舉為準）

states：`idle → active ⇄ functionMode`；`active → opening → suspended → active`。
`listRenderMode` 映射：active→buffer、opening→frozen、其餘→native。**例外：相對命令配對（begin-relative）期間 state=functionMode 但 render=frozen**（不變量 12）——frozen∧functionMode 時 onKeyDown 吞所有鍵。

- idle：clean-list ∧ pref ∧ rows==24 ∧ `!buf.startedEasyReading` → active（seed＋start-fill）。engage 守門不用 `view.useEasyReadingMode`（article ER 離篇後仍 latch true）。
- active：clean-list 板名同→continue-fill；異→rebuild；article→suspended；**menu→idle cleanup**（離板可與 in-flight prefetch 的 jump 重繪交錯：jump settle 先把 functionMode 彈回 active，menu settle 若走 catch-all 進 functionMode 會因靜止畫面無下一個 settle 而卡死）；prompt/transient ∧ 無 in-flight→functionMode；有 in-flight→stay。
- key（active）：nav（↑↓jk/PgUp/PgDn/Home/End → read.c op）；Enter/→＝opening（selectedNum 有值→begin-open；null＝pinned→begin-open-pinned）；`[` `]` `=` ∧ 有序號選取＝relative（→functionMode＋begin-relative，見不變量 12）；其他鍵＝functionMode（不 preventDefault）。
- opening：settle 等 article；timeout→functionMode 自癒；期間吞所有鍵。
- functionMode：clean-list→active（landedNum∈buffer ∧ 板名同→resume；否則＋rebuild）；article→suspended；menu→idle cleanup。
- suspended：clean-list→restore；menu→idle。
- 任意：pref-off/斷線→cleanup。

## 關鍵不變量（違反即復發）

1. **零內容 settle 不驅動轉移**：`_onScreenSettled` 開頭 `changedRows.size===0 → return`（本地 `_forceRedraw` 也 re-arm settle）。
2. **`_settleChangedRows` 只在 server 寫入點 add**（統一走 `_touchRows`），不可掛 `lineChangeds`。
2b. **settle timer 只由 server 活動 re-arm**（`_serverActivity`：`_touchRows`＋游標 escape 的 posChanged；notify 的 changed 分支 gated）。本地 `_forceRedraw` 不得推遲 pending settle——否則按住 nav 鍵（~30ms 一次重繪）永遠不 settle → queue expect 餓死 → prefetch timeout →「按住 PgUp 無效」＋ markEdge 假邊界（置底文顯示異常的來源）。守護：`settle_gating.test.js`。
3. **跳號回應 settle 底列是空的**（classify=transient 永不 clean-list）→ jump 類 expect 用「park 在 entry 區 col≤1 ∧ 游標列=目標序號」。`_requestEnd` 落點可為置底列（cursorRowNum null 也接受）。
4. demand 只朝移動方向。
5. pinned map key＝`pinnedRowKey`（author|title）；`_pinnedKeyAt` 必須同函式。游標停置底列（有★）仍收錄、● 兩格還原空白；無★游標列排除。**loose-parse guard**：`parseListArticleNumLoose`（strip ●★ 後有行首數字）非 null 的列永不進 pinned map——mid-response 幀（jump 回應寫入中）● 可畫在非 cur_y 列，該列 num 無法回推＋作者欄有效會誤檔成置底，bullet 未還原永久殘留（●52880 污染 bug）。
5b. **frozen 讓位 pageState 3**（redraw list 分支條件 `pageState !== 3`）。
5c. **預讀＝錨定命令對或鏈式單腿**：首次＝jump 到 `bufferEdgeNum(方向)` → PgUp/PgDn；同方向連補＝`_chainState={dir,lastLanded}` 跳過 jump 直送翻頁（moved/edge 判準改以 lastLanded 為基準——PgDn 落新頁**頂**、anchor 在新頁**底**，用 anchor 等值判 edge 會誤判）。**鏈失效點必須齊全**（漏一個＝錯位翻頁、v4 bug 3 復發）：所有 flush 呼叫點、任何非 prefetch enqueue（End/Home/open/relative）、無 in-flight 的 server settle（`_onScreenSettled` 在 `queue.onSettle` **前**檢查）、seed/rebuild/resume/restore/cleanup、markEdge、noteEvicted。錨定失敗 onFail flush。回退開關＝`_chainState` 恆 null。offline 門控支援省略的同位置 jump（replay.js「先餵 jump 回應再餵翻頁」分支）。
6. 選取以序號為身分；pinned 選取以標題 key；**視窗頂同理以 `_topNum` 錨定**——prepend/evict 不動視窗（PgUp 不被新文往下擠的機制）。
7. 預讀 timeout＝良性到邊；開文 timeout＝functionMode 自癒；flush 靜默（**flush 不觸發 onFail → `_prunePivotOverride` 要在 flush 出口手動重置**）。預讀翻頁腿 timeout 用 `adaptiveTimeoutMs(_lastPrefetchRtt)`（無量測 fallback 3000）——板尾探測零回應只能靠 timeout 判邊，固定 3s＝「近置底更慢」。
8. CommandQueue timer 要包 wrapper（Illegal invocation）。
9. `_renderScreenLines` list 分支傳 `{pageState:2}`；**dropHidden=false**（黑名單已在 `visibleListIndices` 前置過濾，視窗切片本來就不含隱藏列）。
10. `visibleListIndices` 與 `Screen#computeAnnotations` PAGE_LIST 分支同規則（含**刪除文無條件隱藏**：`isDeletedListRow`＝作者欄 `-`；刪除文開文永無 article → 必 wedge，故比照黑名單隱藏）。
12. **相對命令鍵（`[` `]` `=`，RELATIVE_COMMAND_KEYS）＝keyClass 'relative' 一級公民**：reducer active+relative → functionMode＋begin-relative（flush → **render=frozen**（非 native！閃現原生一幀＝黑名單/刪除文裸露）→ enqueue jump→key 配對）。frozen∧functionMode 期間 onKeyDown 吞所有鍵（序列化保護）。jump＋key **不可同 tick 直送**：pttbbs typeahead 會跳過重繪（協定 §2）。配對期間 functionMode 的 clean-list settle 被 in-flight 吸收（reducer `event.inFlightKind → stay`），完成的 settle 才 resume（採落點游標）。**第二腿 timeout RTT 自適應**（`adaptiveTimeoutMs`＝clamp(4×jump腿rtt, 800, 3000)）——沒命中零回應只能靠 timeout 收尾，固定 3s＝「按了沒反應」；誤判提早 resume 無永久漂移（下一個錨定命令第一腿即歸位）。**只限這組鍵**：←/q 等離板鍵照舊 passthrough（多插回應會卡 menu 出口，live soak 實測）。pinned 選取無序號＝原 passthrough。**配對結束若 reducer 仍在 functionMode（沒命中＝只回訊息列，或 timeout）→ `_resumeAfterRelative` 強制回 buffer**。底列訊息不顯示（快取 feeter 蓋掉）＝與 native 已知小差異。守護：`list_keys.test.js`。
13. `relabelListCursorRow` 只在 cell 2 起有數字（● 真的蓋到數字）時回填 prefix；短序號（`/` 搜尋結果）● 蓋的是 padding，必須填空白——否則序號末兩位灌進行首並存進 map（污染跨頁殘留）。
11. edge 確認（markEdge/_requestEnd）後要 `_forceRedraw`——pinned 門控開啟需要重繪才可見。

## 已知限制

rows≠24 不 engage；buffer 模式滑鼠點擊瀏覽停用（滾輪照原生映射可用）；MODE_SELECT（`/` 篩選）以板名一致＋∈buffer/rebuild 涵蓋。

## 素材再錄

`$env:RECORD_MODE='list'; $env:RECORD_BOARD='C_Chat'; $env:RECORD_NAME='cchat-list-nav'; $env:RECORD_LIST_SCRIPT='nav'; yarn record:cassette`（guest 滿加 `RECORD_ALLOW_LOGIN=1`）。
pinned 卷＝`RECORD_NAME='cchat-list-pinned' RECORD_LIST_SCRIPT='pinned'`（要求該板置底 ≥3 篇）。
nav 腳本＝10 step（start/jump/pageup/jump/pageup/jump/open/back/jumpsame/pageup）。重放門控 map 在 `tests/e2e/helpers/replay.js#replayListCassette`（**jump/jumpsame 按 step.num 精確比對**）。offline 編排與 runtime 決策耦合：改 fill/demand 邏輯時 spec 內 prefetchCount／按鍵序列要重算（例：視窗 demand 觸發比舊選取邊距早——PgUp 一次即觸發，spec 只按一次就吃掉一對錨定命令，見 spec 內註解）。
