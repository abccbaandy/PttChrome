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
| 5 | 選單（主功能表＋所有 domenu 子選單）：選單項大按鈕（ANSI 圖仍縮小格線） | 已實作（真機 `guess`：待實測） |
| 6 | 頂部 App Bar（標題＝看板／文章／選單名）＋上緣幾何 | 已實作（真機 `guess`） |
| 7 | 底部導覽依畫面換動作（icon＋label）＋系統分享 | 已實作（真機 `guess`） |
| 8 | 收起終端機標頭／狀態列（列表卡片、好讀文章、選單大按鈕） | 已實作（真機 `guess`） |
| 9 | Bottom sheet（更多／長按選單／搜尋）＋系統返回收 sheet | 已實作（真機 `guess`） |
| 10 | safe-area／theme-color／等待進度條／點擊波紋（波紋桌機共用） | 已實作（真機 `guess`） |

使用者定案：文章只支援好讀模式、要換行不要縮小；列表做卡片；選單項做大按鈕（主功能表與子選單一致；ANSI 圖保留縮小在上方、點一下直接進入）；其他 80 欄格線畫面只求不被切。
2026-10 原生 App 化定案：App Bar **不放返回鍵**（返回＝系統邊緣滑動／返回鍵，`history_back_guard`）；標頭／狀態列只在卡片／文章／選單畫面收起；文章左右滑換篇**不做**（與捲動、選取、系統返回手勢互搶）。

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
- 底部導覽（`src/components/MobileToolbar`，掛在 ContextMenu 內，`modalOpen` 時隱藏；Material bottom navigation，icon＝`@tabler/icons-react`）：
  - 固定貼底（`bottom: var(--kb-inset)`、`padding-bottom: var(--safe-bottom)`），bar 高 `MOBILE_TOOLBAR_PX`（48，與 CSS `.mobileToolbarBar` 一致，unit 守）。
    **常駐 ⇒ 從列數扣**：`App._applyMobileGeometry` 用 `mobile_layout.mobileRowsHeight(h, safe)`（扣 App Bar＋工具列＋safe-area）算 rows；
    位置由 `_onVisualViewport` 經 `mobileChromeInsets` 寫 `view.setTopInset`／`setKeyboardInset`（下＝軟鍵盤＋工具列＋展開中的按鍵面板＋safeBottom，鍵盤升起時 safeBottom＝0）。
    `--kb-inset` 只算軟鍵盤。`innerBounds` 本身不扣（測試以 `Object.create(App.prototype)` 直接塞它）。
  - 動作依畫面（`mobile_toolbar.toolbarContextFromFacts`，App 在 `screenSettled` 重算、`onScreenContextChange(fn)` 有變才通知；鍵出處 `mbbsd/more.c pager_common_cmds`、`bbs.c` Ctrl('P')）：

    | 畫面 | 動作 |
    |---|---|
    | 文章 pager（非信件） | 推文 X／回文 y／分享／按鍵／更多（更多內：`[` `]` `=` 同主題、`b` `f` 前後篇，`THREAD_NAV_KEYS`） |
    | 信件 pager | 回信 y／按鍵／更多 |
    | 文章列表（非輸入欄） | 搜尋／發文 Ctrl+P（`{key:'p',altKey}` Alt remap，避開瀏覽器列印）／按鍵／更多 |
    | 其他 | 搜尋（`availableSearchKinds` 非空）／按鍵／更多 |

    搜尋**直接開搜尋彈窗**（預設第一個可用種類，無子選單；見 `docs/article-search.md`）。分享＝`deep_link_controller.shareCurrentPostLink(title)`（與複製本篇連結同一條 AID 解析；`navigator.share`，AbortError＝完成，其他拒絕／無 API 退回複製；**click 內同步呼叫**）。
    更多＝bottom sheet（見「Bottom sheet」）：文章導覽／選取模式／設定／登出（inline 二段確認，`LOGOUT_CONFIRM_MS` 無動作自動收回）。
    觸覺回饋 `navigator.vibrate(HAPTIC_MS)`（APK 無 VIBRATE 權限＝no-op）。
  - 送鍵只走 `view.sendKeyAsUser(keyName, mods?)`，並先 `App.noteUserAction()`（等待進度條）。不可 `view._send`（列表好讀＝在序列化交易
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
  錄製狀態真相在 `app.debugRecorder`（`js/debug_record_control.js`），每次 render 經 `enhance.isDebugRecording()` 現問（**不可改回布林快照**：游標底色慢路徑是不換 props 的重畫，快照會把錄製中蓋回灰），點擊走 `enhance.onDebugRecord`（引用穩定）。
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
  reflow 相關另在 `mouse_regions`／`mouse_gating`／`scroll_restore`／`context_menu_items` 各有一組；
  Phase 6–10：`mobile_app_bar.test.js(x)`、`article_meta_card.test.js`、`page_row_top_collapsed.test.js`、`context_sheet.test.jsx`、
  `mobile_busy.test.js`、`ripple.test.js`、`index_html_meta.test.js`、`history_back_guard`（sheet）、`modal_shown_sources`（sheet 登記）、`deep_link_controller`（分享）
