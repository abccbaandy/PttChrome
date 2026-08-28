# 好讀模式（EasyReading）架構與踩坑

對應 `src/js/easy_reading.js` + `src/js/term_buf.js`(settle pageState) + `src/js/term_view.js`(render) + `src/js/pttchrome.jsx`(切換/按鍵)。
狀態旗標：CONFIRMED（已 e2e 實證）/ guess。

## 機制（CONFIRMED）

- 啟用條件：pref `enableEasyReading`(預設 **false**，`PrefModal.jsx` `DEFAULT_PREFS`) && `connectedUrl.easyReadingSupported`(`pttchrome.jsx` true)。使用者自己開，存 localStorage `pttchrome.pref.v1`。
- 啟用旗標：`view.useEasyReadingMode`，由 `bindProperty` 綁成 `EasyReading._enabled`。
- 進文章(pageState 3)後由 `_onChanged` 判斷、`_onViewUpdated` 送 PageDown(`\x1b[6~`)把整篇累積成可捲動長頁（決策落純函式 `nextEasyReadingRowState`；`_onChanged` 已抽 `_computeRowState`+`_applyRowState` 兩 helper 供快路徑與兜底共用）。長文章(精華區索引)因此自動翻頁久、攔截 `/` 等鍵 → 原生搜尋不可用。
- **翻頁＝單一 in-flight 交易（2026-08 重構，治「※ 發信站/※ 文章網址 那段消失」，依據 `docs/pttbbs-screen-protocol.md` §13 P1/P3/P4/P6）**：
  - **why**：pmore 的 `refresh()` 在 client 還有按鍵在途時直接 return **不畫**（P4）⇒ 同一頁送出兩個 PageDown，中間那頁的畫面**永遠不會送出來**，該頁的字永久消失。舊版快路徑 `_onViewUpdated` 記下頁面簽章卻**從不檢查**（只有 settle 路徑有去重），任何在同一頁再出現一次的完整幀（functionMode resume 的強制 notify、水球重繪…）就再送一次 → 掉頁。
  - **how**：`_inFlightSig`＝已送出 PageDown 的那一頁簽章（狀態列 `第 S~E 行`），ack ＝**簽章改變**。快路徑與 settle 路徑共用純函式 `nextPageDownDecision`（`send`/`wait`/`retry`/`giveup`/`done`/`none`），入口統一在 `_maybeSendPageDown`。
  - **到底判定用 `pagePercent === 100`**（P3：`progress==100` ⟺ `mf_viewedAll()`，整數除法剛好等價）。狀態列首格顏色（VIEWALL `37;44`）降為 fallback——footer 是 per-cell patch（P6），單格顏色比讀百分比脆弱。到底後再送 PageDown PTT 是**零回應**，所以絕不能靠 timeout 判斷。
  - **bounded retry 由「送鍵後經過多久」判定，不是「畫面靜止」（2026-08 修，治超長文自動跳回第一頁）**：上限仍是 `PAGE_DOWN_MAX_RETRIES=1`，但補送的前提改成 `sinceSentMs >= PAGE_DOWN_GRACE_MS`（600ms），由 `nextPageDownDecision` 的 `recovery`＋`sinceSentMs` 決定；未達門檻回 `wait`。
    - **why**：settle 計時器是被**送鍵之前**抵達的畫面 arm 的（`term_buf.notify` → `_armSettleTimer`）。長文累積頁 4600+ 列時 React render 很慢（實測翻頁週期從 48ms 惡化到 200ms+），callback 被延到自己送鍵之後才跑 ⇒ 它量到的「靜止」與「PTT 沒回應」無關。實錄 `ptt-debug-20260809`：t=23047 送鍵、t=23124 settle 判定掉包補送、**同一毫秒**真正的回應才到 ⇒ 兩個 PageDown 在途 ⇒ P4 吞頁 ⇒ 自癒送 Home ⇒ 4700 行整篇重讀。
    - **必須配 watchdog，不能只加 grace**：`_armSettleTimer` **只由伺服器活動 re-arm**（`_serverActivity`／`posChanged`）。按鍵真的掉了 ⇒ PTT 零回應 ⇒ **不會再有第二次 settle**。所以重試改由 `EasyReading._armWatchdog()`（`setTimeout(grace+20)`，以自己送鍵的時刻為錨）驅動；settle 保留為第二觸發點。
    - **`_watchdogSig` 身分閘是承重的**：回應在 grace 內到達時 `_inFlightSig` 已換頁，計時器一律空轉——少了它就會在重繪途中多送一個鍵，正好製造 P4。
    - **retry 一律重送 `_inFlightKeys`，不是呼叫端傳進來的 keys**：在途的交易可能是缺頁自癒的 `:N\r` 而不是 PageDown。
  - **交易狀態是 per-article，重置點＝文章邊界（`_resetPagingState`，2026-08）**。涵蓋 `_inFlightSig`／`_inFlightKeys`／`_inFlightSentAt`／watchdog／`_pageDownRetries`／自癒額度／`easyReadingReachedPageEnd`／`sendCommandAfterUpdate`／**`ignoreOneUpdate`**。
    - **`ignoreOneUpdate` 殘留是硬卡死，不是「少一幀」**：它 halt 掉的那一幀通常正是 `enterEasyReading()` 自己重播的 `notify()`，而那是**本地**重繪（沒有 `_touchRows` ⇒ `_serverActivity` false ⇒ **不 re-arm settle**）⇒ 連 `screenSettled` 兜底都沒有 ⇒ 那一篇一個 PageDown 都送不出去。`leaveCurrentPost()` 因此改成「先 `_resetPagingState()` 再視情況重新點起」，順序不可調換。
    - **`sig` 不跨文章唯一**：每篇文章第一頁都是 `1~22`。殘留的 `_inFlightSig` 會把下一篇的第一頁當成「上一篇那個還沒回應的請求」→ 快路徑永遠 `wait`、settle 用完重試上限後永遠 `giveup` ⇒ **一個 PageDown 都送不出去，卡在第一頁；換文章照樣卡**。
    - 邊界由 **settle 過的 pageState 進出 3** 判定（`_onPageStateSettled`：`1|2 → 3` 或 `3 → 1|2`）。**只認 1/2**：文章中途狀態列失配一幀而掉出 3 再回來不是換文章，重置會讓同一頁重送 PageDown（正是 P4 要防的）。
    - 不經列表的文章→文章（`[` `]` 同標題跳、`a/b/f/=/+/-`）沒有 1/2 邊緣，由 `leaveCurrentPost()` 補上；`enterEasyReading`/`exitEasyReading`/`_healFromTop` 也走同一個 helper。
  - **`_onScreenSettled` 不得被 `easyReadingReachedPageEnd` 早退否決**：settle 路徑必須對當下畫面冪等，「到底了」已由 `pagePercent` 在 `_computeRowState` 與 `nextPageDownDecision` 各算一次。
  - **使用者自救 `_kickPageDown()`**：PgDn（鍵盤與滑鼠）在累積頁**捲不動**且狀態列 `pagePercent < 100` 時，清掉交易狀態並補送一次 PageDown。自動翻頁的所有失效模式在使用者眼裡長得一模一樣（長頁停住、PgDn 毫無反應），要有一條手動出口。
  - **debugRecorder `easyReading.pageDown` / `easyReading.pageDownKick`**：記 `retry`/`giveup`/`done`（`send`/`wait` 不記——一個看得到送出事件、一個每幀都有），payload 含 **`sinceSentMs`**（小值的 `retry`＝誤重試 bug 再現，大值＝真的掉鍵，沒有它分不出來）。沒有這些 log 時，所有卡法在素材裡都只是「進文章後零 send」，分不出是重試額度用完還是旗標殘留。
- **累積只在「完整回應幀」（P6）**：`term_view.accumulatePageLines` 以 `buf.cur_y === rows-1 && buf.cur_x === cols-1`（pfterm 每次回應結尾才 park 游標）當閘。半畫幀的 footer 還是**上一頁的舊值**（per-cell patch，狀態列補丁與 park 排在內容之後），拿它算重疊會把舊行號寫進 `_accEndRow`，之後整條去重都建在錯基準上——舊版的 drift guard（比對率 0.5）就是在補這個。不完整的幀只重畫、不動 `pageLines`。
- **掉頁偵測與自癒（P1）**：`comment_parse.classifyPageTransition` 判 `restart`/`continuation`/`gap`/`backward`。`gap`＝`statusStart > accEndRow + 1`，而 PageDown ＝ `mf_forward(dispedlines-1)` 保證 `S' == E`（末頁被 `maxdisps` 夾則更小），**`S' > E` 不可能** ⇒ 一定是中間整頁沒收到。舊版 `resolvePageOverlap` 把負重疊夾成 0 → 照常 append → 破洞無聲。現在 `accumulatePageLines` 升 `buf.easyReadingGapDetected`，由 `EasyReading._healGap()` 處理。
  - **自癒策略順序（2026-08 改，治超長文整篇重讀）**：`HEAL_GOTO_MAX=3` 次**精準跳回缺頁行** → 1 次 Home 從頭重讀（`_healFromTop`，最後手段）→ 放手（畫面維持現狀，PgDn／切原生熱鍵都還在）。額度 per-article，由 `_resetPagingState` 重置。
  - **精準跳回 `_healAtLine(N)`**：送 `:` + N + `\r`。pmore `case ':'`（`pmore.c` goto 區塊）走**行號**模式（`pageMode = (ch != ':')`），`getdata_buf(PMORE_MSG_GOTO_LINE, buf, 8, DOECHO)` → `i = atoi(buf)` → `if (i-- > 0) mf_goto(i)` → `mf.disps = mf.start; mf.lineno = 0; mf_forward(N-1)` ⇒ 落地畫面 `目前顯示: 第 N~… 行`。
    - **N 取 `_accEndRow`，不是 +1**：`statusStart === accEndRow` 正是 PageDown 自己的後置條件（P1 `S' == E`），落地幀與正常翻頁**形狀完全相同** → `continuation` → `resolvePageOverlap` k=1 → `append`，零新路徑，還多一列可做內容交叉驗證。末頁被 `maxdisps` 夾住只會讓重疊變大，兩個方向都安全。
    - **不動任何累積狀態**：`pageLines`／`_accEndRow`／`_lastAccumulatedSig`／`scrollTop`／`_articleInstanceId` 全部保持——缺的那幾列在落地幀的 append 補進去。
    - **heal 本身是一筆 in-flight 交易**（`_inFlightSig` 設成當下簽章、`_inFlightKeys = ':N\r'`、arm watchdog）。舊 `_healFromTop` 先 `_resetPagingState()` 清成 null 才送鍵 ⇒ 任何搶先抵達的完整幀都會讓決策回 `send` ⇒ 又一個 PageDown 撞 P4。
  - **`buf.easyReadingHealInFlight` 是承重的兩道閘**（goto prompt 佔住底部列，狀態列失配 ⇒ 該幀 `pageState` 可能不是 3）：
    1. `decideAccumulateBranch` 的 `healInFlight` 封住**兩條 rebuild 路徑**。`term_view.redraw` **每個渲染幀結尾都寫 `buf.prevPageState = buf.pageState`**，一幀污染就會讓落地幀命中 `prevPageState !== 3 → rebuild` ⇒ **從文章中段重建 `pageLines`、靜默刪掉上面全部內容**，比它要修的掉頁更糟。`gap` 與 P6 的 `skip` 刻意仍然生效。
    2. `_onScreenSettled` 早退，否則 `pageState !== 3 → _teardownAccumulationOffArticle()` 會呼叫 `hideEasyReadingOverlays()` 把 `pageLines` 清空。
    旗標由 `accumulatePageLines` 在 append 成功時清掉；PTT 完全沒回應時由交易的 `giveup` 清掉（有界，不會卡死）。
  - **debugRecorder `easyReading.gapHeal`** 帶 `{mode: goto|home|exhausted|busy, accEndRow, screenStart, missingLines, targetLine, gotoCount, homeUsed}`。舊版**完全沒有 payload**，而且額度用盡那條只有 `console.log` 不進 recorder ⇒ 素材裡看到 1 筆其實可能發生過很多次。
