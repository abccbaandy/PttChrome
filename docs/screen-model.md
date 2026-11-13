# 單一畫面模型（`src/js/screen_model.js`）

新增或修改「現在是哪個畫面」的判斷前先讀。

## 規則

- **一幀一份**：`screenOf(buf)` 回這一幀的畫面物件，同一幀問幾次都是同一個。「一幀」＝`TermBuf.notify`
  之間（`buf.frameSeq`，notify 處理到內容或游標變動就加一）；快取鍵另外帶 `pageState` 與游標，因為好讀會在
  notify 以外直接改 `pageState`；也帶終端機大小，因為 resize 不經 notify。事實是用到才算、算過就不再算。
- **只在 notify 之後讀**：事實算的是第一次讀它那一刻的 buffer。parser 寫了一半、還沒 notify 時讀，
  會拿到半成品並一路沿用到下一次 notify。讀的地方限 `change`／`viewUpdate` 監聽、`screenSettled`、使用者輸入事件。
  `dismissTarget` 這類刻意每次現算的判定不收進來。
- **外殼不改規則**：每個事實都是既有判定函式的原樣結果（對照表在 `tests/unit/screen_model.test.js`）。
  功能刻意較嚴或較鬆的判定不合併；要改規則就改原本的判定函式，模型跟著變。
- **`kind` 與「此刻真的是」是兩個問題**：`kind` 由 `pageState` 推出，`pageState` 會黏（pressanykey 後
  停在 5、編輯器 prompt 停在 6），`kind` 也跟著黏。替使用者送鍵前要的是「此刻真的是」⇒ 讀 `pass`／`editor`／
  `promptPending` 這些事實，不讀 `kind`。
- **`pageState` 不寫魔術數字**：比較與賦值一律 `PAGE_STATE.X`（`READING` 不是 `3`）。守護
  `tests/unit/page_state_constants.test.js` 掃整個 src 的程式碼（註解照舊可以寫數字）。
- **認不出就是 `UNKNOWN`**：`pageState` 0（以及從沒人寫過的 4）一律 `UNKNOWN`，不猜。0 也包含 setPageState
  主動判成 NORMAL 的畫面（底列空白），外殼不區分。
- **`BOARD_LIST` 不等於「看板列表」**：看板列表大多是 `pageState` 2 ⇒ `LIST`。要判看板列表照舊問 `board_list_parse`。

## `kind` 對照

| `pageState` | 子判定 | `SCREEN_KIND` |
|---|---|---|
| 5 | — | `PASS` |
| 6 | — | `EDITOR` |
| 3 | `isLiveScreenNow` | `LIVE`，否則 `ARTICLE` |
| 2 | — | `LIST`（文章列表與看板列表都在這；看板列表大多是 2，見 `docs/board-list-smooth-scroll.md`） |
| 1 | `isMailListScreen` → `isBoardListScreen` → `isMenuScreen` | `MAIL_LIST`／`BOARD_LIST`／`MENU`，都不是 `OTHER_MENU`（例：精華區） |
| 0、4 | — | `UNKNOWN` |

事實：`row0Text`、`lastRowText`、`pass`、`editor`、`editorTyping`、`live`、`mailList`、`boardList`、`menu`、
`cursorOnInputField`、`promptPending`、`pagerContext`、`boardName`。新增事實時在 `FACTS` 加一條、測試的對照表
加一條（守護會要求兩邊一致）。

- **沒有 `frameSeq` 的 buf 不快取**：不是 TermBuf（測試的假 buf）看不出幀的邊界，每次現算，跟直接呼叫判定函式一樣。
  假 buf 要補上讀到的判定（例：`isLiveScreenNow`），模型不替缺的函式找藉口。

## 消費端

| 功能 | 讀什麼 |
|---|---|
| `comment_bar._inEasyArticle`（推文列） | `kind === ARTICLE`（文章、不是實況） |
| `next_article._inEasyArticleEnd`（下一篇卡片） | `kind === ARTICLE` |
| `article_tools._inEasyArticle`（文章工具側欄） | `kind` 是 `ARTICLE` 或 `LIVE`（只讀累積頁，實況照樣出現） |
| `MobileToolbar` 編輯器「存檔」 | 按下當下讀 `editorTyping` 事實 |
| `MobileToolbar` 信件列表「寫信」 | 按下當下讀 `mailList`、`promptPending` 事實 |

## 下一步（A3 步驟 b～d）

b 功能逐一改讀它（先只讀不送鍵的浮層，送鍵類排後；推文列、下一篇卡片、文章工具側欄、手機工具列的存檔／寫信已搬）；d `parse_failure_degrade` 突變矩陣與 upstream 產畫面 nightly 改對畫面物件驗。
