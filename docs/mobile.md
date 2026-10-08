# 手機版面（`mobileLayout`）

目標裝置：Android Chrome 現代版（iOS Safari `unknown`，未驗）；Android APK 殼（背景不斷線）見 `docs/android-app.md`，其鍵盤高度由原生回報（`keyboardInset` 的 `hostInset`）。動 `mobile_layout.js`、
`App.applyMobileLayout`、`MobileToolbar`、`#t` 的 `inputmode` 前先讀。

## 狀態

| Phase | 內容 | 狀態 |
|---|---|---|
| 1 | tap 不叫鍵盤＋虛擬按鍵（2026-10 起為底部工具列）＋鍵盤鈕＋viewport 解鎖縮放 | CONFIRMED（Android 真機實測） |
| 2 | 版面不被切（所有畫面縮到塞滿）＋軟鍵盤不蓋底列 | 已實作（真機 `guess`：待實測） |
| 3 | 文章好讀：正常字級＋超寬換行（`mobileReflow`），reflow 下關掉以 col 判斷的滑鼠區域 | 已實作（真機 `guess`：待實測） |
| 4 | 文章列表／看板列表：手機卡片版（固定高 `K*chh` 保住 `list_scroll` 等高假設） | 已實作（真機 `guess`：待實測） |

使用者定案：文章只支援好讀模式、要換行不要縮小；列表做卡片；其他 80 欄格線畫面（主選單等）只求不被切。

## 規則

- **手機模式是 runtime 覆寫，絕不寫回 prefs**：prefs 經 `pref_sync` 同步到其他裝置。
  手機被切掉右半邊的成因就是桌機的 `termSizeMode=fixed-font-size`（20px×80 ≈ 800px）同步過來。
  Phase 2 起任何「手機上強制某設定」都走讀取端覆寫，不 `writeValues`。
- 判準 `mobile_layout.isMobileEnv`：pref `mobileLayout`（auto/on/off，預設 auto）；auto ＝
  `(pointer: coarse)` AND `(hover: none)` AND 短邊 < 800px。推導唯一寫入點
  `App.applyMobileLayout`（入口：建構子、matchMedia change、`onWindowResize`、pref）。
  body 掛 `mobile-layout` class；訂閱 `App.onMobileChange(fn)`。
- **tap 不叫鍵盤＝`#t` 的 `inputmode="none"`**，不是改 `setInputAreaFocus` 的呼叫點：
  焦點照舊停在 `#t`（十幾個呼叫點、實體鍵盤全不動），只是 focus 不彈軟鍵盤。
  軟鍵盤只由按鍵面板的鍵盤鈕 `App.toggleSoftKeyboard()` 叫出：切 `inputmode=text` 後
  `blur()`→`focus()`（inputmode 對已有焦點的欄位不即時生效），**必須在 click handler
  內同步呼叫**（user activation）。被別的方式收起（Android 返回鍵）由 `App._onVisualViewport`
  偵測：看過 inset>0 之後回到 0 ⇒ `softKeyboard` 歸零、通知工具列（`onMobileChange(fn(mobile, kb, sel, ctrl))`）。
  「看過出現」是必要條件：剛按鍵盤鈕那幾幀鍵盤還沒升起。
