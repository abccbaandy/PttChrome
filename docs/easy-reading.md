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
  - **bounded retry**：settle（畫面靜止 `SETTLE_MS`）時若仍是同一簽章，代表 PTT 已 flush 並卡在 `dogetch`（沒有進行中的重繪會被 typeahead 吞），此時補送一次安全；上限 `PAGE_DOWN_MAX_RETRIES=1`，之後 giveup。
  - **交易狀態是 per-article，重置點＝文章邊界（`_resetPagingState`，2026-08）**。涵蓋 `_inFlightSig`／`_pageDownRetries`／`_healedOnce`／`easyReadingReachedPageEnd`／`sendCommandAfterUpdate`。
    - **`sig` 不跨文章唯一**：每篇文章第一頁都是 `1~22`。殘留的 `_inFlightSig` 會把下一篇的第一頁當成「上一篇那個還沒回應的請求」→ 快路徑永遠 `wait`、settle 用完重試上限後永遠 `giveup` ⇒ **一個 PageDown 都送不出去，卡在第一頁；換文章照樣卡**。
    - 邊界由 **settle 過的 pageState 進出 3** 判定（`_onPageStateSettled`：`1|2 → 3` 或 `3 → 1|2`）。**只認 1/2**：文章中途狀態列失配一幀而掉出 3 再回來不是換文章，重置會讓同一頁重送 PageDown（正是 P4 要防的）。
    - 不經列表的文章→文章（`[` `]` 同標題跳、`a/b/f/=/+/-`）沒有 1/2 邊緣，由 `leaveCurrentPost()` 補上；`enterEasyReading`/`exitEasyReading`/`_healFromTop` 也走同一個 helper。
  - **`_onScreenSettled` 不得被 `easyReadingReachedPageEnd` 早退否決**：settle 路徑必須對當下畫面冪等，「到底了」已由 `pagePercent` 在 `_computeRowState` 與 `nextPageDownDecision` 各算一次。
  - **使用者自救 `_kickPageDown()`**：PgDn（鍵盤與滑鼠）在累積頁**捲不動**且狀態列 `pagePercent < 100` 時，清掉交易狀態並補送一次 PageDown。自動翻頁的所有失效模式在使用者眼裡長得一模一樣（長頁停住、PgDn 毫無反應），要有一條手動出口。
  - **debugRecorder `easyReading.pageDown` / `easyReading.pageDownKick`**：記 `retry`/`giveup`/`done`（`send`/`wait` 不記——一個看得到送出事件、一個每幀都有）。沒有它時，所有卡法在素材裡都只是「進文章後零 send」，分不出是重試額度用完還是旗標殘留。
