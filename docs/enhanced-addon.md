# Enhanced Add-on（黑名單／樓層／自動登入）

原生整合自 `3rd_script/PttChrome ...Enhanced Add-on`（原為 DOM-scraping userscript）。功能改用內部
`TermChar[]` 結構，不爬 DOM。測試：`yarn test:unit`（vitest，純邏輯+Row 渲染，不連網，見
`tests/unit/`）；`yarn test:e2e`（Playwright，連真 PTT，需好讀模式）。

## 純邏輯核心：`src/js/comment_parse.js`
- `rowToText(chars)`：`TermChar[]`→Unicode（DBCS 合併，比照 `term_buf.getRowText`）。
- `parseComment(text)`→`{type:'推'|'噓'|'→', userid(lower)}|null`，正則 `/^(推|噓|→)\s+([A-Za-z][0-9A-Za-z]+)\s*:.*<COMMENT_TIME_RE>/`。
  **必須**結尾有時間戳 `COMMENT_TIME_RE=/\s\d{1,2}\/\d{2}\s+\d{2}:\d{2}\s*$/`（定義在 `string_util.js`，與 `parsePushInitText` 共用）。
  用以排除「內文中的推文格式文字（無時間戳）」與「`※ 編輯: … MM/DD/YYYY HH:MM:SS`（格式不同+前綴※）」被誤計樓層。
  userid 子樣式 `[A-Za-z][0-9A-Za-z]+`（須字母開頭、≥2 字元）依官方 `go-bbs/user_comment_record.go` 收緊，排掉 `推 1: …` 之類假推文。官方終端 byte/格式規則（型別色碼、IP iff `BRD_IPLOGRECMD`、對齊 iff `BRD_ALIGNEDCMT`、FORWARD/轉錄不計樓）內嵌 `comment_parse.js` 的「Official cross-validation」docstring；交叉驗證測試見 `comment_parse.test.js`「official cross-validation」+ fixture `IpComment_M.1621089154.txt`／`Forward_M.1644506392.txt`。背景見 `docs/ptt-official-app-research.md`。
- `parseListAuthor(text)`→userid|null。**欄位常數 cols 17~28**（CONFIRMED 2026-06 對 C_Chat 校準）。
  fail-safe：非 userid→null→不隱藏。行首全形字（舊版 `●` 游標）造成位移→fall through（可接受的 under-hide）；現行游標是半形 `>`（pttbbs `b9a5029f`），不位移欄位。
  守護測試：`enhance.spec.js` 「看板列表作者欄位常數仍正確」，PTT 改版位移會先紅。
- `FloorCounter`：`seq`(總樓)、`sub`(該 type 分項)；每篇文章 reset。含 **BePTT meta-latch 規則**
  （`nonComment(text)`，演算法來源見踩坑 B「BePTT 反編譯」）：非推文列在 `※ 發信站/※ 文章網址` latch 前一律歸零計數
  → 內文/簽名檔「帶假時間戳的假推文」拿到的暫時樓號被清掉，真推文從 1 起算。
- `parseBlacklist(str)`→lower-case Set（換行分隔）。
- `parseArticleAuthor(text)`→原PO id(lower)|null，正則 `/^\s*作者\s+([0-9A-Za-z]+)/`。**僅文章首頁首行**（作者列）解析得到；翻頁後 lines[0] 是內文→null。
- **`annotateComment(text, ctx)`→逐列判斷的單一真相**（floor/hidden/pusher/contentCol/authorId 範圍）。
  `ctx={blacklist,showFloorNumbers,floorCounter,highlightAuthor,articleAuthor}`。
  推文者高亮**不在這裡**（2026-08 搬走）：述詞是同檔的 `isPusherHighlighted(ann, selectedPusher)`，由 renderer 現算。**單一渲染路徑
  呼叫它**（`js/screen_annotations.js#computeAnnotations`，兩模式共用）；勿為某路徑另寫一份（見踩坑 A「逐列加工走單一純函式」）。
  floor 對黑名單列仍 +1（樓號絕對正確）；hidden 短路其餘高亮。回 null=非推文列。守護測試 `tests/unit/comment_parse.test.js`。

## 渲染整合（單一路徑 `ScreenController`→`buildRow`）

> **2026-08 核心渲染鏈已去 React 化**：`<Screen>`/`<Row>` → `src/render/`（純 JS DOM，見
> `docs/easy-reading.md`「render 單軌」）。以下 DOM 契約／逐列加工邏輯一字不變，只有實作檔改名：
> `components/Screen.jsx` → `js/screen_annotations.js`（標註）＋ `render/screen.js`（控制器）、
> `components/Row/index.jsx` → `render/row.js`、`Row/LinkSegmentBuilder.jsx` → `render/link_segment.js`、
> `Row/ColorSegmentBuilder.js` → `render/color_segment.js`、`Row/WordSegmentBuilder/` → `render/word_segment.js`、
> `LazyInlinePreview.jsx` → `render/inline_preview_slot.js`。`ImagePreviewer` 仍是 React。

- `buildRow`(`render/row.js`) 有參數 `floor`/`hidden`。`floor`→`link_segment.readChar`
  在 **col 2**（marker 與 userid 間的空格）插入 `.floorBadge`（CSS `main.css`：`display:inline-block;
  width:0;vertical-align:super` 小字上標，不位移等寬格線；`user-select:none` 故不污染複製）。
  **定位＝右對齊 userid 起始欄、向左生長**（零寬盒 `left:calc(0.5em/--floor-scale)` 右移 1 欄，內層
  `.floorBadgeNum` 再 `translateX(-100%)`）：1~2 位數落在空隙內，3 位數以上（`floorBadge--wide`，另補
  半透明深底）往 marker 方向溢出 → **作者 id 永不被蓋**。`hidden`→
  外層 bbsrow `visibility:hidden`（保留行高、不破壞固定格線）。樓層計數：黑名單推文 **仍 +1 樓**（先
  `counter.next` 再決定隱藏/移除），故編號維持絕對正確。
- **單一渲染路徑（兩模式都走 `renderScreen`→`screen_annotations.js#computeAnnotations`）**：逐列加工只有一處，無法發散。
  `term_view.redraw`/`_renderScreenLines` 傳 `enhance={blacklist,showFloorNumbers,highlightAuthor,
  articleAuthor,selectedPusher,pageState,dropHidden}`（`selectedPusher` 只給 renderer 當種子，**不進
  `annotationsKey`**）。`computeAnnotations`：`pageState==3`→`annotateComment`
  (floor／黑名單 hidden／作者高亮)；`pageState==2`→`parseListAuthor`(黑名單 hidden)。
  - 兩模式差別只在傳給 renderer 的 `lines`：原生/好讀列表選單=`buf.lines`(單頁)；好讀文章=`buf.pageLines`
    (累積長頁，`term_view.accumulatePageLines` 純 JS 去重：`resolvePageOverlap`＝狀態列行號為主、`findPageOverlap` 內文為輔，見 `docs/easy-reading.md`)。
  - **黑名單列移除 vs 隱藏由 `enhance.dropHidden` 決定**：好讀文章 `dropHidden=true`→該列不產生節點
    （整列移除、長卷無空行）；原生/列表 `dropHidden=false`→`visibility:hidden`（固定格線只能隱藏不移除）。
    不產生節點 **不位移**其餘列 `data-row`(=pageLines 絕對索引)，故選取/複製跨缺口仍對齊。
  - floor 跨頁：好讀文章 `lines=完整 pageLines`，`computeAnnotations` 每次 `new FloorCounter()` 走完整篇
    → 樓號自然正確（無 view 端持久計數器）。
- 測試讀列：`#mainContainer > span[type="bbsrow"]`(Row 外層) > `div` > `span[data-type="bbsline"]`(連結/徽章在此)。
  讀推文用 `[data-type="bbsline"]` 的 **textContent**（`visibility:hidden` 列 innerText 為空），推文正則需容忍
  徽章數字：`/^(推|噓|→)\d*\s+/`。好讀文章黑名單列不產生節點→DOM 無該列（childCount 下降）。

## 原PO 推文高亮（same-author，只高亮 userid 區塊）
- 推文者 == 原PO id → **只**把 userid 欄位 `[3, 3+len)` 包成 `<span class="commentByAuthor">`（`main.css`
  `#103a5c`）。userid 起始欄 `COMMENT_USERID_COL=3`（marker 2 欄 DBCS + col2 空格；同 floorBadge 假設）。
  char span `b0`(transparent) 透出底色、不蓋 ANSI。
- wrap 在 `LinkSegmentBuilder`（兩路徑共用）：`readChar` 在 `i===authorIdStart` 開 wrap（`_inAuthor=true`、
  segs 改 push 進 `_authorWrap`），`i===authorIdEnd` 收尾包成一個 span；`build()` 對「userid 到行尾」收尾。
  `authorIdStart/End` 任一 undefined→完全跳過。
- 原PO id 由 `view._articleAuthor` 跨頁持久：`redraw` 開頭 `pageState==3` 時 `parseArticleAuthor(lines[0])`，**有值才覆蓋**
  （翻頁 null 沿用上次；新文章首頁覆蓋）。**勿** reset，靠覆蓋即可。
- 逐列判斷由 `annotateComment` 統一（見上）。render 只負責「把回傳值畫出來」：`screen_annotations#computeAnnotations`
  →`ann.authorIdStart/End`→`buildRow` 參數（兩模式同走 `ScreenController`→`buildRow`，無第二條接線）。
- pref `highlightAuthorComments`(true)；`pttchrome.onPrefChange`→`view.*`+`redraw(true)`。i18n `options_highlightAuthorComments`。

## 點選推文者高亮（pusher highlight，整列）
- 左鍵點推文列的**內容文字**（防誤觸模式關閉時＝整列任一處，見 `docs/mouse.md`）→ 高亮該推文者**本篇所有推文列**
  （整列 navy `.pusherHighlight` `#000080`；`#mainContainer>span` 為 block→整行寬）。再點同一人取消、點別人切換。
- 觸發：`pttchrome.mouse_click`（**非** `onMouse_click`——後者只在 mouse browsing 開時跑）。在 `getSelection().isCollapsed`
  分支最前面：`e.target.closest('[data-pusher]')` 命中→`view.togglePusherHighlight(id)`+`preventDefault`+`return`
  （抑制 browsing 導航/leftButtonFunction）。
- **欄位條件（2026-08）**：防誤觸開啟時還要 `clientToPos().col >= data-pusher-col`（該列的內容起始欄，
  `annotateComment.contentCol`）。欄位不合**不 return**，讓下面的左側退出帶接手 —— 整列都攔的話，文章左側
  0-6 欄的「點一下離開文章」在整個推文區永遠點不到（使用者回報）。
- 偵測一律走 DOM（**好讀畫面是重排長卷、不對應 buf 24 列網格**，不能用 `getRowText`；`clientToPos` 的 **col**
  是純幾何、兩模式都可信，**row** 才是被 clamp 的那個）。推文列 `data-pusher`(lower id) 與 `data-pusher-col`
  由 `buildRow` 的外層 span（參數 `pusher`／`pusherContentCol`，來自 `ann.pusher`／`ann.contentCol`）統一掛上，兩模式同。