- **補畫一律走 `term_buf.notify()`（`_forceRepaint`），不可直接 `view.redraw()`**：`updateCharAttr()` 只在 notify 裡跑，它是 Big5 lead byte 標上 `isLeadByte` 的地方。settle 可能落在「bytes 已到、30ms notify 計時器還沒跑」之間，直接 redraw 會把未轉碼的列 clone 進 `pageLines`，`rowToText` 得到原始 Big5（`¡°` 而非 `※`）→ 下一頁比對不上 → 重疊算成 0 → 重疊列貼兩次（離線拆幀測試抓到的重複「※ 文章網址」）。
- **settle 兜底（`_onScreenSettled`）**：PTT「把游標停到底部狀態列」可能是**獨立的純游標 escape（只設 `posChanged` 不設 `changed`）**，落在自己的 notify 視窗 → `if(this.changed)` 區塊整段跳過 → 該回應**從沒進過 redraw/accumulate**。`screenSettled` 在「畫面真靜止（內容＋游標都停）」時比對 `view._lastAccumulatedSig`，不同就 `_forceRepaint()` 補一次（補畫會重播 change/viewUpdate，翻頁決策由快路徑接手，settle 隨即 return）。
- **離開文章的清理改由 settle 觸發**：`term_view.redraw` 對「好讀開啟 ∧ `buf.settledPageState === 3` ∧ 有 `pageLines`」的 transient 幀**繼續畫累積頁**，不再落到會清空 `pageLines` 的 native 分支（pageState 是逐幀分類，半畫的 footer 會讓它掉出 3 一幀，舊版因此整篇累積被丟掉、下一個完整幀從當前頁重建 → 前面全沒了）。真正離開時由 `EasyReading._teardownAccumulationOffArticle`（settle，debounced 狀態已同意）做 `hideEasyReadingOverlays()`＋重繪。
- 自動「重新啟用」（**settle 後判斷，2026-06 重構，CONFIRMED 純邏輯/手動驗**）：靠 term_buf 的**去抖動** pageState 串流，不再逐 frame 判。`term_buf` 維護 `settledPageState`/`prevSettledPageState`：`notify` 每個 `changed` **或純游標(`posChanged`)** 視窗都 re-arm 一個 `SETTLE_MS=50`(`term_buf.js` 頂常數) 計時器（抽成 `term_buf._armSettleTimer`）；資料/游標持續到達(~30ms 間隔)時一直 re-arm 不觸發，**畫面真靜止（內容＋游標都停）50ms 後**才觸發：`pageState` 改變時升 `settledPageState` 並 dispatch `'pageStateSettled'`（auto-enable 邊緣），且**每次靜止都另 dispatch `'screenSettled'`**（供 mid-article 的翻頁兜底 `_onScreenSettled`，pageState 維持 3 時也會收到）。`EasyReading._onPageStateSettled` 監聽該事件，呼叫純函式 `nextEasyReadingState({settledPageState,prevSettledPageState,enabled,enablePref,supported})`（`easy_reading.js` 頂部 export，unit test `tests/unit/easy_reading_logic.test.js`）。條件 `settledPageState==3 && (prevSettledPageState==2 || prevSettledPageState==1) && !enabled && enableEasyReading && supported`，即「**列表(2) 或選單(1) → 文章(3)**」的乾淨 settle 邊緣。enable 由**單一入口** `enterEasyReading()` 執行（見下「切換」段）。
- **為何來源集含選單(1)（CONFIRMED 讀碼）——勿收緊回 `==2`**：精華區（文章列表按 `z` 進入）頂層首列 `【精華文章】`→`pageState 1`(MENU，`term_buf.js` pageState 判定)，子目錄清單落 MENU(1) 或 LIST(2)，兩者都能 Enter 直接進文章 → 只認 `==2` 時精華區的 `1→3` 邊緣不成立，切原生後卡原生直到回真看板列表。主功能表/分類看板雖也是 MENU(1) 但無法直接開文章（必先經看板 LIST(2)），故 `1→3` 實務上只來自精華區，含 1 安全。pass/edit/normal(5/6/0) 不在來源集→原生模式內看說明(5)再回文章(3) 的 `5→3` 不會誤重啟。
- transient 0 為何不污染：half-paint frame(末列空→`pageState=0`，`term_buf.js` pageState 判定)後續一定有更晚的視窗 re-arm 計時器，故 0 永不 settle；settle 只抓「最後靜止值」(3)。列表→文章的 settled 串流乾淨無 0，**無需 latch**。
- **退出抑制靠 `exitEasyReading` 主動對齊 settle 快照，不是「天生正確」（2026-08 修正，治「F8 切原生卡在最後一頁」）**：舊敘述假設退出當下 `settledPageState` 已是 3、不再升級 → 不觸發邊緣。**該假設只在「這篇文章開著時至少 settle 過一次」才成立**，而自動翻頁每 ~30-40ms 重畫一次，50ms 計時器全程被 re-arm ⇒ **整篇讀完可以一次 settle 都沒有**（長文＝翻頁次數多＝更容易），`settledPageState` 仍停在**進文章前的列表(2)**。退出後的第一個安靜點（`switchToEasyReadingMode` 的 ^L 重繪）settle 成 3 ⇒ 假的 `2→3` 邊緣 ⇒ `nextEasyReadingState` 重開好讀 ⇒ 從文末那頁重新累積、footer 已 100% ⇒ 不再送 PageDown ⇒ 使用者看到的就是「F8 後卡在最後一頁」。
  - 修法：`exitEasyReading()` 呼叫 `term_buf.syncSettledPageState()`（`prevSettled = settled = 當下 pageState`，**不造成邊緣**）。刻意取「當下值」而非硬寫 3：若正好落在半畫幀(0)，後續補完只會是 `0→3`，不在 `1|2→3` 來源集內，同樣安全。
  - 證據：`ptt-debug-…-204141.json` — 進文章後每 32~43ms 一次 recv 全程無 50ms 空檔 → `easyReading.exit`(t=2035) → `easyReading.enter`(t=2135)。守護：`tests/unit/easy_reading_native_switch_settle.test.js`（用真 `TermBuf.notify/_armSettleTimer` 驅動 30ms/50ms 鏈）。
- **第二條重啟邊緣：原生模式下換到另一篇文章（`nextEasyReadingReentry`，2026-08，治「半永久原生模式」）**。`nextEasyReadingState` 只認 settled `1|2 → 3`，而切原生後用 `[` `]` `a` `b` `f` `=` 跳下一篇**全程 pageState 都是 3**，根本不會有邊緣 ⇒ 一路卡原生直到繞回列表。
  - 條件：`!enabled ∧ pref on ∧ supported ∧ !functionMode ∧ pageState 3 ∧ 游標已 park ∧ statusStart === 1 ∧ articleKey **與** nativeArticleKey 皆可讀 ∧ articleKey !== nativeArticleKey`。在 `_onScreenSettled` 的 `!_enabled` 分支評估（`_maybeReenterOnNewArticle`）。
  - **刻意用文章身分而非 pageState 邊緣**：docs 上面那條明令「掉出 3 再回來不是換文章」；而唯一擋不掉的誤觸發是「使用者在原生自己按 Home/`0`/`g` 回到第 1 行」——比對 `articleKey`（畫面第 0~2 列＝作者/標題/時間，只取 row 0 會在同作者 `a` 跳文時撞號）直接擋死。
  - **`_articleKey` 的捕捉點是 `_applyRowState`（每個 `statusStart === 1` 的幀重抓一次），不是 `enterEasyReading()`**（2026-08 修「原生下按 Home 就被切回好讀」的根因）。header 只在第一頁在畫面上，而「這篇變成當前文章」有三條路，只在 `enterEasyReading()` 抓會有兩條存到**錯的** key ⇒ 身分比對形同虛設：
    | 路徑 | 舊版存到什麼 |
    |---|---|
    | settle `1\|2→3` 進文章 | 正確（畫面就是第一頁） |
    | `[` `]` `a` `b` `f` `=` 跳下一篇 | **上一篇**的 key（好讀已開 ⇒ 不經 `enterEasyReading`，見 `_onPageStateSettled` 註解） |
    | F8 toggle 從中段切回好讀 | **內文**（`reenterFromTop` 先 `enterEasyReading()` 再送 Home，捕捉當下還在中段） |
    `enterEasyReading()` 改為只清成 null；`leaveCurrentPost()` 也清（跳文路徑的結構性保險）；`exitEasyReading()` 把它搬到 `_nativeArticleKey`。捕捉點受 `_enabled ∧ !_functionMode` 閘（`_onChanged` 早退），prompt/選單幀不會污染。
  - **兩邊身分任一讀不到就不重啟**（寧可留在原生）：fail-safe，熱鍵永遠還在。舊版「`nativeArticleKey` 為 null ⇒ 視為可重啟」是 **fail-OPEN**，只要捕捉漏一次，同一篇按 Home 就會被切回好讀。這條路徑本來就只為「使用者主動切原生後跳文」存在，一般 `列表→文章` 由 `nextEasyReadingState` 負責，不靠它。