- **累積只在「完整回應幀」（P6）**：`term_view.accumulatePageLines` 以 `buf.cur_y === rows-1 && buf.cur_x === cols-1`（pfterm 每次回應結尾才 park 游標）當閘。半畫幀的 footer 還是**上一頁的舊值**（per-cell patch，狀態列補丁與 park 排在內容之後），拿它算重疊會把舊行號寫進 `_accEndRow`，之後整條去重都建在錯基準上——舊版的 drift guard（比對率 0.5）就是在補這個。不完整的幀只重畫、不動 `pageLines`。
- **掉頁偵測與自癒（P1）**：`comment_parse.classifyPageTransition` 判 `restart`/`continuation`/`gap`/`backward`。`gap`＝`statusStart > accEndRow + 1`，而 PageDown ＝ `mf_forward(dispedlines-1)` 保證 `S' == E`（末頁被 `maxdisps` 夾則更小），**`S' > E` 不可能** ⇒ 一定是中間整頁沒收到。舊版 `resolvePageOverlap` 把負重疊夾成 0 → 照常 append → 破洞無聲。現在 `accumulatePageLines` 升 `buf.easyReadingGapDetected`，`EasyReading._healFromTop()` 送 Home（`\x1b[1~` → `pmore#mf_goTop`）從頭重讀，每篇一次（`_healedOnce`）防迴圈。
- **補畫一律走 `term_buf.notify()`（`_forceRepaint`），不可直接 `view.redraw()`**：`updateCharAttr()` 只在 notify 裡跑，它是 Big5 lead byte 標上 `isLeadByte` 的地方。settle 可能落在「bytes 已到、30ms notify 計時器還沒跑」之間，直接 redraw 會把未轉碼的列 clone 進 `pageLines`，`rowToText` 得到原始 Big5（`¡°` 而非 `※`）→ 下一頁比對不上 → 重疊算成 0 → 重疊列貼兩次（離線拆幀測試抓到的重複「※ 文章網址」）。
- **settle 兜底（`_onScreenSettled`）**：PTT「把游標停到底部狀態列」可能是**獨立的純游標 escape（只設 `posChanged` 不設 `changed`）**，落在自己的 notify 視窗 → `if(this.changed)` 區塊整段跳過 → 該回應**從沒進過 redraw/accumulate**。`screenSettled` 在「畫面真靜止（內容＋游標都停）」時比對 `view._lastAccumulatedSig`，不同就 `_forceRepaint()` 補一次（補畫會重播 change/viewUpdate，翻頁決策由快路徑接手，settle 隨即 return）。
- **離開文章的清理改由 settle 觸發**：`term_view.redraw` 對「好讀開啟 ∧ `buf.settledPageState === 3` ∧ 有 `pageLines`」的 transient 幀**繼續畫累積頁**，不再落到會清空 `pageLines` 的 native 分支（pageState 是逐幀分類，半畫的 footer 會讓它掉出 3 一幀，舊版因此整篇累積被丟掉、下一個完整幀從當前頁重建 → 前面全沒了）。真正離開時由 `EasyReading._teardownAccumulationOffArticle`（settle，debounced 狀態已同意）做 `hideEasyReadingOverlays()`＋重繪。
- 自動「重新啟用」（**settle 後判斷，2026-06 重構，CONFIRMED 純邏輯/手動驗**）：靠 term_buf 的**去抖動** pageState 串流，不再逐 frame 判。`term_buf` 維護 `settledPageState`/`prevSettledPageState`：`notify` 每個 `changed` **或純游標(`posChanged`)** 視窗都 re-arm 一個 `SETTLE_MS=50`(`term_buf.js` 頂常數) 計時器（抽成 `term_buf._armSettleTimer`）；資料/游標持續到達(~30ms 間隔)時一直 re-arm 不觸發，**畫面真靜止（內容＋游標都停）50ms 後**才觸發：`pageState` 改變時升 `settledPageState` 並 dispatch `'pageStateSettled'`（auto-enable 邊緣），且**每次靜止都另 dispatch `'screenSettled'`**（供 mid-article 的翻頁兜底 `_onScreenSettled`，pageState 維持 3 時也會收到）。`EasyReading._onPageStateSettled` 監聽該事件，呼叫純函式 `nextEasyReadingState({settledPageState,prevSettledPageState,enabled,enablePref,supported})`（`easy_reading.js` 頂部 export，unit test `tests/unit/easy_reading_logic.test.js`）。條件 `settledPageState==3 && (prevSettledPageState==2 || prevSettledPageState==1) && !enabled && enableEasyReading && supported`，即「**列表(2) 或選單(1) → 文章(3)**」的乾淨 settle 邊緣。enable 由**單一入口** `enterEasyReading()` 執行（見下「切換」段）。
- **為何來源集含選單(1)（CONFIRMED 讀碼）——勿收緊回 `==2`**：精華區（文章列表按 `z` 進入）頂層首列 `【精華文章】`→`pageState 1`(MENU，`term_buf.js` pageState 判定)，子目錄清單落 MENU(1) 或 LIST(2)，兩者都能 Enter 直接進文章 → 只認 `==2` 時精華區的 `1→3` 邊緣不成立，切原生後卡原生直到回真看板列表。主功能表/分類看板雖也是 MENU(1) 但無法直接開文章（必先經看板 LIST(2)），故 `1→3` 實務上只來自精華區，含 1 安全。pass/edit/normal(5/6/0) 不在來源集→原生模式內看說明(5)再回文章(3) 的 `5→3` 不會誤重啟。
- transient 0 為何不污染：half-paint frame(末列空→`pageState=0`，`term_buf.js` pageState 判定)後續一定有更晚的視窗 re-arm 計時器，故 0 永不 settle；settle 只抓「最後靜止值」(3)。列表→文章的 settled 串流乾淨無 0，**無需 latch**。
- 退出抑制天生正確：`switchToNativeAtBottom` 後留在 pageState 3、`settledPageState` 仍 3、**不再升級**→ `'pageStateSettled'` 不觸發、邊緣不成立 → 不誤重啟（故也不需要額外的抑制旗標）。
- 退化情形（guess）：連線在**畫面中途**停 >`SETTLE_MS`（網路卡）才可能 premature settle；最壞首篇自動 enable 漏一次（捲動/重進即恢復），非 crash。`SETTLE_MS` 為可調常數，slow link premature-settle 就調高。