- 狀態 `view._selectedPusher`（唯一真相）；`togglePusherHighlight` 兩模式同：設 `_selectedPusher`
  + `componentScreen.setSelectedPusher(id)` → renderer 逐列搬 `.pusherHighlight` class，**不重畫**
  （同 `setCursorHighlight` 的快路徑）。build 時的判斷由 `comment_parse.isPusherHighlighted(ann, selected)`
  現算，讀的是 controller 欄位（`update(props)` 從 `enhance.selectedPusher` 同步）而非 annotation。
  - **踩坑（2026-08 修，勿走回頭路）**：原本是 `redraw(true)`，而 `selectedPusher` 進了 `annotationsKey`
    ⇒ 點一下推文列＝整份好讀長頁全量重算（含每個 run 的 `buildMergedCommentChars`）＋每一列節點重建。
    兩個使用者回報的症狀：(1) 每個 `inlinePreviewSlot` 被 `disposeNode` 收掉重建、`pinned=null` ⇒
    `minHeight` 歸零 ⇒ 圖片佔位盒塌陷再非同步撐回來＝**合併推文的空白區閃爍、隱約看到別行推文**；
    (2) 節點抽換落在雙擊的第二個 mousedown 之前 ⇒ **雙擊選字時好時壞**。守護：
    `tests/e2e/offline/pusher_highlight.offline.spec.js`（點擊前替每個 bbsrow 掛 JS expando，點完必須全數存活）
    ＋ `tests/unit/screen_incremental_render.test.js`／`screen_dirty_rows.test.js`／`screen_annotate_cache.test.js`。
- 清除：好讀新文章在 `accumulatePageLines` else（新文章）分支 reset；原生 `redraw` `pageState!==3` 時 reset。
  兩處**只設欄位**（都跑在 `_renderScreenLines` 之前，隨後那次 render 會經 `update()` 同步給 controller，
  再由 `_render()` 收尾的 `_appliedPusher` 對帳補 class）—— 在那裡呼叫 `setSelectedPusher` 只是對即將被
  丟掉的上一幀節點白做一次 O(n)。
- 無 pref/i18n（點擊驅動、恆可用）。

## 連續同作者推文合併（`src/js/comment_merge.js`，2026-08 改版）
- 規則（使用者定案）：**連續同 userid** 的推文列合成一塊（A A A B A A → A B A）；跨型別（推/噓/→）照合
  （PTT 連推自動降 →）；hidden（黑名單）列**透明**（不斷 run、不入 run）；非推文列斷 run；≥2 才合併。
  樓層徽章**只顯示 run 首則**（`floorBadge` 單一樓號）。**FloorCounter／黑名單判定不動**
  ——合併僅 render 層。
- 排版＝**一則一行**，**作者在第一則行首、時間在最後一則行尾且置右**（2026-08 使用者定案）：去掉
  第 2 則起重複的「型別符＋id」前綴與中間各則的時間戳，則間一律插換行 cell（`\n`，Object.create
  繼承來源空格 prototype 的 clone，**勿 mutate 原 buf cell**），末行補上最後一則原列
  **「內容尾 → 時間戳結束」整段**（padding＋可選 IP＋時間）原樣。
  - **置右靠資料不靠 CSS**：run 內必為同 userid ⇒ 各列 `info.start` 相同 ⇒ 合併末行的左緣偏移
    （懸掛縮排）等於原列的 ⇒ 帶著原 padding 就落在**與原生逐列渲染完全相同的欄**（時間 col 67..77，
    整行 78 欄 < 容器 80 欄故不會換行）。勿改成「接在內容尾端」（使用者回報過）或 CSS 絕對定位。
  - 全段**沿用原列 cell** → 配色與原生模式一致、且是一般文字，`^C`（走
    `window.getSelection().toString()`）選得到。**勿改回 React 標籤節點**：舊版 `.mergedCommentTime`
    （淡色縮小＋`user-select:none`）不可複製，使用者已回報要改。
- DOM：`LinkSegmentBuilder` 遇 `\n` cell 就**切一個新的 bbsline span**（`_flushLine`），每個 span 後面
  緊跟該行自己的自動開圖 div——否則整塊的預覽會全部堆到最後（使用者 2026-08 回報）。`\n` 本身不進
  segment，換行改由區塊邊界表達；空的預覽 div 照樣輸出（區塊盒把下一行的 inline 內容擠到新行，
  跟單行路徑同形，不需額外包裝層）。**沒有 `\n` 的一般列走原路徑，DOM 一字不動。**
- 懸掛縮排：`main.css` 給 bbsrow `padding-left: var(--merged-comment-indent)`，首則 bbsline 再以
  **負 `margin-left`** 拉回 0 欄；變數由 `render/screen.js` 依 `contentStart × forceWidth/2` inline 指定。
  **勿用 `text-indent`**——每則各自是 bbsline span，text-indent 會繼承下去把每行都往左拉。
- **勿再加回 gap 門檻**（舊 `BREAK_GAP_COLS`，2026-08 已整組拆除）。舊版猜「這則是不是打滿被截斷的續行」
  並把它與下一則串接；反查 pttbbs 證實此判斷**在畫面上無資訊量**：
  | 來源 | 事實 |
  |---|---|
  | `bbs.c#recommend` | `maxlength = 78 - 3(lead) - 6(date) - 1(space) - 6(time) [- 15 if BRD_IPLOGRECMD/guest] - strlen(myid)` |
  | `comments.c#FormatCommentString` | `type + " " + id + ":" + %-maxlength(msg) + tail` |
  | `vtuikit.c#vgetstring` | 上限 `iend+1 < len`；全形另需 `len - iend >= 3` |
  | term.ptt.cc 實測 | `':'` 後多一格 → 內容欄 `[3+len(id)+2, 66)`（IP 板 `[.., 51)`），時間戳固定 col 67..77 |
  「作者剛好寫滿一句話」與「被輸入欄切斷」完全同形（實例：AI_Art M.1785606011 三連推第 2 則，內容
  50 bytes ＝ 10 字 id 的理論上限），任何寬度門檻都判不出來。唯一還有訊息量的訊號是行尾時間戳
  （真續行幾乎同分鐘送出），但仍是啟發式 → 使用者決定不猜。代價：被截斷的句子分兩行顯示（原生本來就這樣）。
- 純函式：`groupSameAuthorRuns(anns)`（走 computeAnnotations 的 per-row 結果）、`commentContentCells(chars)`
  （cell 邊界 `{start,end,time,timeStart}`：前綴/內容/時間戳/可選 IPv4，全 ASCII 區掃描故無
  DBCS 對映問題）、`buildMergedCommentChars`（回 `{chars,contentStart}`）。
  **fail-safe**：run 中任一列切不出邊界 → 整組還原逐列（寧不合併不錯切）。
- 接線：pref `mergeSameAuthorComments`(true) → `pttchrome.onPrefChange`→`view.*`+`redraw(true)` →
  `term_view` enhance → `screen_annotations#computeAnnotations` 好讀分支：run 首列掛 `mergeCommentRun`
  （合併 chars＋首則 timeLabel＋**對合併 chars 重跑的 detectRowExtras**——原列偵測 col 全失效）、
  其餘列 `mergedIntoComment`（頂層 render null）。i18n `options_mergeSameAuthorComments`（zh/en）。
- 關鍵不變量：合併 chars 的每個 cell **沿用原 TermChar 實例**（分隔空白重用 padding cell）——自造 plain
  object 會剝掉 prototype（`isStartOfURL` 崩潰，pageLines JSON-clone 事故同型）。前綴 `[0, start)` 原樣保留
  → `authorIdStart=3`、data-pusher、右鍵快速加黑名單的 col 數學全部照舊。
- 已知取捨：合併塊內 `getText` col 對映失真（^C 複製走 `window.getSelection().toString()` 不受影響）；
  正文假推文（完整含時間戳 shape）若連續同作者也會被合併（罕見，寧簡）。
- 測試：unit `tests/unit/comment_merge.test.js`（grouping/邊界/一則一行/末則時間＋wettland 十二連推、
  stock-end golden rz2x×7）、`merge_comment_render.test.js`（renderer 接線：分行數、縮排 CSS var、
  作者只在第一行／時間只在最後一行且置右到 col 67／時間戳是一般 cell 不是額外節點）、`row_render.test.js`
  （單一樓號徽章、`\n` 切成多個 bbsline 且文字零遺失、無 `\n` 仍是單一 span）；
  offline `comment_merge.offline.spec.js`（不變量：**相鄰 bbsrow 不得同 data-pusher**；stock-end 指名：
  7→1、徽章 `\d+`、內容零遺失、**7 個 bbsline**、作者/時間位置、**時間可被 getSelection 選取**（守
  user-select 回歸）、**時間戳 x 座標＝同頁原生推文列**（Range 量子字串 rect）、**懸掛縮排幾何**
  （jsdom 無 layout，只能真瀏覽器量）、**自動開圖跟在含連結那一行下面**、關開關還原）。
  依賴逐列斷言的既有 spec（enhance/easy-reading live+offline 樓層連號、pusher 計數）已顯式傳
  `mergeSameAuthorComments:false` 鎖舊行為。**pusher 解析勿用 textContent 正則**（樓號徽章數字會混進
  文字），一律讀 `data-pusher`。

## 自動修復斷掉的 URL（`src/js/url_fix.js`）
作者把 URL 弄壞（插空白／漏 scheme／副檔名被空白斷開）→ 既有 `TermBuf.uriRegEx`（要求 scheme、不容空白）
**完全偵測不到** → 不可點、不自動開圖。本功能**不改寫原文**，偵測後在原文那一列**下方加一行**修復版可點連結；
修復後 URL 是圖/影片且好讀模式開著時，沿用既有 `<ImagePreviewer>` 自動開圖。
- 純邏輯：`detectFixableUrls(text)->[{original,fixed}]`（無 DOM/網路，守護測試 `tests/unit/url_fix.test.js`）。
  策略=**TLD 錨定掃描**（非單一全域 regex，避免中文散文誤判）：host `label(\s*\.\s*label)*\s*\.\s*TLD\b`，
  **最後一段須屬封閉 TLD 允許清單**（主要防誤判閘門；全形句號 `。`U+3002 非 ASCII `.` → 中文句子天然免疫；
  `版本 3.5` 因 `5` 非 TLD 不中）。可選 scheme（容忍 `https : //`）、可選 :port、可選 path。
  - **path 內只容忍「斷開的副檔名」這一個空白**（`name. png`／`name .png`，EXT 清單與 `ImagePreviewer.jsx`
    `RE_IMAGE_EXT/RE_VIDEO_EXT` 對齊）；**禁止**一般「空白+單字」合併（否則 `http://a.com/b here` 會被吃成
    `bhere`，守護見 `url_fix.test.js`）。host/path 字元類純 ASCII → CJK 字自然終止 match。
  - 去重既有有效 URL：候選**在原文中字面**已被 `uriRegEx` verbatim 命中 → 跳過（`https://yahoo.com` 不重複）。
  - **裸網域提及守門**：候選**既無注入空白、又無路徑**→ 跳過（`if(!hasSpace&&!hasPath)continue`）。
    這擋掉 prose 裡的網域提及（如 `※ 發信站: …(ptt.cc)`）被補 scheme 成連結，同時保留**有路徑/檔案的
    scheme-less 深連結**（如 `i.imgur.com/ajHklmb.jpeg` → `https://…`，值得可點＋自動開圖）。**勿改成單一條件**：
    只認空白會誤殺後者、只認路徑會漏判前者（兩個方向都試過）。守護測試 `url_fix.test.js`「發信站 line」
    「scheme-less deep link」「imgur 同列去重」。**被這條擋掉的候選改由下節的 `bare_domain.js` 承接**
    （原位連結、不加行），本節不再放寬。
  - 重建 fixed=移除所有 ASCII 空白（真 URL 不含空白）；無 scheme 則前置 `https://`（既有 scheme 不改寫）。
  - **`gray` 旗標＝無 scheme 且無 path**（修復理由只有「注入空白」，產物是首頁連結）。這一類與英文散文的
    「句號＋句首單字」**完全同形**，因為 `it/in/to/me/us/be/la` 這些 ccTLD 剛好也是英文單字（regex 帶 `i` flag）：
    `...a modern Call of Duty. It does not.` → `Duty. It` → `https://Duty.It`（使用者 2026-08 回報）。
    靠空白位置或大小寫判反而兩邊都誤（已否決）。故 `detectFixableUrls` **只回報旗標不自行過濾**，由消費端決定：
    `screen_annotations#computeAnnotations` 一律套 `applyAiFix` → **AI 關 ⇒ gray 全部不修**，AI 判 `true` 才放行。
    守護 `url_fix.test.js`「句號誤判標成 gray」＋`tests/unit/url_fix_ai_render.test.js`＋
    `tests/e2e/offline/url-fix-gray.offline.spec.js`。
  - 取捨：保守設計，漏冷門 TLD 換取近零誤判。**文章內文的跨列斷開 URL 仍 out of scope**
    （逐列偵測；內文沒有「輸入欄寫滿」這種訊號）；**推文**的跨列斷開由下節的 `url_wrap.js` 承接。
    2026-08 起再加一項：無 scheme 無 path 的斷開裸網域（`www . a .com`）未開 AI 時不修。
