# 好讀模式（EasyReading）架構與踩坑

對應 `src/js/easy_reading.js` + `src/js/term_buf.js`(settle pageState) + `src/js/term_view.js`(render) + `src/js/pttchrome.js`(切換/按鍵)。
2026-06 改 End 行為時整理；同月再以 settle debounce 治本重構（pageState 去抖動 + 移除 `_cameFromList` latch + 收斂進/退入口）。狀態旗標：CONFIRMED（已 e2e 實證）/ guess。

## 機制（CONFIRMED）

- 啟用條件：pref `enableEasyReading`(預設 **false**, `PrefModal.js:27`) && `connectedUrl.easyReadingSupported`(`pttchrome.js:185` true)。使用者自己開，存 localStorage `pttchrome.pref.v1`。
- 啟用旗標：`view.useEasyReadingMode`，由 `bindProperty` 綁成 `EasyReading._enabled`（`easy_reading.js:27`）。
- 進文章(pageState 3)後**快路徑**逐 redraw frame 由 `_onChanged` 判斷、`_onViewUpdated` 送 PageDown(`\x1b[6~`)把整篇累積成可捲動長頁（決策落純函式 `nextEasyReadingRowState`；`_onChanged` 已抽 `_computeRowState`+`_applyRowState` 兩 helper 供快路徑與兜底共用）。長文章(精華區索引)因此自動翻頁久、攔截 `/` 等鍵 → 原生搜尋不可用。
- **翻頁兜底（settle 驅動，2026-06，治推文截斷 race，CONFIRMED 讀碼/unit+e2e 守護）**：快路徑只在 `changed` frame 觸發，但 PTT「把游標停到底部狀態列」是**獨立的純游標 escape（只設 `posChanged` 不設 `changed`）**，可能落在自己的 notify 視窗 → `if(this.changed)` 區塊整段跳過 → `change`/`viewUpdate` 不 dispatch → `_onChanged` 看不到「游標已到狀態列」的關鍵幀 → 不再送 PageDown → 累積頁缺尾（登入後第一篇封包最碎、機率最高）。`EasyReading._onScreenSettled` 監聽 term_buf 每靜止視窗的 `screenSettled`，在「畫面真靜止（內容＋游標都停）」時重跑同一決策、補送漏掉的 PageDown。以**頁面簽章**（狀態列 `第 a~b 行` 範圍，`_currentPageSignature`）對快路徑去重：每送一次 PageDown（快路徑 `_onViewUpdated` 或兜底）都記 `_lastPagedDownSignature`，settle 只在「本頁尚未送過」時補送 → PTT 慢回應也不會雙送跳頁。簽章於 `enterEasyReading`/`leaveCurrentPost` 重置。快路徑成功時，畫面在非 100% 頁不會靜止（立即翻頁），故 settle 只在快路徑脫拍時「補洞」、與其互斥。
- 自動「重新啟用」（**settle 後判斷，2026-06 重構，CONFIRMED 純邏輯/手動驗**）：靠 term_buf 的**去抖動** pageState 串流，不再逐 frame 判。`term_buf` 維護 `settledPageState`/`prevSettledPageState`：`notify` 每個 `changed` **或純游標(`posChanged`)** 視窗都 re-arm 一個 `SETTLE_MS=50`(`term_buf.js` 頂常數) 計時器（抽成 `term_buf._armSettleTimer`）；資料/游標持續到達(~30ms 間隔)時一直 re-arm 不觸發，**畫面真靜止（內容＋游標都停）50ms 後**才觸發：`pageState` 改變時升 `settledPageState` 並 dispatch `'pageStateSettled'`（auto-enable 邊緣），且**每次靜止都另 dispatch `'screenSettled'`**（供 mid-article 的翻頁兜底 `_onScreenSettled`，pageState 維持 3 時也會收到）。`EasyReading._onPageStateSettled` 監聽該事件，呼叫純函式 `nextEasyReadingState({settledPageState,prevSettledPageState,enabled,enablePref,supported})`（`easy_reading.js` 頂部 export，unit test `tests/unit/easy_reading_logic.test.js`）。條件 `settledPageState==3 && (prevSettledPageState==2 || prevSettledPageState==1) && !enabled && enableEasyReading && supported`，即「**列表(2) 或選單(1) → 文章(3)**」的乾淨 settle 邊緣。enable 由**單一入口** `enterEasyReading()` 執行（見下「切換」段）。
- **為何含選單(1)（精華區重啟修正，CONFIRMED 讀碼，2026-06）**：精華區（文章列表按 `z` 進入）頂層首列 `【精華文章】`→`pageState 1`(MENU，`term_buf.js:1031-1035`)，子目錄清單落 MENU(1) 或 LIST(2)，兩者都能 Enter 直接進文章。原條件只認 `==2`，故在精華區按 End 切原生後，下一篇是 `1→3` 邊緣→重啟不成立→卡原生，必須回真看板列表(2)才復原。改吃 `1||2` 後精華區也會重啟。主功能表/分類看板雖也是 MENU(1) 但無法直接開文章（必先經看板 LIST(2)），故 `1→3` 實務上只來自精華區，含 1 安全。pass/edit/normal(5/6/0) 不在來源集→原生模式內看說明(5)再回文章(3) 的 `5→3` 不會誤重啟。
- transient 0 為何不污染：half-paint frame(末列空→`pageState=0`，`term_buf.js:1016`)後續一定有更晚的視窗 re-arm 計時器，故 0 永不 settle；settle 只抓「最後靜止值」(3)。列表→文章的 settled 串流乾淨無 0，無需 latch。
- 退出抑制天生正確：`switchToNativeAtBottom` 後留在 pageState 3、`settledPageState` 仍 3、**不再升級**→ `'pageStateSettled'` 不觸發、邊緣不成立 → 不誤重啟（取代舊 `_cameFromList` latch 與 `prevPageState=0` 抑制）。
- 退化情形（guess）：連線在**畫面中途**停 >`SETTLE_MS`（網路卡）才可能 premature settle；最壞首篇自動 enable 漏一次（捲動/重進即恢復），非 crash。`SETTLE_MS` 為可調常數，slow link premature-settle 就調高。