- 底部工具列（`src/components/MobileToolbar`，掛在 ContextMenu 內，`modalOpen` 時隱藏；2026-10 取代浮動按鍵列）：
  - 固定貼底（`bottom: var(--kb-inset)`），高 `MOBILE_TOOLBAR_PX`（48，與 CSS `.mobileToolbarBar` 一致，unit 守）。
    **常駐 ⇒ 從列數扣**：`App._applyMobileGeometry` 用 `innerBounds.height - MOBILE_TOOLBAR_PX` 算 rows；
    位置由 `_onVisualViewport` 把工具列併進 `view.setKeyboardInset`（＝軟鍵盤 inset ＋ 工具列 ＋ 展開中的按鍵面板）。
    `--kb-inset` 只算軟鍵盤。`innerBounds` 本身不扣（測試以 `Object.create(App.prototype)` 直接塞它）。
  - 按鈕依畫面（`mobile_toolbar.toolbarContextFromFacts`，App 在 `screenSettled` 重算、`onScreenContextChange(fn)` 有變才通知）：
    推＝文章（pageState 3 且這一幀是 pager 狀態列、非信件）；搜尋＝`article_search.availableSearchKinds` 非空時出現，點了**直接開搜尋彈窗**（預設第一個可用種類，無子選單；見 `docs/article-search.md`）；
    按鍵、更多常駐。更多＝選取模式／設定／登出（inline 二段確認，`LOGOUT_CONFIRM_MS` 無動作自動收回）。
    彈出選單畫在 root 底下（**不用 Mantine Menu**：portal 出去的 click 會到 window 的 App 滑鼠入口）。
  - 送鍵只走 `view.sendKeyAsUser(keyName, mods?)`。不可 `view._send`（列表好讀＝在序列化交易
    中途插隊）、不可 `App.onFunctionKey`（文章好讀會先進 functionMode ⇒ PgDn 不捲動）。
    推文 `X` 是單字元：`sendKeyAsUser` 在 keydown 沒人接手時補走 `_keyboard.onKeyPress`。
  - `mousedown` preventDefault（不搶 `#t` 焦點）＋ mousedown/mouseup/click stopPropagation
    （App 的滑鼠入口在 window）。守護 `tests/unit/mobile_toolbar.test.jsx`。
  - 按鍵面板（`#mobileKeypad`，6 欄 grid 貼在工具列上方）：`MOBILE_KEYPAD_ROWS` ＋ ⌨（`toggleSoftKeyboard`）＋ Ctrl ＋
    `MOBILE_KEYPAD_EXTRA_ROW`（Esc／Tab／Del：Gboard 等軟鍵盤打不出來）。每個 key 必須在 `term_keyboard.KeyMap`。
    展開時以 `App.setMobileKeysPanelInset(offsetHeight)` 回報 ⇒ 終端機排到面板上方（暫態，不改列數、不重送 NAWS）。
  - **黏滯 Ctrl**：`App.mobileCtrlArmed`（唯一寫入點 `setMobileCtrlArmed`，經 `onMobileChange` 第 4 參數亮燈）。
    term_view `onKeyDown`（單按修飾鍵不算）與 `onTextInput`（軟鍵盤字走 input 事件）吃下一個字元 →
    `mobile_layout.mobileCtrlKey`：字母走 **Alt remap**（`altKey`；byte 同 Ctrl，但繞過 Ctrl+A/C/V 的全選／複製／貼上），
    `@[\]^_?` 走 `ctrlKey`，其他字元解除不轉。用一次就解除。守護 `mobile_ctrl.test.js`。
- `index.html` viewport **不鎖** `user-scalable`（原生雙指縮放是後援）。
- **尺寸（Phase 2）**：`App.applyTermSize` 是唯一套用點；手機分支無視 `termSizeMode`，用
  `mobile_layout.mobileTermGeometry`：rows ＝ 高度 / `MOBILE_ROW_FONT_PX`(16)（`calcTermSize`，欄數恆 80），
  chh ＝ min(80 欄塞滿寬, rows 列塞滿高) 再對齊裝置像素。**不用 transform scale**：縮小時 layout box
  比視窗寬，`align=center` 置中失效，`mouse_geometry` 縮放分支的前提不成立。
  `onValuesPrefChange` 把尺寸 prefs 存進 `_termSizeValues`，手機模式切換時用同一組值重套（桌機規則還原）；
  值裡沒有 `termSizeMode` 不動尺寸。
- **手機欄數同樣恆 80，不送窄欄 NAWS**：pttbbs 雖已允許 20 欄（`dc30d74`），但畫面層沒跟著重排，
  理由見 `docs/terminal-size.md` §3。
