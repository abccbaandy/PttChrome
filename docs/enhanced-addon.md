# Enhanced Add-on（黑名單／樓層／自動登入）

原生整合自 `3rd_script/PttChrome ...Enhanced Add-on`（原為 DOM-scraping userscript）。功能改用內部
`TermChar[]` 結構，不爬 DOM。對應 e2e：`tests/e2e/enhance.spec.js`（連真 PTT，需好讀模式）。

## 純邏輯核心：`src/js/comment_parse.js`
- `rowToText(chars)`：`TermChar[]`→Unicode（DBCS 合併，比照 `term_buf.getRowText`）。
- `parseComment(text)`→`{type:'推'|'噓'|'→', userid(lower)}|null`，正則 `/^(推|噓|→)\s+([0-9A-Za-z]+)\s*:/`。
- `parseListAuthor(text)`→userid|null。**欄位常數 cols 17~28**（CONFIRMED 2026-06 對 C_Chat 校準）。
  fail-safe：非 userid→null→不隱藏。`●`(編輯過) 列有全形字位移→fall through（可接受的 under-hide）。
  守護測試：`enhance.spec.js` 「看板列表作者欄位常數仍正確」，PTT 改版位移會先紅。
- `FloorCounter`：`seq`(總樓)、`sub`(該 type 分項)；每篇文章 reset。
- `parseBlacklist(str)`→lower-case Set（換行分隔）。

## 渲染整合（雙路徑收斂到 `<Row>`）
- `<Row>`(`components/Row/index.js`) 新增 props `floor`/`hidden`。`floor`→`LinkSegmentBuilder.readChar`
  在 **col 2**（marker 與 userid 間的空格）插入 `.floorBadge`（CSS `main.css`：`display:inline-block;
  width:0;vertical-align:super` 小字上標，不位移等寬格線；`user-select:none` 故不污染複製）。`hidden`→
  外層 bbsrow `visibility:hidden`（保留行高、不破壞固定格線）。樓層計數：黑名單推文 **仍 +1 樓**（先
  `counter.next` 再決定隱藏/移除），故編號維持絕對正確。
- **關鍵：渲染路徑取決於 `view.useEasyReadingMode`**：
  - 好讀**關**：所有畫面走原生 `renderScreen`→`Screen.js#computeAnnotations`。
    `pageState==3`→`parseComment`(floor／黑名單 hidden)；`pageState==2`→`parseListAuthor`(黑名單 hidden)。
    `renderScreen`(`term_ui.js`) 多傳 `enhance={blacklist,showFloorNumbers,pageState}`(`term_view.redraw`)。
  - 好讀**開**：**所有**畫面走 `appendRows`（文章=`populateEasyReadingPage`，列表/選單=`hideEasyReading`），
    **繞過 Screen**。故 `appendRows(lines,preview,enhance=true)` 內需自行依 pageState 過濾：
    `pageState==3`→黑名單推文 **直接不 append**（真正不占行，解決舊版 opacity:0）；
    `pageState==2`→黑名單發文設 `el.style.visibility='hidden'`（固定格線只能隱藏不移除）。
    floor 用 `view._floorCounter`（跨頁持久，新文章在 `populateEasyReadingPage` else 分支 reset）。
    `hideEasyReading` 也必須帶 `enhance=true`（否則列表黑名單失效——曾是 bug）。
- 測試讀列：好讀模式外層 el 包住 Row 自身的 bbsrow（多一層巢狀）；讀推文用 `[data-type="bbsline"]` 的
  **textContent**（`visibility:hidden` 列 innerText 為空），推文正則需容忍徽章數字：`/^(推|噓|→)\d*\s+/`。

## 設定（`PrefModal.js` 「增強功能」分頁）
pref keys（`DEFAULT_PREFS`，存 localStorage `pttchrome.pref.v1`）：
`showFloorNumbers`(true)、`blacklist`("" 換行)、`autoLogin`(false)、`autoLoginUser/Password`("")、
`autoLoginDupConn`('N')、`autoLoginSkipWelcome`(true)。套用見 `pttchrome.onPrefChange`
（`showFloorNumbers`/`blacklist`→`view.*`+`redraw(true)`）。i18n 鍵在 zh_TW/en_US `options_*`。

