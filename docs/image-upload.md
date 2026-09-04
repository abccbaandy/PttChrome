# 圖片上傳（urusai 圖床）

PTT 無貼圖功能 → 本站代傳圖床、把**直連網址**填進推文列／編輯器。

## API 合約（CONFIRMED，2026-08 實測）

```
POST https://api-v1-t2-upload.urusai.cc      multipart/form-data
  file    必填，單檔 ≤ 50MB
  token   選填，空字串＝匿名上傳（欄位照送）
  r18     選填，本站固定送 "0"
  sha256  選填，本站不送（跳過校驗）
→ 200 { status:"success", message:"uploaded",
        data:{ id, r18, filename,
               url_preview:"https://i.urusai.cc/<id>",
               url_direct :"https://i.urusai.cc/<id>.png",
               url_delete :"https://urusai.cc/del/<hash>", mime } }
刪除 POST https://api.urusai.cc/v1/delete  { token, type:file|album, hash }（需 token；本站不呼叫，只把 url_delete 顯示在紀錄面板）
```

CORS **CONFIRMED**：preflight `OPTIONS` 回 `204` + `Access-Control-Allow-Origin` 回射 Origin、
`Allow-Headers: *`、`Allow-Methods: POST, OPTIONS` ⇒ 瀏覽器直傳，**不需要自架代理**。

**一律插 `url_direct`**：只有它帶副檔名 → 命中 `image_url_detect.js#RE_IMAGE_EXT` → 好讀模式自動開圖；
`url_preview` 是 urusai 的網頁，任何 PTT client 都不會展開。長度約 30 字元，推文列容得下。

用 `XMLHttpRequest` 不用 `fetch`：需要 `upload.onprogress` 的百分比。`uploadImage` **永遠 resolve**
（`{ok:false,message}`），多檔佇列才能「一張失敗、其餘照跑」。

## 檔案

| 檔 | 責任 |
|---|---|
| `src/js/image_upload.js` | 純決策（validate／pick／parse／decideInsertMode／format）＋ XHR 上傳 |
| `src/js/upload_history.js` | 本機紀錄（純函式 + localStorage） |
| `src/js/image_upload_controller.js` | 三個入口、佇列、插入分派、imperative render；`isUploadLayerTarget` |
| `src/components/ImageUploadLayer/Overlay/Panel.jsx` + `ImageUpload.css` | 遮罩／進度／提示／紀錄面板 |

## 決策表：上傳完的網址往哪去（`decideInsertMode`）

| 畫面 | 判準 | 動作 |
|---|---|---|
| 頁面上有註冊的文字輸入框 | `hasTextTarget`（controller 的 `_insertTarget`） | `target`：`target.insert(text)`。**最優先**，贏過下面兩條 |
| 編輯文章 | `pageState === 6`（`term_buf.js#setPageState`） | `send`：`App.onPasteDone(text)` |
| 推文**內容輸入列** | `classifyPushScreen([lastRowText], 1).kind === 'inputPrompt'`（`push_screen.js`） | `send` |
| 其他（列表／選單／閱讀／推文流程的其餘各步） | — | `clipboard`：`App.doCopy(text)` + 提示 |