## render 單軌（兩模式同走 `<Screen>`）

兩模式都走 `renderScreen()`=`ReactDOM.render(<Screen lines/>, mainDisplay)`(`term_ui.js`)，**React 單一擁有 `#mainContainer`**（Screen owns，Row `key={row}`）。差別只在傳給 `<Screen>` 的 `lines`：

| 模式 | `lines` 來源 | 黑名單列 |
|---|---|---|
| 原生 / 好讀列表選單(pageState≠3) | `buf.lines`（單頁 24 列） | `visibility:hidden`（保固定格線，`enhance.dropHidden=false`） |
| 好讀文章(pageState 3) | `buf.pageLines`（累積長頁，`term_view.accumulatePageLines` 純 JS `findPageOverlap` 去重） | 整列移除（Screen render `null`，`dropHidden=true`，長卷無空行） |

- 逐列加工（blacklist/樓層/作者高亮/pusher 高亮）統一在 `Screen#computeAnnotations` 一處。好讀文章因 `lines=完整 pageLines`，`new FloorCounter()` 一次走完整篇 → 跨頁樓號自然正確（已**無** view 端持久計數器 `_floorCounter`）。
- `dropHidden` 移除的列**不位移**其餘列 `data-row`（=pageLines 絕對索引）；`getText` 用絕對 index → 選取/複製跨缺口仍對齊（順帶修掉舊 `appendRows` 的 `srow`/`data-row` off-by-one）。
- pusher 高亮：`togglePusherHighlight` 只設 `_selectedPusher`+`redraw(true)`（兩模式同；好讀重繪重入 `accumulatePageLines` 同畫面，`findPageOverlap` 去重成 no-op append，只有 render 反映變更）。
- 好讀兩個 overlay 列（footer `#easyReadingLastRow`、reply `#easyReadingReplyRow`）是 `BBSWin` 下獨立 div、非 `#mainContainer`，仍 imperative 畫（`term_ui.renderOverlayRow` 單列），不涉所有權衝突。
- **圖片預覽（`_renderScreenLines` 的 `inlinePreview`/`hoverPreview` 兩參數，CONFIRMED e2e）**：好讀文章 `inlinePreview=true`+`hoverPreview=false`（自動行內開圖，每個連結旁掛 `<ImagePreviewer Inline>`，等同舊 `appendRows(showsLinkPreview=true)`，**不**受 `enablePicPreview` pref 約束）；原生 `inlinePreview=false`+`hoverPreview=enablePicPreview`（hover 才開）；好讀列表/選單兩者皆 false。守護：unit `image_preview.test.js`（Screen→Row→builder 接線）+ e2e `easy-reading.spec.js`「好讀模式自動行內開圖」。
- **`buf.pageLines` 既是 render source 又是選取 source，clone 用 `term_view.cloneRow`**（`Object.assign(Object.create(Object.getPrototypeOf(ch)), ch)`），保留 TermChar prototype 方法（`isStartOfURL`/`getColor`…）；勿用 `JSON.parse(JSON.stringify())`（剝 prototype → render 即炸）。WHY 見 `term_view.js#cloneRow` 註解。
- **底部 padding**：`accumulatePageLines` 開頭統一設 `mainContainer.paddingBottom='1em'`（讓位給 footer overlay）；回列表/選單由 `hideEasyReadingOverlays` 清回 ''＋`scrollTop=0`（守護 `tests/unit/easy_reading_overlay_reset.test.js`；單頁文末行不被 overlay 遮的回歸見 offline `easy-reading.offline.spec.js`「末行不被底部狀態列 overlay 遮住」）。
- **footer 鏡像（CONFIRMED 讀碼）**：footer overlay (`#easyReadingLastRow`) **不** hardcode 文字，而是每次 `accumulatePageLines` 末由 `_mirrorStatusRowToFooter` 把**真實狀態列** `buf.lines[rows-1]`（含「瀏覽 第 X/Y 頁 (n%)…(h)說明(←)離開」、真實顏色）以 `renderOverlayRow` 畫進去（`parseStatusRow` 守門，transient 空列不洗掉）。WHY：原 hardcode `(y)回應(X%)推文(←)離開` 少「(h)說明」、頁數/% 永遠靜止，與原生不一致（原生 100%／非 100% 都有 (h)說明，差別只在頁數反白）。

