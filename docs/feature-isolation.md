# 功能故障隔離（`event.js`）

動 `src/js/event.js`、在 `TermBuf` 上掛新的 settle 監聽者、或改 `App._onFeatureError` 前先讀。

## 為什麼

`TermBuf` 的 `screenSettled`／`pageStateSettled` 掛了二十幾個功能（好讀、列表、指令佇列的完成通知、各種浮層）。
派發原本是沒有 try/catch 的迴圈：任何一個週邊功能丟例外，排在它後面的監聽者這一幀全部不跑，畫面可以停在「處理中」。
「功能壞了就回原生」原本只能靠每個功能自己保證；這一層讓它變成派發端的保證。

## 規則

- **只隔離 `TermBuf`**（它的所有事件：settle 之外，好讀重畫用的 `change`／`viewUpdate` 也在內）（`Event.mixin(TermBuf.prototype, { isolate: true })`）。連線層（telnet／websocket／ssh）不隔離，例外照原樣冒出去。
- **正式版**：每個監聽者各自 try/catch，一個丟例外，後面的照跑；例外交給 `setListenerErrorPolicy` 的 `onError`（`App._onFeatureError`：`console.error`＋debug 錄製 `featureError`，只記本機、不上傳）。
- **dev build、e2e 打包版與測試是 strict**（`import.meta.env.DEV || process.env.DEVELOPER_MODE`；CI 的 offline／adverse 跑的是 `PTTCHROME_E2E_BUNDLE` 打包版，只看 DEV 會讓 pageerror 斷言靜默失效）：照樣往外丟，跟沒有隔離時一樣，測試不會因此變鈍。正式版路徑由 `tests/unit/event_isolation.test.js` 以 `setListenerErrorPolicy({ strict: false })` 驗。
- **停用要登記**：`buf.addEventListener(type, fn, { feature: <設定鍵>, disable: () => … })`。登記了的功能出錯 ⇒ 呼叫它自己的 `disable` 收乾淨、這次連線派發跳過它，並用既有的紅底浮動提示說一次「「<設定名稱>」出了問題，先暫停到重新連線」（名稱取 `options_<設定鍵>`）。新連線（`App.onConnect`）`enableAllListeners` 恢復。`feature` 必須是 `DEFAULT_PREFS` 裡的設定鍵、有 `options_<鍵>` 名稱，並列進下面「目前登記的」（守護 `tests/unit/feature_isolation_registry.test.js` 靜態掃 src 逐一對）。
- **不走派發的主入口也要算進來**：功能若有不經事件派發、每包／每次都會跑的入口（例：收件匣在 `App.onData` 解析），在那裡 try/catch 後呼叫 `buf.reportListenerError(type, fn, err)`（`fn`＝登記時的那條監聽者）：跟派發出錯走同一套政策（strict 照丟；正式版停用＋提示一次）。
- **停用要擋住所有入口**：功能若還有別的觸發點（resize、推文列…），在那裡用 `buf.isListenerDisabled(fn)` 判斷，否則停用後又被叫回來（導覽軸的 `refresh` 就是這樣擋）。
- **沒登記的不停用**，每幀照樣再試：不知道怎麼收乾淨的功能（例如好讀、列表 session 這類狀態機）半套停用只會更糟（畫面凍住）。新功能能乾淨收起（浮層收起、回原生）的，註冊時就帶上 `feature`／`disable`。
- **派發順序有意義的監聽者要帶 `owner`**（App 上的屬性名，例 `{ owner: 'listSession' }`）：`buf.listenerOwners(type)` 讀得到派發順序，`tests/e2e/offline/listener_order.offline.spec.js` 守 App 建構子裡「順序有意義」的那幾組先後（架構 review A6 第一步）。新增一組先後依賴時，在那支 spec 的 `BEFORE` 補一列，兩邊都帶 `owner`。`owner` 只是標籤，不會讓功能出錯時停用。
- 目前登記的：新功能小卡（`showWhatsNew`，收起小卡）、文章導覽軸（`enableArticleNav`，收起軸、原生捲軸跟著回來）、看板分頁（`enableBoardTabs`，收起分頁列、露出原生按鍵提示列；resize 與別的視窗改分頁的 `storage` 事件也擋）、手機文章內找字（`mobileFindInArticle`）、搜尋狀態列（`enableSearchStatus`，收起狀態列；resize、換卡片版面、搜尋彈窗送出這些重畫入口也擋）、列表快速捲動把手（`enableListFastScroll`，收起把手、拖到一半的放開不送跳號；捲動入口也擋）、下一篇卡片（`enableNextArticleCard`，收起卡片、同主題列與換文遮罩；點擊、往下拉、滾輪的 `open`／`setPull` 也擋。換文途中被停用：鍵是 `aid_navigation` 在送，照常跑完叫 `done`，閱讀紀錄照常收尾，只是遮罩馬上拿掉、不再等好讀接手）、文章工具側欄（`enableArticleTools`，收起側欄、終端機旁的空白回來；resize 入口也擋）、雙欄閱讀的左欄（`enableSplitReading`，收起左欄；resize 入口也擋，收起後點不到所以不會再開文。換文途中被停用：鍵是 `aid_navigation` 在送，照常跑完叫 `done`、閱讀紀錄照常收尾）、底部推文列（`enableCommentBar`，收起列；列表上蓋著的推文類型選單露出來給使用者原生回答：擋鍵解除、系統返回交還，不替使用者取消；手機工具列問 `takesOverListPrompt` 回 false ⇒ 照出自己的選項；展開／預填因 `available` 清掉而叫不回來；文章模式輸入框打到一半的字留在元件裡，列表模式的字跟著目標清掉）、編輯器輸入框（`enableEditorInput`，收起入口鈕與框；resize、App 的 refresh、`open`／`insert` 都經 `_available` 擋住，停用後不送字；框裡打到一半的字留在元件裡）、水球收件匣（`enableMessageInbox`，清空收件匣、鈴鐺消失、取消進行中的回覆；回覆入口也擋。它的主入口 `App.onData` 每包解析不是事件派發，出錯經 `buf.reportListenerError(type, 同一條監聽者, err)` 算在同一個功能上一起停用，不往上丟進連線層）、最近讀過（`enableRecentArticles`，不再記最近讀過與讀到哪、還沒落地的「接著讀」作廢、提示收起；捲動取樣與 `open` 的接著讀經 `resumeEnabled` 擋住。已存的清單照舊顯示，使用者自己按的稍後閱讀增刪不受影響）、新推文標記（`markNewComments`；列表「+N」`listNewPushCount` 共用同一條監聽與紀錄，一起停：不再記推文數、渲染時問的 `rowFor`／`listBadge` 回 null，下一次重畫標記就消失；還沒落地的「點徽章跳到新推文」作廢，`armJumpOnOpen` 也擋）、只看關注（`enableFollowOnly`，收起切換鈕、列表回到全部：篩選唯一的閘門 `view.listFollowOnly` 問 `followOnly.suspended()` 回 null，列表好讀的藏列與標註快取鍵跟著變；使用者存的切換狀態不動，新連線照存的狀態回來；resize、設定變更、點鈕也擋）、首頁儀表板（`enableHomeDashboard`，收起面板露出原生主功能表、自動抓我的最愛的計時取消；點卡片、開信箱、`fetchFavorites`（含 F5 認首頁）都擋。抓我的最愛途中被停用：鍵已在佇列裡，照常跑完回主功能表、閱讀紀錄照常收尾，收尾時叫的 `_onSettled` 先看停用，面板不再出現。最近看板與看板未讀也不再記）。
- **不登記的 settle 監聽者**：推文篩選橫幅（`CommentFilterBar`）的監聽只做 React `setState`，本身丟不出例外（render 的錯誤歸 React，不經派發），登記沒有意義。
- **週邊功能宣告表**（`src/js/features.js`）：搬進表的功能由 App 建構子 `createFeatures` 照表順序建（陣列順序＝settle 派發順序），表裡的 `pref` 必須就是它登記的 `feature`（守護 `tests/unit/features_table.test.js`）。目前在表裡的：首頁儀表板、新功能介紹、最近讀過（`HOME_FEATURES`，儀表板 `after` 核心流程 deepLinkController／reconnectResume：`after` 也可以指向那段表之前建構子() => '已經 new 的核心物件），存到本機、雙欄閱讀、文章工具側欄、選取文字頁、手機找字（`READING_FEATURES`；沒有 settle 監聽的標 `settle: false`，測試改查檔案裡真的沒有 settle 監聽），推文列、'搜尋狀態列、只看關注、列表快速捲動把手、編輯器輸入框、下一篇卡片（`PERIPHERAL_FEATURES`），水球收件匣、新推文標記、導覽軸、看板分頁（`LATE_PERIPHERAL_FEATURES`，中間夾著下一篇手勢的 DOM 監聽）。**先後有意義就寫在該項的 `after`**（例：導覽軸 `after: ['commentBar']`，下緣要扣推文列）：建到它時前置還沒建 ⇒ `createFeatures` 丟例外；每一組 `after` 也必須列在 `listener_order.offline.spec.js` 的 `BEFORE`（同一支 unit 守護對），不要只靠建構子行序＋註解。

## 不走事件派發的入口

- **`App.onPrefChange` 逐 key**：每個 key 自己 try/catch，失敗交給 `event.js#reportIsolatedError('pref:<key>')`。以前是默默吞掉；現在 dev／測試照樣丟出。
- **`App.onClose` 逐功能收攤**：每個 reset／disable 用 `runIsolated('close:<名稱>')` 包起來，一個丟例外，其餘照收、斷線提示照畫（不然畫面停在「連線中」、沒有重連鈕）。新增收攤項目照同樣包。
- 這兩種只記錄、不停用、不提示（沒有對應的開關）。

## 全域未捕捉的例外

`page_error_log.js`：`window` 的 `error`／`unhandledrejection` 只在開著 debug 錄製時記一筆（`pageError`／`pageRejection`，進錄製器的環狀緩衝），不 `preventDefault`、不上傳。沒開錄製就什麼都不做。
