# 好讀模式（EasyReading）架構與踩坑

對應 `src/js/easy_reading.js` + `src/js/term_buf.js`(settle pageState) + `src/js/term_view.js`(render) + `src/js/pttchrome.js`(切換/按鍵)。
2026-06 改 End 行為時整理；同月再以 settle debounce 治本重構（pageState 去抖動 + 移除 `_cameFromList` latch + 收斂進/退入口）。狀態旗標：CONFIRMED（已 e2e 實證）/ guess。

## 機制（CONFIRMED）

- 啟用條件：pref `enableEasyReading`(預設 **false**, `PrefModal.js:27`) && `connectedUrl.easyReadingSupported`(`pttchrome.js:185` true)。使用者自己開，存 localStorage `pttchrome.pref.v1`。
- 啟用旗標：`view.useEasyReadingMode`，由 `bindProperty` 綁成 `EasyReading._enabled`（`easy_reading.js:27`）。
- 進文章(pageState 3)後 `_onChanged` 持續送 PageDown(`\x1b[6~`)把整篇累積成可捲動長頁：`sendCommandAfterUpdate='\x1b[6~'`(`:83`) → `_onViewUpdated` 實際送出(`:117-126`)。長文章(精華區索引)因此自動翻頁久、攔截 `/` 等鍵 → 原生搜尋不可用。
- 自動「重新啟用」（**settle 後判斷，2026-06 重構，CONFIRMED 純邏輯/手動驗**）：靠 term_buf 的**去抖動** pageState 串流，不再逐 frame 判。`term_buf` 維護 `settledPageState`/`prevSettledPageState`：`notify`(`:785`) 每個 `changed` 視窗 re-arm 一個 `SETTLE_MS=50`(`term_buf.js` 頂常數) 計時器；資料持續到達(~30ms 間隔)時一直 re-arm 不觸發，**畫面靜止 50ms 後**才把當前 `pageState` 升為 `settledPageState` 並 dispatch `'pageStateSettled'`。`EasyReading._onPageStateSettled` 監聽該事件，呼叫純函式 `nextEasyReadingState({settledPageState,prevSettledPageState,enabled,enablePref,supported})`（`easy_reading.js` 頂部 export，unit test `tests/unit/easy_reading_logic.test.js`）。條件 `settledPageState==3 && prevSettledPageState==2 && !enabled && enableEasyReading && supported`，即乾淨的「列表(2)→文章(3)」邊緣。enable 由**單一入口** `enterEasyReading()` 執行（見下「切換」段）。
- transient 0 為何不污染：half-paint frame(末列空→`pageState=0`，`term_buf.js:1016`)後續一定有更晚的視窗 re-arm 計時器，故 0 永不 settle；settle 只抓「最後靜止值」(3)。列表→文章的 settled 串流乾淨無 0，無需 latch。
- 退出抑制天生正確：`switchToNativeAtBottom` 後留在 pageState 3、`settledPageState` 仍 3、**不再升級**→ `'pageStateSettled'` 不觸發、邊緣不成立 → 不誤重啟（取代舊 `_cameFromList` latch 與 `prevPageState=0` 抑制）。
- 退化情形（guess）：連線在**畫面中途**停 >`SETTLE_MS`（網路卡）才可能 premature settle；最壞首篇自動 enable 漏一次（捲動/重進即恢復），非 crash。`SETTLE_MS` 為可調常數，slow link premature-settle 就調高。

**踩坑 #12（登入後第一篇偶發走原生，已治本）**：症狀=PTT 把文章分多個 30ms redraw 視窗畫出，半畫 frame 末列空→`pageState=0`，而 `prevPageState` 每輪 render 被覆寫(`term_view.js:323`)→列表(2)→半畫(0)→文章(3) 使進文章瞬間 `prevPageState` 是 0 非 2，整篇卡原生（登入後第一篇未快取、最易跨多視窗故機率最高）。
→ **舊治標**（commit 77d49df，已移除）：`_cameFromList` latch 繞過 transient frame；但 latch 需在 `leaveCurrentPost` 同步清除，否則按 End→`exitEasyReading`(unmount React)→其 `^L` 重繪(pageState 3)→latch 仍真→重啟好讀→`populateEasyReadingPage` 讀失效的 `mainContainer.style`→crash。
→ **現治本**（settle debounce）：上面三條。re-enable 改吃 `settledPageState`（transient 0 永不入串流），latch 整個移除；crash 路徑隨之消失（settle 不升級就不重啟）。`prevPageState` 仍逐 frame，只服務渲染（見下）。

## render 雙軌（這是最大坑）

| 模式 | 路徑 | 寫入 |
|---|---|---|
| 原生 | `renderScreen()`=`ReactDOM.render(<Screen lines/>, mainDisplay)`(`term_ui.js:34`) | React 管理 `#mainContainer`(Screen 元件 owns，`Screen.js:51`，Row `key={row}`) |
| 好讀 | `populateEasyReadingPage`→`clearRows()`(`mainContainer.innerHTML=''`)+`appendRows`(`term_view.js:800-815`) | **直接竄改** `#mainContainer`，繞過 React |