## render 單軌（兩模式同走 `<Screen>`）

兩模式都走 `renderScreen()`＝把 `<Screen lines/>` render 進 mainDisplay(`term_ui.jsx`)，**React 單一擁有 `#mainContainer`**（Screen owns，Row `key={row}`）。差別只在傳給 `<Screen>` 的 `lines`：

| 模式 | `lines` 來源 | 黑名單列 |
|---|---|---|
| 原生 / 好讀列表選單(pageState≠3) | `buf.lines`（單頁 24 列） | `visibility:hidden`（保固定格線，`enhance.dropHidden=false`） |
| 好讀文章(pageState 3) | `buf.pageLines`（累積長頁，`term_view.accumulatePageLines` 純 JS 去重：`comment_parse.resolvePageOverlap`＝狀態列行號為主、`findPageOverlap` 內文比對為輔） | 整列移除（Screen render `null`，`dropHidden=true`，長卷無空行） |

- 逐列加工（blacklist/樓層/作者高亮/pusher 高亮）統一在 `Screen#computeAnnotations` 一處。好讀文章因 `lines=完整 pageLines`，`new FloorCounter()` 一次走完整篇 → 跨頁樓號自然正確（已**無** view 端持久計數器 `_floorCounter`）。
- `dropHidden` 移除的列**不位移**其餘列 `data-row`（=pageLines 絕對索引）；`getText` 用絕對 index → 選取/複製跨缺口仍對齊。
- pusher 高亮：`togglePusherHighlight` 只設 `_selectedPusher`+`redraw(true)`（兩模式同；好讀重繪重入 `accumulatePageLines` 同畫面，`findPageOverlap` 去重成 no-op append，只有 render 反映變更）。
- 好讀兩個 overlay 列（footer `#easyReadingLastRow`、reply `#easyReadingReplyRow`）是 `BBSWin` 下獨立 div、非 `#mainContainer`，仍 imperative 畫（`term_ui.renderOverlayRow` 單列），不涉所有權衝突。
- **圖片預覽（`_renderScreenLines` 的 `inlinePreview`/`hoverPreview` 兩參數，CONFIRMED e2e）**：好讀文章 `inlinePreview=true`+`hoverPreview=false`（自動行內開圖，每個連結旁掛 `<ImagePreviewer Inline>`，**不**受 `enablePicPreview` pref 約束）；原生 `inlinePreview=false`+`hoverPreview=enablePicPreview`（hover 才開）；好讀列表/選單兩者皆 false。守護：unit `image_preview.test.jsx`（Screen→Row→builder 接線）+ e2e `easy-reading.spec.js`「好讀模式自動行內開圖」。
- **`buf.pageLines` 既是 render source 又是選取 source，clone 用 `term_view.cloneRow`**（`Object.assign(Object.create(Object.getPrototypeOf(ch)), ch)`），保留 TermChar prototype 方法（`isStartOfURL`/`getColor`…）；勿用 `JSON.parse(JSON.stringify())`（剝 prototype → render 即炸）。WHY 見 `term_view.js#cloneRow` 註解。
- **跨頁去重 `resolvePageOverlap`（狀態列行號為主，2026-07，治「重複區塊」race，CONFIRMED unit+offline/live e2e 守護）**。2026-08 起半畫幀已被上面的「完整回應幀」閘擋在外，本節的 drift guard 因此退居第二道保險而非主力。`findPageOverlap` 取最大內文相符 `k`，在半畫好中間 frame（重疊區某列未 settle）會 lock 到偏小 `k` → 少跳 → 重複追加 → 畫面重複段落（難重現、非特定文章）。改以狀態列 `目前顯示: 第 S~E 行`（`parseStatusRow` 的 `rowIndexStart/End`）算重疊：`kStatus = accEndRow - statusStart + 1`（`accEndRow` = `pageLines` 末列文章行號＝上頁 rowIndexEnd，`term_view._accEndRow` 追蹤；首頁 seed、`hideEasyReadingOverlays` 重置）。規則：**content 為重疊下界**（`findPageOverlap` 找到的相符列確定重複、必跳，`kStatus<=kContent` 用 `kContent`；長「行」可 wrap 成 2 顯示列使 kStatus 偏小，故不得低於 content）；僅 `kStatus>kContent`（content 因 race 少算）時用 `kStatus` 補回，並過 **drift guard**（該重疊區與 accTail 非空列相符率 <0.5 視為 `accEndRow` 漂移 → 退回 `kContent`）。純函式在 `comment_parse.resolvePageOverlap`，守護 `tests/unit/comment_parse.test.js` `describe("resolvePageOverlap")` + offline `replay_fixture.test.jsx` 鏡像同路徑。
- **換篇不得與舊篇串接（`decideAccumulateBranch` 雙保險，CONFIRMED unit＋replay 合成守護）**：分支決策抽純函式 `comment_parse.decideAccumulateBranch`，`accumulatePageLines` 依其三路 rebuild/append/skip 分流。**`leaveCurrentPost` 的一次性 `prevPageState=0` 不可信**——會被 redraw 每幀末的 `prevPageState=pageState` 覆寫，leave 與新文章第一頁之間夾任何 pageState 3 幀（舊文殘幀）就吃掉旗標 → 兩篇串接且此後恆串接。故：(1) **sticky 旗標 `buf.easyReadingPendingReset`**——`leaveCurrentPost`/`enterEasyReading` 設 true，只在「確認文章第一頁」（`statusStart===1`）時消費，functionMode resume 與 `hideEasyReadingOverlays` 顯式清 false；(2) **身分自癒**——續接時 `statusStart===1 ∧ kContent===0 ∧ acc 非空` ⇒ 不可能是同篇下一頁 → 強制 rebuild（未知路徑漏旗標也能復原；誤判代價僅「從第一頁重新累積」）。守護：`comment_parse.test.js` `describe("decideAccumulateBranch")`＋`replay_fixture.test.jsx` 合成 race 案例。
- **圖片放大/縮小的捲動錨定（2026-07-25，CONFIRMED unit＋offline e2e）**：點內嵌預覽圖切換整頁 `.imagesEnlarged`（`Screen.jsx#handleImageClick`）會讓內容總高驟變，而 `.main` 的 `scrollTop` 不變 → 視窗相對文章整個位移，剛在看的那張圖跑出視野（實測放大態縮小後偏 ~1700px）。修法：click 當下（React 19 的 `setState` 尚未 commit ⇒ 讀到的是**舊 layout**，正是 before 值）以被點的 img 為錨點記 `{topBefore,heightBefore,scrollBefore}` 存 ref，`useLayoutEffect([imagesEnlarged])`（commit 後、paint 前 ⇒ 無閃爍）用 `scroll_anchor.computeAnchoredScrollTop` 換算並寫回 `scrollTop`。錨定分兩式：圖頂仍在視窗內 ⇒ 維持固定間距；圖頂已捲出視窗上方（看大圖常態）⇒ 視窗頂端維持落在圖內同一比例處（縮小後必然仍在圖範圍內）。
  - **座標系鐵則**：量測一律 `offsetTop`/`offsetHeight`，**不可用 `getBoundingClientRect()`**——`.main` 整體被 `transform: scale()`、`img.hyperLinkPreview` 另被套反向 scale（`term_view.setTermFontSize`/`updateReverseScaleCss`），rect 含 transform，與 layout 座標的 `scrollTop` 不同尺規。`offsetTopWithin` 用「兩端各自沿 offsetParent 鏈累加後相減」，因 `#mainContainer` 未設 position、鏈會跳過它（單邊累加會多算）。
  - **已知限制**：只補償同步高度變化。錨點**上方**尚未載入完成的圖（未載入時只佔一行 `LoadingOverlay`）之後撐開仍會推走位置，本次未處理（需 ResizeObserver 限時校正，與使用者捲動/自動翻頁互動難測）。
  - 守護：`tests/unit/scroll_anchor.test.js`（算式＋offsetParent 鏈）＋ offline e2e `easy-reading.offline.spec.js`「點圖縮小後被點的圖仍在視野內」（stock-end.json 圖多；舊 code 實測 visible=-908 → 紅）。