**底列分類只有一套：`push_screen.js#classifyPushScreen`**（已逐字對過 `bbs.c#recommend`，
見 `docs/pttbbs-screen-protocol.md` §11.3），長推文送出序列（`long_push_session.js`）吃的是
同一支，不要在 `image_upload.js` 另寫 regex。
踩過的坑（2026-08-28）：這裡原本用 `string_util.js#parsePushInitText`，它只認 `→ id:`，
但 prompt 是 `bbs.c:3079` 的 `sprintf("%s%s%s %s:", ctype_attr[type], ctype[type], RESET, myid)`，
`ctype = 推／噓／→` ⇒ **最常按的 `1.值得推薦` 一律判不到**，症狀是「上傳完都說不在推文框」
（編輯文章那條走 `pageState`，所以看起來只有推文列壞）。長推文功能後來做對了分類器卻沒回頭
換掉這裡，兩套判斷分歧就是本 bug 的成因；`parsePushInitText` 已移除，分類器也從 `long_push.js`
抽成獨立的 `push_screen.js`（原本擺在長推文的功能模組裡，是會再長出第二套的形狀）。
換掉後順帶擋住三種「開頭長得像輸入列、但送字會壞事」的底列：`typeMenu`（`vkey()` 只吃 1 byte
⇒ 網址首字被當型別鍵吞掉）、`confirm`（`確定[y/N]` 的 `ans` 只吃 1 字元 ⇒ 非 `y` ＝整則靜默取消）、
`angel`／`cooldown`／`fatal` 橫幅。

`target` 的唯一消費者是**長推文輸入框**（`components/ContextMenu/LongPushModal.jsx`）：
它 `show` 時 `setInsertTarget({ insert })`、關閉／unmount 時 `clearInsertTarget(target)`
（傳自己回去，避免「A 關閉時把後開的 B 清掉」）。目標形狀刻意做成**通用**的
`{ insert(text) }` 而不是 longPush 專屬（`InputHelperModal` 之類將來同題），但現在只有
一個消費者 ⇒ **不做註冊表／堆疊**。

`target` **必須贏過 `send`，不能並列**：那個 modal 開著時底下的畫面是文章／文章列表，
走 `send` 等於把網址的每個字元當成列表快捷鍵按下去。`enableImageUpload` 關閉時
LongPushModal **不註冊**——註冊了會判成 `target` 卻沒東西可插。

- 判斷在**上傳結束當下**做，不是拖曳當下：上傳要數秒，使用者可能已離開推文列。
  連帶：modal 中途被關掉 ⇒ 目標消失 ⇒ 乾淨退回既有決策，絕不往已卸載的 React state 塞字。
- `send` 走既有貼上漏斗 `onPasteDone`（內含列表好讀接管、文章好讀 `_enterFunctionMode`），
  **不可**改成 `view.conn.send`。**不補 Enter**，送不送由使用者決定。
- 多檔：空白分隔、整批結束才插入一次（`formatInsertText`）。

## 入口

| 入口 | 接線點 |
|---|---|
| 拖放 | controller 建構時綁 `window` 的 `dragenter/over/leave/drop`；`dragover` 必須 `preventDefault`，否則沒有 drop 且瀏覽器會用本分頁開圖（＝沖掉 BBS session）。只認 `dataTransfer.types` 含 `Files`；`dragenter/leave` 用深度計數防閃爍 |
| 貼上截圖 | `App.onDOMPaste` 先問 `tryClipboardImage(e)`；無圖回 `false` → 文字貼上行為零改變。`clipboardData.files` 有時是空的，故 `files` 與 `items` 都看 |
| 貼上快捷鍵 | **Ctrl+V／Shift+Insert 的 keydown 一律不可 `preventDefault`**：被 cancel 的 keydown 不會生 `paste` 事件 ⇒ `#t` 收不到 ⇒ `onDOMPaste` 不跑 ⇒ 文字與截圖兩條路一起死。`term_keyboard._onKeyDown` 的 ctrl 分支對 `v` 提早 `return false`（別改成 `doPaste()`：它只讀文字，會吞掉貼圖）。`^V` 讓位後改由 **Alt+V** 送（pttbbs `edit.c` 切 ANSI 彩色／`bbs.c` `do_post_vote`）。守護：`tests/unit/term_keyboard_paste.test.js`、`image_upload.offline.spec.js` |
| 長推文輸入框 | modal 內的「插入圖片」鈕 → `openFilePicker()`；Textarea 的 `onPaste` → `tryClipboardImage(e)`（**不可**走 `App.onDOMPaste`：那條後半段會 `onPasteDone` 送進終端機）。拖放沿用 window 層那條，不必額外接線。modal 必須 `closeOnClickOutside={false}`——上傳浮層是另一個 React root（`#imageUploadReact`，portal 在 body 上），對 Mantine Modal 而言算「點外面」，點一下「開啟上傳紀錄」就整段稿子沒了 |
| 右鍵選單 | `menuHandlerByEventKey.uploadImage / uploadHistory`（`components/ContextMenu/index.jsx`）；檔案對話框期間 `setModalOpen('imageUploadPicker', true)`，`change`／`cancel`／window `focus` 三路兜底關閉（漏關＝終端機永久收不到鍵盤） |

