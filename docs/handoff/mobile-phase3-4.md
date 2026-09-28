# 手機版面 Phase 3（文章換行）＋ Phase 4（列表卡片）

先讀 `docs/mobile.md`（Phase 1–2 已實作的規則、測試環境限制、Phase 3–4 設計要點）。
兩個 phase 各自一個 commit，做完一個就回報使用者真機測；兩個都做完刪掉本檔，並把 `docs/mobile.md` 狀態表改掉。

## 使用者定案（勿重議）

- 文章：**只支援好讀模式**；正常字級＋超寬自動換行。不要整體縮小、不要左右平移。ANSI 圖／表格換行後會散，接受。
- 列表（文章列表好讀、看板列表平滑捲動）：做成手機卡片版。
- 其他 80 欄格線畫面（主選單等）：維持 Phase 2 的塞滿縮放。
- 目標裝置 Android Chrome（iOS 後續）。

## Phase 3 待做

- surface 判定：好讀文章 engaged ⇒ `article`。進出好讀時重算版面（不改 rows ⇒ 不重送 NAWS）。
  入口候選：`easy_reading.enterEasyReading`／`exitEasyReading` 通知 `App.applyTermSize`。
- `article` 幾何：字級 `MOBILE_ROW_FONT_PX`，`.main` 寬＝視窗寬；`.main` 高仍是 `chh*rows+10`
  （`easy_reading._scrollBy` 下界公式是 LOCKED，見該函式註解）。
- CSS class `mobileReflow`（掛 `.main` 與 `#easyReadingLastRow`）：列改 `white-space: pre-wrap; overflow-wrap: anywhere`。
  `.wpadding` 是 inline-block，自然成為斷行原子。**不得**宣告 `user-select`（`tests/unit/css_user_select.test.js`）。
- `nextScrollRestoreStep` 的 `lineIndex*chh` 在換行下失準 ⇒ 手機分支改用 `data-row` 節點 `offsetTop`。
- 滑鼠：`resolveMouseGates` 加 `reflow` gate，關掉以 col 判斷的區域（邊緣翻頁、推文者防誤觸、列點擊送鍵）；
  元素層（連結、圖片、`a.fnKey`、合併按鈕）保留。先讀 `docs/mouse.md` gating 表。
- 桌機 golden（`render_dom_equivalence`）必須零 diff：reflow 只能是 class＋CSS，不改渲染輸出。

## Phase 4 待做

- `src/render/list_card.js`：手機＋列表 body 列時取代 `buildRow`。一筆 2 行（標題／推文數・日期・作者）。
  欄位解析沿用 `comment_parse.parseListTitle`／`parseListAuthor`／`parseListArticleNum`；看板列表的欄位
  **先讀 `3rd_script/pttbbs` 的 `board.c`，不猜**（Big5 grep 規則見 CLAUDE.md）。
- 卡片固定高 `K*chh` ⇒ `list_session._rowHeight()`／`board_list_session._rowHeight()` 手機分支回 `K*chh`，
  `list_scroll.js` 的等高假設不破（量化容差 `SCROLL_QUANT_EPS` 已在）。
- 保留 `data-row`、`data-list-author/-title` 契約（選取反查、右鍵黑名單）。
- 點擊：卡片 element-level click → `list_session.js` 的「列點擊開文」合約（`_rowHeight` 下方那段註解），
  不走格線換算。游標（選取）標示＝整張卡片底色。
- `docs/easy-reading-list.md` 的不變量先讀。

## 驗證

- `offline-mobile` project（`playwright.config.js`，視窗高 390 ⇒ 24 列，理由見 `docs/mobile.md`）加對應 spec。
- 改到渲染：`yarn test:e2e:offline`＋`yarn test:e2e:offline:adverse`＋live `easy-reading.spec.js`/`enhance.spec.js`（一次登入）。