## 文章 functionMode（按非導覽鍵 → 鏡像原生 LIVE，CONFIRMED 讀碼+unit）

對應 `EasyReading._functionMode`(=`buf.easyReadingFunctionMode`)。**原則：底部互動不 hardcode、不逐選單 parse——原生畫什麼好讀就鏡像什麼**（與未合併分支 `wip/easy-reading-list` 的 list functionMode 同概念，文章版獨立、更單純）。

- **為何需要**：文章內按 `r` 回應／`X`/`%` 推文／`y` 收暫存檔，PTT 在 row22/row23 畫出選單（pageState 仍 3），但好讀仍渲染累積長頁＋footer，**蓋住選單**。舊作法靠 `curY==22`+`parseReplyText` 偵測「回應至」設 `showReplyText`，但畫選單文字(`changed`)與移游標到 row22(`posChanged`)可能不同 notify 視窗 → `curY` 閘漏接 → 選單不顯示（且到底 `reachedPageEnd` 時 `_onScreenSettled` 提早 return，無兜底）。
- **進入（鍵驅動）**：`_onKeyDownProcessUI` default 分支，凡**單字元鍵**(`e.key.length===1`)且不在導覽吞鍵清單→`_enterFunctionMode`：清 `sendCommandAfterUpdate`、存 `mainDisplay.scrollTop`、設 `_functionMode=true`、全列 dirty+`notify()` 立即重繪。**不** preventDefault（鍵照送 PTT）。leave-post 鍵(`abf=+-[]ABF`)與吞鍵清單不進。
- **鍵流**：`term_view.onKeyDown` gate 加 `&& !buf.easyReadingFunctionMode` → functionMode 期間全鍵直通原生（含 Enter，在原生 prompt/編輯器操作）。
- **渲染**：`term_view.redraw` **最高優先**分支 `useEasyReadingMode && easyReadingFunctionMode` → `hideEasyReadingOverlaysKeepPage()`(只藏 overlay、**不清 pageLines/padding/scroll**)＋`mainDisplay.scrollTop=0`＋`_renderScreenLines(buf.lines)` 整頁原生 24 列 LIVE。**關鍵：不可用 `hideEasyReadingOverlays`**（它清 `pageLines=[]`，退出需重抓整篇、PTT 已在文末 End no-op → 不可行）。
- **退出（內容判定，settle 驅動）**：`_onChanged` functionMode 時早退（不跑翻頁機）；`_onScreenSettled` functionMode 時走 `_evalFunctionModeExit`→純函式 `functionModeExitDecision({pageState,isStatusRow,curY,lastRowNum})`（`easy_reading.js` 頂部 export，unit 守護）：
  - `resume`：`pageState==3 && isStatusRow && curY==lastRowNum`（回乾淨文章頁）→ `_functionMode=false`、`prevPageState=3`+dirty+`notify()`（`accumulatePageLines` 接續分支、`findPageOverlap` 對同畫面去重成 no-op append → 長頁無痕恢復）、還原 `scrollTop`。
  - `leave`：`pageState==1||2`（settle 進選單/列表，使用者離篇）→ `_functionMode=false`、`startedEasyReading=false`、`leaveCurrentPost()`、重繪原生列表；下一篇由既有 settle 重啟。
  - `stay`：其餘（選單/編輯器/pass 5/6/0/transient）→ 續鏡像。