- **軟鍵盤蓋住底列（PTT 的輸入列）**：**不可**加 `interactive-widget=resizes-content`（鍵盤開關變成
  layout resize ⇒ 重算字級、改列數、重送 NAWS）。維持 Android 預設 `resizes-visual`（layout 高度不變 ⇒
  列數穩定），`App._onVisualViewport` 以 `mobile_layout.keyboardInset` 算被蓋住的高度 →
  `view.setKeyboardInset` → `term_size.termLayoutOffsets({bottomInset})`：在可視區內置中，放不下就底對齊
  （頂端列被推出畫面）。同一個值寫進 CSS 變數 `--kb-inset` 推高底部工具列（fixed 錨在 layout viewport）；終端機的 inset 另加工具列與按鍵面板（見上）。
  只在 `softKeyboard` 時算；`visualViewport.scale ≠ 1`（雙指縮放）不算。
- **開站原點**：`#BBSWindow` 顯示前量到的 `firstGridOffset` 是 0；`main.jsx` 顯示後呼叫
  `onWindowResize({ immediate: true })` 跳過 resizer 的 500ms debounce（手機與桌機 fixed-font-size 都有 resizer）。

## 浮動工具「⋯」（`render/merge_buttons.js#createFloatingTools`，桌機＋手機共用）

圖文並排／AI 校正／開燈（文章頁）與 debug 錄製鈕（debug 模式下任何畫面）收在一顆圓鈕裡（攤開的一疊在 reflow 版面會蓋住文章字；
獨立的錄製鈕曾疊在底部工具列上）。**不要再加獨立的 fixed 浮動鈕**，一律進這個面板。
- 展開：桌機純 CSS `@media (hover: hover) .floatTools:hover`；觸控 tap 圓鈕 toggle `data-open`，點了面板裡的工具自動收合。
  一個工具都不用顯示 ⇒ 整個「⋯」不出現（`screen.js#_syncOverlays`）。
- debug 錄製：`App.setDebugMode`（唯一寫入點，PrefModal Switch 經 ContextMenu 呼叫）→ `view.debugRecordButton` → `enhance.debugRecordButton`；
  錄製狀態真相在 `app.debugRecorder`（`js/debug_record_control.js`），每幀以 `enhance.debugRecording` 對帳，點擊走 `enhance.onDebugRecord`（引用穩定）。
  錄製中「⋯」掛 `data-recording`（紅）。「已下載」隱私提示是 React（`components/DebugRecordNotice`，`App.onDebugRecordDownloaded` 訂閱）。
  守護 `debug_record_render.test.js`、`app_debug_mode.test.js`、offline `debug_record`／`mobile_float_tools`。
- 面板 absolute 貼在圓鈕外側（`data-vdir`／`data-hdir` 依圓鈕在視窗哪一半），**圓鈕永遠不動**；與圓鈕的間距用 padding。
  兩者都是為了 hover 不掉。按下工具時面板 `min-width` 釘住（label 點完變短 ⇒ 按鈕縮走 ⇒ 游標落出面板），
  `pointerleave` 才解除，**不可**在 `setOpen(false)` 解除。守護 `float_tools.test.js`。
- 位置 `{right,bottom}` 存 localStorage `pttchrome.floatToolsPos`（`mobile_layout.load/saveFloatPos`，不寫 prefs），可拖曳，
  預設 `FLOAT_TOOLS_DEFAULT_POS`＝在底部工具列上方。手機 z-index 2400 < 工具列 2500。
- `data-own-control` ⇒ `pttchrome.jsx#isOwnControlTarget` 把整塊（含面板間隙）當成自己的控制項，不落到邊緣翻頁。
- pref `showMergeCaptionButton`／`showLightsOnButton`（預設 true，增強分頁）→ `enhance.mergeCaptionButton`／`lightsButton`。
  關掉時 `screen.js#update` 還原效果（合併狀態、軌 A）；軌 B（已切純文字）要送鍵，按鈕保留到使用者切回。

## 設定頁窄版（`PrefModal.jsx` `PREF_NARROW_QUERY` = max-width 640px）

看視窗寬、不看 App 的 mobile 旗標（桌機拉窄同樣適用）。`fullScreen`＋Tabs `horizontal`＋content class `PrefModal--narrow`
（CSS：左欄變頂端一條、分頁列橫向捲動、右欄滿寬）；標題移到 Modal header；「重設」移到右欄最底。
守護 `pref_modal_narrow.test.jsx`（真版面，CSS 以 `?raw` 注入）、offline-mobile `mobile_float_tools.offline.spec.js`。