- 退化情形（guess）：連線在**畫面中途**停 >`SETTLE_MS`（網路卡）才可能 premature settle；最壞首篇自動 enable 漏一次（捲動/重進即恢復），非 crash。`SETTLE_MS` 為可調常數，slow link premature-settle 就調高。

## render 單軌（兩模式同走 `ScreenController`）

兩模式都走 `renderScreen()`＝把 `lines` 交給 `ScreenController.update()`（`term_ui.js` → `src/render/screen.js`），**controller 單一擁有 `#mainContainer`**。差別只在傳進去的 `lines`：

> **2026-08 核心渲染鏈已去 React 化**：`<Screen>`/`<Row>` 換成 `src/render/`（純 JS DOM）。
> 週邊 UI（設定頁／右鍵選單／各種 alert／上傳浮層）與 `ImagePreviewer` 仍是 React，各自獨立 root。
> 對外介面沒變：`term_view` 照樣呼叫 `renderScreen(...)` 與 `componentScreen.setCursorHighlight(...)`。
> DOM 產物逐字不變，由 `tests/unit/fixtures/screen_golden/` 的整份快照守（golden 是改寫前用 React 版產生的）。

| 模式 | `lines` 來源 | 黑名單列 |
|---|---|---|
| 原生 / 好讀列表選單(pageState≠3) | `buf.lines`（單頁 24 列） | `visibility:hidden`（保固定格線，`enhance.dropHidden=false`） |
| 好讀文章(pageState 3) | `buf.pageLines`（累積長頁，`term_view.accumulatePageLines` 純 JS 去重：`comment_parse.resolvePageOverlap`＝狀態列行號為主、`findPageOverlap` 內文比對為輔） | 整列移除（該列不產生節點，`dropHidden=true`，長卷無空行） |

- 逐列加工（blacklist/樓層/作者高亮/pusher 高亮）統一在 `src/js/screen_annotations.js#computeAnnotations` 一處（純函式、零 DOM）。好讀文章因 `lines=完整 pageLines`，`new FloorCounter()` 一次走完整篇 → 跨頁樓號自然正確（已**無** view 端持久計數器 `_floorCounter`）。
- `dropHidden` 移除的列**不位移**其餘列 `data-row`（=pageLines 絕對索引）；`getText` 用絕對 index → 選取/複製跨缺口仍對齊。
- pusher 高亮：`togglePusherHighlight` 設 `_selectedPusher` + `componentScreen.setSelectedPusher(id)`（兩模式同）—— renderer 逐列搬 class，**不重畫**。`selectedPusher` 因此**不在 `annotationsKey`** 裡；它在裡面的年代，點一下推文列＝整份長頁重算＋每列節點重建＋所有 `inlinePreviewSlot` 塌陷重建（症狀：合併推文空白區閃爍、雙擊選字時好時壞）。細節見 `docs/enhanced-addon.md`「點選推文者高亮」。
- 好讀 footer overlay 列（`#easyReadingLastRow`）是 `BBSWin` 下獨立 div、非螢幕容器，另外單獨畫（`term_ui.renderOverlayRow` 單列），不涉所有權衝突。**它是全專案唯一不經 `computeAnnotations` 的渲染路徑**，所以「功能鍵可點」在這裡要自己接：`term_view._mirrorStatusRowToFooter` 呼叫 `footer_keys.parseFunctionKeys(chars)` 後經 `renderOverlayRow` 的第 4 參數帶進去（`docs/mouse.md`「功能鍵按鈕」）。它沒有 `pointer-events:none` ⇒ 點得到；每次都整個 `replaceChildren` 重建，listener 隨舊節點丟掉，無洩漏。（另一個 `#easyReadingReplyRow` 已隨 legacy overlay 路徑移除，見 functionMode 節。）
- **圖片預覽（`_renderScreenLines` 的 `inlinePreview`/`hoverPreview` 兩參數，CONFIRMED e2e）**：好讀文章 `inlinePreview=true`+`hoverPreview=false`（自動行內開圖，每個連結旁掛一個延遲載入佔位盒，**不**受 `enablePicPreview` pref 約束）；原生 `inlinePreview=false`+`hoverPreview=enablePicPreview`（hover 才開）；好讀列表/選單兩者皆 false。守護：unit `image_preview.test.js`（ScreenController→buildRow→builder 接線）+ e2e `easy-reading.spec.js`「好讀模式自動行內開圖」。
- **累積頁的每頁 render 成本必須是 O(新增列)，不是 O(文章)（2026-08，CONFIRMED unit 計次＋offline e2e 曲線）**：`term_buf.notify` → `view.update()` → `redraw()` → `_renderScreenLines(buf.pageLines)` → `renderInto` 的 **`flushSync`** ⇒ 每收到一頁就**同步**重算＋重建整份累積頁。舊版每幀對全部 n 列重跑 `rowToText`/`annotateComment`/`detectRowExtras`（五組偵測）＋對每個推文合併 run 重跑 `buildMergedCommentChars`＋重建 n 個 `<Row>`（每列 80 個 TermChar 過 `LinkSegmentBuilder`）⇒ 每頁 O(n)、整篇 O(n²)。實錄 `ptt-debug-20260809`（8512 行）翻頁週期 55ms→1196ms。**這不只是體感**：週期一旦越過 `PAGE_DOWN_GRACE_MS`(600)，watchdog 就誤判掉包 → 補送 PageDown → P4 吞頁 → 缺頁自癒 → 「讀到一半跳回第一頁」「卡住不讀」。修法兩層，都在 renderer（現為 `src/render/screen.js`）＋純函式 `src/js/screen_annotate_cache.js`：
  1. **增量標註**：累積是純 append（`pageLines.concat`，舊列的 TermChar[] 參考永不變），故前綴的 `texts`/`base` 標註/`FloorCounter` 實例/AI 候選清單全部沿用，逐列偵測只跑新增的列。推文合併 run 以 `mergeRunKey`＋該 run 每列的 base 參考當快取鍵；圖文合併塊以塊座標＋base 參考當鍵。
  2. **逐列節點快取**：沿用**同一個 DOM 節點**、完全不重建那一列。重用條件＝列 chars 參考、最終 annotation 物件參考、該列高亮狀態三者皆未變。所以第 1 層必須讓沒被裝飾到的列**沿用同一個 annotation 物件**（base/result 分兩層的理由）。去 React 化之前這層是「交回同一個 React element 物件」讓 React 走 `bailoutOnAlreadyFinishedWork`，判準一字相同。
     - 原生 24 列／列表視窗沒有 `stableRows`（活 buffer），退路是「重建後比對 `outerHTML`，一字未變就沿用舊節點」⇒ 使用者的選取範圍不會每 30ms 被抽換一次。長頁走上面的參考快取，不付這個序列化成本。
  3. **dirty-row 逐列 patch（2026-08，第 3 層）**：上面第 2 層的退路仍然付了「建節點 + 兩次 `outerHTML` 序列化」×24。這一層讓 renderer 對「這一幀沒被寫過的列」**完全不建節點**。兩個 dirty 來源，都由 `term_view.redraw` 放進 `enhance`：
     - `changedRows`：活 buffer（`buf.lines`）這一幀 server 寫了哪幾列，來自 `buf.lineChangeds`。**`TermChar.needUpdate` 2026-08 才去 sticky**（`updateCharAttr` 消費完就清），在那之前任何寫過一次的列永遠 dirty，`lineChangeds` 等於全部列、`redraw` 裡那行逐列 `continue` 幾乎永不生效。
     - `rowIdentityStable`：列表好讀視窗的列是 `cloneRow` 快照（存進 `_listNumMap` 之後不再就地改寫）⇒ 列參考相同即內容相同。frozen 幀 24 列全部命中。
     - **功能鍵按鈕（`enhance.functionKeyRows`）刻意繞開這一層**：`term_view._renderScreenLines` 只在 `!ov.stableRows` 時才算它 ⇒ 累積長頁的兩條分支（帶 `STABLE_ROWS` 的）**永不拿到**這個欄位，增量快取零風險。它逐列獨立，故 `annotationsAreRowIndependent` 不必改；但**必須進 `annotationsKey`**（`functionKeyRows` ＋ `onFunctionKey`），否則列表好讀視窗的 `rowIdentityStable` 會讓切 pref 完全不生效——理由與回歸鎖見 `docs/mouse.md`。
- **守門住在 `src/js/screen_annotations.js#annotationsAreRowIndependent`，不在 `term_view`**：`term_view` 只回報事實，「這組 enhance 能不能只重畫 dirty 列」由標註端決定（跨列耦合全長在 `computeAnnotations` 裡）。`pageState 3` 一律拒絕——functionMode 原生鏡像與防黑守門兩條分支會帶著 `easyReading:true` 把活 buffer 交進來，FloorCounter／推文合併／圖文合併全開，只重畫 dirty 列會讓樓號永久位移。
     - 逐列的承重條件是 `prevLines[row] === lines[row]`，一次擋掉「原生 24 列 ↔ 列表視窗 24 列互換」「`buf.lines` ↔ `buf.pageLines` 互換」「`term_buf.scroll()` 把列物件搬到別的 index」三件事，所以呼叫端不需要自我宣告來源 token。
     - 收益集中在**列表好讀本地 nav／frozen 幀**（來自 `rowIdentityStable`；那條路徑走 `_forceRedraw`，`changedRows` 恆為全列）與**原生列表按住 ↑↓**（pttbbs 只重畫游標前後兩列）。好讀累積長頁走 `stableRows`，這一層不介入。
     - 停用開關：`annotationsAreRowIndependent` 恆回 `false` ＋ 拿掉 `rowIdentityStable`，兩行就回到只有前兩層的行為。
     - 守護：`tests/unit/screen_dirty_rows.test.js`（等價性一律拿「全新 controller 全量重建」當對照組逐字比 DOM）、`tests/unit/term_buf_dirty_rows.test.js`（dirty 不得漏報：真 cassette 逐步重放＋逐列內容簽章）、`tests/unit/render_dispose.test.js`（沿用的列不得被 dispose、換掉的列不得洩漏）。
  - **`enhance.stableRows` 是這整層的前提，只有累積頁那兩個 render 分支帶（`term_view.js` 的 `STABLE_ROWS`）**：那裡的列是 `cloneRow` 快照、append 後永不再被寫；原生 24 列畫面與列表視窗是 `term_buf` **就地改寫**的活 buffer，列參考一路不變而內容每幀在變，套快取會一直畫出上一幀的內容。
  - 一次性全量重算仍在（改設定、切圖文合併）：超長文會卡一幀，已知取捨。**點推文者高亮已不在此列**（2026-08 改成 class 層切換）；若日後又有互動狀態被塞進 `annotationsKey`，先看那條踩坑。
  - 守護：`tests/unit/screen_annotate_cache.test.js`（純判準）、`tests/unit/screen_incremental_render.test.js`（**等價**：逐頁 append 的 DOM == 一次到位的 DOM；**增量**：append 22 列後重新標註／重建的列數 < 80，舊 code 是 1311）、offline e2e `ezsoft-longpost.json` 150 頁的 head/tail 週期曲線（修好 37→43ms；關掉快取 49→224ms）。