- **enter/exit/leaveCurrentPost** 皆重置 `_functionMode=false`+`_savedScrollTop=null`。
- **與舊 reply/push overlay 路徑關係**：functionMode 為主路徑；`showReplyText`/`showPushInitText` 的 redraw 分支與 `nextEasyReadingRowState` 對應 branch **保留為 legacy fallback**（functionMode 攔截互動鍵 → 機器不在 prompt 幀執行 → 旗標恆 false → 分支實務上不觸發），暫不移除以縮小 blast radius。

**坑 2（仍有效）**：好讀已自動翻頁到**底**時，實際游標在最後頁，再送原生 End(`\x1b[4~`)是 **no-op、PTT 不回應不重繪** → 必須另送 `^L`(`\x0c`, Ctrl-L)強制全頁重繪。`switchToEasyReadingMode()`(無參數)已內含 `^L`(`pttchrome.js:354`)。

## 切換：三個對稱入口（CONFIRMED 純邏輯/手動驗）

好讀的進/退/離篇收斂到三個語意明確的入口（`easy_reading.js`），新路徑只呼叫入口、不各自設旗標：
- **`enterEasyReading()`**：唯一開好讀點，由 `_onPageStateSettled` 在 settled 2→3 邊緣驅動。`_enabled=true` + `prevPageState=0`/`pageLines=[]`（強制 `populateEasyReadingPage` 新文章 clearRows 分支）+ 全列 dirty + `changed=true` + `notify()` 重播一輪 render/viewUpdate（settle 在 'change' 迴圈外觸發，故需自行重播以啟動翻頁）。
- **`leaveCurrentPost()`**：仍在好讀、離開本篇 → 重置 per-post（`ignoreOneUpdate`、`prevPageState=0`），**不改 `_enabled`**。鍵/滑鼠多處直接呼叫；`switchToEasyReadingMode`(`pttchrome.js:344`) 內部也呼叫它（**隱藏傳遞鏈**，已加註解標出）。
- **`exitEasyReading()`**：唯一關好讀點。`sendCommandAfterUpdate=''` + `_enabled=false` + `_core.switchToEasyReadingMode()`（還原 overlay 列/padding/pageLines+送 `^L`）。**已無** `unmountComponentAtNode`（統一渲染後 React 恆擁有 `#mainContainer`，切原生由 reconcile 把長頁收回 24 列，舊坑1 凍結消失）。