- offline e2e：project `offline-mobile`（Pixel 7 模擬，只跑 `offline/mobile_*.spec.js`：換行版面、長按選單、推文卡片與檔頭卡片在
  `mobile_reflow`、列表卡片在 `mobile_list_cards`、底部導覽／按鍵面板／黏滯 Ctrl／進度條在 `mobile_toolbar`、「⋯」與設定頁窄版在 `mobile_float_tools`、
  App Bar 在 `mobile_app_bar`、sheet（遮罩不漏點、返回收 sheet、拖把手、搜尋 sheet）在 `mobile_sheet`；`offline` project 以 testIgnore 排除 mobile_*）。
  手機的長按／右鍵選單是 `[data-sheet="context"]`（項目 `[data-cmenu=<key>]`），**不是** `.DropdownMenu`；Drawer 內容非同步掛上、
  有 slide-up 動畫 ⇒ 先 `toBeVisible` 再 `waitRectStable` 才量座標。已併入
  `yarn test:e2e:offline`。**視窗高壓到 390px**：錄製檔全是 24 列，Pixel 7 原生高度會給 52 列、
  重放湊不成完整一屏；390 ⇒ 24 列。
- 真 Android Chrome（模擬器）：`tests/e2e/android/mobile_input.android.spec.js`（真 tap 不彈鍵盤、⌨ 後的版面、
  返回鍵收鍵盤／送 ←）與 `select_mode`，跑法見 `docs/android-e2e.md`。
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

- `term_view.mobileSurface` ∈ `grid`／`article`／`list`／`menu`，推導＝**這一幀畫的是什麼**（`_frameSurface`）：
  好讀長頁（`!_gridRender`）＝ article、列表好讀視窗（`_renderScreenLines` 帶 `listScroll`）＝ list，
  選單（`buf.isMenuScreen()`，主功能表與子選單）＝ menu，其餘（functionMode 原生鏡像、空頁防黑、原生列表…）＝ grid。不看好讀旗標。
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
  header（`[0,bodyStart)`）與 footer（末列）收起（Phase 8，`render/collapsed_row.js`）。
  `listCards` 進 `annotationsKey`（同一批列物件切換卡片模式要整批重建）。
- 版型（欄位按 **cell** 切，出處見 `list_card.js` 檔頭）：文章列表＝標題 [29,80)／序號・標記・推文數・日期
  [0,17)＋作者 [17,29)；看板列表＝序號・未讀・板名・類別 [0,28)＋人氣 [64,67)／◎敘述 [28,64)＋板主 [67,80)。