- **自動開圖是延遲載入的（`src/render/inline_preview_slot.js`＋`src/js/lazy_media.js`，2026-08，CONFIRMED unit＋offline e2e）**：同一篇 8512 行長文有 **287 個圖片連結**，舊行為是文章一累積到就全部解析＋下載＋解碼、到離開文章前永不釋放 —— 已解碼的點陣圖是「記憶體吃滿」的最大宗。改成兩個共用 IntersectionObserver（root＝viewport，`.main` 的裁切會被算進交集）：接近視野（`LAZY_MOUNT_MARGIN_PX` 1500）才掛 `<ImagePreviewer>`（唯一留在核心畫面裡的 React 葉子島，一個佔位盒一個小 root），遠離（`LAZY_UNMOUNT_MARGIN_PX` 6000，遲滯區避免來回重載）就卸掉。
  - **延後的是整個元件的掛載，不是只有 `<img>` 的下載**：`requestPreview()` 一被呼叫就開始解析網址（imgur 無副檔名的還會發兩發 HEAD 探測），所以 `loading="lazy"` 攔不到它；而且現行 `<img>` 未載入時是 `display:none`，瀏覽器對 `display:none` 的元素本來就不會觸發 lazy。只加 `decoding="async"`。
  - **卸載前必須把當下 `offsetHeight` 釘進佔位盒的 `min-height`**，否則內容總高塌陷 → `scrollTop` 被夾住 → 閱讀位置整個位移（同上面放大/縮小那類問題）。
  - **佔位高度必須綁定「圖片尺寸模式」，而且要能替沒量過的模式算出來（2026-08-15，CONFIRMED unit＋offline e2e）**。同一張圖在放大態（`width:100%`／`max-height:none`，長圖 layout 高度數千 px）與縮小態差好幾倍，只記一個值會出現**互為代價的兩個症狀**，使用者兩次回報的正是這兩個（`ptt-debug-20260815-112407`，`stock-end` 重放複現）：
    1. 不分模式就套用 ⇒ 放大態釘的高度留到縮小態＝**永久假空白**（實測 slot 908px／圖 570px ⇒ 338px）。點縮小只是拿掉 `#mainContainer` 的 class，CSS 立刻生效但 inline `min-height` 不受影響。
    2. 模式不符就丟掉不套 ⇒ 佔位盒塌陷成 0，往上捲時圖一張張掛回來把**視窗上方**的內容撐開 ⇒ **跳頁**（實測 9 個圖佔位盒有 2 個整段被跳過，使用者描述「從圖3往上直接跳到圖1」）。
    - 修法兩層（`src/js/lazy_media.js` 純函式＋`inline_preview_slot.js`）：**(a) 分模式各記一組實測高度** `{ [mode]: height }`（`recordSlotHeight`／`slotMinHeight`），記錄時機除了卸載前，還多了**媒體載入完成時**（`ResizeObserver`）——只在卸載時記的話，使用者典型動線「normal 看幾張 → 點放大 → 往下捲才卸載」永遠不會替 normal 那格留值。**(b) 卸載期間放一個同比例的替身盒** `.inlinePreviewGhost`（`recordSlotAspect` 記媒體原尺寸 `naturalWidth/Height`）：它**也掛 `.easyReadingImg`**，於是 `max-width`/`max-height`/放大態 `width:100%` 全部由同一組 CSS 規則替它算高度 ⇒ 連「這個模式從沒量過」也佔得準（(a) 補不到的缺口正是這個：往下捲時那幾張圖只在放大態載入過）。JS 端因此不必複製任何 CSS 常數。
    - **替身盒的寬度走 CSS 變數 `--ghost-w` 而非 inline `width`**：inline 樣式會蓋掉放大態的 `width:100%`，變數不會（`#mainContainer.imagesEnlarged .easyReadingImg` 特異性也高於 `.inlinePreviewGhost`）。
    - 模式由 `ScreenController` 對存活中的佔位盒逐一 `setSizeMode()` 廣播（值＝`imagesEnlarged ? "enlarged" : "normal"`）。**切換模式不重建任何一列**：容器 class 決定圖片尺寸，佔位盒只需要知道現在是哪個模式。（去 React 化之前這個值走 `PreviewSizeModeContext`，理由是 `<Row>` 元素快取會讓新 prop 傳不進來。）
    - 量測兩個陷阱：載入完成前 `<img>` 已在 DOM 但 `display:none`，量到的是「讀取中…」指示器高度（要用 `offsetHeight > 0` 判斷是否真的佔到版面）；相簿一個 slot 多張圖，單一比例代表不了整盒 ⇒ 不記 aspect，退回分模式高度。
    - **量測結果存在 module 級 memo（`inline_preview_slot.js` 的 `sizeMemo`，鍵＝`href`，LRU `SIZE_MEMO_MAX`=500，跨文章保留）**，2026-08。理由：`pinned`/`aspect` 原本只活在 slot 閉包裡，**任何會改動 `annotationsKey` 的操作都全量重建每一列**（AI 校正逐筆回填最頻繁，一篇數十次；還有圖文並排、黑名單、樓號、字級…）⇒ 新 slot 從 `null` 開始 ⇒ 整份長頁佔位盒同時塌陷再非同步撐回來（閃爍＋跳頁）。命中 memo 的 slot 在 `createInlinePreviewSlot` 內就 `applyMinHeight()`+`syncGhost()`，**第一幀**即有高度，不等 observer。
      - 兩種量測的**有效範圍不同**：`aspect`（原尺寸）與版面寬度**無關**（替身盒交給 CSS 算）⇒ 無條件重用；`pinned`（分模式實測高度）只在**寬度不變**時成立。寬度改變的入口只有兩個，都收斂到 `render/screen.js#notifyLayoutChanged`：`term_view.setTermFontSize`（`chw` 變＝字級 pref／視窗 resize）與 `ScreenController._toggleMergeCaption`（`.mergedImageCol` 左欄比全寬窄）。它會 `invalidateInlinePreviewHeights()`＋對 `_liveSlots` 逐一 `invalidatePinned()`。**`_setImagesEnlarged` 不算**（那是 sizeMode，本來就分模式各記一筆）。
      - 作廢規則是**有 `aspect` 才丟 `pinned`**：替身盒能在新寬度下算出正確高度；沒有 `aspect` 的（iframe、相簿）留著舊值當最佳猜測 —— iframe 是固定 `height:450px`，本來就與寬度無關，丟掉只換來一次無謂的塌陷。
      - **量測前一定要先拿掉自己的 inline `min-height`**（`measureContentHeight`）：`offsetHeight` 會被它墊高 ⇒ 過期偏大的值被原封不動再記一次＝**自我增強的永久假空白**。有了這一手，即使 memo 帶進過期值，slot 一被掛載量測就自動修正。
    - 守護：`tests/unit/lazy_inline_preview.test.js`（含 memo／作廢規則／量測抗膨脹）、`tests/unit/render_dispose.test.js`（症狀級：pref 切換全量重建後新節點第一幀就有 `min-height`）、`tests/e2e/offline/lazy_preview_enlarge_blank.offline.spec.js`（同時鎖空白量、替身盒高度＝縮小態真圖高度、往上捲不得跳過任何圖佔位盒）。
  - **測試要驗預覽一律先捲到**（`tests/e2e/helpers/replay.js` 的 `mountLazyPreviewsAt` / `seekInlineMedia`）：replay 完就 `querySelector('img')` 永遠只量到空的佔位盒。同理，捲到目標後**要等版面靜下來再量座標**——先掛上的圖載入後會長高把目標推走（`blacklist_quick_add` 的右鍵座標就踩過）。