- 渲染：`screen_annotations#computeAnnotations` **逐列**（含內文非推文列，獨立於 `annotateComment`）算 `fixedUrls` 掛進 ann →
  `buildRow` 參數 → `link_segment.build()` 在 inline-preview 區塊後產生 `.fixedUrlLine`
  （`render/link_segment.js#fixedUrlLine`：連結錨點＋恆掛一個延遲載入佔位盒，讓 resolver 自判可否開圖）。
  **僅當 `enableLinkInlinePreview`（好讀模式）才渲染**——原生固定 24 列 grid 加行會破壞對齊，故不加，與自動開圖一致。
  CSS `.fixedUrlLine/.fixedUrlLabel`(`main.css`)。守護測試 `tests/unit/row_render.test.js`「列 fixed-URL line」。
- pref `enableAutoFixUrl`(true)；`pttchrome.onPrefChange`→`view.enableAutoFixUrl`+`redraw(true)`；
  傳入 `enhance.autoFixUrl`。i18n `options_enableAutoFixUrl`。

## 跨行推文連結接合（`src/js/url_wrap.js`）
推文輸入欄有固定寬度上限，長網址會被硬切成兩則連續推文（使用者 2026-08 回報）：
```
→ pttuser : ...DeepMind員工 https://i.imgur.c  08/09 15:35
→ pttuser : om/Pn3XurX.jpeg                    08/09 15:35
```
兩層偵測都逐列做 ⇒ 都失效：`uriRegEx` 只看到殘段 `https://i.imgur.c`（渲染成一個 404 連結），
`url_fix` 逐列也拼不回來。**只有「連續同作者推文合併」塊做得到**——它已經把同一位作者的連續推文
重組成含 `\n` cell 的 `TermChar[]`，接合所需的上下文全在手上。沿用 `url_fix` 的呈現方式：
**不改寫原文**，只在合併塊下方多一行 `↳ 完整網址`（可點＋自動開圖）。

**三個訊號缺一不可**（單一訊號都會誤判）：
1. `breaks[].leftFull`＝左邊那則寫滿內容欄（`comment_merge.commentContentCells` 的 `fieldEnd`，
   依 pttbbs 算式由該列自己的 `timeStart` 推導，見 `docs/pttbbs-screen-protocol.md` §11.1）。
2. 兩則時間戳相差 **≤ 1 分鐘**（被切斷的續推幾乎都在同一分鐘送出；月長一律當 31 天，短月月底
   跨日會多算 ⇒ 判成不接，方向安全）。
3. 斷點兩側**併起來**是合法 URL：host 尾段屬 `url_fix.TLDS`（共用同一份清單）＋（有 scheme 或有 path）。
   無 scheme 又無 path＝`url_fix` 的 `gray` 那一類，直接排除 ⇒ **永遠不需要 AI 閘門**（`gray:false`）。
- **反向守門**：左片段自己就以媒體副檔名收尾（共用 `url_fix` 的 `EXT`，經 `endsWithMediaExt`）
  ⇒ 那是「作者剛好寫滿的完整網址」，不接。
- **這不是把 gap 門檻加回來**（見上面「連續同作者推文合併」的禁令）：那條講的是**中文散文**續行，
  寬度單獨用判不出來；這裡寬度只是必要條件，判別力來自「併起來是不是網址」。散文續行仍不猜。
- 掃描一律走 `TermChar[]` 旗標判 DBCS，**不可只看 `ch`**：Big5 trail byte 可能剛好是 `0x40`（`'@'`）
  這種合法 URL 字元（踩坑 A 同源）。
- 接線：`screen_annotations#computeAnnotations` 的合併塊分支在 `detectRowExtras(merged.chars, …)` 之後，
  以 `fixed` 去重併進 `fixedUrls` → 渲染（`FixedUrlLine`）／`runCache`／`applyAiFix` 全部沿用、零改動。
- 限制：需 `mergeSameAuthorComments` 開啟（預設開）＋好讀模式；中間被別人插一則推文而斷開 run 的不接。
- 「時間戳相差 ≤ 1 分鐘」與「這一格是不是 DBCS 的一半」抽在 `src/js/comment_break.js`
  （與下節的 AID 接合共用同一份判準，守護 `tests/unit/comment_break.test.js`）。
- 守護測試：`tests/unit/url_wrap.test.js`（三訊號逐條＋78 欄整合＋IP 板 `fieldEnd`）、
  `tests/unit/comment_merge.test.js`（`fieldEnd`／`breaks`）、
  `tests/unit/merge_comment_render.test.js`「跨行連結接合」。

## 跨行 AID 接合（`src/js/aid_wrap.js` ＋ `aid_parse.parseBoardSuffix`）
同一個坑、被切斷的東西換成文章代碼。**兩種切法走不同的程式路徑，別混為一談**：

| 切法 | 畫面 | 實作 | 需要三訊號？ |
|---|---|---|---|
| A. 只有看板後綴被切到下一則 | `…可到 #1gU3wwNZ` ／ `(Browsers) 體驗` | `aid_parse.parseBoardSuffix` 的分隔段允許 `[空白?] [換行?] [空白?]` | **否** |
| B. AID 本體 8 碼被切成兩半 | `…說明 #1gU3ww` ／ `NZ (Browsers)` | `aid_wrap.detectWrappedAids` | 是（同 `url_wrap`） |

- **A 為什麼不要 `leftFull`／同分鐘**：使用者 2026-08-27 的錄製檔（`ask-aid-wrap.json`）裡，
  左邊那則收尾還剩 **6 格空白**——要求「寫滿內容欄」會直接漏掉真實案例。而看板 token 本來
  就要 `[0-9A-Za-z_-]{2,}` ＋閉合 `)`，誤判成本只是「跳到不存在的看板」（PTT 自己會擋）。
  這與 `comment_merge` 檔頭「勿再猜散文續行」不衝突：這裡沒有猜續行，只是讓後綴的分隔段
  多認一個換行。
- **B 的三訊號**與 `url_wrap` 完全對稱（`leftFull` ＋ 時間差 ≤ 1 分鐘 ＋ 併起來**恰好** 8 個
  AID 字元）。反向守門：左片段自己已滿 8 碼 ⇒ 逐列 `detectAids` 抓得到，不重複產生；
  `'#'` 前一格是 AID 字元或 `'#'` ⇒ 沿用 `detectAids` 的前綴規則不認。
  兩端任一落在 `term_url_flag` 標記的 URL 內也不接（網址 fragment 與 AIDc 同形）。
- **B 一次接合產出「兩筆」候選（左殘段一筆、右殘段一筆）**，`aid`／`board`／`onClick` 相同。
  理由：`LinkSegmentBuilder.readChar` 在 `'\n'` cell 上**一律收錨並清掉** `_aid`／`_mention`／…
  （那個無條件清空是刻意的，否則 `endCol` 落在換行格時狀態外溢、整塊被畫底線）。分成兩錨
  ⇒ 兩半都有底線、點哪一半都跳同一篇，而 renderer 與「候選範圍不跨換行」這條不變量零改動。
- 接線：`screen_annotations#computeAnnotations` 的合併塊分支，在 `detectWrappedUrls` 那段正
  下方以 `startCol` 去重併進 `aids` → 渲染（`aidLink`）／`runCache` 全部沿用、零改動。
- 限制同 `url_wrap`：需 `mergeSameAuthorComments`（預設開）＋好讀模式；被別人插一則而斷開
  run 的不接；文章**內文**的跨列 AID 仍 out of scope（內文沒有「輸入欄寫滿」這種訊號）。
- 修好之前的症狀（錄製檔整段錄下）：`board` 為 null → 退回目前文章所在看板 → 送出 `sask`
  跳到 ask 板 → `#1gU3wwNZ` 搜不到 → `queue.miss`，跳轉失敗。
- 守護測試：`tests/unit/aid_wrap.test.js`（三訊號逐條＋形狀邊界＋URL fragment）、
  `tests/unit/aid_parse.test.js`「board suffix across a merged-comment newline」、
  `tests/unit/merge_comment_render.test.js`「跨行 AID 接合」、
  `tests/e2e/offline/aid_wrap.offline.spec.js`（真鏈重放使用者現場，含「點下去送出的是
  `sBrowsers` 不是 `sask`」）。

## 裸網域自動連結（`src/js/bare_domain.js` + `url_ai*.js`）
「無 scheme、無路徑、無空白」的網域（`indiegametw.com`、`eaigc.filtergame.com`）：`uriRegEx` 要 scheme 看不見，
`url_fix` 的裸網域提及守門刻意跳過 → 兩層都漏（使用者 2026-08 回報）。本功能專責這塊灰色地帶。

**分層契約（關鍵不變量）**

| 層 | 行為 | pref | 預設 |
|---|---|---|---|
| 規則 `bare_domain.js` | 裸網域**預設連**，三道守則排除提及型 | `enableBareDomainLink` | 開 |
| AI `url_ai.js`（key `url`） | 只能**撤掉**規則已允許的連結（單向收縮），永不新增 | `enableAi && enableBareDomainLink && enableUrlAi` | 關 |
| AI `url_ai.js`（key `urlfix`） | **方向相反**：只能**放行** URL 修復的 gray 候選，永不撤掉非 gray | `enableAi && enableAutoFixUrl && enableUrlAi` | 關 |

→ 裸網域那條：AI 關／不支援／逾時／垃圾回覆 ⇒ 結果恆等於純規則結果。與 `merge-caption-ai-assist` 的零回歸同構，
**方向相反**（那邊 AI 單向擴張、這邊單向收縮）。
→ **URL 修復那條又是相反的**（規則不敢認 → 預設不修，AI 才放行）：同一個檔案裡住著兩組方向相反的 `apply*`，
改動時務必先確認是哪一組。保守側的定義不同——裸網域是「連結留著」，URL 修復是「不要生出假連結」。
`applyAiFix(cands, {}) ≡ cands.filter(c => !c.gray)`；`fixKey` 帶 `fix:` 前綴，與 `domainKey` 不得撞（同一列同一
host 兩邊問的是不同問題）。session key 也分開（`prompt_api.js` 依 key 快取 base session，system prompt 定義任務框架）。

- 偵測 `detectBareDomains(chars, rowText) -> [{startCol,endCol,host,href,gray}]`（守護 `tests/unit/bare_domain.test.js`）。
  **走 `TermChar[]` 而非 `rowToText`**，理由同 `mention_parse`：Big5 trail byte 落在 0x40–0x7E 涵蓋 `A-Za-z`，
  字串掃描會湊出假 label（「中」的 trail byte = `a` → 假的 `a.com`）。TLD 允許清單**從 `url_fix.js` export 的
  `TLDS` 複用**，兩功能不得各持一份。
  - 三道提及守則：①`SYSTEM_LINE_RE` 命中（`※ 發信站/文章網址/編輯/轉錄/引述`、`◆ From:`）→ **整列**不偵測；
    ②候選前後被括號包住（半形 `()`／Big5 全形 `（）`= `a1 5d`/`a1 5e`，UTF-8 charset 下 `cell.ch` 直接是該字元）；
    ③`SYSTEM_HOSTS` 黑名單（`ptt.cc`/`ptt2.cc`/`www.*`）。
  - 重疊排除：run 內任一 cell `isPartOfURL()` 為真（`uriRegEx` 已標，判定走共用的
    `term_url_flag.js#isTermUrlCell`，`aid_parse`／`mention_parse` 同一套）／前後緊鄰 `@`（email）／後接 `/`（深連結歸
    `url_fix`）。`Screen#detectRowExtras` 另比對 `fixedUrls[].original` 含同 host 者剔除。
  - `gray`＝規則沒把握、值得送 AI：`www.` 前綴或 **≥3 段子網域**視為強訊號（`gray:false`，省一次 ~1s 推論）；
    其餘（兩段裸網域，形狀與 `ptt.cc` 型提及相同）`gray:true`。