## 測試

- unit：`mobile_layout.test.js`、`float_tools.test.js`、`pref_modal_narrow.test.jsx`、`mobile_toolbar.test.jsx`、`mobile_toolbar.test.js`、`mobile_ctrl.test.js`、`logout_session.test.js`、`comment_card.test.js`、`app_mobile_layout.test.js`、`mobile_surface.test.js`、
  `list_card.test.js`（含兩個 session 的卡片換算；看板列表沒有錄製素材，這是它唯一的守護）；
  reflow 相關另在 `mouse_regions`／`mouse_gating`／`scroll_restore`／`context_menu_items` 各有一組
- offline e2e：project `offline-mobile`（Pixel 7 模擬，只跑 `offline/mobile_*.spec.js`：換行版面、長按選單與推文卡片在
  `mobile_reflow`、列表卡片在 `mobile_list_cards`、工具列／按鍵面板／黏滯 Ctrl 在 `mobile_toolbar`、「⋯」與設定頁窄版在 `mobile_float_tools`；`offline` project 以 testIgnore 排除 mobile_*），已併入
  `yarn test:e2e:offline`。**視窗高壓到 390px**：錄製檔全是 24 列，Pixel 7 原生高度會給 52 列、
  重放湊不成完整一屏；390 ⇒ 24 列。
- Windows 本機跑 `offline-mobile` 會用到 local 細明體，小字級下半形字寬被 hinting 取整（實測 5.0 vs
  chw 4.952）；Android／CI Linux 沒有細明體，走內建 webfont `SymMingLiu`（精確 0.5em）。量座標的斷言
  以欄數 × 誤差估容差，別因本機多幾 px 就改產品。
- 真機：`yarn start --host`，手機開 `http://<電腦區網 IP>:8080`（dev 預設站台跟著頁面 host，見 `docs/run-local.md`）。

## 已修的手機專屬 bug

- **列表 PgUp／PgDn 卡住**：非整數 DPR 下列高是小數（Pixel 7：26/2.625），`scrollTop` 被瀏覽器
  量化後讀回來略小於 `pos*rowH` ⇒ `list_scroll.topPosFromScrollTop` 的 floor 少算一列。容差改為像素單位
  `SCROLL_QUANT_EPS`。手機的列表現在是卡片（高＝2×15.619px，同樣是小數），守護在
  `mobile_list_cards.offline.spec.js` 的 PgUp／PgDn 那條（`easy-reading-list` 是 80 欄格線的斷言，只在桌機跑）。
- 已知未修：瀏覽器實際排版的列距是 LayoutUnit（Chrome 1/64px）量化後的值（實測 `chh` 9.90476 → 列距
  9.90625），列表捲動數學用的仍是 `chh` ⇒ 每列累積 ~0.0015px 誤差（300 列 < 0.5px，在容差內）。

## 畫面類型（surface，Phase 3–4 共用）

- `term_view.mobileSurface` ∈ `grid`／`article`／`list`，推導＝**這一幀畫的是什麼**（`_frameSurface`）：
  好讀長頁（`!_gridRender`）＝ article、列表好讀視窗（`_renderScreenLines` 帶 `listScroll`）＝ list，
  其餘（functionMode 原生鏡像、空頁防黑、原生列表、主選單…）＝ grid。不看好讀旗標。
- 對帳點 `term_view._syncMobileSurface`（`_renderScreenLines` 開頭，**render 之前**：forceWidth 與列表視口
  高度取當下 chh，同一幀就畫對）→ `App._applyMobileGeometry(surface)`（唯一套幾何點；resizer 不帶參數
  ＝沿用上一幀的）→ `view.setMobileSurface`（旗標 `reflow`／`listCards` ＋ `.main` 的 class）＋ `fixedResize`。