- **`buf.pageLines` 既是 render source 又是選取 source，clone 用 `term_view.cloneRow`**（`Object.assign(Object.create(Object.getPrototypeOf(ch)), ch)`），保留 TermChar prototype 方法（`isStartOfURL`/`getColor`…）；勿用 `JSON.parse(JSON.stringify())`（剝 prototype → render 即炸）。WHY 見 `term_view.js#cloneRow` 註解。
- **跨頁去重 `resolvePageOverlap`（狀態列行號為主，2026-07，治「重複區塊」race，CONFIRMED unit+offline/live e2e 守護）**。2026-08 起半畫幀已被上面的「完整回應幀」閘擋在外，本節的 drift guard 因此退居第二道保險而非主力。`findPageOverlap` 取最大內文相符 `k`，在半畫好中間 frame（重疊區某列未 settle）會 lock 到偏小 `k` → 少跳 → 重複追加 → 畫面重複段落（難重現、非特定文章）。改以狀態列 `目前顯示: 第 S~E 行`（`parseStatusRow` 的 `rowIndexStart/End`）算重疊：`kStatus = accEndRow - statusStart + 1`（`accEndRow` = `pageLines` 末列文章行號＝上頁 rowIndexEnd，`term_view._accEndRow` 追蹤；首頁 seed、`hideEasyReadingOverlays` 重置）。規則：**content 為重疊下界**（`findPageOverlap` 找到的相符列確定重複、必跳，`kStatus<=kContent` 用 `kContent`；長「行」可 wrap 成 2 顯示列使 kStatus 偏小，故不得低於 content）；僅 `kStatus>kContent`（content 因 race 少算）時用 `kStatus` 補回，並過 **drift guard**（該重疊區與 accTail 非空列相符率 <0.5 視為 `accEndRow` 漂移 → 退回 `kContent`）。純函式在 `comment_parse.resolvePageOverlap`，守護 `tests/unit/comment_parse.test.js` `describe("resolvePageOverlap")` + offline `replay_fixture.test.jsx` 鏡像同路徑。
- **換篇不得與舊篇串接（`decideAccumulateBranch` 雙保險，CONFIRMED unit＋replay 合成守護）**：分支決策抽純函式 `comment_parse.decideAccumulateBranch`，`accumulatePageLines` 依其三路 rebuild/append/skip 分流。**`leaveCurrentPost` 的一次性 `prevPageState=0` 不可信**——會被 redraw 每幀末的 `prevPageState=pageState` 覆寫，leave 與新文章第一頁之間夾任何 pageState 3 幀（舊文殘幀）就吃掉旗標 → 兩篇串接且此後恆串接。故：(1) **sticky 旗標 `buf.easyReadingPendingReset`**——`leaveCurrentPost`/`enterEasyReading` 設 true，只在「確認文章第一頁」（`statusStart===1`）時消費，functionMode resume 與 `hideEasyReadingOverlays` 顯式清 false；(2) **身分自癒**——續接時 `statusStart===1 ∧ kContent===0 ∧ acc 非空` ⇒ 不可能是同篇下一頁 → 強制 rebuild（未知路徑漏旗標也能復原；誤判代價僅「從第一頁重新累積」）。守護：`comment_parse.test.js` `describe("decideAccumulateBranch")`＋`replay_fixture.test.jsx` 合成 race 案例。
- **圖片放大/縮小的捲動錨定（2026-07-25，CONFIRMED unit＋offline e2e）**：點內嵌預覽圖切換整頁 `.imagesEnlarged`（`src/render/screen.js#_onContainerClick`）會讓內容總高驟變，而 `.main` 的 `scrollTop` 不變 → 視窗相對文章整個位移，剛在看的那張圖跑出視野（實測放大態縮小後偏 ~1700px）。修法：click 當下（套用 class 之前 ⇒ 讀到的是**舊 layout**，正是 before 值）以被點的 img 為錨點記 `{topBefore,heightBefore,scrollBefore}`，切換完成後立刻用 `scroll_anchor.computeAnchoredScrollTop` 換算並寫回 `scrollTop`（同步、無閃爍）。錨定分兩式：圖頂仍在視窗內 ⇒ 維持固定間距；圖頂已捲出視窗上方（看大圖常態）⇒ 視窗頂端維持落在圖內同一比例處（縮小後必然仍在圖範圍內）。
  - **座標系鐵則**：量測一律 `offsetTop`/`offsetHeight`，**不可用 `getBoundingClientRect()`**——`.main` 整體被 `transform: scale()`、`img.hyperLinkPreview` 另被套反向 scale（`term_view.setTermFontSize`/`updateReverseScaleCss`），rect 含 transform，與 layout 座標的 `scrollTop` 不同尺規。`offsetTopWithin` 用「兩端各自沿 offsetParent 鏈累加後相減」，因 `#mainContainer` 未設 position、鏈會跳過它（單邊累加會多算）。
  - **已知限制**：只補償同步高度變化。錨點**上方**尚未載入完成的圖（未載入時只佔一行 `LoadingOverlay`）之後撐開仍會推走位置，本次未處理（需 ResizeObserver 限時校正，與使用者捲動/自動翻頁互動難測）。
  - 守護：`tests/unit/scroll_anchor.test.js`（算式＋offsetParent 鏈）＋ offline e2e `easy-reading.offline.spec.js`「點圖縮小後被點的圖仍在視野內」（stock-end.json 圖多；舊 code 實測 visible=-908 → 紅）。
- **內嵌影片（`<video class="easyReadingVideo">`，2026-07-31）**：
  - **尺寸上限比照圖片**（`main.css` `max-height:19em`/`max-width:39em`，`width`/`height` 留 `auto`）。舊值是固定 `width:640px` 無 `max-height` → 直式影片（480×854）高度撐到 1138px 遠超視窗，且影片不像圖片能捲著看，播放控制列被推出畫面即無法操作。**影片沒有 `img.hyperLinkPreview` 那種反向 scale**，故 19em 隨 `scaleY` 一起縮放 ≒ 視窗高八成（19em×26px ÷ 24 列×26px）。守護：offline e2e「影片不得超出可視範圍」（注入刻意超高的 video 替身量 rect，舊 CSS 實測紅）。
  - **退出全螢幕後把影片捲回視野**（`ImagePreviewer.jsx#useFullscreenScrollRestore`）：進全螢幕時 `<video>` 被提到全螢幕層、原位高度塌陷 → 內容總高驟減、`scrollTop` 被夾到新的 maxScroll；退出後高度回來但捲動位置回不去（症狀同上面的放大/縮小，文章跳到很後面）。**不沿用 `computeAnchoredScrollTop`**：原生全螢幕鈕攔不到，退出當下已無 before 值 → 改用可預期的 `scroll_anchor.computeCenteredScrollTop`（影片置中；比視窗高則上緣對齊），並在 `requestAnimationFrame` 內量測（退出的 layout 回復可能落在 `fullscreenchange` 之後）。座標系鐵則同上（`offsetTop`/`offsetHeight`）。守護：`tests/unit/inline_video_fullscreen.test.jsx`＋`scroll_anchor.test.js`。
- **底部 padding**：`accumulatePageLines` 開頭統一設 `mainContainer.paddingBottom='1em'`（讓位給 footer overlay）；回列表/選單由 `hideEasyReadingOverlays` 清回 ''＋`scrollTop=0`（守護 `tests/unit/easy_reading_overlay_reset.test.js`；單頁文末行不被 overlay 遮的回歸見 offline `easy-reading.offline.spec.js`「末行不被底部狀態列 overlay 遮住」）。
- **footer 鏡像（CONFIRMED 讀碼）**：footer overlay (`#easyReadingLastRow`) **不** hardcode 文字，而是每次 `accumulatePageLines` 末由 `_mirrorStatusRowToFooter` 把**真實狀態列** `buf.lines[rows-1]`（含「瀏覽 第 X/Y 頁 (n%)…(h)說明(←)離開」、真實顏色）以 `renderOverlayRow` 畫進去（`parseStatusRow` 守門，transient 空列不洗掉）。WHY：原 hardcode `(y)回應(X%)推文(←)離開` 少「(h)說明」、頁數/% 永遠靜止，與原生不一致（原生 100%／非 100% 都有 (h)說明，差別只在頁數反白）。

### 游標／`#t` 的錨點契約（2026-08-28，不可退回算術模型）

`#cursor`（閃爍游標）與 `#t`（注音輸入匡，本專案自己畫的那個 `border:double` 小框；OS
的候選字清單錨在它上面）的位置**一律錨在「該列真正被畫出來的 DOM 節點」**，決策純函式在
`src/js/cursor_anchor.js`，量測入口只有 `term_view._rowAnchor`（`#mainContainer
[type="bbsrow"][srow=N]`，只在 `_gridRender` 幀有意義）。

| 元素 | 住在 | 錨 | 取值 |
|---|---|---|---|
| `#cursor` | `.main` 內（`position:relative` ⇒ 它的 containing block） | `rowEl.offsetTop / offsetLeft` | 內容座標，捲動與 `transform:scale()` 由 `.main` 一併帶走 |
| `#t` | `#BBSWindow` 內（**刻意不在 `.main`**） | `rowEl.getBoundingClientRect()` | viewport 座標；`#BBSWindow` 是 fixed、貼齊 viewport、無 border/padding ⇒ 可直接當它的 `left/top` |

水平仍是 `cur_x * chw`（沒有逐格節點可錨），靠等寬字型契約保護：ASCII advance 正好
`0.5em`（bundled webfont `SymMingLiu`，Mac 沒有 local MingLiu 時全靠它），全形字走
`.wpadding` 強制 `chh` px。守護：`cursor_shape.offline.spec.js`「格線字寬契約」。

**禁止事項**

1. 不得把位置改回 `cur_y*chh` 這類算術模型。那是「這一列**應該**在哪」，畫面上是
   layout 算出來的「**實際**在哪」，兩者之間沒有守門 ⇒ 任一列 line box 被撐大（標註、
   inline-block baseline、`#mainContainer` 的 padding、字型還沒落地…）就整批脫鉤，
   症狀就是**推文時游標戳出反白輸入匡**。三輪修復（`cbee3f5` → `865b828` → 把 `#cursor`
   搬進 `.main`）拆的都是補償項，這是最後一層。
2. 不得再引入第二套格線原點公式。舊的 `term_view.convertMN2XYEx`（`#t` 專用，多 `+10`
   與 `bbsViewMargin`、**完全不扣 `.main.scrollTop`**、縮放分支垂直原點漏算 10px）已刪除。
3. 不得為了統一座標系而「composition 時把 `#t` `appendChild` 進 `.main`、結束再移出」：
   搬動有焦點的元素會先把它移出 DOM ⇒ 失焦 ⇒ **正在進行的 IME composition 被中斷**
   （之後補 `focus()` 也救不回那個 session）；而且它新增一條「`bshow=0` 必須移出」的
   不變量，漏掉任一路徑就把隱形的 `-100000px` 元素留在捲動容器裡，下次 `focus()`
   把長頁捲飛。
4. `_rowAnchor` **不做跨呼叫快取**。layout 會變的時機不只重繪與改字級（延遲載入的圖片
   落地、pref 切 CSS class、webfont 落地都會），任何以幀序號為鍵的快取都有吃到過期
   `offsetTop` 的路徑 —— 那正是這條契約要消滅的東西。

`cur_x/cur_y` 落在格線外（PTT 偶爾把 `cur_x` 送成 `cols`）時**隱藏游標**
（`_cursorOutOfRange`，`_applyCursorVisibility` 的第四個 OR 來源），不可以「不更新位置」
—— 那會讓可見的游標停在過期座標上。

webfont 落地時序：`@font-face` 用 `font-display: block`，`main.jsx` 的 `loadResources()`
與轉碼表並行 `await loadTerminalFont()`（`document.fonts.load('26px SymMingLiu')`，3s 逾時
就照跑，字型問題絕不擋連線）。理由：Windows 有 local MingLiu，**macOS 沒有** ⇒ 那裡整個
等寬格線契約押在這支非同步 webfont 上，落地前 ASCII 退回系統 monospace（Menlo advance
`0.602em`）⇒ 整列橫向偏 20%，而游標的欄位算術不會跟著偏。

debug 錄製器已可直接判定這一類問題：`snapshotState` 帶 `fnMode / gridRender / chw / chh /
scaleX / scaleY / dpr / fontsReady`，另有 `cursor.geom` 取樣（游標真的移動時才記，含
`#cursor`／該列／`.main` 的矩形與 `scrollTop/scrollHeight/clientHeight`；只錄數字座標）。

## 文章 functionMode（按非導覽鍵 → 鏡像原生 LIVE，CONFIRMED 讀碼+unit）

對應 `EasyReading._functionMode`(=`buf.easyReadingFunctionMode`)。**原則：底部互動不 hardcode、不逐選單 parse——原生畫什麼好讀就鏡像什麼**（與列表好讀的 functionMode 同概念，文章版獨立、更單純）。