- 渲染：**原位**（複用 mentions 的 `[startCol,endCol)` open/close 邊界機制）→ `<a className="bareDomainLink">`，
  **不加行、不掛 inline `ImagePreviewer`**（裸網域多半非圖），掛 hover 預覽 handler。因為是 range 不加行，
  **原生 24 列模式也生效**（與 `FixedUrlLine` 的好讀限定不同）。CSS `.bareDomainLink`(`main.css`)。
  守護 `row_render.test.js`「Row bare-domain link」、`tests/e2e/offline/bare-domain-link.offline.spec.js`。
- AI 層：純函式 `url_ai_logic.js`（`buildDomainPrompt`／`domainLinkSchema`＝單一 boolean `link`／`parseLinkReply`／
  `applyAiLink`／`domainKey`／`candNeedsAi`），瀏覽器層 `url_ai.js`。
  **零回歸不變量：`applyAiLink(cands, {}) ≡ cands`**（引用都不換），只有明確 `false` 才 filter 掉。
  `link === null`（逾時／垃圾／不支援）**不寫進 cache** → 連結保留且不被記成永久答案。
  `domainKey` = FNV-1a(host + 整列文字)：同 host 在不同句子答案本就該不同；換文章（`articleId` 變）整包丟掉。
  接線在 `Screen`：`computeAnnotations` 收 `result.domainCands`/`domainCandsSig`（**套判決前**的候選，簽章才不抖），
  effect 依 `[urlAiEnabled, domainCandsSig]` 漸進推論。**無浮動按鈕**——這是壓誤判、不是使用者要切換的排版。
- URL 修復側的對應物（同兩檔、方向相反）：`urlFixSystemPrompt`／`buildBrokenUrlPrompt`／`fixCandNeedsAi`／
  `fixKey`／`applyAiFix`＋`classifyBrokenUrl(s)`（session key `urlfix`）。`Screen` 收 `result.fixCands`/
  `fixCandsSig`，effect 依 `[fixAiEnabled, fixCandsSig]`。`destroyUrlAi()` 兩把 key 一起關。
  注意 `detectRowExtras` 內 **bareDomains 的重疊過濾必須對「未套 `applyAiFix` 的完整 `fixedUrls`」做**，
  否則 AI 撤掉一筆修復會讓原本被壓住的裸網域連結冒出來。
- session 樣板抽在共用的 `src/js/prompt_api.js`（`caption_ai.js` 也改建其上，export 簽名不變）：
  依 key 分別快取 base session（system prompt 決定任務框架，共用會互相帶偏）。模型下載由設定「AI」
  分頁的**總開關**觸發（模型是 per-origin，兩功能只需下載一次），見下「設定」節。

## X(Twitter) @帳號自動連結（`src/js/mention_parse.js`）
內文/推文出現 `@帳號`→做成連 `https://x.com/帳號` 的連結。**存在性驗證目前 OFF**（見下「驗證」）：所有格式合格 `@handle` 一律連結，可能連到不存在帳號。
- **偵測（純邏輯，無 DOM/網路）`detectMentions(chars)->[{startCol,endCol,handle}]`**（守護 `tests/unit/mention_parse.test.js`）。
  規則：`@`+1–15 個 `[A-Za-z0-9_]`；`@` 前須非單詞字元/非 `@`（擋 email `a@b`、`@@`）；後接單詞字元則截斷（16+ 連續→不連）；全數字 `@123` 排除。`endCol` exclusive（同 `authorIdStart/End` 慣例）。
  - **走 `TermChar[]`（cols）而非 `rowToText` 字串**：Big5 DBCS **trail byte 可能=0x40(`@`)**，掃字串會誤判中文內的假 `@`；逐列遇 `isLeadByte` 跳 2 格、只在單 byte ASCII 偵測，回傳的 col 就是 `LinkSegmentBuilder.readChar(ch,i)` 比對的 index。守護有「trail byte 0x40 不誤判」case。
  - **落在既有 URL 內的 `@` 不算提及**（`https://x.com/@jack`、`http://user@host/…`）：走共用的
    `term_url_flag.js#rangeInTermUrl`，理由與 `aid_parse` 同（見「踩坑筆記 A」該條）。
- 渲染：`screen_annotations#computeAnnotations`（`pageState=READING`、非 hidden、非原PO-id 列）`detectMentions`→掛 `ann.mentions`→`buildRow` 參數→`link_segment` 比照 URL href 邊界，在 `[startCol,endCol)` 包 `<a className="xMention" target=_blank rel=noreferrer>`（**不掛內嵌預覽**，與一般 URL 錨點區隔）。CSS `.xMention`(`main.css`) 比照 `.y`(color.css)：橘色 `http.bmp` 底線、文字保留 ANSI 原色，外觀同一般連結。守護 `row_render.test.js`「Row X mention link」。
- pref `enableXMentionLink`(true)；`pttchrome.onPrefChange`→`view.enableXMention`+`redraw(true)`；傳入 `enhance.enableXMention`。i18n `options_enableXMentionLink`。
- **驗證為何 OFF（CONFIRMED 2026-06 實測，外部事實）**：純前端無可行探測法——unavatar 免費版每日僅 25 次（`X-Rate-Limit-Limit:25`）且 `<img>` `onerror` 無法區分 404 與 429 → 限流期會把存在帳號誤標 invalid；直連 x.com 存在/不存在 HTTP **都回 200**（SPA）；官方 API 需付費 bearer 且無瀏覽器 CORS；syndication 端點 ACAO 鎖 `platform.twitter.com`。
  - **唯一可行路＝自建 worker**：server-side 用**一般瀏覽器 UA** `fetch('https://x.com/<handle>')`，存在帳號 HTML `<title>Name (@handle) / X`、不存在 title 空（facebookexternalhit/Twitterbot UA 一律回 404，**勿用**）。worker 回小 JSON＋Cloudflare KV 快取；前端只快取明確「不存在」、429/錯誤不快取。風險：X 對 Cloudflare 出口 IP 可能另眼相待，部署後需實測。

## 設定（`PrefModal.jsx`）
pref keys（`DEFAULT_PREFS`，存 localStorage `pttchrome.pref.v1`）。套用見 `pttchrome.onPrefChange`
（`showFloorNumbers`/`blacklist`→`view.*`+`redraw(true)`）。i18n 鍵在 zh_TW/en_US `options_*`。

**「增強功能」分頁**：`showFloorNumbers`(true)、`mergeSameAuthorComments`(true)、
`highlightAuthorComments`(true)、`enableAutoFixUrl`(true)、`enableXMentionLink`(true)、
`enableBareDomainLink`(true)、`blacklist`/`titleBlacklist`("" 換行)。

**「一般 → 右鍵選單」分頁**：`enableInputHelper`(**false**)、`enableLiveArticleHelper`(**false**)
—— 右鍵選單那兩個小幫手選項的顯示開關。走 `enableImageUpload` 那條最輕的鏈路（`ContextMenu/
index.jsx#onContextMenu` 開選單當下 `readValuesWithDefault()` 現讀，**不進 `onPrefChange`**）。
關掉＝選單不畫該項；Live 文小幫手的 End 鍵 toggle 也跟著失效（那條要先從選單開浮層才會掛上
`onToggleLiveHelperModalState`）。守護 `tests/unit/dropdown_menu_preview.test.jsx`、
`tests/unit/pref_modal_context_menu.test.jsx`、`tests/e2e/offline/article_link_menu.offline.spec.js`。

**「一般 → 游標所在列」分頁區塊**：`cursorRowBrighten`(**true**)、`cursorRowBackground`(**false**)
＝**樣式層**（畫什麼，兩者可同時開）；`keyboardCursorHighlight`(true) 與「滑鼠」分頁的
`mouseBrowsingHighlight`(true) ＝**來源層**（哪一列）；`mouseBrowsingHighlightColor`(2) 只對底色
樣式有意義（底色關掉時色票整排 `aria-disabled`）。提亮＝還原 pttbbs `GRAYOUT_COLORBOLD`（整列
`ESC[1m`，前景提亮一階、背景不動），實作全在 `css/color.css` 的 `.cursorBrighten`。
分層合約與「為什麼底色要開新 key」見 `docs/mouse.md`「游標列標示」，pttbbs 考證見
`docs/pttbbs-screen-protocol.md` §11.4。

**「一般 → 介面」分頁**：`autoHideBlinkCursor`(true) — PTT 自己畫了游標的畫面不再疊閃爍游標。
判定純函式 `comment_parse.js#hasServerCursorMark`（cur_x/cur_y 那格＝游標記號；兩代 `>`/`●` 都認），
依據是 pttbbs `mbbsd/stuff.c#cursor_show` 印完記號會把終端機游標**移回同一格**（`psb.c` 用
`STR_CURSOR "\b"` 同義）。套用鏈：`term_buf.notify`（changed/posChanged 的共同匯流點，每幀一次）
→ `term_view.refreshCursorVisibility` → `_applyCursorVisibility`。
**`_cursorSuppressed` 與列表好讀的 `_cursorHidden` 是兩個獨立來源、OR 合併**——共用一個旗標會讓
`list_session` 的 `showCursor()` 誤清抑制狀態，且 `_cursorHidden` 會讓 `updateCursorPos` 提早 return。
守護：`tests/unit/server_cursor_mark.test.js`、`tests/e2e/offline/blink_cursor.offline.spec.js`
（computed display 才看得到 inline style 疊 `.blink--active` CSS 的最終結果）。

**「自動登入」分頁**（2026-08 從增強功能＋本機設定兩處集中過來）——整條登入流程一頁看完，
內部兩個 fieldset 各自標示同步性質：

| fieldset | pref | 上雲 |
|---|---|---|
| 開關組 | `autoLogin`(false)、`autoLoginDupConn`('N')、`autoLoginSkipWelcome`(true) | 是 |
| 憑證組 | `autoLoginUser`、`autoLoginPassword`、`autoLoginOtpSecret`（皆 `""`） | **否**（`LOCAL_ONLY_PREF_KEYS`） |

- 分開的理由：只看開關組不知道帳密填哪、只看憑證組不知道何時觸發；但兩者同步性質不同，
  合成一個 fieldset 會讓「只存本機」的承諾失真。**「本機設定」分頁仍是 local-only 的預設去處**，
  憑證是唯一例外（流程可讀性優先）。
- 欄位狀態＝**localStorage 當下實際內容**，取自開啟對話框時的 `storedSnapshot`（不可用 `values`，
  那會隨打字變動）。空欄位的 placeholder 明說「已交給密碼管理員保管」——否則使用者會誤判沒存成功。
- 三態說明 `options_autoLoginLocalStatus_{none,pending,plaintext}`（純函式 `localCredentialStatus`）。
- `#autoLoginClearLocalBtn` 只 `setValues` 清三欄，寫入仍走既有的「關閉才落地」路徑。
- **這一頁不可長駐 DOM**：`Tabs.Panel value="autologin"` 內容再包一層
  `navActiveKey === "autologin" &&`（其他分頁維持 Tabs 預設 keepMounted）。它是唯一「長得像
  登入表單」的內容，留在 DOM 會讓瀏覽器密碼管理員在使用者根本沒在看它時就跑自動填入。
- **2FA 密鑰欄禁用 `type="password"`**（實測災情，見踩坑筆記「設定頁的憑證欄位＝瀏覽器眼中的
  登入表單」）。整頁只准有一個真正的密碼欄，且必須標 `autoComplete="new-password"`。