- **內嵌影片（`<video class="easyReadingVideo">`，2026-07-31）**：
  - **尺寸上限比照圖片**（`main.css` `max-height:19em`/`max-width:39em`，`width`/`height` 留 `auto`）。舊值是固定 `width:640px` 無 `max-height` → 直式影片（480×854）高度撐到 1138px 遠超視窗，且影片不像圖片能捲著看，播放控制列被推出畫面即無法操作。**影片沒有 `img.hyperLinkPreview` 那種反向 scale**，故 19em 隨 `scaleY` 一起縮放 ≒ 視窗高八成（19em×26px ÷ 24 列×26px）。守護：offline e2e「影片不得超出可視範圍」（注入刻意超高的 video 替身量 rect，舊 CSS 實測紅）。
  - **退出全螢幕後把影片捲回視野**（`ImagePreviewer.jsx#useFullscreenScrollRestore`）：進全螢幕時 `<video>` 被提到全螢幕層、原位高度塌陷 → 內容總高驟減、`scrollTop` 被夾到新的 maxScroll；退出後高度回來但捲動位置回不去（症狀同上面的放大/縮小，文章跳到很後面）。**不沿用 `computeAnchoredScrollTop`**：原生全螢幕鈕攔不到，退出當下已無 before 值 → 改用可預期的 `scroll_anchor.computeCenteredScrollTop`（影片置中；比視窗高則上緣對齊），並在 `requestAnimationFrame` 內量測（退出的 layout 回復可能落在 `fullscreenchange` 之後）。座標系鐵則同上（`offsetTop`/`offsetHeight`）。守護：`tests/unit/inline_video_fullscreen.test.jsx`＋`scroll_anchor.test.js`。
