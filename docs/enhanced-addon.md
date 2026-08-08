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
  fail-safe：非 userid→null→不隱藏。`●`(編輯過) 列有全形字位移→fall through（可接受的 under-hide）。
  守護測試：`enhance.spec.js` 「看板列表作者欄位常數仍正確」，PTT 改版位移會先紅。
- `FloorCounter`：`seq`(總樓)、`sub`(該 type 分項)；每篇文章 reset。含 **BePTT meta-latch 規則**
  （`nonComment(text)`，演算法來源見踩坑 B「BePTT 反編譯」）：非推文列在 `※ 發信站/※ 文章網址` latch 前一律歸零計數
  → 內文/簽名檔「帶假時間戳的假推文」拿到的暫時樓號被清掉，真推文從 1 起算。
- `parseBlacklist(str)`→lower-case Set（換行分隔）。
- `parseArticleAuthor(text)`→原PO id(lower)|null，正則 `/^\s*作者\s+([0-9A-Za-z]+)/`。**僅文章首頁首行**（作者列）解析得到；翻頁後 lines[0] 是內文→null。
- **`annotateComment(text, ctx)`→逐列判斷的單一真相**（floor/hidden/pusher/authorId 範圍/pusherHighlight）。
  `ctx={blacklist,showFloorNumbers,floorCounter,highlightAuthor,articleAuthor,selectedPusher}`。**單一渲染路徑
  呼叫它**（`Screen#computeAnnotations`，兩模式共用）；勿為某路徑另寫一份（見踩坑 A「逐列加工走單一純函式」）。
  floor 對黑名單列仍 +1（樓號絕對正確）；hidden 短路其餘高亮。回 null=非推文列。守護測試 `tests/unit/comment_parse.test.js`。

## 渲染整合（單一路徑 `<Screen>`→`<Row>`）
- `<Row>`(`components/Row/index.jsx`) 有 props `floor`/`hidden`。`floor`→`LinkSegmentBuilder.readChar`
  在 **col 2**（marker 與 userid 間的空格）插入 `.floorBadge`（CSS `main.css`：`display:inline-block;
  width:0;vertical-align:super` 小字上標，不位移等寬格線；`user-select:none` 故不污染複製）。
  **定位＝右對齊 userid 起始欄、向左生長**（零寬盒 `left:calc(0.5em/--floor-scale)` 右移 1 欄，內層
  `.floorBadgeNum` 再 `translateX(-100%)`）：1~2 位數落在空隙內，3 位數以上（`floorBadge--wide`，另補
  半透明深底）往 marker 方向溢出 → **作者 id 永不被蓋**。`hidden`→
  外層 bbsrow `visibility:hidden`（保留行高、不破壞固定格線）。樓層計數：黑名單推文 **仍 +1 樓**（先
  `counter.next` 再決定隱藏/移除），故編號維持絕對正確。
- **單一渲染路徑（兩模式都走 `renderScreen`→`Screen.jsx#computeAnnotations`）**：逐列加工只有一處，無法發散。
  `term_view.redraw`/`_renderScreenLines` 傳 `enhance={blacklist,showFloorNumbers,highlightAuthor,
  articleAuthor,selectedPusher,pageState,dropHidden}`。`computeAnnotations`：`pageState==3`→`annotateComment`
  (floor／黑名單 hidden／作者高亮／pusher 高亮)；`pageState==2`→`parseListAuthor`(黑名單 hidden)。
  - 兩模式差別只在傳給 `<Screen>` 的 `lines`：原生/好讀列表選單=`buf.lines`(單頁)；好讀文章=`buf.pageLines`
    (累積長頁，`term_view.accumulatePageLines` 純 JS 去重：`resolvePageOverlap`＝狀態列行號為主、`findPageOverlap` 內文為輔，見 `docs/easy-reading.md`)。
  - **黑名單列移除 vs 隱藏由 `enhance.dropHidden` 決定**：好讀文章 `dropHidden=true`→Screen render `null`
    （整列移除、長卷無空行）；原生/列表 `dropHidden=false`→`visibility:hidden`（固定格線只能隱藏不移除）。
    render `null` **不位移**其餘列 `data-row`(=pageLines 絕對索引)，故選取/複製跨缺口仍對齊。
  - floor 跨頁：好讀文章 `lines=完整 pageLines`，`computeAnnotations` 每次 `new FloorCounter()` 走完整篇
    → 樓號自然正確（無 view 端持久計數器）。