**「連線」分頁**（2026-08 從一般分頁獨立出來）——兩組「開關＋自訂 URL」的代理設定：

| pref | 預設 | 角色 |
|---|---|---|
| `useProxy` | false | BBS 連線走 relay。套用在 `main.jsx` 啟動時（`util.js#proxySiteFromPrefs`），故標「重新整理後生效」 |
| `proxyUrl` | `""` | 裸 host 或完整 `ws(s)telnet://`；**空＝`util.js#DEFAULT_PROXY_HOST`**。容錯全在 `proxySiteFromPrefs` |
| `useImgurProxy` | **true** | imgur 圖片走快取代理（`proxy/imgur-worker`）。預設開：多數人不翻設定，關掉等於功能沒人用；額度計費單位是回源次數，快取命中不計 |
| `imgurProxyUrl` | `""` | 裸 host 或完整 URL；**空＝`imgur_proxy.js#DEFAULT_IMGUR_PROXY_BASE`**。容錯在 `normalizeImgurProxyBase` |

- 兩組形狀相同：Checkbox 當閘門、URL 欄位 `disabled={!閘門}`（值保留）、UI 層零驗證（容錯下放純函式）。
- **預設位址放 `placeholder`，不寫進 pref 值**：欄位空著＝用預設，使用者才能把自訂位址整段刪掉回到預設，而不是刪成「開著卻沒有位址」。說明文字改掛 `description`（原本佔著 placeholder）。回退由兩個純函式各自負責，守在 `proxy_site.test.js` / `imgur_proxy.test.js`。
- imgur 代理的改寫層 `src/js/imgur_proxy.js`：白名單 `^[A-Za-z0-9]{1,12}$` + `jpg|jpeg|png|gif|webp`，**逐字對齊 Worker 的 `RE_ASSET`**；對不上一律回原址 ⇒ 影片、未知副檔名、異常 id 全被同一條規則擋掉（影片送過去會撞 Worker 的 **404**，不是 fail-open 的 302）。
- `imgurCandidates()` 產「代理第一、`i.imgur.com` 墊底」的候選陣列，交給既有的 `FallbackImage`；Worker 掛掉／額度用盡（Error 1027）自動退回現況。候選只有一個時不放 `srcset`，代理關閉時 descriptor 與整合前逐字相同。
- 模組級 config **預設 `enabled:false` 是 fail-safe**，真值由 `onPrefChange` 注入（`setImgurProxyConfig`）；沒接上 pref 的路徑（含 unit 測試）維持直連。
- 型別探測（`imgur_probe.js`）**只有 `.jpg` 那一發走代理**，`.mp4` 硬寫直連——代理擋影片回 404 → `mp4Ok=false` → 影片型動圖被誤判成 `static` → 動圖被靜音。
- 切換**不 redraw**：`requestPreview`（href 為鍵）與 `probeCache`（id 為鍵）都是 module cache，只對之後新解析的連結生效 ⇒ 文案標「重新整理後生效」。
- 隱私：代理由專案方持有，會看到「哪個 IP 在看哪張圖」；**Worker 程式碼不主動寫入任何請求紀錄**
  （Cloudflare 平台層仍有 metrics／`wrangler tail`／Logs 這類站方視角，不在我方保存範圍）。設定 UI 有
  揭露段（`tooltip_imgurProxy`）。**別加上會留存使用者請求的紀錄。**
- 賣點是**「不再卡住」而非「更快」**（median 幾乎不變，max 15.7 s → 1.04 s、stall 0/20）。文案不得宣稱加速。量測見 `docs/imgur-latency-research.md`。
- 守護：`tests/unit/imgur_proxy.test.js`（白名單/候選/config）、`imgur_probe.test.js`（`.jpg` 走代理、`.mp4` 不走）、`imgur_webp_resolver.test.jsx`（代理優先原址墊底、影片不代理）、`pref_modal_connection_tab.test.jsx`（分頁 UI 契約）、`ui_behavior.offline.spec.js`（分頁切換可見性）。

**「AI」分頁**（2026-08 從增強功能分頁獨立出來）——所有裝置端 AI 設定收攏於此：

| pref | 預設 | 角色 |
|---|---|---|
| `enableAi` | false | **總閘門**。勾選＝帶著 user activation 觸發模型下載（`prompt_api.js#ensurePromptApiModel`）；取消勾選＝`destroyPromptApi()` 釋放常駐 session |
| `enableCaptionAi` | false | 好讀圖文並排的 AI 校正配對（`docs/merge-caption-ai-assist.md`） |
| `enableUrlAi` | false | 網址類 AI 複核，**一次管兩個增強功能**：裸網域連結（撤誤連）與 URL 修復的 gray 候選（放行）。依附 `enableBareDomainLink \|\| enableAutoFixUrl`（兩個都關才反灰） |

- **AND 的單一 choke point 在 `term_view.js#_renderScreenLines`**：`captionAiEnabled = enableAi &&
  enableCaptionAi`、`urlAiEnabled = enableAi && enableBareDomainLink && enableUrlAi`、
  `fixAiEnabled = enableAi && enableAutoFixUrl && enableUrlAi`。子功能不各自查總開關。
- 總開關關閉時子選項只是**反灰、值原樣保留**（重開即回到先前組合），不清空。
- **不支援的瀏覽器／裝置：分頁照常顯示、全部反灰＋狀態說明**（`options_aiStatus_*` 五態），
  使用者才知道有這功能與為何不能用。判斷一律以 `availability()` 探測結果為準。
- 補救鈕 `#aiDownloadBtn` **只在 `enableAi=true && availability='downloadable'` 時出現**：prefs 會跨
  裝置同步，換一台機器時勾選那次的 user activation 早就用掉了，沒有別的入口能觸發下載。
- 舊的常駐下載鈕 `#captionAiEnableBtn` 已移除（其職責併入總開關）。`ensureCaptionAiReady`／
  `ensureUrlAiReady` 仍存在但 app 不再呼叫（前者供 `tools/caption-ai-eval.html`）。
- 守護：`tests/unit/pref_modal_ai_tab.test.jsx`（分頁 UI 契約）、`tests/unit/prompt_api_model.test.js`
  （暖機入口不偷下載／建完即毀）、`ui_behavior.offline.spec.js`（分頁切換＋三種 availability 的反灰）、
  `bare-domain-link.offline.spec.js`（總開關關閉時子選項開著也不推論）。

## 自動登入：`src/js/auto_login.js`
`App` constructor `new AutoLogin(this)`；`onConnect` 末尾 `start()`（async fire-and-forget）。**自走
polling**（setTimeout 每 500ms），每 tick 直接從 `buf.getRowText` 讀整頁（**勿用
`#mainContainer.innerText`**：`'change'` 事件在 React re-render **之前** 觸發 → DOM 慢一幀，導致
「要按鍵才動」）。比對提示字串沿用 `tests/e2e/helpers/ptt.js#login` 流程，帳密用 `app.sendData`(Big5)、
空白/Y/N 同。到主功能表即 `stop()`；逾時 90s 自停；reconnect 時 `start()` 重置（`_seq` 防 async 重入）。
守護：`tests/unit/auto_login_logic.test.js`（假 app 驅動 `_tick`：帳號/密碼順序、dup/err one-shot、loose「重複登入」需 `[Y/n]`/`(Y/N)`、主選單 stop、密碼錯誤 stop）；e2e shared 登入 fixture 亦間接走此路徑（需 env PTT_USER/PTT_PASS）。

### 兩階段驗證 2FA / TOTP（`_handleOtp`）
server 端行為以 `3rd_script/pttbbs/mbbsd/mbbsd.c#checkuser_2fa` 為準（**勿從畫面反推**）：
密碼正確後才問，最多 **5 次**；`U_2FA_NEWIP` 模式下 `lasthost` 相同就整段跳過 ⇒
**同一帳號 2FA 提示可能不出現**。TOTP 參數見 `common/sys/2fa.c`：HMAC-SHA1 / 6 位 / 30 秒 /
Base32（PTT 給 10 bytes＝16 字元），server 驗證 `time_window=1`（±30s）。

- 純函式 `src/js/totp.js`：`base32Decode`（**非法字元回 `null` 不可跳過**——`0/1/8/9` 誤植會變成
  「格式看似正確、code 永遠錯」）、`normalizeOtpSecret`（吃純 base32／含空白破折號／整段
  `otpauth://`；用 regex 不用 `new URL()`，otpauth 是 non-special scheme）、`totpCode`（WebCrypto，
  async）、`totpCounter`/`totpRemainingMs`。守 RFC 6238 官方向量。
- **偵測 marker 是 `請輸入兩階段`/`位限時數字`/`位救援碼`，絕不可用 `2FA`**：成功訊息與
  「找不到 2FA 設定檔」自癒訊息都含 `2FA`，會在不需驗證的畫面亂送數字。三個 anchor 分散在
  prompt 頭中尾 ⇒ 80 欄下單處折行仍至少兩個存活（`_readScreen` 以 `\n` 串列會切斷子字串）。
- **後續步驟（dup／err／歡迎畫面／主選單）一律只 gate `_sentPass`，禁止加 `_sentOtp`**，
  否則 NEWIP 直接放行時整條流程卡死。
- **沒有可用密鑰 → `stop()` 且一個鍵都不送**：這是刻意支援的降級用法（不想把密鑰交給密碼
  管理員的人留空即可），不是錯誤處理。送空白會被當錯誤驗證碼、白燒 server 的 5 次額度。
- 重試：需畫面出現 `驗證碼錯誤` 這個明確證據，**且必須跨 30 秒窗**（同窗重算 code 相同，重送必錯）；
  我方最多用 `MAX_OTP_ATTEMPTS=2` 次，其餘留給人手打或 8 位救援碼（救援碼一次性，不自動填）。
- 本窗剩餘 `< OTP_MIN_REMAIN_MS(2s)` 就等下一窗；看到 prompt 才把 deadline 加 `OTP_EXTRA_MS`。
- async 送出用 `_otpPending` 防重入，resolve 後**重驗** `_done`／`_seq`／`connectState`／prompt 還在。
  `_otpPromise` 是測試 seam。
- 守護：`tests/unit/totp.test.js`、`tests/unit/auto_login_2fa.test.js`。

### 憑證儲存（Credential Management API）
密碼**不再長期明文落地 localStorage**（支援的瀏覽器）。解析順序（`_resolveCredential`）：
1. **session cache**（module-level `sessionCred`；PrefModal 存檔經 `onValuesPrefChange` →
   `setSessionCredential` 寫入，reconnect 不重跳 chooser。**合併語意**：只給密鑰也合法）
2. **瀏覽器密碼管理員**：`navigator.credentials.get({password:true, mediation:'optional'})`——
   使用者開啟 auto sign-in 後無聲取回，否則 page load 跳帳號選擇器（取消→走 3）
3. **legacy localStorage 明文**（舊資料、Firefox/Safari 等無 `PasswordCredential` 的 fallback、
   e2e addInitScript 注入路徑）

**密鑰打包（`src/js/credential_pack.js`）**：`PasswordCredential` 只有 id/password，且 `get()` 一次
只回一筆 ⇒ 第二筆 credential 永遠讀不回來，只能把密鑰塞進 password 欄位：

```
pttchrome:v1:<BASE32_SECRET>:<password>      # 密碼永遠在最後
```
解包＝剝前綴後取**第一個** `:` 一刀切（`indexOf`，**不是 `split`**）。密鑰打包前已正規化成
`[A-Z2-7]+`，不含 `:` ⇒ 第一個 `:` 必為分隔符，密碼含幾個 `:` 都不必跳脫。判別子與密鑰放前面是
因為只需找一個邊界（後綴式得從尾巴倒著猜 marker，而密碼是任意 72 字）。**無密鑰就不套信封**
⇒ 非 2FA 使用者的條目維持可讀、舊版 build 也讀得懂。畸形信封一律回 legacy 語意（整串當密碼）。

