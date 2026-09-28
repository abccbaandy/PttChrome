# 手機版面（`mobileLayout`）

目標裝置：Android Chrome 現代版（iOS Safari `unknown`，未驗）。動 `mobile_layout.js`、
`App.applyMobileLayout`、`MobileKeypad`、`#t` 的 `inputmode` 前先讀。

## 狀態

| Phase | 內容 | 狀態 |
|---|---|---|
| 1 | tap 不叫鍵盤＋虛擬按鍵列＋鍵盤鈕＋viewport 解鎖縮放 | CONFIRMED（Android 真機實測） |
| 2 | 版面不被切（所有畫面縮到塞滿）＋軟鍵盤不蓋底列 | 已實作（真機 `guess`：待實測） |
| 3 | 文章好讀：正常字級＋超寬換行（`mobileReflow`），reflow 下關掉以 col 判斷的滑鼠區域 | 未做 |
| 4 | 文章列表／看板列表：手機卡片版（固定高 `K*chh` 保住 `list_scroll` 等高假設） | 未做 |

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
- **軟鍵盤蓋住底列（PTT 的輸入列）**：**不可**加 `interactive-widget=resizes-content`（鍵盤開關變成
  layout resize ⇒ 重算字級、改列數、重送 NAWS）。維持 Android 預設 `resizes-visual`（layout 高度不變 ⇒
  列數穩定），`App._onVisualViewport` 以 `mobile_layout.keyboardInset` 算被蓋住的高度 →
  `view.setKeyboardInset` → `term_size.termLayoutOffsets({bottomInset})`：在可視區內置中，放不下就底對齊
  （頂端列被推出畫面）。同一個值寫進 CSS 變數 `--kb-inset` 推高按鍵列（fixed 錨在 layout viewport）。
  只在 `softKeyboard` 時算；`visualViewport.scale ≠ 1`（雙指縮放）不算。
- **開站原點**：`#BBSWindow` 顯示前量到的 `firstGridOffset` 是 0；`main.jsx` 顯示後呼叫
  `onWindowResize({ immediate: true })` 跳過 resizer 的 500ms debounce（手機與桌機 fixed-font-size 都有 resizer）。

## 測試

- unit：`mobile_layout.test.js`、`mobile_keypad.test.jsx`、`app_mobile_layout.test.js`
- offline e2e：project `offline-mobile`（Pixel 7 模擬，`offline/mobile_*.spec.js` ＋
  `easy-reading-list.offline.spec.js`；`offline` project 以 testIgnore 排除 mobile_*），已併入
  `yarn test:e2e:offline`。**視窗高壓到 390px**：錄製檔全是 24 列，Pixel 7 原生高度會給 52 列、
  重放湊不成完整一屏；390 ⇒ 24 列。
- Windows 本機跑 `offline-mobile` 會用到 local 細明體，小字級下半形字寬被 hinting 取整（實測 5.0 vs
  chw 4.952）；Android／CI Linux 沒有細明體，走內建 webfont `SymMingLiu`（精確 0.5em）。量座標的斷言
  以欄數 × 誤差估容差，別因本機多幾 px 就改產品。
- 真機：`yarn start --host`，手機開 `http://<電腦區網 IP>:8080`（dev 預設站台跟著頁面 host，見 `docs/run-local.md`）。

## 已修的手機專屬 bug

- **列表 PgUp／PgDn 卡住**：非整數 DPR 下列高是小數（Pixel 7：26/2.625），`scrollTop` 被瀏覽器
  量化後讀回來略小於 `pos*rowH` ⇒ `list_scroll.topPosFromScrollTop` 的 floor 少算一列。容差改為像素單位
  `SCROLL_QUANT_EPS`。`easy-reading-list.offline.spec.js` 同時跑在 `offline-mobile`（唯一測得到的環境）；
  該 spec 的 px 比較一律容許 < 1px（`clientHeight` 取整數、`scrollTop` 被量化）。
- 已知未修：瀏覽器實際排版的列距是 LayoutUnit（Chrome 1/64px）量化後的值（實測 `chh` 9.90476 → 列距
  9.90625），列表捲動數學用的仍是 `chh` ⇒ 每列累積 ~0.0015px 誤差（300 列 < 0.5px，在容差內）。

## Phase 3–4 設計要點（未實作，交接見 `docs/handoff/mobile-phase3-4.md`）

- surface：`article`（好讀文章）／`list`（列表好讀 session engaged）改用 `MOBILE_ROW_FONT_PX` 字級、
  寬＝視窗寬；其餘維持 Phase 2 的塞滿縮放。rows 不隨 surface 變 ⇒ 不重送 NAWS。
  字級可調時再開 pref `mobileFontSize`（與桌機 `fontSize` 分開），且 rows 要跟著它算。
- reflow：`.main > span` 改 `white-space: pre-wrap; overflow-wrap: anywhere`（`.wpadding` 是
  inline-block，自然成斷行原子）；`nextScrollRestoreStep` 的 `lineIndex*chh` 在換行下失準 ⇒
  手機分支改用 `data-row` 節點 `offsetTop`；`resolveMouseGates` 加 `reflow` gate 關掉以 col 判斷的區域。
- 卡片：`list_session._rowHeight()`／`board_list_session._rowHeight()` 手機分支回 `K*chh`；
  保留 `data-row`、`data-list-author/-title` 契約；卡片 element-level click 走
  `list_session` 列點擊開文合約；看板列表欄位先讀 pttbbs `board.c`，不猜。
