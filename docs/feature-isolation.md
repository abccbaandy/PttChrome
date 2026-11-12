# 功能故障隔離（`event.js`）

動 `src/js/event.js`、在 `TermBuf` 上掛新的 settle 監聽者、或改 `App._onFeatureError` 前先讀。

## 為什麼

`TermBuf` 的 `screenSettled`／`pageStateSettled` 掛了二十幾個功能（好讀、列表、指令佇列的完成通知、各種浮層）。
派發原本是沒有 try/catch 的迴圈：任何一個週邊功能丟例外，排在它後面的監聽者這一幀全部不跑，畫面可以停在「處理中」。
「功能壞了就回原生」原本只能靠每個功能自己保證；這一層讓它變成派發端的保證。

## 規則

- **只隔離 `TermBuf`**（`Event.mixin(TermBuf.prototype, { isolate: true })`）。連線層（telnet／websocket／ssh）不隔離，例外照原樣冒出去。
- **正式版**：每個監聽者各自 try/catch，一個丟例外，後面的照跑；例外交給 `setListenerErrorPolicy` 的 `onError`（`App._onFeatureError`：`console.error`＋debug 錄製 `featureError`，只記本機、不上傳）。
- **dev build 與測試是 strict**（`import.meta.env.DEV`）：照樣往外丟，跟沒有隔離時一樣，測試不會因此變鈍。正式版路徑由 `tests/unit/event_isolation.test.js` 以 `setListenerErrorPolicy({ strict: false })` 驗。
- **停用要登記**：`buf.addEventListener(type, fn, { feature: <設定鍵>, disable: () => … })`。登記了的功能出錯 ⇒ 呼叫它自己的 `disable` 收乾淨、這次連線派發跳過它，並用既有的紅底浮動提示說一次「「<設定名稱>」出了問題，先暫停到重新連線」（名稱取 `options_<設定鍵>`）。新連線（`App.onConnect`）`enableAllListeners` 恢復。
- **沒登記的不停用**，每幀照樣再試：不知道怎麼收乾淨的功能（例如好讀、列表 session 這類狀態機）半套停用只會更糟（畫面凍住）。新功能能乾淨收起（浮層收起、回原生）的，註冊時就帶上 `feature`／`disable`。
- 目前登記的：新功能小卡（`showWhatsNew`，收起小卡）、文章導覽軸（`enableArticleNav`，收起軸、原生捲軸跟著回來）。

## 還沒做（架構 review A1 的後續步驟）

- `onPrefChange` 逐 key、`onClose` 逐功能重置用同一套包法。
- 全域接 `error`／`unhandledrejection`，只寫進本機 debug 錄製的環狀緩衝。