寫入端（`PrefModal` → `pref_credential.js#credentialToStore`）：帳密齊全且支援 API →
`credentials.store(new PasswordCredential({ password: packCredential(...) }))` 觸發瀏覽器
「儲存／更新密碼？」提示。**localStorage 照原樣寫入，不再提早剝除**（2026-08 修）：
`store()` 的 promise resolve **早於**使用者回答提示，舊版立刻把 `autoLoginPassword` 清成 `""`，
使用者按「不儲存」就兩邊都沒了，且與 `_maybeMigrate` 刻意不清的設計自相矛盾。只填密鑰沒填
密碼 → 回 `null`（組不出 credential），改由下面的 `needsStore` 補完。

遷移（自我修復、不弄丟憑證）：`_maybeMigrate()` 在到主選單時觸發，條件 `_usedLegacy || _needsStore`
（**此時不清明文**：store resolve ≠ 使用者按了儲存）；之後某次 `get()` 真取回 → 才
`clearLegacyAutoLoginCredential()` 清掉 prefs 明文**帳號+密碼**。
**密鑰的清除條件不同**：只有解包真的拿到密鑰（`clearSecret`）才清——PM 回來若是尚未 repack 的
裸密碼，密鑰只存在本機一份，跟著清會永久遺失；這種情況設 `needsStore=true`，下次登入成功後
重新 `store()` 打包版，再下次 `get()` 取回才清。這條也是「舊使用者只補填密鑰」的主要升級路徑。
連動：`autoLoginUser`／`autoLoginOtpSecret` 皆 local-only（不上雲，見
`docs/pref-sync-firestore.md`），否則清空的 `""` 會經雲端洗掉其他裝置的資料。
`pref_sync.savePrefs` **不給 `autoLoginOtpSecret` 送 `deleteField()`**：它從第一天就是 local-only，
雲端文件不可能有，加了只是每次上傳多送無用欄位（`autoLoginUser` 需要是因為它曾經上雲）。
密鑰也已列入 `debug_recorder` 的 redact `secrets`（長期憑證，外洩要重設 2FA 才能作廢）。
UI 警語/placeholder 依 `window.PasswordCredential` 切換。需 secure context（localhost/HTTPS）。
守護：`tests/unit/credential_pack.test.js`、`auto_login_credentials.test.js`、
`pref_credential.test.js`、`pref_modal_autologin_tab.test.jsx`。

## 未移植（原腳本失效/越界）
axios/tippy/GM_config/國旗 IP 查詢(外部 osk2.me:9977 已失效)、滑鼠瀏覽友善模式、右鍵搜尋作者選單。

## 踩坑筆記

維護原則：本節只留**對後續 session 有前瞻價值**的內容——(A) 動到相關 code 仍會踩的活躍陷阱；(B) 不可由本專案 code 反推的外部參考。**已修正的 bug 不列敘事**（靠回歸測試 + git 守護），只在仍有可重用教訓時併入 A。引用以標題為準（勿用流水號）。

### A. 活躍陷阱（動到相關 code 前先讀）

- **async/await 已可用**（`vite.config.mjs` `build.target` = 現代桌機瀏覽器）。**勿把 target 降回舊瀏覽器**（歷史教訓，Babel 時代 preset-env 會注入 regenerator → 整包 bundle 載入即炸；現 esbuild/oxc 對過舊 target 直接報錯，仍不要降）。診斷捷徑：Playwright `page.on('pageerror')`。
- **讀「當前畫面文字」用 `buf.getRowText`，勿讀 `#mainContainer.innerText`**。`term_buf.notify` 先 `dispatchEvent('change')` 才 `view.update()` → DOM 慢一幀（下次更新才追上）。← auto-login「要按鍵才動」根因。
- **DOM scraping 容錯**（測試/外部讀畫面）：① `visibility:hidden` 列 `innerText` 回空字串（Chromium）→ 改讀 `textContent`；② floorBadge 插在 bbsline 內污染文字（`推9 userid`）→ 推文正則須容忍 `/^(推|噓|→)\d*\s+/`。app 邏輯讀 buf、複製有 `user-select:none`，皆不受影響。
- **改樓層徽章必須守三個契約**（各有測試守護，破一個就紅）：① 對等寬格線**淨推進 0**（零寬盒 + `position:relative`/`transform` 位移，勿改用 margin/padding 撐位）；② `[data-floor]` 的 `textContent` 仍是純樓號數字（unit/e2e 皆以此讀樓號）；③ `color` 留在 `.floorBadge` 外層（上班模式 `color.css` 以 `.floorBadge` 覆寫壓灰，`ui_behavior.offline.spec.js` 直接探測該 class）。幾何回歸（不侵入 id 欄）只有真瀏覽器量得到 → 守在 `enhance.offline.spec.js`（含合成 4 位數樓號）。
- **打字游標（`#cursor`）的顏色是 inline style，任何「用 CSS 改寫配色」的功能都必須同步它**。`term_view.updateCursorPos` 以 `cursor_color.js#cursorColorForBg(bg, workModeActive)` 設 `bbsCursor.style.color`，原生模式取的是**原生 ANSI 背景的反色**（`term_buf.termInvColors`）→ class 覆寫（`.work-mode-active` 之類）碰不到它，一脫鉤最慘的是 PTT 反白輸入列（b7/b15：推文列/標題列/搜尋列）：游標 `#3F3F3F` 畫在被壓灰的 `#374151` 上，對比 ≈1.0＝隱形。上班模式因此改回傳與 bg 無關的固定淺灰，且 `cursor_color.js#workModeBgColor` 是 `color.css` `.work-mode-active .b*` 的鏡像（**改一邊要改另一邊**，否則對比保證失效）。旗標由 `App.onPrefChange` → `view.setWorkMode` 餵。守護：`tests/unit/cursor_color.test.js`（對比 ≥4.5:1）＋ `ui_behavior.offline.spec.js` 上班模式那條（接線）。
- **打字游標必須跟畫面共用同一個座標系；「對齊」是錯誤的解法（2026-08-21 定案，勿回頭）**。`#cursor` 現在由 `term_view` 建構子建在 **`.main` 裡面**（不在 `index.html`），位置就是 `.main` 的內容座標 `(cur_x*chw, cur_y*chh)` —— 捲動由 `.main` 帶著走、縮放由 `.main` 的 `transform` 一起套、置中／`marginTop`／捲軸讓位的 `+10` 全部自動吸收。**不可以再引入任何 `scrollTop` 或 `scale` 補償**；需要補償就代表它又被搬出 `.main` 了。
  - 前身是掛在 `#BBSWindow`(`position:fixed`) 下、用 `convertMN2XYEx` 的格線公式算絕對座標，於是每個差異都要補一項，補兩輪（cbee3f5、865b828）仍復發。實測出兩條結構性漏洞：**(a) 純捲動不重繪** —— `updateCursorPos` 只由 `term_buf.notify` 驅動，滾輪／`scrollIntoView`／對焦捲動都不產生 buf 更新，補償永遠慢一步，游標停在原地直到下一次按鍵（＝「有時候、非特定文章、重進就好」）；**(b) 縮放模式垂直原點差 `5*(1-scaleY)` px** —— `.main` 實際高 `chh*rows+10`、`transform-origin: center`，而公式的垂直原點用 `chh*rows`，漏掉那 10px；水平方向的 `+10` 剛好在兩式間抵消，所以舊測試只守得住水平。
  - **`.main` 必須有 `position: relative`**（`main.css`）：縮放時 `transform` 本來就會讓它成為 containing block，但未縮放時 `transform` 是 `none`，少了這行游標會退回以 `#BBSWindow` 為基準而全盤錯位。
  - **React 不可以直接 render 進 `.main`**：React 19 在 root container 首次 mount 的 commit 會執行 `container.textContent = ''`（`react-dom-client` 的 HostRoot mutation phase）⇒ 預先放進去的 `#cursor` 第一次 render 就被清光。故 `.main` 內另切 `#screenRoot` 給 React 獨佔，`#cursor` 是它的兄弟。
  - **`#t`（隱藏輸入框／注音候選）刻意留在 `#BBSWindow`**：它 `left:-10000px`，一旦成為 scroller 的子孫，瀏覽器對焦時會把 `.main` 捲過去。它仍走 `convertMN2XYEx`（那是 `convertMN2XYEx` 目前唯一的消費者）。
  - **非格線幀（好讀累積長頁）直接隱藏游標**：畫面第 N 列與格線第 N 列無關，`buf.cur_y` 指不到任何一列。文章內的輸入一律先進 functionMode 鏡像原生 24 列（`easy_reading._onKeyDownProcessUI` 對任何單字元鍵），那是格線幀，所以不影響打字。
  - 守護：`tests/e2e/offline/cursor_shape.offline.spec.js`（8 條：形狀／格內／水平／縮放／functionMode 不可捲／純捲動不脫鉤／`#cursor` 活在 `.main`／長頁隱藏）＋ `tests/unit/server_cursor_mark.test.js`（三個可見性來源 OR 合併）。
