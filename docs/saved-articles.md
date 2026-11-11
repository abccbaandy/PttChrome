# 存到本機（P64，`saved_article_codec.js`／`saved_articles_store.js`）

動 `saved_article*.js`、`saved_articles*.js`、`term_view.showStaticArticle` 前先讀。

## 是什麼

文章存起來，之後不用連線也能讀：好讀模式已經讀到的整篇（內文、推文、顏色、網址）存進這個瀏覽器的 IndexedDB，首頁「本機收藏」點開就用現有好讀渲染唯讀顯示，不連線、不送任何鍵給 PTT。

## 規則

| 項目 | 規則 | 理由 |
|---|---|---|
| 資料來源 | 只取好讀累積頁 `buf.pageLines`（文章工具側欄同一份），**一個 byte 都不送** | 不碰登入額度、不碰畫面判定；原生 pmore 手上只有一屏，不能存 |
| 身分 | 看板＋AID，取自文末網址列（`aid_navigation.findLocalPostAid`）；讀不到就不能存 | 跟「最近讀過」同一條（`docs/recent-articles.md`）；沒網址列的（站內信、轉錄）不知道是哪一篇 |
| 格式 | `encodeRows`：屬性組合表＋每列「字串＋(屬性索引, 連續格數) run」。屬性欄位＝`term_char_intern.INTERN_FIELDS` 去掉 `ch`、`needUpdate` | 一份欄位清單（TermChar 加欄位時 intern 那邊已有守護）；連網址旗標一起存 ⇒ 還原後不用重跑網址偵測，畫出來一模一樣 |
| 讀回來不可信 | `decodeRows` 任何一處對不上回 `null`（呼叫端當「這篇壞了」） | IndexedDB 可能是舊版、半寫入；不畫半份 |
| 儲存 | IndexedDB `pttchrome-saved-articles`：`meta`（清單摘要）＋`body`（整篇），一個 transaction 一起寫／刪 | 清單只讀小的 meta；打開才讀內文 |
| 上限 | 200 篇、單篇 30000 列；**滿了拒絕，不自動刪舊的** | 存檔是使用者明確留下的，偷偷刪比存不進去更糟 |
| 不上雲 | 只在這個瀏覽器 | 內文大，Firestore 額度扛不住；提案原本說「雲端只同步清單」，第一版先不做 |
| 失敗 | 每個操作 resolve `{ ok:false, reason }`（`invalid`／`tooLarge`／`full`／`quota`／`error`），不 reject | 私密視窗、封鎖網站資料時 IndexedDB 會 throw；呼叫端只要照結果提示 |

## 唯讀頁（`?saved=<key>`，`saved_articles.js#bootSavedReader`）

| 項目 | 規則 | 理由 |
|---|---|---|
| 打開方式 | 另開一頁（`SavedArticles.open` ⇒ 新分頁 `?saved=<key>`），`main.jsx` 在 `claimDeepLink` 之前分流 | 不跟活連線搶畫面、不佔 PTT 連線名額，也不會搶走別的分頁的 deep link |
| 不連線 | 唯讀頁不 `connect()`、不接 deep link／返回鍵／雲端同步 ⇒ `view.conn` 恆 `undefined`，`_send` 天生送不出任何鍵 | 「一個 byte 都不送」由結構保證，不靠逐一攔截 |
| 畫法 | `term_view.showStaticArticle(rows)`：之後每次 `redraw` 都畫存檔（`_redrawStatic`），走同一個 `_renderScreenLines`／`#mainContainer`，override `STATIC_ARTICLE_OVERRIDES`（`stableRows`、`pageState: 3`、`easyReading: true`） | 核心畫面只有一條寫入路徑（`CLAUDE.md`）；CSS、縮放、手機 reflow、推文合併／樓層／推文卡片原樣可用 |
| 鍵盤 | `term_view.onKeyDown` 在唯讀頁只拿來捲動（`saved_articles.staticReaderKey`，鍵位照 pmore：空白／PgDn／f、PgUp／b、↓／j／Enter、↑／k、Home／g／0、End／G／$）；其他鍵吞掉，Ctrl／Alt／Meta 組合鍵不管 | 沒有連線，鍵送不出去；組合鍵留給瀏覽器（Ctrl+F、複製） |
| 手機 | `mobile_toolbar.staticReaderContext`（`bootSavedReader` 畫完自己通知一次）：App Bar 是文章標題與看板；底部導覽推／回文／重整反灰，到底、按鍵（捲動）照常；「更多」只剩閱讀工具與設定（`readOnly` ⇒ 不列上傳圖片、登出） | 送鍵的按鈕按了沒反應比不出現更糟；格位不動（`toolbarSlots`） |
| 找不到／壞掉 | 一則錯誤提示（`saved_missing`），一樣不連線 | 存檔可能在別的瀏覽器、被刪、或格式不對（`decodeRows` 回 null） |

