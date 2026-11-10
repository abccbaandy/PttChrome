# 存到本機（P64，`saved_article_codec.js`／`saved_articles_store.js`）

動 `saved_article*.js` 前先讀。

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

## 還沒做（依序）

1. **唯讀閱讀器**（`lines`＝`decodeRows(rec.body, Object.getPrototypeOf(buf.attr))`）。兩條路，11/11 讀碼後的判斷：
   - **A（建議）：同一條寫入路徑換資料來源**。`term_view.redraw` 已經有「畫 `buf.pageLines`＋`_pageRenderOverrides()`（`stableRows`）」的好讀分支（`term_view.js` 約 1019 行）；閱讀器開著時讓那條分支畫存檔的列（新的 override，例如 `savedRows`），其餘照舊：同一個 `ScreenController`、同一個 `#mainContainer`、`fixedResize` 的縮放與手機 reflow、推文合併／樓層／推文卡片都免費。PTT 送來的畫面照收進 `buf`（不送鍵就不會變），關閉時 `redraw(true)` 畫回活畫面。要處理：開著時鍵盤／滑鼠／觸控一律不送 PTT（新的具名 modal 來源或 `nav_key_gate` 一條）、捲動照好讀的 `.main` 原生捲動、頂端一條「本機收藏・唯讀｜關閉」；標註層用到 `buf.pageState` 的地方要給 3。
   - B：自己的全螢幕容器＋自己的 `ScreenController`。不碰 `#mainContainer`，但 `main.css` 有 50 多條選擇器掛在 `#mainContainer` 底下、`.main` 的字級／縮放由 `term_view.fixedResize` 算 ⇒ 要嘛複製一份 CSS、要嘛全改成 class，代價大且兩份會漂移。
   關閉時（任一條）延遲載入盒由 `render/screen.js#disposeNode` 收。
2. **入口**：好讀文章「更多」面板（手機）／右鍵選單（桌機）「存到本機」；首頁儀表板「本機收藏」區、指令面板（F4）搜尋已存文章；可刪除。pref `enableSavedArticles`（預設開）＋設定頁開關；README 功能列表一條。
3. 匯出成檔案（JSON），之後再看要不要存圖片本體。

## 測試

`tests/unit/saved_articles.test.js`（browser）：真 TermBuf＋AnsiParser 寫一頁（顏色、全形字、網址、閃爍、底線），存回來 `buildRow` 逐列相同、prototype 相同；壞資料矩陣全回 null；真 IndexedDB 的存／列／讀／刪、覆蓋不佔名額、滿了拒絕、太長拒絕、IndexedDB 不可用不 throw。