- **「pref → 畫面」的鏈路要有測試盯著終點，不能只看到有人賦值就算接上**。實例：`mouseBrowsingHighlightColor`（游標底色）→ `view.highlightBG` 從 fork 改 React 起就是**只寫不讀**——`term_view.js` 初始化一次、`App.onPrefChange` 賦值一次，全 repo 零讀取點，真正上色的是 `LinkSegmentBuilder`/`Row` 硬寫的 `cx({ b2: … })`。使用者選任何顏色畫面永遠是 `#008000`，而且因為 pref 有正確持久化、`redraw(true)` 也有被呼叫，看起來一切正常。2026-08-15 才發現並改成 `cursor_highlight.js#highlightClass(pref)` → `b1..b15`。教訓：新增/搬動任何「設定值影響渲染」的 pref，回歸測試要斷言**渲染輸出**（DOM class/style），不是斷言中間欄位被設到。
- **游標列標示只有一個套用入口 `term_view.applyCursorHighlight`**，決策全在純函式 `src/js/cursor_highlight.js`（`resolveHighlightRow`＝哪一列、`cursorHighlightClasses`＝畫什麼、`highlightColStart`＝從第幾欄畫起）。來源有三種（原生真游標 `buf.cur_y`／列表好讀虛擬游標／滑鼠 hover）、模式判斷靠 `buf.listRenderMode` 與 `pageState`，**勿在 render 分支各自呼叫 Screen 的命令式 API**（舊版只有原生分支呼叫 `setHighlightedRow`，所以列表好讀與 functionMode 的游標永遠沒有底色）。掛載點：redraw 的 if/else 鏈之後（統一一次）、`term_buf.setHighlight`、`updateCursorPos`（涵蓋只有游標動的幀）、pref 變更。
- **傳給 `React.PureComponent` 的 prop 勿在 render 內現生新物件/Promise**。否則 shallow-compare 永遠不等 → PureComponent 形同失效、子樹每次重掛。實例：`ImagePreviewer` 的 `request` 曾每 render `of(href).then(resolveSrcToImageUrl)` 新 Promise → pusherHighlight 重繪時 value 重置、YouTube iframe 卸載重掛**閃爍**（img 有快取無感）；改 `ImagePreviewer.jsx#requestPreview(href)` 以 href memoize（module `Map`），同 href 同參考。核心渲染鏈去 React 化後 `ImagePreviewer` 仍是 React 葉子島，這條照樣成立。守護 `tests/unit/row_render.test.js`「same href → requestPreview 回同一個 Promise」。
- **逐列節點快取只在 `enhance.stableRows` 為真時成立**（好讀累積長頁 `buf.pageLines`，由 `term_view.js` 的 `STABLE_ROWS` 帶）。那裡的列是 `cloneRow` 快照、append 之後永不再被寫，所以「列物件參考相同 ⇒ 內容相同」才成立。**原生 24 列畫面與列表視窗是 `term_buf` 就地改寫的活 buffer**：`buf.lines[y][x].ch = …`，列參考一路不變而內容每幀在變 —— 這兩條路徑加上 `stableRows` 就會一直畫出上一幀的內容。守護 `screen_incremental_render.test.js`「stableRows 沒帶 ⇒ 不套快取」。細節與另一半（逐列節點快取）見 `docs/easy-reading.md`「累積頁的每頁 render 成本必須是 O(新增列)」。
- **自動開圖是延遲載入的（`render/inline_preview_slot.js`）：測試要驗預覽必先捲到，且捲完要等版面靜下來再量座標**。replay/boot 完就 `querySelector('img')` 只會量到空的佔位盒（用 `tests/e2e/helpers/replay.js` 的 `mountLazyPreviewsAt`／`seekInlineMedia`）。更隱蔽的一條：`scrollIntoView()` 之後**立刻**讀 `getBoundingClientRect()` 會拿到過期座標 —— 附近的圖這時才開始掛上、載入完又長高，把目標推走 → 後續 `page.mouse.click(x, y)` 點在別列上（`blacklist_quick_add` 的右鍵選單「查無加入黑名單」就是這樣紅的）。捲動與量測分開，中間等 `scrollHeight` 連續兩輪不變。
- **佔位盒的塌陷補償只能給「真的有媒體」的 slot**（`lazy_media.recordSlotHeight` 的 `hasMedia`）。佔位盒卸載時會把當下高度釘進 `min-height`，本意是防真圖片卸載後內容塌陷、閱讀位置位移；但好讀對**每一個**連結都掛 slot，而每篇文章結尾都有「※ 文章網址: https://www.ptt.cc/bbs/…html」這種**非媒體**連結——它捲到附近只會顯示「讀取中…」指示器（`.previewLoading`，URL 解析中／媒體下載中共用），判定後內容消失。舊碼無條件釘住那 65px ⇒ **每篇文章的推文區前面都多出一塊假空白**，而且非媒體連結永遠不會再長出內容來填它（使用者 2026-08 回報）。判準用 `LAZY_MEDIA_SELECTOR` 查 slot 內有無真媒體元素，**刻意不含** `.previewLoading`／`.previewError`。守護：`tests/unit/lazy_inline_preview.test.js` ＋ `tests/e2e/offline/lazy_preview_blank.offline.spec.js`（素材必須夠長才會觸發卸載，見 `docs/offline-replay-testing.md`「素材選用」）。
- **送鍵（或任何副作用）不可寫在 `console.log` 的字串運算式裡**。`easy_reading._onViewUpdated` 曾寫成 `console.log("send:" + keys + " -> " + this._maybeSendPageDown(keys, false))` —— 哪天把 log 包進 `if (TRACE)` 就會連好讀唯一的翻頁動力一起關掉。每幀日誌現由 `util.js` 的 `TRACE`（= `process.env.DEVELOPER_MODE`）在**呼叫端**包住，dev/e2e 照印、prod 由 bundler 整段消除。
- **逐列加工走單一純函式 `comment_parse.annotateComment`**，勿為某路徑另寫一份（好讀/原生曾各複製一份而發散出 bug）。逐列狀態用每圈新物件 `const ann={}`，**勿用函式作用域 `var`**（JS `var` 不每圈重設 → 非推文列繼承前列 floor/authorId 範圍，畫出整條色塊或樓號溢出到空白/※編輯/內文）。守護 `comment_parse.test.js`。
- **`parseListAuthor` 欄位需實機校準**（cols 17–28 @ C_Chat）；PTT 改版位移會先讓守護測試 `enhance.spec.js` 紅。
- **要算「逐列欄位位置（col）」一律走 `TermChar[]`，勿掃 `rowToText` 後字串**。Big5 DBCS **trail byte 可能=0x40(`@`)**（其他 ASCII 標點同理）→ 掃字串會在中文內誤命中、且 string index ≠ TermChar col（DBCS 佔 2 cols）。逐列遇 `isLeadByte` 跳 2 格、只在單 byte ASCII 比對（同 `rowToText` 走訪）。實例：`mention_parse.detectMentions`（X @帳號），守護有「trail byte 0x40 不誤判」case。
- **額外連結偵測器（`bare_domain`／`aid_parse`／`mention_parse`）一律要排除「已被 `uriRegEx` 標成 URL」的格子**，統一走 `src/js/term_url_flag.js` 的 `isTermUrlCell`／`rangeInTermUrl`（假 cell 沒有 `isPartOfURL` → 回 false，不影響純邏輯測試）。它們是在**同一批 cell** 上再掃一次找主偵測器看不見的形狀，一旦在 URL 內命中，`LinkSegmentBuilder` 就會在那個 col 切開 segment ⇒ 一條網址被拆成好幾個 `<a>`、中段換成別的 href。實例（使用者 2026-08 回報）：`https://…/PttChrome/#Browsers/1gU3wwNZ` 的 `#Browsers` 恰是合法 AIDc 形狀（`#` 前非 AID 字元、8 個 AID 字元、第 9 格非 AID 字元）→ 底線只畫到 `#Browsers`、尾段 `/1gU3wwNZ` 不是連結、滑鼠停在中段狀態列顯示 `…/PttChrome/#`（那是 `.aidLink` 的 `href="#"`）。同型還有 `https://x.com/@jack` 的 `@handle`。守護：`aid_parse.test.js`／`mention_parse.test.js` 的「已被 uriRegEx 標記的 URL 內不產生候選」＋ `tests/e2e/offline/url-fragment-aid.offline.spec.js`（真 uriRegEx 設旗標，unit 只能餵假旗標）。
- **`LinkSegmentBuilder.readChar` 對 `'\n'` 提前 return，範圍型連結的關閉邊界必須在那裡一併清掉**。範圍型（`_mention`/`_aid`/`_giveaway`/`_bareDomain`）靠 `i === endCol` 關閉，而合併推文塊的 `'\n'` 分支走在那些檢查之前 ⇒ `endCol` 落在換行 cell 上時**永遠關不掉**，狀態外溢到後續每一行（整塊被畫底線、href 全是上一行那個連結；使用者 2026-08 回報 `duk.tw`）。`comment_merge` 會剝掉每則的行尾空白，所以「範圍結束＝換行前一格」是**常態不是邊角**。清空要在 `saveSegment()` **之後**（那一段仍須用當下狀態包成 `<a>`）；候選字元類都不含 `'\n'`，故無條件清空安全。守護 `row_render.test.js`「行尾裸網域不得外溢到後續行」。
- **e2e flake 常態**：最新文章常無推文（測樓層/黑名單從 End 往舊文找）；guest 名額滿用 env `PTT_USER/PTT_PASS`；偶發 403/ECONNRESET（PTT 端）。
- **裝置端 AI（`window.LanguageModel`）的存在 ≠ 可用**：Playwright 的 Chromium 有這個 global，但沒有模型。任何「要不要顯示 AI 功能」的判斷一律以 **`availability()` 探測結果**為準，勿用 `typeof window.LanguageModel`——否則會出現一顆按下去每次都 fallback 的假按鈕。中文也**不在** Prompt API 官方支援語言（en/ja/es/de/fr）內，故 `expectedInputs` 一律不傳語言（傳了可能丟 `NotSupportedError`）。見 `docs/merge-caption-ai-assist.md`。
  - **e2e 別斷言 Chromium 的 availability 實際回值**（2026-08 實測）：在真實 origin 下它回的是
    **`'downloadable'`**（不是舊筆記寫的 `'unavailable'`；`about:blank` 下則整個 global 都沒有）。
    這個值會隨 browser 版本漂移 → 要測「不支援／裝置不符」的分支，一律用 `addInitScript` stub
    `window.LanguageModel`（或 `delete` 它）明確驅動，見 `ui_behavior.offline.spec.js` 的 AI 分頁三條。
- **設定頁的憑證欄位＝瀏覽器眼中的登入表單**（2026-08 實測災情）。Chrome 的密碼管理員靠
  版面啟發式判斷，不看你的意圖：只要頁面上有 `<input type="password">`，它就會抓「最近的
  文字輸入」當帳號欄配對。2FA 密鑰欄用 `PasswordInput`（=第二個 password 欄）時，Chrome 抓到的
  是 `autoLoginDupConn` 那顆 Select 的內層 input → 跳出「**使用者名稱：刪除其他連線 (Y)**、
  密碼：<密鑰>」的假儲存提示，並開始自動填入欄位——**那會直接毀掉「欄位空白＝已交給密碼
  管理員」這條說明**（被填滿後使用者以為東西還在本機）。三條規則，動設定頁憑證區前先讀：
  ① 密鑰欄用一般 `TextInput`（它本來就是 PTT 在終端機上明文印出來給人抄的東西，不是密碼）；
  ② 整頁只准有一個真正的 `type="password"`，且標 `autoComplete="new-password"`（Chrome 的
  「這是變更密碼表單，別自動填」標準訊號）；③ 整組欄位只在切到該分頁時才渲染。
  守護：`tests/unit/pref_modal_autologin_tab.test.jsx`「不被瀏覽器密碼管理員誤判成登入表單」。
- **`onValuesPrefChange` 有三個呼叫端，只有設定頁那條可以碰憑證快取**：啟動
  （`main.jsx`）、雲端 snapshot、設定頁存檔（`pref_save.js`，帶 `{ fromPrefModal: true }`）。
  少了這個旗標，啟動時就會把 localStorage 裡**還沒遷移完的明文**塞進 `sessionCred` →
  `_resolveCredential` 第一段直接命中 → `credentials.get()` 永遠不執行 → 明文永遠清不掉。
  症狀很像「清除邏輯壞了」，實際上是快取把它短路了。守護：`pref_save_close.test.js` 與
  `auto_login_credentials.test.js`「只有設定頁編輯能填 session cache」。
- **送機器按鍵前必須確認「這個畫面吃不吃這個鍵」——pmore 的快捷鍵被 `currstat` 綁死**。
  `mbbsd/more.c#pmore_key_handler`：`s`(RET_SELECTBRD) 與 `#`(RET_SELECTAID) 都寫死
  `if (!HasUserPerm(PERM_BASIC) || currstat != READING) break;`。站內信是 `RMAIL` →
  兩鍵都是 DONOTHING，於是 AID 跳文送的 `s<板名>\r` **被 pager 逐鍵當快捷鍵吃掉**
  （`Y`=回信給所有人、`X`/`%`=推文、`T`=改標題、`E`=編輯、`r`/`R`=回信）——不是沒作用，是**誤觸**
  （實錄 `ptt-debug-20260813`：畫面直接跳到另一封信，6s 後才報「切換看板失敗」）。
  三件必須一起記的事實：
  ① **判別式**：pager footer part3 就是 `currstat` 的直接投影
     （`more.c#common_pmore_footer_handler`）——`RMAIL`→「(y)**回信**」、`READING`→「(y)**回應**」、
     其餘→`(h)說明`/`(←q)離開`。純函式 `string_util.parsePagerFooterContext`。
     **推論只能單向**：含「回應」⇒ READING；反向不成立，因為 part3 在寬狀態列下會**整段消失**
     （同檔 `parseStatusRow` 上方註解），所以「沒有回應」只是**不確定**，一律降級走安全路徑。
  ② **退出終點只能是主功能表**：`menu.c:498` 只有 MMENU/TMENU/XMENU 的 `s` 走
     `ReadSelect()`→`do_select()` 真的進板；`board.c:1902`（看板列表／我的最愛／分類看板）的 `s`
     是「搜尋看板」，命中只**移動游標**不進板 → 拿它當終點會靜默失敗。
  ③ **走主功能表就會遇到進板畫面**：`ReadSelect()` 會呼叫 `Read()`，本 session 首次進該板先跑
     `more(notes)` ＋ `pressanykey()`（`bbs.c:4482-4492`）；文章內的 `s`（`more.c:177` 只呼叫
     `Select()`）不會。所以兩條路徑的 expect 不能共用同一套。
  實作在 `src/js/aid_navigation.js`（`_pagerContext` 分流 → `_enqueueEscape` ← 到主功能表 →
  `_enqueueBoardJump(viaMenu)` 化解進板畫面），守護 `tests/unit/aid_navigation.test.js`
  「非 READING context」整個 describe。連帶：退出流程會行經選單，`transitionListSession` 的
  `functionMode`／`suspended` 兩處 `menu` 分支必須有 `if (event.inFlightKind) return stay`，
  否則 `_cleanup()` 的 `queue.flush()` 會把 in-flight 的 AID 指令連根拔掉（onFlushed → 整串失敗）。
