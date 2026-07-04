# 文章列表好讀模式 v4 — 架構

pref `enableEasyReadingList`（預設 off）＋`easyReadingListPrefetchCount`（預設 200，0=停背景 fill）。
三原則：**A 內容判定**（settle 只定何時評估；是什麼靠指紋謂詞，`docs/pttbbs-screen-protocol.md` §3-5）、**B 顯式狀態機**（ListSession 單一擁有者）、**C 命令序列化**（CommandQueue 單一 in-flight；typeahead 跳繪 §2）。誤判永遠往 native 降級（catch-all functionMode）。

## 檔案地圖

| 物件 | 位置 |
|---|---|
| 純函式層：`classifyListScreen`/`classifyListBurst`/`transitionListSession`/`mergeListPage`/`flattenListBuffer`/`shouldStopListPrefetch`/`moveListSelection`/`visibleListIndices`/`parseBoardName` | `src/js/list_session.js` 上半（unit：`tests/unit/list_session.test.js` 轉移表全枚舉） |
| class `ListSession(core,view,termBuf,queue)` | 同檔下半；`pttchrome.js` App constructor 接線 |
| `CommandQueue`（注入 send/timer、soft/hard timeout、flush 靜默） | `src/js/command_queue.js`（unit：`command_queue.test.js`） |
| 序號解析：`parseListArticleNum`/`isPinnedListRow`/`recoverCursorArticleNum`/`pageArticleNums`（單調修復） | `src/js/comment_parse.js` |
| settle snapshot（`{changedRows,curX,curY,pageState}` 凍結＋換新 Set） | `src/js/term_buf.js` `_armSettleTimer`；unit `term_buf_settle_snapshot.test.js` |
| render：redraw `listRenderMode ∈ {buffer,frozen}` 分支、`accumulateListLines`/`resetListAccumulation`/`relabelListCursorRow`/prepend 錨定/`hideCursor` | `src/js/term_view.js` |
| 鍵盤 hook（僅 buffer/frozen 觸發；native 全直通） | `term_view.js` `onKeyDown` |
| 測試 | offline `tests/e2e/offline/easy-reading-list.offline.spec.js`（CI gate）；live `tests/e2e/easy-reading-list.spec.js`（六案含 soak）；素材 `cchat-list-nav.json`(7 step)/`cchat-list-prompt.json`(3 step)，錄製 `RECORD_MODE=list RECORD_LIST_SCRIPT=nav|prompt` |

## 狀態機（reducer＝`transitionListSession`，unit 全枚舉為準）

states：`idle → active ⇄ functionMode`；`active → opening → suspended → active`。
`listRenderMode` 映射：active→buffer、opening→frozen、其餘→native（bindProperty 掛 term_buf）。

- idle：clean-list ∧ pref ∧ rows==24 ∧ `!buf.startedEasyReading` → active（seed＋start-fill）。**engage 守門不用 `view.useEasyReadingMode`**——article ER 離篇後該旗標仍 latch true。
- active：clean-list 板名同→continue-fill；板名異→rebuild（`s` 跳板/MODE_SELECT aliasing）；article→suspended 交棒；prompt/menu/transient ∧ 無 in-flight→functionMode（catch-all）；有 in-flight→stay（慢回應半畫 settle 是預期）。
- key（active）：nav（↑↓jk/PgUp/PgDn/Home/End）＝本地 moveListSelection＋方向性 demand；Enter/→＝opening（selectedNum 有值→begin-open；null＝pinned→begin-open-pinned）；其他鍵＝functionMode（**不 preventDefault**，鍵照送）。
- opening：settle 一律等 article（jump prompt 亂 settle 是預期）；timeout→functionMode 自癒；期間吞所有鍵（preventDefault）。
- functionMode：clean-list→active（landedNum∈buffer ∧ 板名同→只 resume；否則＋rebuild）；article→suspended；menu→idle cleanup；prompt/transient→stay。鍵盤 hook 不觸發＝全鍵直通。
- suspended：clean-list→restore（maps 不重建、重選 restoreNum）；menu→idle。
- 任意：pref-off/斷線→cleanup（單一出口）。

## 關鍵不變量（違反即 v3 復發）