另外比較過、沒採用的兩條（11/11）：A 在活連線的畫面上換資料來源（推文列、下一篇卡片、讀到哪底列等浮層都看 pageState 3＋好讀狀態，活畫面是列表時會互相打架）；B 自己的容器＋自己的 ScreenController（`main.css` 50 多條選擇器掛在 `#mainContainer` 底下、`.main` 的縮放由 `fixedResize` 算，要複製一份）。

## 還沒做（依序）

1. 存圖片本體（現在只存連結；沒網路時預覽打不開）。要先評估 IndexedDB 容量與 200 篇上限怎麼算。

## 入口

| 入口 | 規則 |
|---|---|
| 手機：好讀文章「更多」→「存到本機」 | `savedArticles.canSave()` 決定出現（pref 開＋`savableArticle`），按了 `saveCurrent()` |
| 桌機：右鍵選單「存到本機」 | 同上，跟其他一般項目一樣只在 `normalEnabled` 時出現 |
| 指令面板（F4） | 開面板時 `refresh()` 重讀清單，讀到了補進面板；列最近存的 5 篇（打字比對標題／看板／作者），Enter＝`open(key)`。好讀文章裡（`canSave`）多一個「存到本機」動作＝`saveCurrent()`（`command_palette.savedArticleItems`） |
| 首頁儀表板「本機收藏」 | `onChange`／`refresh()` 讀清單；點了 `open(key)` 開新分頁唯讀頁，✕ `remove(key)` |
| 設定 → 設定備份「本機收藏」 | 匯出＝`exportSavedArticles`：整篇紀錄原樣放進 `{ app, kind: 'savedArticles', schemaVersion, articles }`（`saved_article_codec.buildSavedExport`），0 篇不下載；匯入＝`importSavedArticles`：不是 JSON／不是這種匯出檔整份拒絕，個別對不上（身分、內文形狀、列數）跳過，同一篇覆蓋，放不下（200 篇）算 full、不刪舊的。設定頁拿不到 App ⇒ 直接開同一個 IndexedDB，首頁清單下次出現時重讀 |
| pref `enableSavedArticles`（預設開） | 關掉＝上面四個入口都不出現；已存的不刪，唯讀頁照常打開 |

## 測試

`tests/e2e/offline/saved_reader.offline.spec.js`：stock-huang 好讀讀完 → `saveCurrent()` 存進真 IndexedDB（再存＝覆蓋）→ 開 `?saved=` 唯讀頁：沒有任何 BBS WebSocket（對照組：一般開站數得到）、`view.conn` undefined、逐列文字＝存之前的累積頁；找不到的 key ⇒ 錯誤提示。

`tests/unit/saved_articles.test.js`（browser）：真 TermBuf＋AnsiParser 寫一頁（顏色、全形字、網址、閃爍、底線），存回來 `buildRow` 逐列相同、prototype 相同；壞資料矩陣全回 null；真 IndexedDB 的存／列／讀／刪、覆蓋不佔名額、滿了拒絕、太長拒絕、IndexedDB 不可用不 throw。
