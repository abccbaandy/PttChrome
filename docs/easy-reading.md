# 好讀模式（EasyReading）架構與踩坑

對應 `src/js/easy_reading.js` + `src/js/term_view.js`(render) + `src/js/pttchrome.js`(切換/按鍵)。
2026-06 改 End 行為時整理。狀態旗標：CONFIRMED（已 e2e 實證）/ guess。

## 機制（CONFIRMED）

- 啟用條件：pref `enableEasyReading`(預設 **false**, `PrefModal.js:27`) && `connectedUrl.easyReadingSupported`(`pttchrome.js:185` true)。使用者自己開，存 localStorage `pttchrome.pref.v1`。
- 啟用旗標：`view.useEasyReadingMode`，由 `bindProperty` 綁成 `EasyReading._enabled`（`easy_reading.js:27`）。
- 進文章(pageState 3)後 `_onChanged` 持續送 PageDown(`\x1b[6~`)把整篇累積成可捲動長頁：`sendCommandAfterUpdate='\x1b[6~'`(`:83`) → `_onViewUpdated` 實際送出(`:117-126`)。長文章(精華區索引)因此自動翻頁久、攔截 `/` 等鍵 → 原生搜尋不可用。
- 自動「重新啟用」：`_onChanged` 條件 `prevPageState==2 && pageState==3 && !_enabled && enableEasyReading && supported`(`:40-44`)。離開文章回列表(2)→進下篇(3)自然觸發，**不需手動 re-enable**。`prevPageState` 由 `term_view` 每次 render 後設 `buf.prevPageState=buf.pageState`(`:291/796`)。

## render 雙軌（這是最大坑）

| 模式 | 路徑 | 寫入 |
|---|---|---|
| 原生 | `renderScreen()`=`ReactDOM.render(<Screen lines/>, mainDisplay)`(`term_ui.js:34`) | React 管理 `#mainContainer`(Screen 元件 owns，`Screen.js:51`，Row `key={row}`) |
| 好讀 | `populateEasyReadingPage`→`clearRows()`(`mainContainer.innerHTML=''`)+`appendRows`(`term_view.js:800-815`) | **直接竄改** `#mainContainer`，繞過 React |

**坑 1（凍結根因）**：好讀直接 `innerHTML=''`+appendRows 後，React 的 vdom 仍記得它建立的 Row（已 detached）。之後再 `renderScreen()` React 只更新那些 detached 節點，**不會清掉螢幕上累積的手工列** → 畫面凍結（DOM 仍 N 列、非原生 24 列）。
→ 解法：切原生前 `ReactDOM.unmountComponentAtNode(mainDisplay)` 強制丟棄 stale vdom，下次 render 乾淨重掛。

**坑 2**：好讀已自動翻頁到**底**時，實際游標在最後頁，再送原生 End(`\x1b[4~`)是 **no-op、PTT 不回應不重繪** → 必須另送 `^L`(`\x0c`, Ctrl-L)強制全頁重繪。`switchToEasyReadingMode()`(無參數)已內含 `^L`(`pttchrome.js:354`)。

## 切回原生的正解（CONFIRMED）

`EasyReading.switchToNativeAtBottom`（End/$/G 與滑鼠 End → 此法）：
```
sendCommandAfterUpdate=''        // 停殘留自動翻頁
_send('\x1b[4~')                 // 原生 End 導到底
_enabled=false                   // useEasyReadingMode=false
_core.switchToEasyReadingMode()  // 還原 DOM(last/reply row, padding, pageLines)+送 ^L
ReactDOM.unmountComponentAtNode(_view.mainDisplay)  // 破解坑1
```
- 既有同義路徑：LiveHelper「取消好讀」(`ContextMenu/index.js:226`)=`useEasyReadingMode=false`+`switchToEasyReadingMode()`，但**它沒 unmount → 同樣有坑1（latent bug，會凍結）**。
- `ReactDOM` 在 `easy_reading.js` 可直接用（webpack externals 全域，`webpack.config.js:110`），免 import。
- `switchToEasyReadingMode(doSwitch)`：無參/falsy→還原 DOM+`^L`；truthy→進好讀。`hideEasyReading()`(`term_view.js:825`)是另一條「以 appendRows 重建原生單頁」的退出路徑（pageState≠3 時用）。

## 鍵流（CONFIRMED）

- `term_view.onKeyDown`(`:344`)：`if useEasyReadingMode && startedEasyReading && !reply/pushInit` → `easyReading._onKeyDown`→`_onKeyDownProcessUI`。切原生後 useEasyReadingMode=false ⇒ 走原生 `_keyboard.onKeyDown`，左鍵`\x1b[D`原生離開文章。
- 原生鍵序：`term_keyboard.js` KeyMap，End=`\x1b[4~`、Left=`\x1b[D`、PageDown=`\x1b[6~`。

## e2e 測試要點（tests/e2e/easy-reading.spec.js）

- dev build 須 `NODE_OPTIONS=--openssl-legacy-provider`(webpack4+Node24)。
- **好讀預設 false**：測試須在 `page.addInitScript` 寫 localStorage `pttchrome.pref.v1`→`{values:{enableEasyReading:true}}` 才會啟動，否則 End 只是原生（測不到）。
- app 未掛全域：`main.js` 僅 `DEVELOPER_MODE`(dev build 有)下 `window.__app=app`(`:9`)供測試讀 `view.useEasyReadingMode`/`buf.pageState`。
- 判好讀 vs 原生：好讀 `mainContainer` 累積 >24 列且 `#easyReadingLastRow` display:block；原生 24 列、lastRow display:none、畫面含「說明」狀態列。
- 取消 PTT 搜尋提示用**空 Enter**，勿用 Escape（pmore 把 `\x1b` 當逃逸序列開頭，導覽錯亂）。
- 連線偶發 403/ECONNRESET（PTT 端 flake）；勿與 `yarn build` 並行跑（clean 會擾動）。
- 驗證序列：好讀啟動(useEasyReadingMode=true,~41列)→End(false,≤24列,lastRow none,「說明」+「100%」)→`/`(搜尋提示)→左鍵(pageState 2)→進下篇(true)。