- 幾何 `mobileTermGeometry({ surface })`：article／list 的 chh ＝ min(`MOBILE_ROW_FONT_PX`, 塞滿高) 對齊裝置
  像素、`mainWidth` ＝視窗寬（`view.reflowWidth` → `setTermFontSize`）。**rows 與 surface 無關 ⇒ 不重送
  NAWS**。`.main` 高仍是 `chh*rows+10`（`_scrollBy` 下界 LOCKED）。
- 列表視口高度：呼叫端只給 `listScroll.viewportRows`，px 由 `_renderScreenLines` 在對帳**之後**換算。

## Phase 3：好讀文章換行版面（`term_view.reflow`）

- CSS `.main.mobileReflow #mainContainer span[type="bbsrow"]`：`pre-wrap` ＋ `overflow-wrap: anywhere`
  （ID 選擇器壓過 `#mainContainer > span` 與合併塊的 `pre`）；`.easyReadingImg` 上限改 100%。不宣告 `user-select`。
- 閱讀位置：`view.currentLineIndex()`（AID 回跳／deep link 記錄）與 `view.pageRowTop(row)`
  （`nextScrollRestoreStep` 的 `targetTop`）在 reflow 下量 `srow` 節點，格線版面維持 `scrollTop/chh`。
- 滑鼠：`resolveMouseRegion({ reflow })` 對 pageState 3 早退 NONE（左側退出帶、邊緣翻頁全關），
  `resolveMouseGates({ reflow })` 關 `misclickGuard`／`edgePaging`（推文者高亮退回整列可點）。
  元素層（連結、圖片、`a.fnKey`、合併按鈕）不受影響。右鍵選單的推文者黑名單在 reflow 下整列都算 id 區。
- 已知接受：ANSI 圖／表格換行後會散（使用者定案）；`#easyReadingLastRow`（footer overlay）只改寬度不換行，超出視窗寬的部分被裁。

## 長按選單與選取模式（觸控 contextmenu）

Chromium 長按**先選字、後發 contextmenu** ⇒ 事件到時選取必不為空。`context_menu_items.menuTargetFlags`
的 `touchLongPress`（`isTouchContextMenu`：`pointerType === 'touch'`，退回 `sourceCapabilities.firesTouchEvents`）
讓 `normalEnabled` 不看選取（黑名單／前已讀後未讀／貼上照出）。

使用者定案：長按的兩種用途用工具列「更多 → 選取模式」開關切，**預設關**。狀態 `App.mobileSelectMode`（runtime、不存，
唯一寫入點 `setMobileSelectMode`，body class `mobileSelectMode`，非手機恆關）。
- 關：開我們的選單，並 `removeAllRanges()`（`shouldClearTouchSelection`）⇒ 不留原生選取把手，複製類項目不出現。
  對象（黑名單／前已讀後未讀）仍是長按位置，與桌機右鍵同一條路徑。CSS 另加 `-webkit-touch-callout: none`。
  **不用 `user-select: none` 擋選字**（終端機祖先禁用，`css_user_select.test.js`）。
- 開：`contextMenuDisposition({mobile, selectMode})` 回 `'native'`（排在 swallow 之後）⇒ 不 preventDefault，
  Chrome 原生選取把手＋複製工具列。關掉時順手清選取。
  **只看模式、不看事件來源**：Android Chrome 拖完選取把手放手會再補發一次 contextmenu
  （`RenderWidgetHostViewAndroid::ShowContextMenuAtTouchHandle` → Blink `EventHandler::ShowNonLocatedContextMenu`），
  事件是 `pointerType:'mouse'`、`pointerId:1`、`firesTouchEvents:false`，沒有觸控標記。舊規則「觸控＋選取模式」
  讓那次開出我們的選單、原生複製工具列被吃掉。代價：手機版面接滑鼠、選取模式開時右鍵也走原生（使用者自己開的模式，接受）。
  選取模式關的路徑不受影響：長按後已清選取 ⇒ 沒有把手 ⇒ 不會有那次補發。