## 自動登入：`src/js/auto_login.js`
`App` constructor `new AutoLogin(this)`；`onConnect` 末尾 `start()`。**自走 polling**（setTimeout 每
500ms），每 tick 直接從 `buf.getRowText` 讀整頁（**勿用 `#mainContainer.innerText`**：`'change'` 事件
在 React re-render **之前** 觸發 → DOM 慢一幀，導致「要按鍵才動」）。比對提示字串沿用
`tests/e2e/helpers/ptt.js#login` 流程，帳密用 `app.sendData`(Big5)、空白/Y/N 同。到主功能表即 `stop()`；
逾時 90s 自停；reconnect 時 `start()` 重置。憑證明文存 localStorage（僅本機、不進 git；預設空）。
e2e：`enhance.spec.js`「自動登入：開頁自動到主選單（不需按鍵）」（需 env PTT_USER/PTT_PASS）。

## 未移植（原腳本失效/越界）
axios/tippy/GM_config/國旗 IP 查詢(外部 osk2.me:9977 已失效)、滑鼠瀏覽友善模式、右鍵搜尋作者選單、
原PO 高亮（與專案既有功能重疊）。

## 踩坑筆記（本次整合，CONFIRMED）

1. **渲染雙路徑：好讀開啟時所有畫面繞過 Screen**。`view.useEasyReadingMode==true` 時，redraw 對「任何」
   pageState 都走好讀分支：文章→`populateEasyReadingPage`、列表/選單→`hideEasyReading`，全都 `appendRows`
   直接竄改 DOM，**不經 `Screen.js`**。⇒ 任何「逐列加工」必須**同時**做在 `Screen#computeAnnotations`(原生)
   與 `appendRows`(好讀) 兩處，且 `hideEasyReading` 也要傳 `enhance=true`。← 「列表黑名單沒作用」根因。
2. **`'change'` 事件早於 React 重繪**：`term_buf.notify()` 先 `dispatchEvent('change')` 才 `view.update()`
   (`term_buf.js:800/803`)。要讀「當前畫面文字」一律用 `buf.getRowText`，**勿讀 `#mainContainer.innerText`**
   （慢一幀、需下一次更新才追上）。← auto-login「要按鍵才會動」根因；改自走 polling + getRowText 解決。
3. **`innerText` 對 `visibility:hidden` 回空字串**（Chromium）；要讀隱藏列文字用 `textContent`。e2e 測黑名單
   隱藏列時踩過。
4. **行內徽章污染 DOM 文字**：floorBadge 插在 bbsline 內 → DOM 文字變 `"推9 userid"`。app 邏輯都讀 buf 不受影響、
   複製用 buf + `user-select:none` 也不受影響；只有 DOM scraping 要容忍：正則 `/^(推|噓|→)\d*\s+/`。
5. **dev server 模式陷阱**：Playwright `reuseExistingServer:true` 可能重用到 **production 模式**舊 server →
   `DEFAULT_SITE=wsstelnet://ws.ptt.cc/bbs`（直連、Origin 未改寫）→ **WebSocket 403**。啟動務必
   `NODE_ENV=development`，並驗證 served bundle：`curl .../assets/pttchrome.js | grep DEFAULT_SITE` 應為
   `wstelnet://localhost:8080/bbs`。
6. **`parseListAuthor` 欄位需實機校準**（目前 cols 17–28 @ C_Chat），已加守護測試；PTT 改版位移會先紅。
7. **e2e flake**：最新文章常無推文（測樓層/黑名單要從 End 往舊文找）；guest 名額滿時用 env `PTT_USER/PTT_PASS`；
   連線偶發 403/ECONNRESET（PTT 端）。

## 工作流偏好（FEEDBACK）
- **不要開新功能分支**：直接在現有分支（`dev`）修改與 commit。本次誤開 `feat/enhanced-addon` 已併回 `dev`。