- **底部 padding**：`accumulatePageLines` 開頭統一設 `mainContainer.paddingBottom='1em'`（讓位給 footer overlay）；回列表/選單由 `hideEasyReadingOverlays` 清回 ''＋`scrollTop=0`（守護 `tests/unit/easy_reading_overlay_reset.test.js`；單頁文末行不被 overlay 遮的回歸見 offline `easy-reading.offline.spec.js`「末行不被底部狀態列 overlay 遮住」）。
- **footer 鏡像（CONFIRMED 讀碼）**：footer overlay (`#easyReadingLastRow`) **不** hardcode 文字，而是每次 `accumulatePageLines` 末由 `_mirrorStatusRowToFooter` 把**真實狀態列** `buf.lines[rows-1]`（含「瀏覽 第 X/Y 頁 (n%)…(h)說明(←)離開」、真實顏色）以 `renderOverlayRow` 畫進去（`parseStatusRow` 守門，transient 空列不洗掉）。WHY：原 hardcode `(y)回應(X%)推文(←)離開` 少「(h)說明」、頁數/% 永遠靜止，與原生不一致（原生 100%／非 100% 都有 (h)說明，差別只在頁數反白）。

## 文章 functionMode（按非導覽鍵 → 鏡像原生 LIVE，CONFIRMED 讀碼+unit）

對應 `EasyReading._functionMode`(=`buf.easyReadingFunctionMode`)。**原則：底部互動不 hardcode、不逐選單 parse——原生畫什麼好讀就鏡像什麼**（與列表好讀的 functionMode 同概念，文章版獨立、更單純）。