- 守護：unit `context_menu_disposition.test.js`；offline e2e `mobile_reflow`「長按選單」describe：
  - 補發那次用**真的 ContextMenu 鍵**（CDP `Input.dispatchKeyEvent`，vk 93）當替身：桌機的 ContextMenu 鍵走同一個
    `ShowNonLocatedContextMenu`，事件形狀相同（實測 `mouse|1|false`）。
  - 滑鼠右鍵＋有選取走 `page.mouse.click(..., { button: 'right' })`。
  - 觸控長按**仍是手捏** `PointerEvent('contextmenu', { pointerType: 'touch' })`：CDP 觸控長按
    （`Input.synthesizeTapGesture` duration 900／`dispatchTouchEvent` 按住 1.2s）在桌機 Chromium
    （headless shell、new headless、headed 皆然，Pixel 7 模擬）只產生 pointerdown/up、**不發 contextmenu**
    （CONFIRMED，Windows 本機）⇒ 拿它斷言「選單 0 個」是假陽性。
  - 真長按序列＋拖把手＋原生 Copy 工具列：Android 模擬器 e2e `tests/e2e/android/select_mode.android.spec.js`
    （`yarn test:e2e:android`，`docs/android-e2e.md`）。補發事件形狀在真 Android Chrome 上 CONFIRMED，替身前提成立。

## 一鍵登出（`logout_session.js`）

**不可以 `conn.close()`**：server 端 utmp 不會當下清掉，帳號卡在線上。走 PTT 正常流程，server 自己關線。
- pttbbs：`menu.c:1354` Goodbye（level 0、主選單唯一 G）；`menu.c:566-581` 主選單上 ← 只移游標到 G；
  `xyz.c:59-85` `getdata` 確認「您確定要離開…(Y/N)？[N]」（LCECHO，要 `y\r`）→ `vmsg` 停留時間（未註冊：
  「尚未完成註冊程序。」）→ 任意鍵 → `u_exit`（`mbbsd.c:187-209`）close fd。
- 序列（CommandQueue，一次一鍵、內容確認）：逃回主選單（每步 `resolveDismiss`：輸入欄 ^C／pressanykey 空白，
  否則 ←；畫面沒變或超過 `MAX_ESCAPE_STEPS` 停手）→ `G\r`（expect 確認列＋游標在輸入欄）→ `y\r`（expect
  pressanykey）→ 空白（`probe:false`；再遇 pressanykey 最多補 `MAX_FINAL_KEYS` 次）。認不出的畫面一律停手、不盲送。
- 前置同 `aid_navigation._begin`（autoLogin.stop、好讀 functionMode、兩個列表 session beginExternalNavigation）；
  `serialized_op_gate` 期間吞使用者鍵。完成判定：`App.onClose` → `logout.onConnectionClosed()` 為真 ⇒
  `ConnectionAlert loggedOut`（藍色「已登出」＋重新連線，不跑連線失敗診斷）。
- 守護：unit `logout_session.test.js`（byte 序列＋停手條件）。live e2e 不跑（會斷掉共用登入 session）。

## 推文卡片（`render/comment_card.js`）

換行版面下推文列原樣 pre-wrap ⇒ 時間前的補位空白先折行，時間跑到下一行左邊。
- 旗標 `enhance.commentCards` ＝ `term_view.reflow && stableRows`（寫在 `_renderScreenLines` 的 base 物件，
  不可寫進凍結的 `STABLE_ROWS`），進 `annotationsKey`。桌機 golden 不經過。
- 切換點兩處：`screen.js#_renderRow`（單列）與 `_buildRowNode` 的 `mergeCommentRun`（合併塊不經 `_renderRow`）。
  區段來自 `comment_merge.commentContentCells`／`buildMergedCommentChars` 的 `tailStart`／`timeStart`；
  認不出推文形狀 ⇒ 退回 buildRow。
- 版型：標頭 `推/噓/→`・`.floorBadge[data-floor]`（卡片內改一般行內字）・id（原PO `.commentByAuthor`），
  右靠 `.commentCardMeta`（IP＋時間，0.8em 淡化）；內容 `.commentCardText` 以原欄號餵 LinkSegmentBuilder
  （連結／AID／預覽照舊）。