- **為何需要**：文章內按 `r` 回應／`X`/`%` 推文／`y` 收暫存檔，PTT 在 row22/row23 畫出選單（pageState 仍 3），但好讀仍渲染累積長頁＋footer，**蓋住選單**。舊作法靠 `curY==22`+`parseReplyText` 偵測「回應至」設 `showReplyText`，但畫選單文字(`changed`)與移游標到 row22(`posChanged`)可能不同 notify 視窗 → `curY` 閘漏接 → 選單不顯示（且到底 `reachedPageEnd` 時 `_onScreenSettled` 提早 return，無兜底）。**該路徑已於 2026-08-21 整條刪除**（見本節末）。
- **進入（鍵驅動）**：`_onKeyDownProcessUI` default 分支，凡**單字元鍵**(`e.key.length===1`)且非 leave-post 鍵→`_enterFunctionMode`：清 `sendCommandAfterUpdate`、存 `mainDisplay.scrollTop`、設 `_functionMode=true`、全列 dirty+`notify()` 立即重繪。**不** preventDefault（鍵照送 PTT）。僅 leave-post 鍵(`abf=+-[]ABF`)走 `leaveCurrentPost` 不進。
  - **pmore 功能鍵一律走 functionMode，勿再加 swallow list**：`h` 說明/`o` 選項/`/` 搜尋/`;` 指定頁/`,.<>` 左右捲等鍵由 functionMode 鏡像原生選單（守護 unit `easy_reading_logic.test.js`「pmore function keys enter functionMode」）。`Tab`(`stop=true`)與 ctrl `"@^_?"` 例外（Tab 放行涉 browser focus、不可同時 preventDefault+送鍵）。
  - **進入（貼上驅動）**：貼上不是按鍵 ⇒ 上面那條 `e.key.length===1` 規則抓不到，PTT 因應 `#`／`/`／`;` 等貼上內容畫的 prompt 會被好讀長頁蓋住（使用者看不到反應）。故 `App.onPasteDone` 在送出前補一次 `easyReading._enterFunctionMode()`（該函式自帶 `_functionMode` 早退，重複呼叫無害）。列表好讀的同源缺口見 `docs/easy-reading-list.md` 不變量 12b。
  - **進入（文字輸入驅動＝IME，2026-08-22）**：中文 IME 開著時 keydown 的 `e.key` 是 `'Process'`（keyCode 229）⇒ 上面那條 `e.key.length===1` 規則同樣抓不到；字元改由 input 事件送出（`term_view.onInput` 的 IME 特判刻意放行 `X`）→ `onTextInput` → `_convSend` ⇒ PTT 開了推文 prompt、好讀長頁卻原封不動 ⇒ **看不到輸入框、打字卻有效**（回報症狀「有時按 X 推文輸入框不顯示，切回原生就看得到字」；「有時」＝IME 開著時）。故 `term_view.onTextInput` 這條共用漏斗開頭一律呼叫 `easyReading.noteTextInput()`（gate：`_enabled && startedEasyReading`），keydown／IME／貼上三個入口對 functionMode 行為一致。守護 `tests/unit/easy_reading_text_input.test.js`＋`tests/e2e/offline/pref_close_in_prompt.offline.spec.js`。
  - **進入（滑鼠點功能鍵驅動，2026-08-23）**：畫面底部的 `(y)回應`／`(X)推文`／`(h)按鍵說明` 現在是可點按鈕（pref `mouseFunctionKeys`，見 `docs/mouse.md`「功能鍵按鈕」），點擊同樣不是按鍵、也不是文字輸入 ⇒ 上面三條規則全部抓不到，症狀與貼上／IME 那兩次完全相同（PTT 開了 prompt、好讀長頁原封不動 ⇒ 看不到輸入框）。故送鍵漏斗 `App.onFunctionKey` 在`view._send` **之前**呼叫 `easyReading._enterFunctionMode()`，由純函式 `function_key_plan.functionKeyClickPlan({bytes, mode})` 決策。**`\x1b[D`（`[←]離開`／`[q]`）例外**：走 `stopEasyReading()`，與鍵盤 ArrowLeft 同一條路（`_onKeyDownProcessUI` 的 `case 'ArrowLeft'`），否則離開文章時會先閃一下原生 24 列。守護 `tests/unit/function_key_click_plan.test.js`＋`tests/e2e/offline/function_keys.offline.spec.js`。
- **鍵流**：`term_view.onKeyDown` gate 加 `&& !buf.easyReadingFunctionMode` → functionMode 期間全鍵直通原生（含 Enter，在原生 prompt/編輯器操作）。
- **渲染**：`term_view.redraw` **最高優先**分支 `useEasyReadingMode && easyReadingFunctionMode` → `hideEasyReadingOverlaysKeepPage()`(藏 overlay＋清 `#mainContainer` 的 `paddingBottom`、**不清 pageLines**)＋`mainDisplay.scrollTop=0`＋`_gridRender=true`＋`_renderScreenLines(buf.lines)` 整頁原生 24 列 LIVE。**關鍵：不可用 `hideEasyReadingOverlays`**（它清 `pageLines=[]`，退出需重抓整篇、PTT 已在文末 End no-op → 不可行）。
- **不變量：原生鏡像期間畫面必須不可捲**（`.main` 的 `scrollHeight <= clientHeight`）。`accumulatePageLines` 每頁都在 `#mainContainer` 留 `paddingBottom:1em`（替 footer overlay 讓位），原生鏡像沒有 overlay，留著它 `.main`（height=`chh*rows+10`、`overflow-y:auto`）就還有 **`chh-10` px 可捲**；而 `App.mouse_scroll` 在 `pageState==3` 時**直接 return 不 preventDefault**（推文提示畫面的 pageState 仍是 3）⇒ 滾輪真的把輸入列捲上去，絕對定位的 `#cursor` 卻不會跟著動 ⇒ **推文時閃爍游標戳出反白輸入匡**（2026-08-20；`redraw` 的 `scrollTop=0` 只在「有內容變動的幀」跑，停手不打字時偏移就停在那裡，離開文章才被 `hideEasyReadingOverlays` 清掉 → 症狀是「有時候、非特定文章、重進就好」）。故 `hideEasyReadingOverlaysKeepPage` 也要清 padding；回好讀時 `accumulatePageLines` 會設回 `1em`，且排在 `_evalFunctionModeExit('resume')` 還原 `_savedScrollTop` 之前，捲動位置照舊。守護：`tests/e2e/offline/cursor_shape.offline.spec.js`。
  - **2026-08-21 起這條不再是游標正確性的依賴**：`#cursor` 已搬進 `.main`（見 `docs/enhanced-addon.md` 踩坑 A），與列共用同一個捲動座標系，捲了也不會脫鉤。清 padding 仍保留 —— 原生鏡像畫面本來就不該有可捲距離。
  - **`view._gridRender` 語意**：這一幀的 `.main` 裝的是不是固定格線的一整螢幕（原生／functionMode 鏡像／列表好讀視窗）。好讀累積長頁為 `false`，此時 `buf.cur_y` 指不到任何一列 ⇒ `_applyCursorVisibility` **整個隱藏閃爍游標**（第三個 OR 來源）。旗標只由真的重畫畫面的 redraw 分支設定。
  - **已知洞（未修）**：`App.setBBSCmd` 的好讀分支只看 `useEasyReadingMode && startedEasyReading`、**沒有排除 functionMode**，所以理論上滾輪會去捲一個原生鏡像畫面。現行路徑走不到它（`mouse_scroll` 在 `pageState==3` 就早退），且改成在 functionMode 送 `[5~`/`[6~` 會讓 page 鍵進到 `getdata` 提示，屬行為改動，故留著。
- **退出（內容判定，settle 驅動）**：`_onChanged` functionMode 時早退（不跑翻頁機）；`_onScreenSettled` functionMode 時走 `_evalFunctionModeExit`→純函式 `functionModeExitDecision({pageState,isStatusRow,curY,lastRowNum})`（`easy_reading.js` 頂部 export，unit 守護）：
  - `resume`：`pageState==3 && isStatusRow && curY==lastRowNum`（回乾淨文章頁）→ `_functionMode=false`、`prevPageState=3`+dirty+`notify()`（`accumulatePageLines` 接續分支、`findPageOverlap` 對同畫面去重成 no-op append → 長頁無痕恢復）、還原 `scrollTop`。
  - `leave`：`pageState==1||2`（settle 進選單/列表，使用者離篇）→ `_functionMode=false`、`startedEasyReading=false`、`leaveCurrentPost()`、重繪原生列表；下一篇由既有 settle 重啟。
  - `stay`：其餘（選單/編輯器/pass 5/6/0/transient）→ 續鏡像。
- **enter/exit/leaveCurrentPost** 皆重置 `_functionMode=false`+`_savedScrollTop=null`。
- **但「關設定頁」不准重置（2026-08-22，全黑 bug）**：`PrefModal` 的 X／點空白／Esc 全走 `onPrefSaveImpl` → `App.switchToEasyReadingMode(view.useEasyReadingMode)`，它原本無條件 `leaveCurrentPost()`（含清 `_functionMode`）＋清 `pageLines`。使用者若正停在 prompt 上（`X` 推文／`r` 回應／編輯器）：`_functionMode` 被清 ⇒ `^L` 的整頁重繪落進好讀文章分支 ⇒ 但 prompt 幀的游標不在 `(rows-1, cols-1)` ⇒ `accumulatePageLines` 的 P6 complete gate 不成立 ⇒ `decideAccumulateBranch` 回 `skip` ⇒ `pageLines` 維持 `[]` ⇒ **渲染 0 列＝整頁全黑**；之後每一幀游標都在 prompt 上，`complete` 永遠不成立 ⇒ 只能離開文章再進（100% 複現）。修法：決策抽成純函式 `switchModePlan({doSwitch,functionMode,pageState})`（`easy_reading.js` 頂部 export），functionMode 時**只送 `^L`**——不 `leaveCurrentPost`、不清 `pageLines`、不送 `\x1b[D\x1b[C`（那在 vgets 裡是左右移輸入游標，錄檔實測回 BEL）。`^L` 一律安全：pttbbs `system_key_hook`（`mbbsd/io.c`）把 `Ctrl('L')` 攔成 `redrawwin()+refresh()` 並回 `KEY_INCOMPLETE`，prompt 底下也只是重繪。守護 `tests/unit/switch_mode_plan.test.js`＋offline e2e。
- **第二道防線（防黑守門）**：`term_view.redraw` 的好讀文章分支在 `accumulatePageLines()` 後若 `buf.pageLines` 仍為空，改鏡像原生 24 列（與 functionMode 分支同構），**不把空陣列交給 renderer**。任何路徑造成「累積為空卻還在好讀分支」都不會再全黑。
- **舊 reply/push overlay 路徑已刪除（2026-08-21）**：`_onKeyDownProcessUI` 的 default 分支對**任何單字元鍵**先 `_enterFunctionMode()`，而 `_onChanged` 在 functionMode 下第一行就 return、`redraw` 又把 functionMode 分支排在最前面 ⇒ 那兩個旗標恆 false、分支永不觸發。已一併移除：
  - `buf.easyReadingShowReplyText` / `easyReadingShowPushInitText` 兩旗標（`term_buf` 初始化、`easy_reading` 的 `bindProperty`）
  - `nextEasyReadingRowState` 的 `isReqNotMetRow`/`isPushInitRow`/`isReplyRow` 輸入與對應 branch（現在只認「游標停在末列末欄」的完整幀，其餘一律 `halt`）
  - `term_view.redraw` 兩條 overlay 分支、`updateEasyReadingReplyRow`/`updateEasyReadingPushInitRow`、`#easyReadingReplyRow` div 與其 CSS
  - `term_view.onKeyDown`/`onInput` 兩處 `!showReplyText && !showPushInitText` gate（恆真）
  - `string_util.parseReplyText` / `parseReqNotMetText`（唯二消費者就是這條路徑）。`parsePushInitText` 保留 —— `image_upload.js` 還要用它判斷推文輸入列。