- 測試讀列：`#mainContainer > span[type="bbsrow"]`(Row 外層) > `div` > `span[data-type="bbsline"]`(連結/徽章在此)。
  讀推文用 `[data-type="bbsline"]` 的 **textContent**（`visibility:hidden` 列 innerText 為空），推文正則需容忍
  徽章數字：`/^(推|噓|→)\d*\s+/`。好讀文章黑名單列已 render `null`→DOM 無該列（childCount 下降）。

## 原PO 推文高亮（same-author，只高亮 userid 區塊）
- 推文者 == 原PO id → **只**把 userid 欄位 `[3, 3+len)` 包成 `<span class="commentByAuthor">`（`main.css`
  `#103a5c`）。userid 起始欄 `COMMENT_USERID_COL=3`（marker 2 欄 DBCS + col2 空格；同 floorBadge 假設）。
  char span `b0`(transparent) 透出底色、不蓋 ANSI。
- wrap 在 `LinkSegmentBuilder`（兩路徑共用）：`readChar` 在 `i===authorIdStart` 開 wrap（`_inAuthor=true`、
  segs 改 push 進 `_authorWrap`），`i===authorIdEnd` 收尾包成一個 span；`build()` 對「userid 到行尾」收尾。
  `authorIdStart/End` 任一 undefined→完全跳過。
- 原PO id 由 `view._articleAuthor` 跨頁持久：`redraw` 開頭 `pageState==3` 時 `parseArticleAuthor(lines[0])`，**有值才覆蓋**
  （翻頁 null 沿用上次；新文章首頁覆蓋）。**勿** reset，靠覆蓋即可。
- 逐列判斷由 `annotateComment` 統一（見上）。render 只負責「把回傳值畫出來」：`Screen#computeAnnotations`
  →`ann.authorIdStart/End`→Row props（兩模式同走 `<Screen>`→`<Row>`，無第二條接線）。
- pref `highlightAuthorComments`(true)；`pttchrome.onPrefChange`→`view.*`+`redraw(true)`。i18n `options_highlightAuthorComments`。

## 點選推文者高亮（pusher highlight，整列）
- 左鍵點推文列任一處 → 高亮該推文者**本篇所有推文列**（整列 navy `.pusherHighlight` `#000080`；`#mainContainer>span`
  為 block→整行寬）。再點同一人取消、點別人切換。
- 觸發：`pttchrome.mouse_click`（**非** `onMouse_click`——後者只在 mouse browsing 開時跑）。在 `getSelection().isCollapsed`
  分支最前面：`e.target.closest('[data-pusher]')` 命中→`view.togglePusherHighlight(id)`+`preventDefault`+`return`
  （抑制 browsing 導航/leftButtonFunction）。`useMouseBrowsing` 預設 false。
- 偵測一律走 DOM（**好讀畫面是重排長卷、不對應 buf 24 列網格**，不能用 `clientToPos`/`getRowText`）。推文列
  `data-pusher`(lower id) 由 `<Row>` 外層 span（prop `pusher`，來自 `ann.pusher`）統一掛上，兩模式同。
- 狀態 `view._selectedPusher`（傳入 `annotateComment` ctx）；`togglePusherHighlight` 兩模式同：設 `_selectedPusher`
  + `redraw(true)` → `computeAnnotations` 重算 `ann.pusherHighlight`，`<Screen>` 重繪套 class。（好讀重繪會重入
  `accumulatePageLines` 同畫面，`findPageOverlap` 去重成 no-op append，故無重複列。）