- **卡片固定高 2.5em（`LIST_CARD_ROWS`=2.5 × chh）是承重條件**：`list_scroll.js` 的位置↔scrollTop 是純乘除。
  兩行內容（`LIST_CARD_LINES`=2）＋ 0.5em 卡片間距＝border-box 固定高內的 `padding-block`；分隔線用 inset
  box-shadow；不可 border／margin（加在固定高之外）。CSS 高度與常數一致由 `list_card_css.test.js` 守。
  次行（`.listCardMeta`）縮字 0.8em＋淡化，行框仍 1 chh（height/line-height 寫 1.25em）。兩個 session 的 `_rowHeight()` ＝
  `chh × listRowSpan(listCards)`；`_pageRows()`（PgUp/PgDn 一次翻幾筆）＝ `listPageRows(視口列數)`；
  `_bodyRows()` 仍是 server 的 p_lines（抓頁單位），**不可**跟著換。
- **視口幾何單一真相源 `mobile_layout.listViewportGeometry({rows, headerRows, cards})`**：桌機＝header 下 `rows-4` 列；
  卡片＝`bodyTopRows:0`、`viewportRows: rows`（header／footer 收起）。消費端三處必須同源：`term_view._renderScreenLines`
  的 `listScroll.viewportPx`（對帳**之後**算）、`App.clientToPos`、兩個 session 的 `_pageRows()`。
- **採用原生落點（進板 `_seedAnchors`／回 buffer `_resumeBuffer`／看板列表 `_adoptLanding`）**：錨＝原生頁頂端
  只在桌機成立（一屏＝一頁）；卡片一屏只放 `_pageRows()` 筆 ⇒ 落點後第一次 `applyScrollAfterRender` 用
  `list_scroll.landingTopPos` 把原生頁底貼齊視口底、但游標不得出頂端（`_landingFit`／`_landingLastNum`，一次性；
  待還原閱讀進度 `_pendingViewport` 優先）。在 apply 才算是因為 seed 當下 `listCards` 可能還沒對帳。守護 `list_session.test.js`／`board_list_session.test.js`「手機卡片：採用原生落點」。
- 契約保留：`span[type=bbsrow][srow]`、`data-list-author/-title`、`.listCardBody[data-type=bbsline][data-row]`
  （游標底色的 class 下在這裡 ⇒ 整張卡片上色）。
- 點擊：`App.clientToPos` 的 body 列號除數換成卡片高（`listRowSpan`）；`App.mouse_click` 在 listCards 下
  不做退出帶／邊緣翻頁，點卡片本體＝ `onMouseClick(row, LIST_TITLE_COL_START)`（走 session 的列點擊開文
  合約）；**只有點在卡片本體才開**（`mobile_layout.isListCardBodyTarget`）：間距防誤點、視口外的 `.main` 留白
  （footer 收起後）不落回列號換算；`clientToPos` 的 footer 分支在 listCards 下關閉。`term_view.listEdgeRegion`／`onListMouseMove` 同樣關掉以 col 判斷的部分。退出用按鍵面板的 ←。
- 長按選單的黑名單區域在 listCards 下看 DOM（`.listCardAuthor`／`.listCardTitle`），不看 col；「前已讀後
  未讀」用 `clientToPos` 的列號（已是卡片座標）。
- 字級可調時再開 pref `mobileFontSize`（與桌機 `fontSize` 分開），且 rows 要跟著它算。

## Phase 5：選單大按鈕（`term_view.menuCards`）

- 判定：`menu_items.isMenuScreen`＝pageState 1、標題不是 `看板列表`／`分類看板`，且（標題 `MAIN_MENU` 或末列
  `string_util.parseListRow`＝`menu.c#show_status_bar` 的指紋，新舊格式都吃，與 setPageState 判子選單同一支）
  ⇒ 主功能表與所有 domenu 子選單（個人設定、私人信件、聊天、系統資訊、娛樂、名單…含巢狀）一致。
  分類看板根目錄也用 show_status，靠標題排除。選單項＝`parseMenuItemRow`（列文字形狀，快捷鍵可為數字如 `(2)FA`，
  依據 `mbbsd/menu.c#menu_renderer`／`stuff.c#cursor_show`，見檔頭）。
  同一組判定也讓桌機的 ANSI 圖區不可點、不上底色（`mouse_regions` case 1 的 `menuScreen && !menuItemRow`）。