1. **零內容 settle 不驅動轉移**：`_onScreenSettled` 開頭 `snap.changedRows.size===0 → return`。本地 `_forceRedraw` 也會 re-arm settle，不擋會把 key 驅動的 functionMode 在 server 回應前彈回 active。
2. **`_settleChangedRows` 只在 server 寫入點 add**（puts/clear/erase/insert/del/scroll 六處＋`_touchRows`）。**不可**掛在 `lineChangeds[row]=true`（term_buf:417 附近）——`needUpdate` 從不清除、updateCharAttr 每 notify 全重標，該點拿不到本窗髒列。
3. **跳號回應的 settle 底列是空的**（prompt 行清掉、feeter 下一回應才補；classify=transient 永不 clean-list）→ 所有 jump 類 expect 用「park 在 entry 區 col≤1 ∧ 游標列=目標序號」判定（協定文件 §4 補充；`cchat-list-nav` jump step 實錄）。
4. demand 預讀只朝移動方向（單頁 buffer 裡兩端都「近邊」，無方向會反向亂抓）。
5. pinned map key＝`pinnedRowKey`（author|title；title-only 會把同標題不同作者的公告蓋成一篇＝stabilize bug 2a；整列文字則推文數變動生重複列＝v3 bug 5a）。游標停在置底列（有★可辨）仍收錄、● 兩格還原空白（bug 2b）；無★的游標列仍排除（v3 坑 4）。`_pinnedKeyAt`（選取身分）必須用同一函式。
5b. **frozen 讓位 pageState 3**（redraw list 分支條件 `pageState !== 3`）：opening→suspended 有 settle 空窗，latched article ER 已在快路徑翻頁，frozen 遮蔽那些幀 → 文章前段頁永久漏（stabilize bug 1）。
5c. **預讀＝錨定命令對**（stabilize bug 3）：真游標會被開文/functionMode 移走，盲送 PgUp 會填 buffer 中段、邊緣不長（卡住）＋中段插入打壞捲動補償（亂跳）。每次 prefetch＝`跳號到 bufferEdgeNum(方向)` → `PgUp/PgDn`（cursor 越過錨點=新頁、等於錨點=到邊）。一律跳（不做已在位 fast-path，決定性優先）。錨定失敗 onFail 要 flush 掉排隊中的翻頁令。
6. 選取以序號為身分（prepend 位移不變）；pinned 選取以標題 key。
7. 預讀 timeout＝良性到邊（不翻模式）；開文 timeout＝functionMode 自癒。flush 一律靜默（殘餘回應由 native 鏡像吸收）。
8. CommandQueue 的 timer 要包 wrapper——裸存 `setTimeout` 以 method 呼叫在瀏覽器丟 Illegal invocation（jsdom 寬容測不到，offline e2e 抓到的）。
9. `_renderScreenLines` 第 5 參 `enhanceOverrides`：list 分支傳 `{pageState:2}`，transient 幀也走 LIST 黑名單註記。
10. `visibleListIndices` 必須與 `Screen#computeAnnotations` PAGE_LIST 分支同規則（兩處都有互指註解）。

## 體驗層（optimize 輪，list_session.js 常數為準）

- **fill cap**：初始背景 fill 上限 `FILL_MAX_PAGES=3`（多了＝進板閃動）；其餘靠 demand。`easyReadingListPrefetchCount` 只是 target 上界。
- **總量 cap**：`MAX_LIST_ROWS=300`。`evictListBuffer(numMap, selectedNum, cap)`（純函式，unit 有測）丟離選取最遠端；`accumulateListLines` 於 merge 後呼叫，evict 過的向呼 `session.noteEvicted(dir)` 清 `_edgeUp/_edgeDown`（demand 可重抓）。redraw 捲動補償條件是 `newTop !== prevTop`（prepend 為正、頂端 evict 為負，同一公式）。`_restore` 對被 evict 的 restore 目標 fallback `_selectLastNumbered`。
- **demand 三來源，鏈式不跨來源**（跨了 offline 門控與停止條件都不可決定）：`fill`→`_maybeFill`；`key`（`_maybeDemand`，margin `DEMAND_MARGIN=10`）；`wheel`（`_maybeDemandViewport`，視口距邊 <2 視口高即抓）。
- **wheel listener 掛 `mainDisplay` 的 `wheel` 事件、非 `scroll`**：prepend 補償/scrollIntoView 會發 `scroll`，用它會讓程式化捲動觸發 demand（offline 門控炸、真游標亂跑）。另 `pttchrome.js mouse_scroll`（window capture）在 buffer/frozen **必須早退**——否則滾輪被轉成 doArrowUp/Down bytes 送 server＋stopPropagation 吃掉事件（實測就是這樣壞的）。
- **置底文開啟 `_beginOpenPinned`**：`jump 最大序號`（序號是穩定身分，新文不影響；跳號必有回應）→ `End`（**不可單發**：游標已在底端時 server 零回應必 timeout，live 實測）expect＝park ∧ 目標 pinned 列在畫面上（`isPinnedListRow`＋`pinnedRowKey` 內容定位，非盲數步數）→ `↑/↓`×n 逐步 expect curY，末步再驗 key → Enter expect article。失敗全走 open-timeout 自癒。restore 用 `_restorePinnedKey`。

## 已知限制（v1）

rows≠24 不 engage（謂詞仍 rows-relative）；buffer 模式滑鼠點擊瀏覽停用（滾輪＝DOM 捲動照常）；MODE_SELECT（`/` 篩選）以板名一致＋∈buffer/rebuild 涵蓋（篩選空間序號會 rebuild，離開篩選再 rebuild）。

## 素材再錄

`$env:RECORD_MODE='list'; $env:RECORD_BOARD='C_Chat'; $env:RECORD_NAME='cchat-list-nav'; $env:RECORD_LIST_SCRIPT='nav'; yarn record:cassette`（guest 滿加 `RECORD_ALLOW_LOGIN=1`，有等長 redact＋assertNoLeak）。
pinned 卷＝`RECORD_NAME='cchat-list-pinned' RECORD_LIST_SCRIPT='pinned'`（jumpmax/end/up/up/open/back，要求該板置底 ≥3 篇；offline 測試取 pinned tail 倒數第 3 為目標）。
nav 腳本＝10 step（start/jump/pageup/jump/pageup/jump/open/back/jumpsame/pageup），對應「錨定 fill 對×2 → 開文兩段 → back → restore 後 demand 對」；jump 目標由 `window.__pageArticleNums`（dev build 曝露）取當前頁最上方序號，與 runtime `bufferEdgeNum(up)` 一致。重放門控 map 在 `tests/e2e/helpers/replay.js#replayListCassette`（gating 掛 stub WS send 層；**jump/jumpsame 按 step.num 精確比對**——不匹配的跳號寧可 timeout（runtime 視為良性到邊）也不吃錯 step）。offline 編排與 runtime 決策耦合：改 fill/demand 邏輯時，測試裡的 prefetchCount／按鍵序列要跟著重算（見 spec 內註解）。