- 清除：好讀新文章在 `accumulatePageLines` else（新文章）分支 reset；原生 `redraw` `pageState!==3` 時 reset。
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
  **負 `margin-left`** 拉回 0 欄；變數由 `Screen.jsx` 依 `contentStart × forceWidth/2` inline 指定。
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
  `term_view` enhance → `Screen#computeAnnotations` 好讀分支：run 首列掛 `mergeCommentRun`
  （合併 chars＋首則 timeLabel＋**對合併 chars 重跑的 detectRowExtras**——原列偵測 col 全失效）、
  其餘列 `mergedIntoComment`（頂層 render null）。i18n `options_mergeSameAuthorComments`（zh/en）。
- 關鍵不變量：合併 chars 的每個 cell **沿用原 TermChar 實例**（分隔空白重用 padding cell）——自造 plain
  object 會剝掉 prototype（`isStartOfURL` 崩潰，pageLines JSON-clone 事故同型）。前綴 `[0, start)` 原樣保留
  → `authorIdStart=3`、data-pusher、右鍵快速加黑名單的 col 數學全部照舊。
- 已知取捨：合併塊內 `getText` col 對映失真（^C 複製走 `window.getSelection().toString()` 不受影響）；
  正文假推文（完整含時間戳 shape）若連續同作者也會被合併（罕見，寧簡）。
- 測試：unit `tests/unit/comment_merge.test.js`（grouping/邊界/一則一行/末則時間＋wettland 十二連推、
  stock-end golden rz2x×7）、`merge_comment_render.test.jsx`（Screen 接線：分行數、縮排 CSS var、
  作者只在第一行／時間只在最後一行且置右到 col 67／非 React 節點）、`row_render.test.jsx`
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
    `Screen#computeAnnotations` 一律套 `applyAiFix` → **AI 關 ⇒ gray 全部不修**，AI 判 `true` 才放行。
    守護 `url_fix.test.js`「句號誤判標成 gray」＋`tests/unit/url_fix_ai_render.test.jsx`＋
    `tests/e2e/offline/url-fix-gray.offline.spec.js`。
  - 取捨：保守設計，漏冷門 TLD／跨列斷開 URL（逐列偵測，**out of scope**）換取近零誤判。
    2026-08 起再加一項：無 scheme 無 path 的斷開裸網域（`www . a .com`）未開 AI 時不修。
- 渲染：`Screen#computeAnnotations` **逐列**（含內文非推文列，獨立於 `annotateComment`）算 `fixedUrls` 掛進 ann →
  `<Row>` prop → `LinkSegmentBuilder.build()` 在 inline-preview 區塊後 map 出 `<FixedUrlLine>`
  （`components/Row/FixedUrlLine.jsx`：`<HyperLink>`＋恆掛 `<ImagePreviewer Inline>` 讓 resolver 自判可否開圖）。
  **僅當 `enableLinkInlinePreview`（好讀模式）才渲染**——原生固定 24 列 grid 加行會破壞對齊，故不加，與自動開圖一致。
  CSS `.fixedUrlLine/.fixedUrlLabel`(`main.css`)。守護測試 `tests/unit/row_render.test.jsx`「Row fixed-URL line」。
- pref `enableAutoFixUrl`(true)；`pttchrome.onPrefChange`→`view.enableAutoFixUrl`+`redraw(true)`；
  傳入 `enhance.autoFixUrl`。i18n `options_enableAutoFixUrl`。

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
  - 重疊排除：run 內任一 cell `isPartOfURL()` 為真（`uriRegEx` 已標）／前後緊鄰 `@`（email）／後接 `/`（深連結歸
    `url_fix`）。`Screen#detectRowExtras` 另比對 `fixedUrls[].original` 含同 host 者剔除。
  - `gray`＝規則沒把握、值得送 AI：`www.` 前綴或 **≥3 段子網域**視為強訊號（`gray:false`，省一次 ~1s 推論）；
    其餘（兩段裸網域，形狀與 `ptt.cc` 型提及相同）`gray:true`。