`EasyReading.switchToNativeAtBottom`（End/$/G 與滑鼠 End）= `_send('\x1b[4~')`（原生 End 導到底）+ `exitEasyReading()`。

所有手動關好讀路徑都走 `exitEasyReading()`：End、pref 關閉（`_onChanged` 偵測 `!enableEasyReading && _enabled`）、LiveHelper「取消好讀」(`ContextMenu/index.js:226`，**2026-06 修**：原 `useEasyReadingMode=false`+`switchToEasyReadingMode()` 漏 unmount→坑1 latent freeze，已改呼叫 `pttchrome.easyReading.exitEasyReading()`)、e2e `applyPrefs`。
- `ReactDOM` 在 `easy_reading.js` 可直接用（webpack externals 全域，`webpack.config.js:110`），免 import。
- `switchToEasyReadingMode(doSwitch)`：無參/falsy→還原 DOM+`^L`；truthy→進好讀。好讀開但畫面是列表/選單(pageState≠3)時，`redraw` 走 `hideEasyReadingOverlays()`（只還原 overlay 列+清 pageLines）後以 `_renderScreenLines(buf.lines)` 畫單頁（同原生路徑）。

## 鍵流（CONFIRMED）

- `term_view.onKeyDown`(`:344`)：`if useEasyReadingMode && startedEasyReading && !reply/pushInit` → `easyReading._onKeyDown`→`_onKeyDownProcessUI`。切原生後 useEasyReadingMode=false ⇒ 走原生 `_keyboard.onKeyDown`，左鍵`\x1b[D`原生離開文章。
- 原生鍵序：`term_keyboard.js` KeyMap，End=`\x1b[4~`、Left=`\x1b[D`、PageDown=`\x1b[6~`。

## e2e 測試要點（tests/e2e/easy-reading.spec.js）

- **好讀預設 false**：測試須在 `page.addInitScript` 寫 localStorage `pttchrome.pref.v1`→`{values:{enableEasyReading:true}}` 才會啟動，否則 End 只是原生（測不到）。
- app 未掛全域：`main.js` 僅 `DEVELOPER_MODE`(dev build 有)下 `window.__app=app`(`:9`)供測試讀 `view.useEasyReadingMode`/`buf.pageState`。
- 判好讀 vs 原生：好讀 `mainContainer` 累積 >24 列且 `#easyReadingLastRow` display:block；原生 24 列、lastRow display:none、畫面含原生狀態列「瀏覽 第 N 頁…」。原生狀態列**不論 100% 或非 100% 都含「(h)說明」**（差別只在頁數指示器顏色，到底時反白）。**勿**用「mainContainer 是否含瀏覽第」分原生/好讀 footer：footer overlay 現已**即時鏡像真實狀態列**（含「瀏覽 第…(h)說明」，見 render 段「footer 鏡像」），但它是 `BBSWin` 下獨立 div、非 `#mainContainer`，故 `mc.innerText` 不含它——仍以 `useEasyReadingMode`/`mcChildren`/`lastRowDisplay` 區分。
- 取消 PTT 搜尋提示用**空 Enter**，勿用 Escape（pmore 把 `\x1b` 當逃逸序列開頭，導覽錯亂）。
- 連線偶發 403/ECONNRESET（PTT 端 flake）；勿與 `yarn build` 並行跑（clean 會擾動）。
- 驗證序列：好讀啟動(useEasyReadingMode=true,~41列)→End(false,≤24列,lastRow none,「瀏覽 第 N 頁」+「100%」)→`/`(搜尋提示)→左鍵(pageState 2)→進下篇(true)。