- 幾何同 grid（chh 塞滿寬、rows 不變、不重送 NAWS）。`setTermFontSize` 在 menuCards 下改用
  `mobile_layout.mobileMenuLayout`：`.main` 撐到可視高（扣 inset）貼頂；不夠高退回格線規則，超出由 `.main` 捲動。
- 渲染：`render/screen.js#_renderRow` 在 `enhance.menuCards`（進 `annotationsKey`）時，選單項 →
  `render/menu_card.js#buildMenuCard`（高 `MENU_CARD_PX`=44、字級 16px，寫死 px 不跟 chh；CSS 一致由
  `menu_card.test.js` 守）；整列空白 → `buildMenuBlankRow`；第 0 列（標題）與末列（`show_status_bar`）→
  `buildCollapsedRow`（Phase 8；末列是 prompt 時 `isMenuScreen` 不成立，收不到它）。
  兩者都只看該列自己 ⇒ dirty-row patch 的列獨立前提不破。按鈕文字**不走 LinkSegmentBuilder**（`.wpadding`
  被 `fixedResize` 改成 chh 寬會疊字）。`#cursor` 在 `.main.mobileMenu` 下隱藏（row×chh 座標對不上）。
- 點擊：`App.mouse_click` 在 `view.menuCards` 下以 DOM 目標取列（`mobile_layout.menuCardTargetRow`，
  `data-menu-row`），走 `App._sendRowEnter`（與 ACT_ENTER 同一份「↑↓ × delta ＋ \r」）；按鈕外什麼都不送。
  `resolveMouseRegion({ menuCards })` 早退 NONE（觸控 tap 的相容 mousemove 不在錯的按鈕上底色）。
- 守護：unit `menu_items`／`menu_card`／`main_menu_mouse`／`mouse_regions`；offline e2e `main_menu`（桌機 hover／點擊）、
  `mobile_main_menu`（按鈕高、真 tap 送鍵）。素材是合成畫面 `tests/e2e/helpers/main_menu.js`。

## Phase 6：App Bar（`components/MobileAppBar`）

- 標題純函式 `mobile_app_bar.appBarFromFacts(facts, {pageState, articleTitle, articleBoard, prev})`，與底部導覽同一次計算
  （`mobileToolbarContext` 的 `appBar` 欄位、`sameToolbarContext` 一併比）。判斷順序：pageState 3 → article（`view._articleTitle`，
  與 `_articleAuthor/_articleBoard` 同一個檔頭事件記；副標＝看板）；文章列表（listOwner 或 `boardListContextKind==='article-list'`；
  row 0 是 `【板主:x】` ⇒ 必須先於 menu）→ `parseBoardName`；看板列表 → row 0【X】；其他 row 0【X】（`screen_titles.parseHeaderTitle`）→ menu；
  都不是 ⇒ 沿用 prev（不閃）。`newMail`＝row 0 含「你有新信件」（`menu.c#redraw_title`）。
- **無返回鍵**（使用者定案）。事件規則同工具列（mousedown preventDefault＋stopPropagation）。z-index 150（低於 Mantine overlay 200）。
- 幾何：高 `MOBILE_APPBAR_PX`(48)＋`--safe-top`，**全畫面常駐** ⇒ rows 與 surface 無關（不重送 NAWS）。上緣經
  `term_size.termLayoutOffsets({topInset})`（0＝桌機舊值）、`mobileMenuLayout({topInset})`、`view.setTopInset`。`.main` 高公式不動。
  `PageTopAlert` 手機下 margin-top 讓開 48px。

## Phase 8：收起終端機標頭／狀態列

- 共用 `render/collapsed_row.js#buildCollapsedRow(row, cls)`（`.mobileCollapsedRow` display:none，bbsrow/srow/data-row 契約保留）。
  `_renderRow` 三個分支都只看列號＋該列文字 ⇒ `annotationsAreRowIndependent` 不動；桌機 golden 不經過。
  - listCards：`row < bodyStart || row === last`（視口幾何見 Phase 4）；menuCards：第 0 列與末列。
  - 好讀文章（`enhance.commentCards`）前 `ARTICLE_META_MAX_ROWS`(5) 列：`render/article_meta_card.js`（pmore `_fh_disp_heads`
    作者/標題/時間/轉信 → 卡片；整列 `─` 分隔線 → 收起；形狀不吻合照舊）。