- **為何需要**：文章內按 `r` 回應／`X`/`%` 推文／`y` 收暫存檔，PTT 在 row22/row23 畫出選單（pageState 仍 3），但好讀仍渲染累積長頁＋footer，**蓋住選單**。舊作法靠 `curY==22`+`parseReplyText` 偵測「回應至」設 `showReplyText`，但畫選單文字(`changed`)與移游標到 row22(`posChanged`)可能不同 notify 視窗 → `curY` 閘漏接 → 選單不顯示（且到底 `reachedPageEnd` 時 `_onScreenSettled` 提早 return，無兜底）。
- **進入（鍵驅動）**：`_onKeyDownProcessUI` default 分支，凡**單字元鍵**(`e.key.length===1`)且非 leave-post 鍵→`_enterFunctionMode`：清 `sendCommandAfterUpdate`、存 `mainDisplay.scrollTop`、設 `_functionMode=true`、全列 dirty+`notify()` 立即重繪。**不** preventDefault（鍵照送 PTT）。僅 leave-post 鍵(`abf=+-[]ABF`)走 `leaveCurrentPost` 不進。
  - **pmore 功能鍵一律走 functionMode，勿再加 swallow list**：`h` 說明/`o` 選項/`/` 搜尋/`;` 指定頁/`,.<>` 左右捲等鍵由 functionMode 鏡像原生選單（守護 unit `easy_reading_logic.test.js`「pmore function keys enter functionMode」）。`Tab`(`stop=true`)與 ctrl `"@^_?"` 例外（Tab 放行涉 browser focus、不可同時 preventDefault+送鍵）。
  - **進入（貼上驅動）**：貼上不是按鍵 ⇒ 上面那條 `e.key.length===1` 規則抓不到，PTT 因應 `#`／`/`／`;` 等貼上內容畫的 prompt 會被好讀長頁蓋住（使用者看不到反應）。故 `App.onPasteDone` 在送出前補一次 `easyReading._enterFunctionMode()`（該函式自帶 `_functionMode` 早退，重複呼叫無害）。列表好讀的同源缺口見 `docs/easy-reading-list.md` 不變量 12b。
- **鍵流**：`term_view.onKeyDown` gate 加 `&& !buf.easyReadingFunctionMode` → functionMode 期間全鍵直通原生（含 Enter，在原生 prompt/編輯器操作）。
- **渲染**：`term_view.redraw` **最高優先**分支 `useEasyReadingMode && easyReadingFunctionMode` → `hideEasyReadingOverlaysKeepPage()`(只藏 overlay、**不清 pageLines/padding/scroll**)＋`mainDisplay.scrollTop=0`＋`_renderScreenLines(buf.lines)` 整頁原生 24 列 LIVE。**關鍵：不可用 `hideEasyReadingOverlays`**（它清 `pageLines=[]`，退出需重抓整篇、PTT 已在文末 End no-op → 不可行）。
- **退出（內容判定，settle 驅動）**：`_onChanged` functionMode 時早退（不跑翻頁機）；`_onScreenSettled` functionMode 時走 `_evalFunctionModeExit`→純函式 `functionModeExitDecision({pageState,isStatusRow,curY,lastRowNum})`（`easy_reading.js` 頂部 export，unit 守護）：
  - `resume`：`pageState==3 && isStatusRow && curY==lastRowNum`（回乾淨文章頁）→ `_functionMode=false`、`prevPageState=3`+dirty+`notify()`（`accumulatePageLines` 接續分支、`findPageOverlap` 對同畫面去重成 no-op append → 長頁無痕恢復）、還原 `scrollTop`。
  - `leave`：`pageState==1||2`（settle 進選單/列表，使用者離篇）→ `_functionMode=false`、`startedEasyReading=false`、`leaveCurrentPost()`、重繪原生列表；下一篇由既有 settle 重啟。
  - `stay`：其餘（選單/編輯器/pass 5/6/0/transient）→ 續鏡像。
- **enter/exit/leaveCurrentPost** 皆重置 `_functionMode=false`+`_savedScrollTop=null`。
- **與舊 reply/push overlay 路徑關係**：functionMode 為主路徑；`showReplyText`/`showPushInitText` 的 redraw 分支與 `nextEasyReadingRowState` 對應 branch **保留為 legacy fallback**（functionMode 攔截互動鍵 → 機器不在 prompt 幀執行 → 旗標恆 false → 分支實務上不觸發），暫不移除以縮小 blast radius。

**已到底時原生 End 是 no-op → 必附 `^L`**：好讀已自動翻頁到**底**時，實際游標在最後頁，再送原生 End(`\x1b[4~`) PTT **不回應不重繪** → 必須另送 `^L`(`\x0c`, Ctrl-L)強制全頁重繪。`switchToEasyReadingMode()`(無參數)已內含 `^L`(`pttchrome.jsx`)。

## AID（#文章代碼）一鍵跳文（CONFIRMED unit）