**已到底時原生 End 是 no-op → 必附 `^L`**：好讀已自動翻頁到**底**時，實際游標在最後頁，再送原生 End(`\x1b[4~`) PTT **不回應不重繪** → 必須另送 `^L`(`\x0c`, Ctrl-L)強制全頁重繪。`switchToEasyReadingMode()`(無參數)已內含 `^L`(`pttchrome.jsx`)。

## 送鍵閘門：延後，不是丟棄（CONFIRMED unit＋live 量測）

好讀狀態機自己送的鍵**繞過 CommandQueue**，所以線上有序列化交易時一個 byte 都不准送（`_wireBusy()` = `aidNavigation.active || commandQueue.inFlightKind`；理由與兩個實測症狀見 `easy_reading._send` 註解與 `docs/deep-link.md`）。**但「不准送」必須是延後，不能是丟棄**——

- **為何丟棄一定出事**：文章落地的那一個 settle 上，執行順序是 `pageStateSettled`→好讀開機並送第一個 PageDown →`screenSettled`→好讀（同頁 sig ⇒ wait）→**最後**才是 `list_session`→`queue.onSettle`→`open-enter` 完成。這個順序是 `pttchrome.jsx` 的「ORDER MATTERS」刻意保證的（`ensureEnabledOnArticle` 要 `_enabled` 已定案），所以**好讀的第一個 PageDown 必然撞上仍在飛的 `open-enter`／`aid-open`**。舊碼在 `_send` 前就寫好 `_inFlightSig`/`_inFlightSentAt` 並 `_armWatchdog` ⇒ 留下一筆假 in-flight ⇒ 只剩 620ms（`PAGE_DOWN_GRACE_MS+20`）的 watchdog 能救。**live 量測 2026-08-17：修前 638ms，修後 20ms**（`blocked` 計數 2、`onWireIdle` 1 次）。且 `PAGE_DOWN_MAX_RETRIES=1`，那次 retry 若又撞上別的交易就直接 `giveup` ⇒ 整篇停在第一頁。
- **機制**：`_maybeSendPageDown` **開頭**就 `_wireBusy()` 早退（決策連跑都不跑），把 bytes 存進 `_deferredPageDownKeys` 並回傳 `'blocked'`；交易狀態三件套與 watchdog **完全不動**。線路真的空了由 `CommandQueue.onIdle`（opt-in，`pttchrome.jsx` 接到 `easyReading.onWireIdle`）叫醒補送。
- **`onIdle` 必須在 `_maybeSendNext()` 之後判定**：`open-jump` 的 `onDone` 會接著 enqueue `open-enter`，那時線路根本沒空過；早一步通知等於補送到下一個指令頭上。`flush()` 只在原本非 idle 時才通知。
- **補送是自我保持、不是重試迴圈**：`onWireIdle` 時若仍 busy，`_maybeSendPageDown` 會把 bytes 原封存回 deferred，等下一次通知。沒有 timer。
- **per-article**：`_deferredPageDownKeys` 由 `_resetPagingState` 清（與 `_pendingScrollRestore`／`_pendingEnableOnArticle` 同規）——跨文章帶過去就是憑空多送一次 PageDown（P4）。
- **gap 自癒同理但更嚴**：`_healGap` 開頭 `_wireBusy()` 直接 return 且**刻意不清 `easyReadingGapDetected`**（下次 settle 重試）。`_healFromTop` 會先清 `pageLines` 才送 Home，被 `_send` 吞掉就只剩空白畫面，而它沒有 watchdog 兜底。
- 守護：`tests/unit/easy_reading_send_gate.test.js`（fake timers 斷言「零時間前進即送出」＋不留假 in-flight）、`tests/unit/command_queue.test.js`（`onIdle` 的真空判定）。

## AID（#文章代碼）一鍵跳文（CONFIRMED unit）

好讀讀文中偵測 `#XXXXXXXX`（固定 8 碼 `[0-9A-Za-z_-]`，pttbbs `aidu2aidc` base64 變體；可帶 `(Board)`/`@Board` 後綴，無後綴 fallback `term_view._articleBoard`，來源同列 header `看板 X`，`comment_parse.parseArticleBoard`）→ `.aidLink` 連結。**排除已被 `TermBuf.uriRegEx` 標成 URL 的格子**（`term_url_flag.js#rangeInTermUrl`）：網址 fragment 與 AIDc 同形（`https://…/#Browsers/1gU3wwNZ`），認走會把整條網址的 `<a>` 從中切斷，見 `docs/enhanced-addon.md` 踩坑 A。鏈路：`aid_parse.detectAids`（TermChar columns，同 mention_parse DBCS 規則）→ `screen_annotations.computeAnnotations`（僅 `easyReading && enhance.onAidClick`）→ `src/render/link_segment.js`（同 mention 邊界機制）→ `view.onAidClick`（pttchrome 掛）→ `aid_navigation.AidNavigation.start(aid, board)`。

