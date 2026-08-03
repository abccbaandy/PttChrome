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
    「scheme-less deep link」「imgur 同列去重」。
  - 重建 fixed=移除所有 ASCII 空白（真 URL 不含空白）；無 scheme 則前置 `https://`（既有 scheme 不改寫）。
  - 取捨：保守設計，漏冷門 TLD／跨列斷開 URL（逐列偵測，**out of scope**）換取近零誤判。
- 渲染：`Screen#computeAnnotations` **逐列**（含內文非推文列，獨立於 `annotateComment`）算 `fixedUrls` 掛進 ann →
  `<Row>` prop → `LinkSegmentBuilder.build()` 在 inline-preview 區塊後 map 出 `<FixedUrlLine>`
  （`components/Row/FixedUrlLine.jsx`：`<HyperLink>`＋恆掛 `<ImagePreviewer Inline>` 讓 resolver 自判可否開圖）。
  **僅當 `enableLinkInlinePreview`（好讀模式）才渲染**——原生固定 24 列 grid 加行會破壞對齊，故不加，與自動開圖一致。
  CSS `.fixedUrlLine/.fixedUrlLabel`(`main.css`)。守護測試 `tests/unit/row_render.test.jsx`「Row fixed-URL line」。
- pref `enableAutoFixUrl`(true)；`pttchrome.onPrefChange`→`view.enableAutoFixUrl`+`redraw(true)`；
  傳入 `enhance.autoFixUrl`。i18n `options_enableAutoFixUrl`。

## X(Twitter) @帳號自動連結（`src/js/mention_parse.js`）
內文/推文出現 `@帳號`→做成連 `https://x.com/帳號` 的連結。**存在性驗證目前 OFF**（見下「驗證」）：所有格式合格 `@handle` 一律連結，可能連到不存在帳號。
- **偵測（純邏輯，無 DOM/網路）`detectMentions(chars)->[{startCol,endCol,handle}]`**（守護 `tests/unit/mention_parse.test.js`）。
  規則：`@`+1–15 個 `[A-Za-z0-9_]`；`@` 前須非單詞字元/非 `@`（擋 email `a@b`、`@@`）；後接單詞字元則截斷（16+ 連續→不連）；全數字 `@123` 排除。`endCol` exclusive（同 `authorIdStart/End` 慣例）。
  - **走 `TermChar[]`（cols）而非 `rowToText` 字串**：Big5 DBCS **trail byte 可能=0x40(`@`)**，掃字串會誤判中文內的假 `@`；逐列遇 `isLeadByte` 跳 2 格、只在單 byte ASCII 偵測，回傳的 col 就是 `LinkSegmentBuilder.readChar(ch,i)` 比對的 index。守護有「trail byte 0x40 不誤判」case。
- 渲染：`Screen#computeAnnotations`（`pageState=READING`、非 hidden、非原PO-id 列）`detectMentions`→掛 `ann.mentions`→`<Row>` prop→`LinkSegmentBuilder` 比照 URL href 邊界，在 `[startCol,endCol)` 包 `<a className="xMention" target=_blank rel=noreferrer>`（**不掛 `ImagePreviewer`**，與 URL 的 `HyperLink` 區隔）。CSS `.xMention`(`main.css`) 比照 `.y`(color.css)：橘色 `http.bmp` 底線、文字保留 ANSI 原色，外觀同一般連結。守護 `row_render.test.jsx`「Row X mention link」。
- pref `enableXMentionLink`(true)；`pttchrome.onPrefChange`→`view.enableXMention`+`redraw(true)`；傳入 `enhance.enableXMention`。i18n `options_enableXMentionLink`。
- **驗證為何 OFF（CONFIRMED 2026-06 實測，外部事實）**：純前端無可行探測法——unavatar 免費版每日僅 25 次（`X-Rate-Limit-Limit:25`）且 `<img>` `onerror` 無法區分 404 與 429 → 限流期會把存在帳號誤標 invalid；直連 x.com 存在/不存在 HTTP **都回 200**（SPA）；官方 API 需付費 bearer 且無瀏覽器 CORS；syndication 端點 ACAO 鎖 `platform.twitter.com`。
  - **唯一可行路＝自建 worker**：server-side 用**一般瀏覽器 UA** `fetch('https://x.com/<handle>')`，存在帳號 HTML `<title>Name (@handle) / X`、不存在 title 空（facebookexternalhit/Twitterbot UA 一律回 404，**勿用**）。worker 回小 JSON＋Cloudflare KV 快取；前端只快取明確「不存在」、429/錯誤不快取。風險：X 對 Cloudflare 出口 IP 可能另眼相待，部署後需實測。

## 設定（`PrefModal.jsx` 「增強功能」分頁）
pref keys（`DEFAULT_PREFS`，存 localStorage `pttchrome.pref.v1`）：
`showFloorNumbers`(true)、`highlightAuthorComments`(true)、`enableAutoFixUrl`(true)、`enableXMentionLink`(true)、`blacklist`("" 換行)、
`autoLogin`(false)、`autoLoginUser/Password`(""；
**password 在支援 Credential API 的瀏覽器不落地**，見「自動登入」節)、
`autoLoginDupConn`('N')、`autoLoginSkipWelcome`(true)。套用見 `pttchrome.onPrefChange`
（`showFloorNumbers`/`blacklist`→`view.*`+`redraw(true)`）。i18n 鍵在 zh_TW/en_US `options_*`。

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

### B. BePTT 反編譯（外部參考，不可由本專案 code 反推）

樓層演算法（meta-latch 規則）移植自 BePTT 7.0.9（`tw.ystudio.beptt`，jadx 反編譯確證、使用者實測過行為）。架構：文章閱讀依登入分流——免登入走 www.ptt.cc HTML（AID→URL 在 `Z7/b.java`，okhttp `over18=1`，`div.push` 計樓天然排除假推文）；登入走 telnet 逐頁解析（`I3()` 等變體，grep 錨點 `f3943g1`/`f3959j3`），跨頁去重用近 40 列含色 ring buffer 內容比對。「檢查新推文」= telnet 重進文章（AID+`$$00`）增量解析共用計數器。

要再開反編譯：素材位置、jadx recipe 與三個踩坑見 `docs/easy-reading-list-research.md` §3。
