# 手機版面（`mobileLayout`）

目標裝置：Android Chrome 現代版（iOS Safari `unknown`，未驗）；Android APK 殼（背景不斷線）見 `docs/android-app.md`，其鍵盤高度由原生回報（`keyboardInset` 的 `hostInset`）。動 `mobile_layout.js`、
`App.applyMobileLayout`、`MobileKeypad`、`#t` 的 `inputmode` 前先讀。

## 狀態

| Phase | 內容 | 狀態 |
|---|---|---|
| 1 | tap 不叫鍵盤＋虛擬按鍵列＋鍵盤鈕＋viewport 解鎖縮放 | CONFIRMED（Android 真機實測） |
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
  軟鍵盤只由按鍵列的鍵盤鈕 `App.toggleSoftKeyboard()` 叫出：切 `inputmode=text` 後
  `blur()`→`focus()`（inputmode 對已有焦點的欄位不即時生效），**必須在 click handler
  內同步呼叫**（user activation）。被別的方式收起（Android 返回鍵）由 `App._onVisualViewport`
  偵測：看過 inset>0 之後回到 0 ⇒ `softKeyboard` 歸零、通知按鍵列（`onMobileChange(fn(mobile, kb))`）。
  「看過出現」是必要條件：剛按鍵盤鈕那幾幀鍵盤還沒升起。
- 按鍵列（`src/components/MobileKeypad`，掛在 ContextMenu 內，`modalOpen` 時隱藏）：
  - 送鍵只走 `view.sendKeyAsUser(keyName)`。不可 `view._send`（列表好讀＝在序列化交易
    中途插隊）、不可 `App.onFunctionKey`（文章好讀會先進 functionMode ⇒ PgDn 不捲動）。
  - `mousedown` preventDefault（不搶 `#t` 焦點）＋ mousedown/mouseup/click stopPropagation
    （App 的滑鼠入口在 window）。守護 `tests/unit/mobile_keypad.test.jsx`。
  - 按鍵表 `MOBILE_KEYPAD_ROWS`，每個 key 必須在 `term_keyboard.KeyMap`。
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
  （頂端列被推出畫面）。同一個值寫進 CSS 變數 `--kb-inset` 推高按鍵列（fixed 錨在 layout viewport）。
  只在 `softKeyboard` 時算；`visualViewport.scale ≠ 1`（雙指縮放）不算。
- **開站原點**：`#BBSWindow` 顯示前量到的 `firstGridOffset` 是 0；`main.jsx` 顯示後呼叫
  `onWindowResize({ immediate: true })` 跳過 resizer 的 500ms debounce（手機與桌機 fixed-font-size 都有 resizer）。

## 測試

- unit：`mobile_layout.test.js`、`mobile_keypad.test.jsx`、`app_mobile_layout.test.js`、`mobile_surface.test.js`、
  `list_card.test.js`（含兩個 session 的卡片換算；看板列表沒有錄製素材，這是它唯一的守護）；
  reflow 相關另在 `mouse_regions`／`mouse_gating`／`scroll_restore`／`context_menu_items` 各有一組
- offline e2e：project `offline-mobile`（Pixel 7 模擬，只跑 `offline/mobile_*.spec.js`：換行版面與長按選單在
  `mobile_reflow`、卡片在 `mobile_list_cards`；`offline` project 以 testIgnore 排除 mobile_*），已併入
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

## 長按選單（觸控 contextmenu）

Chromium 長按**先選字、後發 contextmenu** ⇒ 事件到時選取必不為空。`context_menu_items.menuTargetFlags`
的 `touchLongPress`（`isTouchContextMenu`：`pointerType === 'touch'`，退回 `sourceCapabilities.firesTouchEvents`）
讓 `normalEnabled` 不看選取（黑名單／前已讀後未讀／貼上照出），`selEnabled` 照舊（仍可複製那個字）。

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
- 契約保留：`span[type=bbsrow][srow]`、`data-list-author/-title`、`.listCardBody[data-type=bbsline][data-row]`
  （游標底色的 class 下在這裡 ⇒ 整張卡片上色）。
- 點擊：`App.clientToPos` 的 body 列號除數換成卡片高（`listRowSpan`）；`App.mouse_click` 在 listCards 下
  不做退出帶／邊緣翻頁，點卡片本體＝ `onMouseClick(row, LIST_TITLE_COL_START)`（走 session 的列點擊開文
  合約）；點到間距（`mobile_layout.isListCardGapTarget`：在 `.listBodyView` 內、`.listCardBody` 外）吞掉不開文（防誤點）。`term_view.listEdgeRegion`／`onListMouseMove` 同樣關掉以 col 判斷的部分。退出用按鍵列的 ←。
- 長按選單的黑名單區域在 listCards 下看 DOM（`.listCardAuthor`／`.listCardTitle`），不看 col；「前已讀後
  未讀」用 `clientToPos` 的列號（已是卡片座標）。
- 字級可調時再開 pref `mobileFontSize`（與桌機 `fontSize` 分開），且 rows 要跟著它算。