導航 = 共用 `commandQueue` 的序列（每步 expect 內容判定、fullRepaint、失敗可見降級）。**前導段（僅當 pager footer 判不出 `currstat == READING`）**：`string_util.parsePagerFooterContext` 讀末列，含「回應」才敢直接送 `s`/`#`（`more.c:102-112` 把兩鍵綁死 READING；站內信 RMAIL 會**逐鍵當快捷鍵吃掉**板名）。判不出時一律降級：`\x1b[D` 一次一鍵退到 `【主功能表】`（上限 `MAX_ESCAPE_STEPS=6`，每步用整螢幕簽章確認真的退了一層），再走 `s`——只有 `menu.c:498` 的 MMENU/TMENU/XMENU 的 `s` 才真的進板（`board.c:1902` 的 s 只是搜尋看板移游標）；這條路徑會經 `Read()` → 進板畫面＋pressanykey，由 `_enqueueEnterBoardDismiss`（上限 3）化解。主序列：`s<board>\r`(expect clean-list+boardName 不分大小寫) → `#<aid>\r`(expect boardName+cursorRowNum+curY 在 entry 區——**不可要求 kind==clean-list**：# 跳文落地 footer 列空白（\f probe 後仍空）→ classify 判 transient，live 驗證 2026-07-10；找不到→vmsg 游標停底列→cursorRowNum null→probe→miss) → `\r`(expect article|statusRow)。前置：`easyReading._enterFunctionMode()`（原生 LIVE 鏡像；離篇/進新文由既有 settle 邏輯收斂）＋ `listSession.beginExternalNavigation()`（強制 functionMode+nativeHold+flush，reducer 對中途 clean-list settle 一律 stay，最後 article settle 走 handoff）。**順序不變量：先 beginExternalNavigation（含 flush）再 enqueue**。導航中 `aidNavigation.active` 於 `term_view.onKeyDown`／`App.mouse_click`／`onMouse_click`／`mouse_scroll` 入口吞輸入（有 banner）。同板也不省略 `s` 切板（單一路徑）。unit：`tests/unit/aid_parse.test.js`、`aid_navigation.test.js`、`row_render.test.js`（aidLink render）。

### 返回原文（`nav_history.js`，CONFIRMED unit＋live）

PTT 端**沒有**跳轉來源的概念（`read.c#select_by_aid` 只在 currboard 內搜尋，跨板就是真的換板），所以返回＝**用離開前擷取的錨點再導航一次**（同 BePTT 的「每個位置存一段按鍵序列、返回時重放」，差別是這裡每步都有 expect 而非盲送）。正向與返回共用同一組 enqueue 函式，只有中段那一步不同（`_enqueueMiddle`）。

**正向跳轉的第 0 步 `Q`（`_enqueueOriginAid`，2026-08）**：離開前先叫出文章資訊框，讀出**本篇自己的 AID**（協定 §8.2）當返回錨點，讓 aid 級在所有情境都拿得到。
沒有它時 `/` 搜尋過的清單一定回不去：MODE_SELECT 序號空間獨立（`read.c:661-665`），返回的 `s<board>` 又會離開搜尋模式，於是那個序號落在主清單的別篇文章。
best-effort：逾時／miss／框裡沒 AID 一律降級續跳（錨點退回原本級別），**只有 flush 才 `_fail`**。`fullRepaint` 必須是 false、關框鍵必須是**空白鍵**（`\f` 不是「鍵」，關不掉 pressanykey）——理由見協定 §6 末條與 §8.2。

錨點三級（`nav_history.chooseAnchor`，純函式；aid 級另由 `upgradePendingOriginAid` 升級而來）：

| 級 | 來源 | 中段動作 | 備註 |
|---|---|---|---|
| aid | 第 0 步 `Q` 問到的本篇 AID；或 `history.landed()`（本篇自己就是上次跳來的） | `#<aid>\r` | 唯一不受刪文位移／MODE_SELECT 重新編號影響。會**保留 num/subject 當備援**：置底文的 `#` 搜尋必失手（`read.c:404` FIXME），back run 的 miss 就退回序號／停在列表，不清空 stack |
| num | `listSession.currentAnchor()` = `_openedNum` + `_boardName`(可為 null→用 `view._articleBoard` 遞補) + `_lastReadTitle` | `<num>\r`，落地**必須** `subjectOfListText(游標列) === subject` 才送 `\r` | 序號會因刪文位移 |
| board | `view._articleBoard` | 無：落地列表就停手 | 靠 `getkeep` per-board 游標記憶；**同板跳轉時作廢**（正向 `#aid` 已覆寫該板 keep）——但第 0 步問到 AID 時同板也有返回鈕了 |

- **順序不變量**：錨點必須在 `_begin()`（`easyReading._enterFunctionMode()` + `listSession.beginExternalNavigation()`）**之前**擷取——後者會清 `_boardName`/`_serverNum`/`_openedNum`。捲動行索引同理，且要另外掛在 run 上（`run.originLineIndex`）：`chooseAnchor` 回 null 時沒有錨點可以承接它，升級成 aid 級時才補得回去。
- **兩段式 commit**：`beginJump`/`beginBack` 只暫存，`_enqueueOpen.onDone`（文章真的開了）才 `commitJump`/`commitBack`。任一步失敗 → `abort()` **整個清空**，不 pop 不 push 不重試。
- **`_openedNum` 而非 `_selectedNum`**（兩次 live 誤跳的根因）：置底文沒有序號、`_selectedNum` 會留著上一個數字列的殘值；原生模式（functionMode，例如按過 Q 資訊框）下方向鍵是 passthrough，`_selectedNum` 停在舊值。只有 list 好讀自己序列化開文時設的 `_openedNum` 保證對得上畫面上那篇。
- **生命週期（三個純通知 hook，都不得改動對方狀態）**：`list_session._onScreenSettled`（**排在 `queue.onSettle` 之前**，clean-list/menu → `invalidate()`）、`easy_reading.leaveCurrentPost`（文章→文章鍵）、`App.onClose`（斷線 → `reset()`）。
  - **我方落地會自己產生一次 `leaveCurrentPost`**（functionMode 退出走 'leave' 分支，且發生在 `onDone` 清掉 `active` 之後）→ `_ownedLeave` one-shot 吞掉它，否則每次跳完都會把剛 push 的那層抹掉。
- **UI**：返回鈕（`term_view.showBackButton`，`(active, stack)` 的投影）＋快捷鍵 pref `aidNavBackKey`（預設 F9；F 鍵在 `term_keyboard.KeyMap` 沒有對應、送不到 PTT，而 F8 已被 `easyReadingEndSwitchKey` 佔用）。
- **捲動還原**：錨點存的是**行索引**（`scrollTop / chh`），不是像素也不是 `_savedScrollTop`（那是 functionMode 單次進出的暫存，跨文章活不下來）。返回開文後交給 `easy_reading.requestScrollRestore`，由 `_onViewUpdated` 每次併頁時用 `nextScrollRestoreStep` 判斷高度夠不夠（好讀是逐頁累積，位置一開始不可達）；`reachedPageEnd` 仍不夠高就夾到底，使用者一按鍵立刻取消。

## 切換：三個對稱入口（CONFIRMED 純邏輯/手動驗）

好讀的進/退/離篇收斂到三個語意明確的入口（`easy_reading.js`），新路徑只呼叫入口、不各自設旗標：
- **`enterEasyReading()`**：唯一開好讀點，由 `_onPageStateSettled` 在 settled 2→3 邊緣驅動。`_enabled=true` + `prevPageState=0`/`pageLines=[]`（強制 `populateEasyReadingPage` 新文章 clearRows 分支）+ 全列 dirty + `changed=true` + `notify()` 重播一輪 render/viewUpdate（settle 在 'change' 迴圈外觸發，故需自行重播以啟動翻頁）。
- **`leaveCurrentPost()`**：仍在好讀、離開本篇 → 重置 per-post（`ignoreOneUpdate`、`prevPageState=0`、`_resetPagingState()`），**不改 `_enabled`**。鍵/滑鼠多處直接呼叫；`switchToEasyReadingMode`(`pttchrome.jsx`) 內部也呼叫它（**隱藏傳遞鏈**，已加註解標出）。
  - **踩坑：per-post 狀態不可只靠這三個入口重置**（2026-08，「進文章卡在第一頁」的根因）。最常見的換文章路徑一個都不經過它們：`←` 走 `stopEasyReading()`（只設 `sendCommandAfterUpdate='skipOne'`）**不經 `leaveCurrentPost()`**；而好讀已經開著時再進下一篇**也不經 `enterEasyReading()`**（`nextEasyReadingState` 要求 `!enabled`）。凡是「每篇一份」的狀態，重置點必須掛在 settle 的文章邊界（`_onPageStateSettled`），不能掛在按鍵路徑上。
- **`exitEasyReading()`**：唯一關好讀點。`sendCommandAfterUpdate=''` + `_enabled=false` + `_core.switchToEasyReadingMode()`（還原 overlay 列/padding/pageLines+送 `^L`）。React 恆擁有 `#mainContainer`，切原生由 reconcile 把長頁收回 24 列（無 unmount）。

`EasyReading.switchToNativeAtBottom`（熱鍵／`$`／`G` 與滑鼠 End）= `_send('\x1b[4~')`（原生 End 導到底）+ `exitEasyReading()`。

**熱鍵是 toggle：原生下再按一次切回好讀（`tryReenterFromNative` → `reenterFromTop`，2026-08）**。
- 攔截點在 `term_view.onKeyDown`，**排在既有好讀 gate 之前**——好讀關掉後 `useEasyReadingMode` 是 false，那個 gate 不成立，鍵會直接落到原生。條件另加 `!easyReadingFunctionMode ∧ pageState === 3 ∧ !ctrl ∧ !alt`，且 `tryReenterFromNative` 內再要求真的讀得到狀態列（`term_buf.setPageState` 沒有 default 分支，prompt 幀的 pageState 可能是殘值）。
- **只認 `easyReadingEndSwitchKey`（預設 F8），`$`／`G` 不參與**：它們在原生 pmore 是真的導覽鍵（`mf_goBottom`），語意是「跳文末」不是「切模式」。
- `reenterFromTop()` 先 `enterEasyReading()`（唯一入口）再視情況送 Home 倒回第 1 行，**順序不可調換**：`enterEasyReading` 結尾會重播一次 `notify()`，快路徑會從文章中段送出 PageDown；先把 rewind 立成在途交易才能保持「同時只有一個鍵在途」（P4）。
- **Home 只在 `rowIndexStart > 1` 才送**：pfterm 會 diff 畫面、`fterm_rawmove_opt` 原地不動，已經在第 1 行時送 Home 是**零回應**，交易會永遠等不到 ack。

**`exitEasyReading()` 的收尾（2026-08 補三條，治 F8 後的殘留）**，全部必須排在 `_core.switchToEasyReadingMode()` **之後**（它透過 `leaveCurrentPost()` 會把 `ignoreOneUpdate` 重新點起來）：
- `startedEasyReading = false`：唯一清除點原本是 `_applyRowState`，而 `_onChanged` 在 `!_enabled` 時早退 ⇒ 永遠跑不到。`list_session._engageEligible()` 讀它 ⇒ **F8 後回看板列表，列表好讀永遠不 engage**。
- `ignoreOneUpdate = false`：見上面「翻頁交易」段的硬卡死說明。
- `mainDisplay.scrollTop = 0` ＋ `_forceRepaint()`：**不依賴 `^L` 的伺服器往返**。按熱鍵時若還有 PageDown 在途，End／`^L` 的重繪會被 P4 吞掉，DOM 就一直停在數千列的長頁且捲到底 ⇒ 使用者看到「卡在最底部、PgUp 沒反應」。另外 `redraw` 的 native 分支用 `if (useEasyReadingMode)` 守住 overlay/scroll 還原，此時已是 false，沒有別人會重設捲軸。

**所有手動關好讀路徑都必須走 `exitEasyReading()`，勿自行翻 `useEasyReadingMode` 旗標**（會漏掉 `sendCommandAfterUpdate`/pageLines 清理與 overlay 還原）：End、pref 關閉（`_onChanged` 偵測 `!enableEasyReading && _enabled`）、LiveHelper 啟用(`ContextMenu/index.jsx` `onLiveHelperChange`)、e2e `applyPrefs`。LiveHelper 這條只由 UI 驅動，守護在 offline e2e「LiveHelper 启用 → 关好读单一出口」。
- `switchToEasyReadingMode(doSwitch)`：無參/falsy→還原 DOM+`^L`；truthy→進好讀。好讀開但畫面是列表/選單(pageState≠3)時，`redraw` 走 `hideEasyReadingOverlays()`（只還原 overlay 列+清 pageLines）後以 `_renderScreenLines(buf.lines)` 畫單頁（同原生路徑）。

## 鍵流（CONFIRMED）

- `term_view.onKeyDown`：`if useEasyReadingMode && startedEasyReading && !reply/pushInit` → `easyReading._onKeyDown`→`_onKeyDownProcessUI`。切原生後 useEasyReadingMode=false ⇒ 走原生 `_keyboard.onKeyDown`，左鍵`\x1b[D`原生離開文章。
- 原生鍵序：`term_keyboard.js` KeyMap，End=`\x1b[4~`、Left=`\x1b[D`、PageDown=`\x1b[6~`。

## e2e 測試要點（tests/e2e/easy-reading.spec.js）

- **好讀預設 false**：測試須在 `page.addInitScript` 寫 localStorage `pttchrome.pref.v1`→`{values:{enableEasyReading:true}}` 才會啟動，否則 End 只是原生（測不到）。
- app 未掛全域：`main.jsx` 僅 `DEVELOPER_MODE`(dev build 有)下 `window.__app=app` 供測試讀 `view.useEasyReadingMode`/`buf.pageState`。
- 判好讀 vs 原生：好讀 `mainContainer` 累積 >24 列且 `#easyReadingLastRow` display:block；原生 24 列、lastRow display:none、畫面含原生狀態列「瀏覽 第 N 頁…」。原生狀態列**不論 100% 或非 100% 都含「(h)說明」**（差別只在頁數指示器顏色，到底時反白）。**勿**用「mainContainer 是否含瀏覽第」分原生/好讀 footer：footer overlay 現已**即時鏡像真實狀態列**（含「瀏覽 第…(h)說明」，見 render 段「footer 鏡像」），但它是 `BBSWin` 下獨立 div、非 `#mainContainer`，故 `mc.innerText` 不含它——仍以 `useEasyReadingMode`/`mcChildren`/`lastRowDisplay` 區分。
- 取消 PTT 搜尋提示用**空 Enter**，勿用 Escape（pmore 把 `\x1b` 當逃逸序列開頭，導覽錯亂）。
- 連線偶發 403/ECONNRESET（PTT 端 flake）。
- 驗證序列：好讀啟動(useEasyReadingMode=true,~41列)→End(false,≤24列,lastRow none,「瀏覽 第 N 頁」+「100%」)→`/`(搜尋提示)→左鍵(pageState 2)→進下篇(true)。