- 好讀 footer `#easyReadingLastRow`：reflow 下 `display:none`（`_mirrorStatusRowToFooter` 與 `setMobileSurface` 切換時）。
  好讀累積頁底部 1em padding 仍在（無害）。
- `term_view.pageRowTop` 跳過 `offsetParent===null` 的列（收起列 offsetTop＝0 會把閱讀位置還原拉回頂端）。

## Phase 9：Bottom sheet（`components/MobileSheet`，Mantine Drawer position bottom）

- 用在：「更多」（`MobileToolbar` 自己持有，`panel==='more'`）、長按選單（`ContextMenu` 在 `useMobile` 時畫 `ContextSheet`，
  項目清單 `ContextMenu/context_menu_entries.js` 與桌機 `DropdownMenu` 共用）、搜尋（`SearchModal` 的 `mobile` prop 換外殼）。
  長按的 disposition／touchLongPress／清選取都在 render 前，**不動**。
- 開著＝modal：每個實例 `setModalOpen('mobileSheet'+useId, opened)`。遮罩是一般 div、Drawer 在 portal ⇒ 點擊會到 window 的 App 滑鼠入口，
  **靠 modalShown 早退**才不會被當成點終端機。z-index 3000（蓋過工具列 2500）。
- 系統返回＝收起：開著時 `App.registerSheetDismiss(onClose)`；`history_back_guard#onPopState` 在送 ← 之前問
  `App.dismissTopSheet()`，true ⇒ 補 sentinel、不送 ←、不出逃生提示（接住原生返回，非模擬）。
- 拖把手（`[data-sheet-handle]`，`touch-action:none`）往下 > `SHEET_DISMISS_DRAG_PX`(80) 收起。
- Mantine 9 Drawer `size="auto"` 會解析成未定義變數 ⇒ content 被撐全高、內容貼頂；`MobileSheet.css` 明給 `height:auto`。
- sheet 裡的輸入框（搜尋）叫出的鍵盤不經 `softKeyboard`：`mobile_layout.overlayKeyboardInset` → CSS `--vv-kb-inset`
  （`.mobileSheetInner` padding-bottom），不碰終端機幾何。真機 `guess`。
- 新依賴只在 src 深處 import ⇒ 列進 `vitest.config.mjs` unit-browser 的 `optimizeDeps.include`（否則中途重新預打包、瀏覽器斷線）。

## Phase 10：系統整合

- `index.html`：`viewport-fit=cover`、`theme-color` #141418（＝manifest，`index_html_meta.test.js` 守；仍禁 interactive-widget／鎖縮放）。
- safe-area：`App._readSafeInsets`（探針元素的 `env(safe-area-inset-*)` padding）→ `mobileChromeInsets` → CSS `--safe-top/--safe-bottom`
  ＋終端機 inset；`mobileRowsHeight(h, safe)` 扣掉。APK 原生已 padding ⇒ env＝0（`docs/android-app.md` 第 8 點）。
- 等待進度條：`mobile_busy.busyNext`（action → 500ms 內真的 `conn.onDataSent` → pending → 300ms 後 shown → `screenSettled` 或 3s 逾時收）。
  action 只來自我們的 UI（`App.noteUserAction`：底部導覽 sendKey、選單大按鈕、列表卡片 tap）⇒ 列表本地捲動、實體鍵盤不亮。
  畫在 App Bar 底邊，reduced-motion 靜態。
- 點擊波紋 `src/js/ripple.js#installRipple`（main.jsx 開站一次）：document capture-passive pointerdown 委派，只處理 `.pttRipple`，
  **`#mainContainer` 內一律跳過**；Mantine `Button`／`ActionIcon`／`Menu.Item` 由 `MantineRoot` theme classNames 掛（桌機也有）；
  手機底部導覽、sheet 項目手動掛。核心畫面卡片只用 CSS `:active`。工具列／App Bar 關掉 `-webkit-tap-highlight-color`。