- 渲染：**原位**（複用 mentions 的 `[startCol,endCol)` open/close 邊界機制）→ `<a className="bareDomainLink">`，
  **不加行、不掛 inline `ImagePreviewer`**（裸網域多半非圖），掛 hover 預覽 handler。因為是 range 不加行，
  **原生 24 列模式也生效**（與 `FixedUrlLine` 的好讀限定不同）。CSS `.bareDomainLink`(`main.css`)。
  守護 `row_render.test.jsx`「Row bare-domain link」、`tests/e2e/offline/bare-domain-link.offline.spec.js`。
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
- 渲染：`Screen#computeAnnotations`（`pageState=READING`、非 hidden、非原PO-id 列）`detectMentions`→掛 `ann.mentions`→`<Row>` prop→`LinkSegmentBuilder` 比照 URL href 邊界，在 `[startCol,endCol)` 包 `<a className="xMention" target=_blank rel=noreferrer>`（**不掛 `ImagePreviewer`**，與 URL 的 `HyperLink` 區隔）。CSS `.xMention`(`main.css`) 比照 `.y`(color.css)：橘色 `http.bmp` 底線、文字保留 ANSI 原色，外觀同一般連結。守護 `row_render.test.jsx`「Row X mention link」。
- pref `enableXMentionLink`(true)；`pttchrome.onPrefChange`→`view.enableXMention`+`redraw(true)`；傳入 `enhance.enableXMention`。i18n `options_enableXMentionLink`。
- **驗證為何 OFF（CONFIRMED 2026-06 實測，外部事實）**：純前端無可行探測法——unavatar 免費版每日僅 25 次（`X-Rate-Limit-Limit:25`）且 `<img>` `onerror` 無法區分 404 與 429 → 限流期會把存在帳號誤標 invalid；直連 x.com 存在/不存在 HTTP **都回 200**（SPA）；官方 API 需付費 bearer 且無瀏覽器 CORS；syndication 端點 ACAO 鎖 `platform.twitter.com`。
  - **唯一可行路＝自建 worker**：server-side 用**一般瀏覽器 UA** `fetch('https://x.com/<handle>')`，存在帳號 HTML `<title>Name (@handle) / X`、不存在 title 空（facebookexternalhit/Twitterbot UA 一律回 404，**勿用**）。worker 回小 JSON＋Cloudflare KV 快取；前端只快取明確「不存在」、429/錯誤不快取。風險：X 對 Cloudflare 出口 IP 可能另眼相待，部署後需實測。

## 設定（`PrefModal.jsx`）
pref keys（`DEFAULT_PREFS`，存 localStorage `pttchrome.pref.v1`）。套用見 `pttchrome.onPrefChange`
（`showFloorNumbers`/`blacklist`→`view.*`+`redraw(true)`）。i18n 鍵在 zh_TW/en_US `options_*`。

**「增強功能」分頁**：`showFloorNumbers`(true)、`mergeSameAuthorComments`(true)、
`highlightAuthorComments`(true)、`enableAutoFixUrl`(true)、`enableXMentionLink`(true)、
`enableBareDomainLink`(true)、`blacklist`/`titleBlacklist`("" 換行)、
`autoLogin`(false)、`autoLoginDupConn`('N')、`autoLoginSkipWelcome`(true)。
（`autoLoginUser/Password` 在「本機設定」分頁——local-only、不上雲；**password 在支援
Credential API 的瀏覽器不落地**，見「自動登入」節。）

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
- 隱私：代理由專案方持有，會看到「哪個 IP 在看哪張圖」；Worker 不留 log，設定 UI 有揭露段（`tooltip_imgurProxy`）。**別加上會留存使用者請求的紀錄。**
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

### 憑證儲存（Credential Management API）
密碼**不再明文落地 localStorage**（支援的瀏覽器）。解析順序（`_resolveCredential`）：
1. **session cache**（module-level `sessionCred`；PrefModal 存檔經 `onValuesPrefChange` →
   `setSessionCredential` 寫入，reconnect 不重跳 chooser）
2. **瀏覽器密碼管理員**：`navigator.credentials.get({password:true, mediation:'optional'})`——
   使用者開啟 auto sign-in 後無聲取回，否則 page load 跳帳號選擇器（取消→走 3）
3. **legacy localStorage 明文**（舊資料、Firefox/Safari 等無 `PasswordCredential` 的 fallback、
   e2e addInitScript 注入路徑）