- **`_articleBoard` 這類「跨頁沿用」的欄位，要跟它的來源 header 綁成同一次事件**。
  文章 header（`作者 x (y) 看板 Z`）只出現在第一頁，所以必須跨翻頁保留；但**站內信 header 沒有
  「看板」欄位**（該欄只存在於看板文章檔）。舊碼 `if (parsedBoard) this._articleBoard = parsedBoard;`
  分開判斷 ⇒ 信裡沿用**上一篇看板文章**的板名 ⇒ 沒帶後綴的 `#AID` 跳到毫不相干的看板。
  改用 `comment_parse.parseArticleHeader`（回傳 `{author, board}`，非 header 列回 `null`）一次寫入。
- **「回到原本那篇」的座標不能拿 `_selectedNum`，只能拿 `_openedNum`**（AID 返回；兩次 live 誤跳都栽在這）。
  ① 置底（pinned）文根本沒有序號，`_selectedNum` 這時還留著**上一個數字列**的殘值 → 返回時用它跳號，
     開到完全不相干的文章（實測：回 C_Chat 板規變成開了一篇閒聊）。
  ② 列表以**原生**渲染時（functionMode——按一下 `Q` 文章資訊框就會進去），方向鍵是 passthrough，
     server 游標動了而 list session 不知道，`_selectedNum` 停在它最後被告知的那一列。
  所以 `ListSession.currentAnchor()` 只認 `_beginOpen` 設的 `_openedNum`（我方序列化開文用的序號），
  並在 `_enterFunctionMode`／`_cleanup`／`noteLeftPost` 清掉。`_boardName` 則相反：原生插曲會清掉它
  且回列表時不重新 seed，所以允許為 null，由 `nav_history.chooseAnchor` 用 `view._articleBoard` 遞補。
  守護：`tests/unit/list_session.test.js`「currentAnchor」describe。
- **`\f` 關不掉任何「按任意鍵」——它根本不是一個「鍵」**（2026-08-15 live 實錯，AID 返回的
  第 0 步 `Q` 文章資訊框）。`Ctrl('L')` 在 `mbbsd/io.c#system_key_hook:196-203` 就被攔下做
  `redrawwin()` 並回 `KEY_INCOMPLETE`，`vkey()` 對它 `continue`（`io.c:432-434`）⇒ 不會回傳給
  任何 handler。**這正是 `\f` 能當萬用探針的原因，也正是它關不掉 `pressanykey()` 的原因**
  （協定 §6 末條）。
  後果不是「沒作用」而是**整串位移一格**：框沒關 → 下一個字元被拿去關框 → 剩下的字串被
  pager／列表當快捷鍵逐鍵吃掉。實錯：送 `\f` + `sC_Chat\r` ⇒ `s` 關框、`h` 開說明、
  `a` 跳作者下一篇，人直接跑到別篇文章，畫面看起來像「切換看板失敗」。
  **關 pressanykey 一律用空白鍵**（外漏到列表／pager 都只是翻頁），不可用 `←`（外漏會直接
  離板）也不可用 `Q`（`bbs.c:3774` 的特例會切成金錢排序模式）。
  另一半同樣要記：這種「回應以 pressanykey 收尾」的交易一律 `fullRepaint: false`，判定純靠內容。
  守護：`tests/unit/aid_navigation.test.js`「origin AID 錨點」describe 的 REGRESSION 條。
- **AID 導航自己的落地，會觸發一次「使用者離開文章」的通知**。`_begin()` 進 `easyReading` 的
  functionMode，目標文章 settle 時 functionMode 退出走 'leave' 分支 → `leaveCurrentPost()` →
  `aidNavigation.noteLeftPost()`；而 `_enqueueOpen.onDone` **已經先把 `active` 清成 false**，
  所以那個「導航中就略過」的守門擋不住它 → 每次跳完都會把剛 push 的返回層抹掉，返回鈕永遠不出現
  （live 實測 2026-08-13 第一次跑就撞上）。修法是 `_ownedLeave` one-shot，在 `_begin()` 武裝、
  第一次 `noteLeftPost` 消耗掉。守護：`aid_navigation.test.js`「我方落地自己會產生一次 leaveCurrentPost」。
- **可點的 overlay 不能沿用 `flashListHint` 那一族**：它們是 `pointer-events:none`（純提示），
  照抄會做出一顆按不下去的按鈕。返回鈕（`term_view.showBackButton`）要自己的元素 ＋
  `pointer-events:auto`，className 掛 `nomouse_command` 讓 `App.checkClass` 把它排除在終端機區域外
  （否則滑鼠瀏覽開著時，點按鈕會連帶把游標指令送給 PTT），並在 click/mousedown 先 `stopPropagation()`
  （window 上有 capture 階段監聽會把焦點搶回隱藏 input `#t`）。守護：`tests/e2e/offline/aid_back_ui.offline.spec.js`。
- **live e2e 的看板選擇會互相污染**：AID 返回測試要開列表好讀（大量 prefetch）並反覆進出，
  跑在 `C_Chat` 上會改掉該板的 server 游標（`getkeep`）與 `currtitle`，後面用 `C_Chat` 的
  `enhance`／`easy-reading` 測試就會開到別篇文章——症狀是**單獨跑全綠、整包跑必紅**（而且紅的位置每次不同）。
  它也不能跑在 `Test` 板：那裡幾乎只有置底公告，`read.c:404` 的 FIXME 讓置底文的 AID 搜尋失手。
  現用 `movie`。同理，測試若改了 `enableEasyReadingList` 這種 `resetSession` 不會還原的 pref，必須自己在 finally 還原。
- **在測試/工具裡直接餵 cassette 進 `TermBuf` 後讀 `getRowText`，必須先讓事件回圈跑一拍**（unit 用 `vi.advanceTimersByTime(300)`、瀏覽器用 `await sleep(120)`）：`isLeadByte` 只在 buf 的 update pass（notify 30ms + settle 50ms）才標記，沒跑完就讀會拿到**未轉碼的 Big5 位元組**（症狀：整片 `§@ªÌ` 亂碼，看起來像編碼表沒載）。
- **終端機的任何祖先都不可有 `user-select: none`**（issue #22，2026-08 實測）。Firefox 判定
  可選取性是沿 frame 鏈**往上**走、最外層的非 auto 值決定 ⇒ `#BBSWindow { user-select:none }`
  會蓋掉 `.main { user-select:text }`，而且**只壞讀取端、不壞畫面**：拖曳照樣有反白、
  `Range.toString()` 照樣拿得到字、`Selection.isCollapsed` 也是 false，唯獨
  **`Selection.toString()` 回空字串**（它走 document encoder，被判不可選的內容整段跳過）。
  下游全中：選取自動複製寫進空字串、右鍵快速搜尋關鍵字是空的、^C 複製空的。**Chrome 讓子層
  覆寫成功，所以 Chromium e2e 永遠綠**——這類症狀一律先在 Firefox 量
  `getComputedStyle(row).userSelect` 的整條祖先鏈，別往 JS 讀取端追。
  真正不該被選到的節點（`#cursor`、好讀狀態列、樓層徽章）各自宣告 none 即可。
  另附一條同源事實（本次實測**未**構成問題，但改焦點邏輯前要知道）：Firefox 的
  `Element.focus()` 會收合 document selection（Chrome 不會），本 app 的 `setInputAreaFocus`
  各呼叫點都有 `isCollapsed` 守門才沒踩到。
  守護：`tests/e2e/offline/selection.offline.spec.js`（**offline-firefox** project，
  真滑鼠拖曳；程式化 `addRange` 會繞過瀏覽器選取機制 ⇒ Firefox 也會綠，測不到）
  ＋ `tests/unit/css_user_select.test.js`（沒裝 Firefox 也擋得住手滑加回去）。

- **`Alt+字母` 快捷鍵一律用 `e.code` 判斷，不可只比對 `e.key`**（`term_keyboard.js#altRemapCharCode`）：
  macOS 的 Option 是**組字鍵**，`⌥V`/`⌥R`/`⌥T`/`⌥W` 的 `e.key` 是 `√`(U+221A)/`®`/`†`/`∑` 而非字母
  ⇒ 比對 `e.key` 的分支在 Mac 上**靜默全失效**（Ctrl+V 已讓給瀏覽器貼上，`Alt+V` 是送 `^V` 的唯一路，
  於是 Mac 上根本送不出去）。`e.code` 是實體鍵位（`KeyV`），不受 Option 影響。現行順序是
  **key 優先、code 補位**：Win/Linux 的非 QWERTY 佈局仍以實際打出的字母為準，且 `e.code` 缺失
  （合成事件）時不炸。假事件測試只寫 `key:'v'` 測不到這類 bug，必須同時給 Mac 風格的 `key`+`code`
  （`tests/unit/term_keyboard_paste.test.js`）。

### B. BePTT 反編譯（外部參考，不可由本專案 code 反推）

樓層演算法（meta-latch 規則）移植自 BePTT 7.0.9（`tw.ystudio.beptt`，jadx 反編譯確證、使用者實測過行為）。架構：文章閱讀依登入分流——免登入走 www.ptt.cc HTML（AID→URL 在 `Z7/b.java`，okhttp `over18=1`，`div.push` 計樓天然排除假推文）；登入走 telnet 逐頁解析（`I3()` 等變體，grep 錨點 `f3943g1`/`f3959j3`），跨頁去重用近 40 列含色 ring buffer 內容比對。「檢查新推文」= telnet 重進文章（AID+`$$00`）增量解析共用計數器。

**導航／返回（2026-08 反編譯，決定我們**不**走重放路線的依據）**：每個畫面帶一份「從主選單起算、可重放的原始按鍵腳本」`enterStep`（固定前綴 `ESC[D`×10），推進全域 stack `N7/C0683p.java`（就一個 `List<String>`）；返回＝pop 自己那格、把上一格整串重打（`N7/C0632k.java:7821-7824` → `C0654s.run()` 送 `"eeeqq"+腳本+"\f"`）。
- **`/` 搜尋會疊進腳本**：`N7/C0665o.java:2846-2864` `f4258Y += "$$$$/"+關鍵字+"\r\n\f"` 後**取代 stack 頂端那格**（`a` 作者／`Z` 推文數／`Gm`/`Gs` 同模式）⇒ 返回時篩選狀態一起重播。
- **但 AID 跳轉的目標腳本是乾淨的**：`O7/f.java:1350-1393` 產出 `ESC[D×10 s<板>\r\n …#<AID>\r\n`，不帶來源頁任何搜尋條件。
- **重放不可靠，它自己也知道**：落地後比對游標列第 17–29 欄的作者，不符跳 Toast「文章編號可能已改變」（`C0632k.java:1555-1566`／`1403-1413`），作者欄 `-` ⇒「本文已被刪除」——**只是警告，照樣進去**。真正的身分來源是畫面上的「文章代碼(AID):」（`C0632k.java:1579-1593`、`5337-5394`），閱讀紀錄 DB 的 primary key 也是 `<Board>/<AID>`。
- ⇒ 本專案採它信得過的那半（`Q` 讀 AID → `#AID` 定位，見 `docs/easy-reading.md`「返回原文」），不採「重放搜尋＋事後比對作者」。重放另有一個 BePTT 沒解掉的殘留風險：篩選清單本身也會因新文章位移。

要再開反編譯：素材位置、jadx recipe 與三個踩坑見 `docs/easy-reading-list-research.md` §3。