## 浮層與滑鼠（易踩）

浮層**刻意不是 modal**（終端機要能繼續打字）⇒ `modalShown` 擋不住它，且滾輪是註冊在 `window` 的
**capture** listener（浮層自己 `stopPropagation` 攔不到）。因此 `pttchrome.jsx` 的
`mouse_click / mouse_down / mouse_up / mouse_move / mouse_over / mouse_scroll / middleMouse_down`
一律先問 `App._onUploadLayer(e)`（→ `isUploadLayerTarget`，比對 `#imageUploadReact` 祖先）並 return。
元素另外掛 `nomouse_command`（`App.checkClass` 認得）當雙保險。
少了這條：點「插入」會順便在 PTT 送一次滑鼠動作、面板內滾動變成 PTT 翻頁。

容器 `#imageUploadReact` **獨立於 `#reactAlert`**：後者被 ConnectionAlert／PasteShortcutAlert／
DeepLinkHandoffAlert 輪流獨占（共用同一個 react root cache），上傳浮層必須能與它們並存。

面板捲動用原生 `overflow-y`，**不用 Mantine `ScrollArea`**：後者在 jsdom 需要 `ResizeObserver`（測試環境沒有）。

## pref / storage

| key | 位置 | 備註 |
|---|---|---|
| `enableImageUpload`（預設 `true`） | 設定→增強功能 | 總開關，關閉時三個入口全不作用、選單項目不出現 |
| `imageUploadToken`（預設 `""`） | 設定→**本機設定** | 在 `LOCAL_ONLY_PREF_KEYS` ⇒ 不上 Firestore、不進設定匯出檔。**不可用 `type=password`**：整頁多一個密碼欄，Chrome 會把設定頁判成登入表單（守護 `tests/unit/pref_modal_autologin_tab.test.jsx`） |
| `pttchrome.upload.v1` | localStorage，獨立 key | 上傳紀錄，`MAX_HISTORY = 50`；entry `{url, previewUrl, deleteUrl, filename, mime, at}`。**刻意不進 pref**：是使用歷史不是偏好，混進去會被雲端同步／匯出帶走 |

## 測試

- `tests/unit/image_upload.test.js`（決策表、驗檔、回應解析）
- `tests/unit/upload_history.test.js`（順序／去重／上限／壞 JSON）
- `tests/unit/image_upload_panel.test.jsx`（渲染、`nomouse_command` 守護、`isUploadLayerTarget`）
- `tests/unit/long_push_modal.test.jsx`（註冊／解除目標、插在游標處、貼上轉給 `tryClipboardImage`）
- `tests/e2e/offline/long_push_image_upload.offline.spec.js`：modal 開著時拖圖 → 網址進
  Textarea、**stub WS 一個 byte 都沒送**、點「開啟上傳紀錄」modal 不關
- `tests/e2e/offline/image_upload.offline.spec.js`：`installReplay` + `page.route` 假圖床 +
  真 `DataTransfer` 拖放；用 `window.__stubWSSent` 驗「推文列會送 / 列表一個 byte 都不送」。
  推文列畫面用頁面內的 `window.lib.u2bArray` 自行轉 Big5 後餵 `App.onData`。
  面板按鈕用 **class** 選（`.ImageUploadPanel__Insert`），不可用文字——CI 的 chromium 是 en-US 語系。