寫入端（`PrefModal.storeCredentialAndStrip`）：存檔時若支援 API 且帳密齊 →
`credentials.store(new PasswordCredential(...))` 觸發瀏覽器「儲存密碼？」提示，localStorage 只寫
**清空 `autoLoginPassword` 的副本**；`onSave` 仍傳完整 values（in-memory 即時生效）。不支援 → 照舊明文。

遷移（自我修復、不弄丟憑證）：legacy 明文登入成功（到主選單）→ `_maybeMigrate()` 呼叫 `store()`
（**此時不清明文**：store resolve ≠ 使用者按了儲存）；之後某次 `get()` 真取回 → 才
`clearLegacyAutoLoginCredential()` 清掉 prefs 明文**帳號+密碼**（帳號沒密碼也沒用，瀏覽器 store 的
cred.id/cred.password 兩者都供）。連動：`autoLoginUser` 同步改 local-only（不上雲，見
`docs/pref-sync-firestore.md`），否則清空的 `""` 會經雲端洗掉其他裝置的 legacy 帳號。
UI 警語/placeholder 依 `window.PasswordCredential`
切換（i18n `tooltip_autoLogin` / `tooltip_autoLoginPlaintext` / `placeholder_autoLoginPassword`）。
需 secure context（localhost/HTTPS）。

## 未移植（原腳本失效/越界）
axios/tippy/GM_config/國旗 IP 查詢(外部 osk2.me:9977 已失效)、滑鼠瀏覽友善模式、右鍵搜尋作者選單。

## 踩坑筆記

維護原則：本節只留**對後續 session 有前瞻價值**的內容——(A) 動到相關 code 仍會踩的活躍陷阱；(B) 不可由本專案 code 反推的外部參考。**已修正的 bug 不列敘事**（靠回歸測試 + git 守護），只在仍有可重用教訓時併入 A。引用以標題為準（勿用流水號）。

### A. 活躍陷阱（動到相關 code 前先讀）