- 契約：外層 `span[type=bbsrow][srow][data-pusher][data-pusher-col]`（`.commentSpacing` 直接子選擇器、長按黑名單），
  標頭與內容每行都是 `[data-type=bbsline][data-row]`。
- 守護：unit `comment_card.test.js`；offline e2e `mobile_reflow`「手機推文卡片」。

## Phase 4：列表卡片（`term_view.listCards`）

- 只換 body 列：`render/screen.js#_renderRow` 在 `enhance.listCards`（＝ `'article'`／`'board'`，由
  `listScroll.kind` 帶）且列在 `[bodyStart, lines.length-1)` 時改走 `render/list_card.js#buildListCard`；
  header／footer 照舊是 80 欄列（超出視窗寬的部分被 `.main` 的 `overflow-x: hidden` 裁掉）。
  `listCards` 進 `annotationsKey`（同一批列物件切換卡片模式要整批重建）。
- 版型（欄位按 **cell** 切，出處見 `list_card.js` 檔頭）：文章列表＝標題 [29,80)／序號・標記・推文數・日期
  [0,17)＋作者 [17,29)；看板列表＝序號・未讀・板名・類別 [0,28)＋人氣 [64,67)／◎敘述 [28,64)＋板主 [67,80)。
- **卡片固定高 2.5em（`LIST_CARD_ROWS`=2.5 × chh）是承重條件**：`list_scroll.js` 的位置↔scrollTop 是純乘除。
  兩行內容（`LIST_CARD_LINES`=2）＋ 0.5em 卡片間距＝border-box 固定高內的 `padding-block`；分隔線用 inset
  box-shadow；不可 border／margin（加在固定高之外）。CSS 高度與常數一致由 `list_card_css.test.js` 守。
  次行（`.listCardMeta`）縮字 0.8em＋淡化，行框仍 1 chh（height/line-height 寫 1.25em）。兩個 session 的 `_rowHeight()` ＝
  `chh × listRowSpan(listCards)`；`_pageRows()`（PgUp/PgDn 一次翻幾筆）＝ `listPageRows(bodyRows)`；
  `_bodyRows()` 仍是 server 的 p_lines（抓頁單位），**不可**跟著換。
- **採用原生落點（進板 `_seedAnchors`／回 buffer `_resumeBuffer`／看板列表 `_adoptLanding`）**：錨＝原生頁頂端
  只在桌機成立（一屏＝一頁）；卡片一屏只放 `_pageRows()` 筆 ⇒ 落點後第一次 `applyScrollAfterRender` 用
  `list_scroll.landingTopPos` 把原生頁底貼齊視口底、但游標不得出頂端（`_landingFit`／`_landingLastNum`，一次性；
  待還原閱讀進度 `_pendingViewport` 優先）。在 apply 才算是因為 seed 當下 `listCards` 可能還沒對帳。守護 `list_session.test.js`／`board_list_session.test.js`「手機卡片：採用原生落點」。
- 契約保留：`span[type=bbsrow][srow]`、`data-list-author/-title`、`.listCardBody[data-type=bbsline][data-row]`
  （游標底色的 class 下在這裡 ⇒ 整張卡片上色）。
- 點擊：`App.clientToPos` 的 body 列號除數換成卡片高（`listRowSpan`）；`App.mouse_click` 在 listCards 下
  不做退出帶／邊緣翻頁，點卡片本體＝ `onMouseClick(row, LIST_TITLE_COL_START)`（走 session 的列點擊開文
  合約）；點到間距（`mobile_layout.isListCardGapTarget`：在 `.listBodyView` 內、`.listCardBody` 外）吞掉不開文（防誤點）。`term_view.listEdgeRegion`／`onListMouseMove` 同樣關掉以 col 判斷的部分。退出用按鍵面板的 ←。
- 長按選單的黑名單區域在 listCards 下看 DOM（`.listCardAuthor`／`.listCardTitle`），不看 col；「前已讀後
  未讀」用 `clientToPos` 的列號（已是卡片座標）。
- 字級可調時再開 pref `mobileFontSize`（與桌機 `fontSize` 分開），且 rows 要跟著它算。