好讀讀文中偵測 `#XXXXXXXX`（固定 8 碼 `[0-9A-Za-z_-]`，pttbbs `aidu2aidc` base64 變體；可帶 `(Board)`/`@Board` 後綴，無後綴 fallback `term_view._articleBoard`，來源同列 header `看板 X`，`comment_parse.parseArticleBoard`）→ `.aidLink` 連結。鏈路：`aid_parse.detectAids`（TermChar columns，同 mention_parse DBCS 規則）→ `Screen.computeAnnotations`（僅 `easyReading && enhance.onAidClick`）→ `Row/LinkSegmentBuilder`（同 mention 邊界機制）→ `view.onAidClick`（pttchrome 掛）→ `aid_navigation.AidNavigation.start(aid, board)`。

導航 = 共用 `commandQueue` 三步序列（每步 expect 內容判定、fullRepaint、失敗可見降級；`s`/`#` 在文章內直接可用，**不需先 `←` 退列表**）：`s<board>\r`(expect clean-list+boardName 不分大小寫) → `#<aid>\r`(expect boardName+cursorRowNum+curY 在 entry 區——**不可要求 kind==clean-list**：# 跳文落地 footer 列空白（\f probe 後仍空）→ classify 判 transient，live 驗證 2026-07-10；找不到→vmsg 游標停底列→cursorRowNum null→probe→miss) → `\r`(expect article|statusRow)。前置：`easyReading._enterFunctionMode()`（原生 LIVE 鏡像；離篇/進新文由既有 settle 邏輯收斂）＋ `listSession.beginExternalNavigation()`（強制 functionMode+nativeHold+flush，reducer 對中途 clean-list settle 一律 stay，最後 article settle 走 handoff）。**順序不變量：先 beginExternalNavigation（含 flush）再 enqueue**。導航中 `aidNavigation.active` 於 `term_view.onKeyDown`／`App.mouse_click`／`onMouse_click`／`mouse_scroll` 入口吞輸入（有 banner）。同板也不省略 `s` 切板（單一路徑）。unit：`tests/unit/aid_parse.test.js`、`aid_navigation.test.js`、`row_render.test.jsx`（aidLink render）。

## 切換：三個對稱入口（CONFIRMED 純邏輯/手動驗）

好讀的進/退/離篇收斂到三個語意明確的入口（`easy_reading.js`），新路徑只呼叫入口、不各自設旗標：
- **`enterEasyReading()`**：唯一開好讀點，由 `_onPageStateSettled` 在 settled 2→3 邊緣驅動。`_enabled=true` + `prevPageState=0`/`pageLines=[]`（強制 `populateEasyReadingPage` 新文章 clearRows 分支）+ 全列 dirty + `changed=true` + `notify()` 重播一輪 render/viewUpdate（settle 在 'change' 迴圈外觸發，故需自行重播以啟動翻頁）。
- **`leaveCurrentPost()`**：仍在好讀、離開本篇 → 重置 per-post（`ignoreOneUpdate`、`prevPageState=0`、`_resetPagingState()`），**不改 `_enabled`**。鍵/滑鼠多處直接呼叫；`switchToEasyReadingMode`(`pttchrome.jsx`) 內部也呼叫它（**隱藏傳遞鏈**，已加註解標出）。
  - **踩坑：per-post 狀態不可只靠這三個入口重置**（2026-08，「進文章卡在第一頁」的根因）。最常見的換文章路徑一個都不經過它們：`←` 走 `stopEasyReading()`（只設 `sendCommandAfterUpdate='skipOne'`）**不經 `leaveCurrentPost()`**；而好讀已經開著時再進下一篇**也不經 `enterEasyReading()`**（`nextEasyReadingState` 要求 `!enabled`）。凡是「每篇一份」的狀態，重置點必須掛在 settle 的文章邊界（`_onPageStateSettled`），不能掛在按鍵路徑上。
- **`exitEasyReading()`**：唯一關好讀點。`sendCommandAfterUpdate=''` + `_enabled=false` + `_core.switchToEasyReadingMode()`（還原 overlay 列/padding/pageLines+送 `^L`）。React 恆擁有 `#mainContainer`，切原生由 reconcile 把長頁收回 24 列（無 unmount）。

`EasyReading.switchToNativeAtBottom`（End/$/G 與滑鼠 End）= `_send('\x1b[4~')`（原生 End 導到底）+ `exitEasyReading()`。

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