- **async/await 已可用**（`vite.config.mjs` `build.target` = 現代桌機瀏覽器）。**勿把 target 降回舊瀏覽器**（歷史教訓，Babel 時代 preset-env 會注入 regenerator → 整包 bundle 載入即炸；現 esbuild/oxc 對過舊 target 直接報錯，仍不要降）。診斷捷徑：Playwright `page.on('pageerror')`。
- **讀「當前畫面文字」用 `buf.getRowText`，勿讀 `#mainContainer.innerText`**。`term_buf.notify` 先 `dispatchEvent('change')` 才 `view.update()` → DOM 慢一幀（下次更新才追上）。← auto-login「要按鍵才動」根因。
- **DOM scraping 容錯**（測試/外部讀畫面）：① `visibility:hidden` 列 `innerText` 回空字串（Chromium）→ 改讀 `textContent`；② floorBadge 插在 bbsline 內污染文字（`推9 userid`）→ 推文正則須容忍 `/^(推|噓|→)\d*\s+/`。app 邏輯讀 buf、複製有 `user-select:none`，皆不受影響。
- **改樓層徽章必須守三個契約**（各有測試守護，破一個就紅）：① 對等寬格線**淨推進 0**（零寬盒 + `position:relative`/`transform` 位移，勿改用 margin/padding 撐位）；② `[data-floor]` 的 `textContent` 仍是純樓號數字（unit/e2e 皆以此讀樓號）；③ `color` 留在 `.floorBadge` 外層（上班模式 `color.css` 以 `.floorBadge` 覆寫壓灰，`ui_behavior.offline.spec.js` 直接探測該 class）。幾何回歸（不侵入 id 欄）只有真瀏覽器量得到 → 守在 `enhance.offline.spec.js`（含合成 4 位數樓號）。
- **傳給 `React.PureComponent` 的 prop 勿在 render 內現生新物件/Promise**。否則 shallow-compare 永遠不等 → PureComponent 形同失效、子樹每次重掛。實例：`ImagePreviewer` 的 `request` 曾每 render `of(href).then(resolveSrcToImageUrl)` 新 Promise → pusherHighlight 重繪時 value 重置、YouTube iframe 卸載重掛**閃爍**（img 有快取無感）；改 `ImagePreviewer.jsx#requestPreview(href)` 以 href memoize（module `Map`），同 href 同參考。守護 `tests/unit/row_render.test.jsx`「same href → request prop 參考相等」。
- **逐列加工走單一純函式 `comment_parse.annotateComment`**，勿為某路徑另寫一份（好讀/原生曾各複製一份而發散出 bug）。逐列狀態用每圈新物件 `const ann={}`，**勿用函式作用域 `var`**（JS `var` 不每圈重設 → 非推文列繼承前列 floor/authorId 範圍，畫出整條色塊或樓號溢出到空白/※編輯/內文）。守護 `comment_parse.test.js`。
- **`parseListAuthor` 欄位需實機校準**（cols 17–28 @ C_Chat）；PTT 改版位移會先讓守護測試 `enhance.spec.js` 紅。
- **要算「逐列欄位位置（col）」一律走 `TermChar[]`，勿掃 `rowToText` 後字串**。Big5 DBCS **trail byte 可能=0x40(`@`)**（其他 ASCII 標點同理）→ 掃字串會在中文內誤命中、且 string index ≠ TermChar col（DBCS 佔 2 cols）。逐列遇 `isLeadByte` 跳 2 格、只在單 byte ASCII 比對（同 `rowToText` 走訪）。實例：`mention_parse.detectMentions`（X @帳號），守護有「trail byte 0x40 不誤判」case。
- **e2e flake 常態**：最新文章常無推文（測樓層/黑名單從 End 往舊文找）；guest 名額滿用 env `PTT_USER/PTT_PASS`；偶發 403/ECONNRESET（PTT 端）。
- **裝置端 AI（`window.LanguageModel`）的存在 ≠ 可用**：Playwright 的 Chromium 有這個 global，但沒有模型。任何「要不要顯示 AI 功能」的判斷一律以 **`availability()` 探測結果**為準，勿用 `typeof window.LanguageModel`——否則會出現一顆按下去每次都 fallback 的假按鈕。中文也**不在** Prompt API 官方支援語言（en/ja/es/de/fr）內，故 `expectedInputs` 一律不傳語言（傳了可能丟 `NotSupportedError`）。見 `docs/merge-caption-ai-assist.md`。
  - **e2e 別斷言 Chromium 的 availability 實際回值**（2026-08 實測）：在真實 origin 下它回的是
    **`'downloadable'`**（不是舊筆記寫的 `'unavailable'`；`about:blank` 下則整個 global 都沒有）。
    這個值會隨 browser 版本漂移 → 要測「不支援／裝置不符」的分支，一律用 `addInitScript` stub
    `window.LanguageModel`（或 `delete` 它）明確驅動，見 `ui_behavior.offline.spec.js` 的 AI 分頁三條。
- **在測試/工具裡直接餵 cassette 進 `TermBuf` 後讀 `getRowText`，必須先讓事件回圈跑一拍**（unit 用 `vi.advanceTimersByTime(300)`、瀏覽器用 `await sleep(120)`）：`isLeadByte` 只在 buf 的 update pass（notify 30ms + settle 50ms）才標記，沒跑完就讀會拿到**未轉碼的 Big5 位元組**（症狀：整片 `§@ªÌ` 亂碼，看起來像編碼表沒載）。

### B. BePTT 反編譯（外部參考，不可由本專案 code 反推）

樓層演算法（meta-latch 規則）移植自 BePTT 7.0.9（`tw.ystudio.beptt`，jadx 反編譯確證、使用者實測過行為）。架構：文章閱讀依登入分流——免登入走 www.ptt.cc HTML（AID→URL 在 `Z7/b.java`，okhttp `over18=1`，`div.push` 計樓天然排除假推文）；登入走 telnet 逐頁解析（`I3()` 等變體，grep 錨點 `f3943g1`/`f3959j3`），跨頁去重用近 40 列含色 ring buffer 內容比對。「檢查新推文」= telnet 重進文章（AID+`$$00`）增量解析共用計數器。

要再開反編譯：素材位置、jadx recipe 與三個踩坑見 `docs/easy-reading-list-research.md` §3。