**坑 1（凍結根因）**：好讀直接 `innerHTML=''`+appendRows 後，React 的 vdom 仍記得它建立的 Row（已 detached）。之後再 `renderScreen()` React 只更新那些 detached 節點，**不會清掉螢幕上累積的手工列** → 畫面凍結（DOM 仍 N 列、非原生 24 列）。
→ 解法：切原生前 `ReactDOM.unmountComponentAtNode(mainDisplay)` 強制丟棄 stale vdom，下次 render 乾淨重掛。

**坑 2**：好讀已自動翻頁到**底**時，實際游標在最後頁，再送原生 End(`\x1b[4~`)是 **no-op、PTT 不回應不重繪** → 必須另送 `^L`(`\x0c`, Ctrl-L)強制全頁重繪。`switchToEasyReadingMode()`(無參數)已內含 `^L`(`pttchrome.js:354`)。

## 切換：三個對稱入口（CONFIRMED 純邏輯/手動驗）

好讀的進/退/離篇收斂到三個語意明確的入口（`easy_reading.js`），新路徑只呼叫入口、不各自設旗標：
- **`enterEasyReading()`**：唯一開好讀點，由 `_onPageStateSettled` 在 settled 2→3 邊緣驅動。`_enabled=true` + `prevPageState=0`/`pageLines=[]`（強制 `populateEasyReadingPage` 新文章 clearRows 分支）+ 全列 dirty + `changed=true` + `notify()` 重播一輪 render/viewUpdate（settle 在 'change' 迴圈外觸發，故需自行重播以啟動翻頁）。
- **`leaveCurrentPost()`**：仍在好讀、離開本篇 → 重置 per-post（`ignoreOneUpdate`、`prevPageState=0`），**不改 `_enabled`**。鍵/滑鼠多處直接呼叫；`switchToEasyReadingMode`(`pttchrome.js:344`) 內部也呼叫它（**隱藏傳遞鏈**，已加註解標出）。
- **`exitEasyReading()`**：唯一關好讀點。`sendCommandAfterUpdate=''` + `_enabled=false` + `_core.switchToEasyReadingMode()`（還原 DOM(last/reply row, padding, pageLines)+送 `^L`）+ `ReactDOM.unmountComponentAtNode(_view.mainDisplay)`（破解坑1）。

`EasyReading.switchToNativeAtBottom`（End/$/G 與滑鼠 End）= `_send('\x1b[4~')`（原生 End 導到底）+ `exitEasyReading()`。

所有手動關好讀路徑都走 `exitEasyReading()`：End、pref 關閉（`_onChanged` 偵測 `!enableEasyReading && _enabled`）、LiveHelper「取消好讀」(`ContextMenu/index.js:226`，**2026-06 修**：原 `useEasyReadingMode=false`+`switchToEasyReadingMode()` 漏 unmount→坑1 latent freeze，已改呼叫 `pttchrome.easyReading.exitEasyReading()`)、e2e `applyPrefs`。
- `ReactDOM` 在 `easy_reading.js` 可直接用（webpack externals 全域，`webpack.config.js:110`），免 import。
- `switchToEasyReadingMode(doSwitch)`：無參/falsy→還原 DOM+`^L`；truthy→進好讀。`hideEasyReading()`(`term_view.js:825`)是另一條「以 appendRows 重建原生單頁」的退出路徑（pageState≠3 時用）。

## 鍵流（CONFIRMED）

- `term_view.onKeyDown`(`:344`)：`if useEasyReadingMode && startedEasyReading && !reply/pushInit` → `easyReading._onKeyDown`→`_onKeyDownProcessUI`。切原生後 useEasyReadingMode=false ⇒ 走原生 `_keyboard.onKeyDown`，左鍵`\x1b[D`原生離開文章。
- 原生鍵序：`term_keyboard.js` KeyMap，End=`\x1b[4~`、Left=`\x1b[D`、PageDown=`\x1b[6~`。

## e2e 測試要點（tests/e2e/easy-reading.spec.js）

- **好讀預設 false**：測試須在 `page.addInitScript` 寫 localStorage `pttchrome.pref.v1`→`{values:{enableEasyReading:true}}` 才會啟動，否則 End 只是原生（測不到）。
- app 未掛全域：`main.js` 僅 `DEVELOPER_MODE`(dev build 有)下 `window.__app=app`(`:9`)供測試讀 `view.useEasyReadingMode`/`buf.pageState`。
- 判好讀 vs 原生：好讀 `mainContainer` 累積 >24 列且 `#easyReadingLastRow` display:block；原生 24 列、lastRow display:none、畫面含「說明」狀態列。
- 取消 PTT 搜尋提示用**空 Enter**，勿用 Escape（pmore 把 `\x1b` 當逃逸序列開頭，導覽錯亂）。
- 連線偶發 403/ECONNRESET（PTT 端 flake）；勿與 `yarn build` 並行跑（clean 會擾動）。
- 驗證序列：好讀啟動(useEasyReadingMode=true,~41列)→End(false,≤24列,lastRow none,「說明」+「100%」)→`/`(搜尋提示)→左鍵(pageState 2)→進下篇(true)。
