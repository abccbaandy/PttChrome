# 文章列表好讀模式 — 架構（v5：封閉互動＋確定性交易）

## 核心原則（最高優先，違反＝方向錯誤）

**v5 合約（2026-07-05 拍板，取代舊 parity 合約；論證見 `docs/easy-reading-list-research.md` §1「困難點本質」／§3「BePTT 的穩定性來自哪」）：**

1. **外觀近似**原生（24 列高的畫面＋游標 `>`＋鍵盤習慣近似），**不再承諾**「與原生無可感知差異」。捲動本身自 2026-08-30 起是**瀏覽器原生捲動**（與文章好讀模式同一套），刻意偏離原生的整頁翻。
2. **封閉互動**：白名單＝導覽/開文/跳號/離板；**未列鍵＝一鍵切原生 passthrough＋黏性 hold**（可選 sync 腿 → enter-function-mode → queue 代送原鍵；切原生後停在原生，article/menu 情境切換才恢復好讀）。**不做**氣閘（同鍵二連擊）與 `[ ] =`/`v`/`/` 的模擬交易。
3. **確定性交易**：server 互動一律 CommandQueue 交易；高風險交易尾附 `\f`（Ctrl+L，igetch 全域熱鍵→全幅重繪，協定 §2）→ 必得一幀全幅畫面，timeout 降為真異常。
4. 交易期間 render=frozen＋吞鍵＋讀取中指示。
5. **失敗顯性化**：timeout → 單獨 `\f` 探針拿全幅畫面重分類 → 恢復或 banner＋切原生。禁止靜默墜落。

**勿回頭走 parity**（「與原生完全一致、read.c 逐格對齊」）：「測試全綠 ≠ 實測穩」跨 v3/v4 兩代重現，失敗面積在素材之外，屬結構性成本（論證見 research doc §1）。`list_window.js` 視窗數學保留但允許偏離 read.c（web 慣例優先），`list_window.test.js` 只留行為級守護、不做 read.c lockstep。

## 操作分類（枚舉即合約）

| 類 | 操作 | 處置 |
|---|---|---|
| T0 忽略鍵 | `keyEventToBytes(e) == null` 的鍵：CapsLock／F1–F12／NumLock／ScrollLock／不可映射的 Ctrl+Shift 組合 | `_classifyKey` 回 keyClass `ignore` → 吞掉、**不轉態、不 preventDefault**。判準即「這個鍵交給原生鍵盤路徑會不會送出 byte」，不硬列鍵清單 |
| T1 本地 | ↑↓ jk／PgUp PgDn／Home End（buffer 內）／滾輪；read.c 同義鍵 `空白`＝`N`＝PgDn、`P`＝PgUp、`p`＝↑、`n`＝↓、`$`＝End | 零 server。視窗/游標語意＝web 慣例，不 read.c 逐格對齊（同義鍵集合本身照 read.c:858-902，**Ctrl-F/Ctrl-B 不納入**，維持 Ctrl 組合與瀏覽器快捷鍵的分界）。滑鼠 hover＝上游標底色（`term_view.onListMouseMove`，只對有文章的 body 列；**防誤觸模式開啟時只有標題欄 col≥30 給 pointer 並接受點擊，底色也只蓋那一段**，見 `docs/mouse.md`） |
| T2 列表內交易 | 開文（Enter／**左鍵單擊該列**）、數字跳號、End/Home 邊界確認、`←`/q/e 離板 | 腳本交易（CommandQueue 序列化） |
| T3 一鍵切原生 passthrough | `[` `]` `=`、`v`、`/`、Ctrl-P、`z`、`s`……**其餘一切未列鍵** | 單按即生效：有序號選取且 `_serverNum` 未同步→先 `native-sync-jump`（frozen＋吞鍵）→ `enter-function-mode`（原生 excursion，不變量 15 拋 cache）→ raw 代送原鍵（`native-key` 佇列命令，防 sync 落地 settle 提早 resume）＋提示「已切至原生」。Ctrl 組合/不可映射鍵不代送（事件放行原生鍵盤路徑）。**黏性 hold（`_nativeHold`）**：切原生後 clean-list settle 一律 stay（反覆 [ ] 不閃動/不誤觸 banner），只有 article（開文→文章好讀接手→返回 re-seed）或 menu（離板→重進板 engage）才恢復好讀 |
| T3a 右鍵「前已讀後未讀」 | 右鍵選單項（只在列表好讀、游標下是**有序號**的文章列時出現） | 同 T3 的序列，但 payload 是**兩步**：`v`（expect＝畫面上出現 getdata prompt「…(W)前已讀後未讀…」，**掃整個畫面**，prompt 在 row 22 不是底列）→ 落地後才送 `w\r`。第二步只在第一步的 `onDone` 裡 enqueue —— `v` 沒進 prompt 時 `w` 會落回列表按鍵 `b_call_in`（對該列作者送呼叫器），協定見 `docs/pttbbs-screen-protocol.md` §11.5。`markReadTargetAtRow(renderRow)` 是零副作用的可行性查詢（React 端不重複判斷）；完成後照 T3 停在原生（已讀標記變了＝累積 buffer 過時，返回時走 rebuild）|
| T3b 貼上 | Shift+Insert／右鍵選單「貼上」／中鍵貼上 | 同 T3，但 payload 是整串：`App.onPasteDone` → `ListSession.onPaste(text)`（回 true＝已接手）→ 需要時 `native-sync-jump` → `enter-function-mode` → `native-paste` 佇列命令送出 `ansiHalfColorConv(u2b(normalizePasteText(...)))`。**PTT 收到後完全原生**：不代按 Enter、不特判 AID（`#` 仍要 Enter 才跳且只移游標不開文，協定 §8.1）；貼上內容自帶換行則照送 Enter。交易在途（opening／frozen）吞掉＋提示 |
| T3c 文字輸入（IME） | 中文輸入法組完字送出（compositionend） | 同 T3b，只是**不套 `normalizePasteText`**（那是貼上專屬的換行／折行正規化，IME 送的是剛組完的一段字）、佇列命令 kind 為 `native-input`。入口是 `term_view.onTextInput` 這條共用漏斗 → `ListSession.noteTextInput(text)`（回 true＝已接手）。**按鍵路徑抓不到它**：IME 的 keydown keyCode 是 229，被 `keyEventFilter` 擋在 `onKeyDown` 之外 ⇒ 走不到 `_classifyKey`。見不變量 12d |
| T4 非請自來 | 水球/廣播（server 主動寫入） | 唯一自動切原生路徑：banner 明示（水球專屬措辭）＋停在原生（黏性 hold，article/menu 才恢復好讀） |

pref `enableEasyReadingList`（預設 off）＋`easyReadingListPrefetchCount`（預設 200，0=停背景 fill）
＋`mouseWheelSmoothScroll`（預設 on＝捲動交給瀏覽器；關＝滾輪一次一頁。滑鼠分頁，
見 `docs/mouse.md`）。
三原則：**A 內容判定**（settle 只定何時評估；是什麼靠指紋謂詞，`docs/pttbbs-screen-protocol.md` §3-5）、**B 顯式狀態機**（ListSession 單一擁有者）、**C 命令序列化**（CommandQueue 單一 in-flight；typeahead 跳繪 §2）。誤判永遠往 native 降級（catch-all functionMode）。

## 檔案地圖

| 物件 | 位置 |
|---|---|
| 導覽序列與游標標記（純函式）：`windowVisibleSequence`/`pruneListToSegment`/`labelListCursor`/`LIST_HEADER_ROWS` | `src/js/list_window.js`（unit：`list_window.test.js`）。**read.c 視窗數學已整組退場**（見「視圖模型」） |
| 捲動數學（純函式，零 DOM）：`topPosFromScrollTop`/`anchorScrollTop`/`revealScrollTop`/`revealPlan`/`maxScrollTopFor`/`isRowVisible` | `src/js/list_scroll.js`（unit：`list_scroll.test.js`） |
| 純函式層：`classifyListScreen`/`classifyListBurst`/`transitionListSession`/`mergeListPage`/`flattenListBuffer`/`moveListSelection`/`visibleListIndices`/`parseBoardName`/`evictListBuffer`/`bufferEdgeNum` | `src/js/list_session.js` 上半（unit：`list_session.test.js`） |
| class `ListSession(core,view,termBuf,queue)`：狀態機＋捲動錨（`_topNum`/`_topPinnedKey`/`_scrollFrac`）＋游標（`_selectedNum`）＋demand＋`getListView`／`captureScrollAnchor`／`applyScrollAfterRender`／`onDomScroll` | 同檔下半；`pttchrome.jsx` App constructor 接線 |
| `CommandQueue`（注入 send/timer/onEvent、soft/hard/probe timeout、`expedite`、flush 靜默） | `src/js/command_queue.js` |
| 序號解析：`parseListArticleNum`/`isPinnedListRow`/`recoverCursorArticleNum`/`pageArticleNums` | `src/js/comment_parse.js` |
| settle snapshot | `src/js/term_buf.js` `_armSettleTimer` |
| render：redraw buffer/frozen 分支（`buildListWindowLines`＝header/footer 快取＋`getListView()` 的整段序列＋`>` 游標裝飾）、`accumulateListLines`（merge→evict→prune→flatten→chrome 快取）、`relabelListCursorRow` | `src/js/term_view.js` |
| body 捲動視口（`.listBodyView`）：`_patchRows`／`_ensureBodyView`／`getListScrollTop`／`setListScrollTop`／`scrollListTo`／`getListViewportPx`／scroll listener | `src/render/screen.js`（unit：`render_list_scroll.test.js`） |
| 鍵盤 hook（僅 buffer/frozen；native 全直通）；滾輪：`pttchrome.jsx mouse_scroll` buffer 分支 → **early return 交給瀏覽器**（pref 關才走 `ListSession.onWheel`） | `term_view.js onKeyDown`／`pttchrome.jsx` |
| 測試 | offline `tests/e2e/offline/easy-reading-list.offline.spec.js`（CI gate）；live `tests/e2e/easy-reading-list.spec.js`（soak＝白名單操作輪播，新增白名單操作時同步補站）；素材 `cchat-list-nav/prompt/pinned/mark/search`（**新 `>` 游標世代**，2026-08 重錄）＋ `cchat-list-*-wide`（**舊 `●` 世代**，只被「雙支援」那一條用；勿刪，它是兩代 parser 的唯一真瀏覽器覆蓋） |

## 視圖模型（render 層）

- **畫面＝header 3 列（快取）＋ body 視口（固定 20 列高＝`bodyRows = rows-4`）＋ footer 1 列**。
  body 視口（`.listBodyView`，`src/render/screen.js#_patchRows`）裡放的是**整段過濾後
  序列**（上限 `MAX_LIST_ROWS`≈300 列），`overflow-y:auto` ⇒ **捲動完全交給瀏覽器**，
  與文章好讀模式同一套引擎。header/footer 留在 `#mainContainer` 直系子層（不跟著捲）。
  `mainDisplay.scrollTop=0` 仍維持（`.main` 的內容恰好 24 列高，沒有可捲距離）。
  序列短於 `bodyRows` 時補 blank 列到 20（維持 24 列外觀，且不產生額外可捲距離）。
- **`data-row` ＝ 傳給 `<Screen>` 的 lines index**，所以 footer 的 data-row 是 `3+N`
  （隨序列長度變動，**不再固定 23**）。消費端只有選取複製（`App.doCopyAnsi` 用
  `view._renderedLines` 反查，`term_view._renderScreenLines` 記的那一份）與 golden。
  - **連帶：buffer/frozen 幀的 `srow` 不是 `buf` 的列號**，所以 `#cursor`／`#t` 在這裡
    **沒有可錨的列**。`term_view._rowAnchor` 除了 `_gridRender`（這裡是 true）還要
    `_srowIsBufRow`（這裡是 false，由 `_renderScreenLines` 依
    `cursor_anchor.paintedRowsAreBufRows` 逐列參考比對推導），量不到就退回 `.main`
    可視區左下角＝原生輸入列將出現的位置。少了這道守門，`buf.cur_y` 會反查到
    `.listBodyView` 深處、通常已捲出視野的一列，`#t` 被寫到視窗外（2026-08-31 的
    IME bug，見不變量 12d）。
- **捲動位置＝內容錨**：`(_topNum | _topPinnedKey, _scrollFrac)` ＝ 視口頂端是哪一列、
  那一列被捲掉幾 px。列高恆為 `chh` ⇒ 位置 ↔ scrollTop 是純乘除（`src/js/list_scroll.js`
  的純函式，零 DOM）。每幀順序：`captureScrollAnchor()`（重繪前從 DOM 擷取）→
  `accumulateListLines()`（merge/evict/prune，序列可能整段位移）→ `buildListWindowLines()`
  → render → `applyScrollAfterRender()`（錨 → 新位置 → 寫 scrollTop ＋消費 reveal）。
  frozen 幀走快照、不做上述任何一步（畫面逐像素凍住）。
  錨遺失（那一列被 evict／黑名單／pinned 門控拿掉）的退路三層：錨 → 游標 → 0，
  退到第二/三層時發 `listSession.scrollAnchorLost` 診斷（不變量 7f）。
- **游標與捲動解耦（網頁式語意）**：游標＝行首半形 `>`（`labelListCursor`，只蓋 cell 0
  ＝`%7d` 的前導空格，同 server `STR_CURSOR` 畫法；ASCII 免 u2b；**不反白**——原生
  lightbar 是 `UF_MENU_LIGHTBAR` 旗標非預設）。捲動**不動游標**，游標可以被捲出視野；
  鍵盤導覽移完游標後排一次 reveal 把它帶進視野。舊的「游標被視窗推著走」與
  `normalizeListWindow`（視窗以游標重錨）**已退場**——那條耦合正是 v1–v4 混合模型失敗
  的接縫（research doc §4）。`list_window.js` 只剩 `windowVisibleSequence` /
  `pruneListToSegment` / `labelListCursor`；read.c 的視窗數學（`listCursorPos` /
  `moveListCursorWindow` / `scrollListWindow` / `normalizeListWindow`）整組刪除。
  **兩代游標**：server 自 pttbbs `b9a5029f` 起畫 `>`（舊為全形 `●`，蓋 cells[0,1] 含
  序號最高位）——**讀 server 畫面的 parser 必須雙支援**（cassette 是舊素材，協定 §4），
  我們畫的假游標則一律 `>`。map 內永遠存序號欄正規化過的乾淨列（`relabelListCursorRow`
  依 resolved num 重寫 cells[0,7) 為 `%7d`），游標只畫在 render-time clone。
- 導航空間＝**過濾後序列**：`visibleListIndices`（黑名單）→ `windowVisibleSequence`
  （pinned 門控）。`_sequence()` 有記憶化（O(緩衝列數) 的 rowToText，捲動每幀都要問）。
- **鍵盤語意**（白名單一律零 server、零 byte；serverOp 的邊界判準照抄 read.c:842-880）：

  | 鍵（含同義鍵） | 游標 | 捲動 |
  |---|---|---|
  | `↑` `k` `p` | `cursor-1`；第一列 ∧ `_edgeDown` → wrap 到最後一列；`!_edgeDown` → serverOp `end` | 移動前可見 → `nearest`（**instant**）；不可見 → `center`（smooth） |
  | `↓` `j` `n` | `cursor+1`（到底不 wrap） | 同上 |
  | `PgUp` `P` / `PgDn` `空白` `N` | `視口頂 ∓ bodyRows`，游標落在那裡 | `start`，smooth |
  | `Home` / `End` `$` | 邊已確認 → 0／`len-1`；否則 serverOp | `start` / `end`，smooth |

  **表中的 smooth 只適用單發**：按住／連發時 block 不變、behavior 一律退成 instant（下一條）。

  兩個刻意的決定：**PgUp/PgDn/Home/End 以「視口頂」為基準**（游標在視野外時，先瞬移
  回游標再翻一頁很怪；游標可見時與 read.c 一致）；**↑↓ 的 nearest 一律 instant**。
  政策收斂在 `list_scroll.js#revealPlan` 一支純函式；`prefers-reduced-motion: reduce`
  時一律 instant。
- **連發（按住／連續滾輪刻度）一律 instant**（2026-08-30 第二輪修正）。理由是瀏覽器的
  能力邊界：programmatic 的 `scrollTo({behavior:'smooth'})` **不保留速度** —— 每次呼叫
  都取消上一個動畫、從 ease 曲線的**起點**重新起跑（Blink 的 ProgrammaticScrollAnimator；
  Chrome 自己的鍵盤捲動走 `ScrollAnimator::UpdateTarget`，那個保留速度的 retarget 沒有
  暴露給 web）。於是按住 PgUp/PgDn 時 keydown 約 30/s 比動畫快，目標又一次往前一整頁 ⇒
  **按著只慢慢爬、放開後才快速補捲 1~2 頁**（使用者回報，錄製檔 `ptt-debug-20260830-191557`）。
  判定＝`e.repeat`（OS 自動重複；抓得到初次延遲後的第一發）**或**距上一次導覽 <
  `NAV_BURST_MS`（250ms，補上沒有 repeat 旗標的來源：滾輪一次一頁、貼上的 bytes、
  使用者自己連按）。單發維持 smooth（＝Chrome 的「慢速捲一下」）。
  守護：`list_scroll.test.js`「連發」＋`list_session.test.js`「按住 PgUp」／「連發視窗」
  ＋offline e2e「按住 PgUp（自動重複）」（用 CDP `autoRepeat` 送真 trusted keydown，
  斷言**送完鍵當下**就到位、放開後 scrollTop 不再動）。
- **平滑動畫 × 背景補頁：兩個不同的錨，缺一就回捲**（`_scrollAnim`）。實測每按一次
  PgUp 都會觸發 prefetch，回應約 110ms 後落地，而動畫要 200~400ms ⇒ **必然重疊**
  （錄製檔 `ptt-debug-20260830-175318` / `-175419`）。重疊時要同時做到兩件事：
  1. **補償**：prepend 在上方插入 N 列＝內容整體下移 N 列 ⇒ scrollTop 必須 +N 列才能
     維持視覺連續。這件事靠**視口錨**（`_topNum`，每幀從 DOM 擷取，動畫期間照樣擷取）。
  2. **目標跟著內容走**：動畫的終點是「某一列」，`_scrollAnim` 記的是那一列的**內容
     身分**（序號／pinned key）而不只是 px；序列位移後用 `_animTargetPos` 重算目標 px，
     只有在真的變了才重發 `scrollListTo`（序列沒動 ⇒ 動畫不被打斷）。

  **歷史坑（勿重蹈）**：第一版為了修「PgUp 只捲了幾列就停」而在動畫期間**凍結視口錨**
  （錨＝目標），於是失去「現在顯示哪一列」的資訊、做不了補償 ⇒ 補頁時畫面瞬間往上跳
  過頭，動畫再把它拉回來 —— 那就是使用者回報的**回捲**（黑名單多寡改變過濾後的位移量，
  所以各板強弱不同）。正解是「兩個錨各司其職」，不是凍結。
  逾時逃生門 `SCROLL_ANIM_MAX_MS=1000`（使用者中途自己捲動會取消瀏覽器的動畫，那時
  永遠到不了目標）。目標那一列被 evict／黑名單拿掉 ⇒ 放棄動畫、停在原地。

  **補償寫入只有在真的要補償時才准做**（2026-08-30）：同步寫 `scrollTop` 會取消瀏覽器
  進行中的平滑捲動（`_cancelScroll` 正是靠這個副作用停住畫面的）。`applyScrollAfterRender`
  原本每一幀都無條件寫一次「與現值相同」的值 ⇒ 動畫被殺，而重發條件又是「目標變了才發」
  ⇒ **不重發、動畫永久停擺**（症狀：單按一次 PgUp，中途來一幀重繪就捲到一半停住）。
  現在是 `compensated = |top - 現值| >= 0.5` 才寫，而且**寫過就必定重發**動畫（即使目標
  px 一格沒變）。instant 的 reveal 則相反：上一發的動畫還在飛時**一定要**寫一次把它殺掉，
  否則放開手畫面還會被舊動畫帶走。
  守護：`list_session.test.js`「序列沒位移的幀不得寫 scrollTop」／「補償寫入之後必定重發
  動畫」。注意 unit 的 mock 量不到「寫入＝取消動畫」這個副作用，所以斷言的是
  `setListScrollTop` 的**呼叫次數**，別把它改回單純比對數值。
  翻頁的基準是 `_navTopPos`（動畫在飛時取**動畫終點**，不是中間值），否則連按 PgUp
  的第二次只會從半路再翻一頁、距離不足。
  交易凍結（`_freezeForTransaction`／`_beginOpen`／`_beginOpenPinned`）必須
  `_cancelScroll()`：`overflow:hidden` 不會取消已排定的 `scrollTo({smooth})`。
  補償的另一半在 CSS：`.listBodyView` 的 `overflow-anchor: none` —— 瀏覽器內建的
  scroll anchoring 也會在前置插入時調 scrollTop，兩邊各補一次就是補過頭。
  守護：`list_session.test.js`「平滑捲動 × 背景補頁（回捲的回歸）」六條。
- **邊未確認的大跳走 server**（serverOp）：End→`_requestEnd`（送 `99999999\r`——jump
  超過最大序號 server clamp 到 last_line 含置底，**必有回應**；單發 End 在游標已於底端
  時零回應必 timeout）；Home→`_requestHome`（`1\r`，序號 1 恆存在）。onDone 確認 edge
  → 本地套 End/Home（`_anchorOverride` ＋ reveal）。
- **pinned 門控**：置底列只在 `_edgeDown`（已確認板尾）時進導航序列（native：置底只存在
  last page）→ 舊文區往下讀不會先看到置底文。seed/resume 時畫面含 ★ ⇒ `_edgeDown=true`。
- **缺口 prune**：序號是連續整數，`pruneListToSegment` 在 accumulate（merge→evict 後）
  只留 pivot 所在連續段，視窗永不跨缺口。pivot＝`session.prunePivot()`：平常＝selection；
  End jump 在途＝null（留最大段）；Home jump＝1。**far-jump 必設 `_prunePivotOverride`**，
  否則 prune 會把剛抓到的目標頁丟掉。
- demand：視口頂/底距 buffer 邊 **< 2×bodyRows（兩頁）** 即補（方向性，方向由 scrollTop
  的變化量推導；chain 不跨來源 fill/key）。到邊等待＝右下「讀取中…」指示
  （`view.setListLoading`；prefetch onDone/markEdge 清除）。
  - **捲不動時也要補頁**（`onWheelAtEdge`，`App.mouse_scroll` 在放行給瀏覽器之前呼叫）：
    demand 由 scroll 事件驅動，而 buffer 只有一頁時內容高＝視口高 ⇒ **零可捲距離 ⇒ 沒有
    scroll 事件**，使用者往上滾會看到畫面不動也不補頁（剛進板的常態）。到邊的滾輪本身
    就是「請給我更多」。補進來的舊文接在上方，畫面**刻意不動**（不變量 6），要再滾一次
    才會往上看到它們。守護：`list_session.test.js`「滾輪到邊即請求」＋ live spec 的
    「滾輪原生捲動本地執行」。
- **滑鼠**：座標一律先換成**渲染後**的列號（`clientToPos` 對 body 區用
  `floor((y - bodyTop + scrollTop×scaleY)/rowH)`），再經 `LIST_HEADER_ROWS`（=3）換算
  body index ＝**序列位置**，用 `getListView().seq[idx]` 反查絕對索引。
  - hover → `term_view.onListMouseMove`：只有「body 區且 idx < seq.length（非補列）」才
    上游標底色；`cursor:pointer` 另需 `mouseLeftClick` 且落在可點區（防誤觸開＝標題欄
    col≥30，關＝整列，`mouse_regions.clickableColStart`）—— **底色的範圍與可點區相同、
    條件不同**（底色不看 `mouseLeftClick`），與原生一致。整條路徑受總開關
    `useMouseBrowsing` gate；frozen 一律清掉。**不得走 `term_buf.onMouse_move`**。
  - 左鍵單擊 → `ListSession.onMouseClick(renderRow, col)`：寫回序號錨 → `_forceRedraw`
    → 走鍵盤同一條 reducer（`open`／`open-pinned`）＋ `_beginOpen`。**永遠不得放行到
    `App.onMouse_click`**（那條依 `buf.mouseAction` 與 server 幾何直送
    `\x1b[A`×N+`\r`，座標不對應且繞過 CommandQueue）。非 active／frozen 時吞掉＋提示。
- header/footer 快取：accumulate 時從「像 clean-list 的 live 幀」更新（row0 含《＋row2 含 編號 → header；底列含 文章選讀 → footer）——跳號空底列不會污染 footer 快取。

## 狀態機（reducer＝`transitionListSession`，unit 全枚舉為準）

states：`idle → active ⇄ functionMode`；`active → opening → suspended → active`。
`listRenderMode` 映射：active→buffer、opening→frozen、其餘→native。**例外：passthrough 的 sync 腿與 leave/jump 交易期間 state=functionMode 但 render=frozen**——frozen∧functionMode 時 onKeyDown 吞所有鍵（含淡出提示「指令處理中」——**吞鍵不得無聲**）。

- idle：clean-list ∧ pref ∧ rows==24 ∧ `!buf.startedEasyReading` → active（seed＋start-fill）。engage 守門不用 `view.useEasyReadingMode`（article ER 離篇後仍 latch true）。
- active：clean-list 板名同→continue-fill；異→rebuild；article→suspended；**menu→idle cleanup**（離板可與 in-flight prefetch 的 jump 重繪交錯：jump settle 先把 functionMode 彈回 active，menu settle 若走 catch-all 進 functionMode 會因靜止畫面無下一個 settle 而卡死）；prompt/transient ∧ 無 in-flight→functionMode **＋banner**（失敗顯性化：`isWaterballSettle` 命中（protocol §9 底列 ◆ 指紋）→水球專屬措辭，否則通用「畫面偏離列表」；顯式入口不出 banner——`_enterFunctionMode(facts)` 只在 facts 非 null 時顯示）；有 in-flight→stay。交易 onFail 一律 `_degradeToNative(訊息)`＝banner＋原生鏡像。
- key（active）：nav（↑↓jk/PgUp/PgDn/Home/End → read.c op）；Enter/→＝opening（selectedNum 有值→begin-open；null＝pinned→begin-open-pinned）；數字＝jump-digit（overlay 收參）；`←`/q/e＝leave 交易（**先 sync-jump 同步 server 游標再送離板鍵**——pttbbs getkeep 記 REAL cursor，不 sync 則再進板落點錯；`_serverNum` 快路徑同 passthrough，共用 `_enqueueCursorSyncJump`）；**其餘鍵（含 `[ ] =` `v` `/`）＝keyClass `passthrough` → `_beginNativePassthrough`：一鍵切原生＋代送**（`term_keyboard.keyEventToBytes` 轉 bytes，非 ASCII 單字元 `u2b`）。
- opening：settle 等 article；timeout→functionMode 自癒；期間吞所有鍵。
- functionMode：clean-list→**`nativeHold`（passthrough/自癒/降級 excursion）時 stay 鏡像（黏性）**；無 hold（leave/jump 交易）→active（landedNum∈buffer ∧ 板名同→resume；否則＋rebuild）；article→suspended；menu→idle cleanup。**enter-function-mode（passthrough/自癒/降級——原生 excursion）在 action 層清 `_boardName`** → 回 clean-list 必走 rebuild 分支（不變量 15）；只有保留 `_boardName` 的 frozen 交易（leave/jump）可走純 resume 快路徑；passthrough 屬原生 excursion → 黏性停原生；經 article/menu 回好讀時因 `_boardName` 已清必 rebuild。
- suspended：clean-list→re-seed（resume-buffer：採用落地幀的游標與**視窗頂列**當錨，並設 `_anchorOverride`（不變量 6c）；落點不在緩衝/板名異＋rebuild）；menu→idle。
- 任意：pref-off/斷線→cleanup。

## 關鍵不變量（違反即復發）

1. **零內容 settle 不驅動轉移**：`_onScreenSettled` 開頭 `changedRows.size===0 → return`（本地 `_forceRedraw` 也 re-arm settle）。
2. **`_settleChangedRows` 只在 server 寫入點 add**（統一走 `_touchRows`），不可掛 `lineChangeds`。`needUpdate` 已於 2026-08 去 sticky ⇒ `lineChangeds` 現在**是**真的 dirty 集合，但視窗與語意都不對：它由 `term_view.redraw` 清除（一個 settle 視窗可跨多次 redraw），而且本地強制重繪（`lineChangeds.fill(true)`）會餵它，混進去就是 2b 的「按住 nav 鍵永遠不 settle」。
2b. **settle timer 只由 server 活動 re-arm**（`_serverActivity`：`_touchRows`＋游標 escape 的 posChanged；notify 的 changed 分支 gated）。本地 `_forceRedraw` 不得推遲 pending settle——否則按住 nav 鍵（~30ms 一次重繪）永遠不 settle → queue expect 餓死 → prefetch timeout →「按住 PgUp 無效」＋ markEdge 假邊界（置底文顯示異常的來源）。守護：`settle_gating.test.js`。
3. **跳號回應 settle 底列是空的**（classify=transient 永不 clean-list）→ jump 類 expect 用「park 在 entry 區 col≤1 ∧ 游標列=目標序號」。`_requestEnd` 落點可為置底列（cursorRowNum null 也接受）；**prefetch 向下翻頁腿同理**：真板尾 PgDn 游標落置底列（cursorRowNum null ∧ clean-list）＝`{edge, landed:null}`，不可 miss——miss 的 hard timeout 會讓 \f 探針回應變無主 settle → catch-all 誤降級「畫面偏離列表格式」。向上腿 null 仍 false（置底只在板尾）。另有三道放寬，皆為「板尾/完成幀的無主 settle 不得誤降級」：
   - (a) `classifyListScreen` 板尾短頁規則——編號列 <3 時，若游標列本身是列表形（編號/loose/置底/刪除）∧ entry 區每個非空列都是列表形 → 仍 clean-list（板尾最後一頁可能只剩 1 列編號＋置底＋空白；舊 `●` 游標蓋掉最高位時僅 loose 可讀，新 `>` 游標 strict/loose 同值——**loose 仍須 strip `>`**，否則此規則失效、板尾無主 settle 全數誤降級）。
   - (b) prefetch 翻頁腿 expect 第二道防線——facts 非 clean-list 但 park（entry 區 col≤1）∧ cursorRowNum 相對 base 位移確定 → 照收 moved/edge（null 在 transient 幀不得判 edge，等探針幀）。
   - (c) **consumed 標記**——`queue.onSettle` 回傳 `'done'|'miss'|null`，settle event 帶 `consumed`，active 的 prompt/transient catch-all 對 consumed settle 一律 stay（完成當下 inFlightKind 已 post-account 成 null，板尾 edge 探針幀＝jump-park 後底列空的 transient，會被當無主 settle 誤降級 functionMode＋黏性 hold）。miss 也算 consumed（onFail 自己善後，否則 catch-all double-banner）。
   守護：`list_session.test.js`「板尾短頁」×3、「transient 幀但 park 指紋」、「被完成指令消費的 settle」（真 CommandQueue 全鏈）＋reducer 枚舉 consumed case＋`command_queue.test.js` onSettle 回傳三態。
4. demand 只朝移動方向。
5. pinned map key＝`pinnedRowKey`（author|title）；`_pinnedKeyAt` 必須同函式。游標停置底列（有★）仍收錄、游標格還原空白（`blankListCursorMark`，依 `row[0].isLeadByte` 判 1 格（`>`）或 2 格（`●`））；無★游標列排除。**loose-parse guard**：`parseListArticleNumLoose`（**只 strip 游標標記 `●`/`>` ＋空白、不 strip `★`**，之後有行首數字）非 null 的列永不進 pinned map——mid-response 幀（jump 回應寫入中）游標標記可畫在非 cur_y 列，該列 num 無法回推＋作者欄有效會誤檔成置底，標記未還原永久殘留（●52880 污染 bug）。**不得 strip `★`**：★ 之後緊接推文數欄，常為純整數（`★    4 …`、`★   35 …`——無 m/M/=/+ 標記的公告），strip ★ 會露出推文數→pinned 列被誤判成編號列而排除→該公告固定消失（使用者實測「部分置底文固定消失」）；★ 天生屏蔽推文數（`^(\d+)` 不 match 仍以 ★ 開頭的列）。守護：`comment_parse.test.js`（純數字推文數→null）＋`list_accumulate.test.js`（純數字推文數置底列收錄）。
5b. **frozen 讓位 pageState 3**（redraw list 分支條件 `pageState !== 3`）。
5c. **預讀＝錨定命令對或鏈式單腿**：首次＝jump 到 `bufferEdgeNum(方向)` → PgUp/PgDn；同方向連補＝`_chainState={dir,lastLanded}` 跳過 jump 直送翻頁（moved/edge 判準改以 lastLanded 為基準——PgDn 落新頁**頂**、anchor 在新頁**底**，用 anchor 等值判 edge 會誤判）。**鏈失效點必須齊全**（漏一個＝錯位翻頁）：所有 flush 呼叫點、任何非 prefetch enqueue（End/Home/open/passthrough）、無 in-flight 的 server settle（`_onScreenSettled` 在 `queue.onSettle` **前**檢查）、seed/rebuild/resume/cleanup、markEdge、noteEvicted。錨定失敗 onFail flush。回退開關＝`_chainState` 恆 null。offline 門控支援省略的同位置 jump（replay.js「先餵 jump 回應再餵翻頁」分支）。
6. 選取以序號為身分；pinned 選取以標題 key；**視口頂同理以 `_topNum`／`_topPinnedKey`
   錨定**——prepend/evict 不動畫面（PgUp 不被新文往下擠的機制）。原生捲動下的形式＝
   「重繪前 `captureScrollAnchor` 從 scrollTop 擷取錨、重繪後 `applyScrollAfterRender`
   把錨換算回 scrollTop」，列高恆定所以是一次乘法。守護：`list_session.test.js`
   「錨定還原」（prepend 20 列 ⇒ scrollTop 恰 +20 列；evict 10 列 ⇒ 恰 -10 列；錨遺失
   三層退路）＋ offline e2e「demand 落地後視口第一列的序號不變」。
6b. **evict 的樞紐＝視口，不是選取**（`ListSession.evictPivot()`＝`_topNum`，退路才是
   `_selectedNum`）。游標與捲動解耦後使用者可以把畫面捲到離游標兩百多列外，樞紐若還
   綁著選取，撞到 `MAX_LIST_ROWS` 時被丟掉的正是**眼前那一段**（症狀：列突然消失、
   畫面跳）。**刻意不做「選取那一列一定留著」**：留一列孤島會讓 buffer 不連續，隨後
   的 `pruneListToSegment` 本來就會把它丟掉；選取被淘汰的降級是既有且正確的
   （`_cursorPos` snap 到最近存活列，開文走序號 jump 不依賴 buffer）。守護：
   `list_session.test.js`「evictListBuffer」＋「evictPivot」。
6c. **錨的真相源是 DOM 的 scrollTop —— 但只有 `.listBodyView` 還在 DOM 上時才成立。**
   視口節點是 `ScreenController._bodyView` 上的常駐快取；切到文章／原生鏡像時
   `_patchRows` 把它移出容器（節點還在，只是 detached），而 **detached 節點的
   scrollTop 恆為 0**——那是「沒有資訊」，不是「捲到最上面」。兩道防線：
   - `captureScrollAnchor` 開頭問 `screen.hasListViewport()`，false 就整幀不擷取。
   - 凡是「這一幀的錨由 action 指定」的路徑都要設 `_anchorOverride`：`_requestEnd`／
     `_requestHome`／**`_resumeBuffer`**（退文回列表）。錨的三個欄位
     （`_topNum`/`_topPinnedKey`/`_scrollFrac`）一律一起重設，同 `_seedAnchors`。
   漏掉任一道的症狀＝**退出文章後視野跑掉**：`_resumeBuffer` 剛採用的 server 落點
   被緊接著的 `_forceRedraw` 那一幀覆寫成序列位置 0，畫面跳到緩衝最舊那一列、剛讀
   的文章捲出視野（緩衝只有一頁時 0 剛好正確 ⇒ 症狀「有時候」；錄製檔
   ptt-debug-20260830-221107）。另一半：程式化定位（補償寫入／instant reveal）必須
   同步 `_lastScrollTop`，否則它引發的 scroll 事件會被 `_onScrollFrame` 讀成
   「使用者往下捲」而偷送一次反方向 demand（違反不變量 4）。
   守護：`list_session.test.js`「退文回列表：視野停在 server 落點那一頁」三條＋
   「視口不在 DOM 上（文章期間）→ 完全不動錨」，`render_list_scroll.test.js`
   「hasListViewport()」。**offline e2e 的 cchat-list-nav 卷測不到這條**：它錄的開文
   目標恰好是緩衝最舊一篇 ⇒ 落點頁頂＝序列位置 0，覆寫與否同值。
7. 預讀 timeout＝良性到邊；開文 timeout＝functionMode 自癒；flush 靜默（**flush 不觸發 onFail → `_prunePivotOverride` 要在 flush 出口手動重置**）。timeout 一律只是 **\f 探針觸發器**（`command_queue.js`），非訊號（**勿再引入 RTT 自適應 timeout**）。**交易前導用 `flushPending`（保留 in-flight 配對，序列化排隊）**；全量 `flush` 只准在退原生鏡像路徑（`_enterFunctionMode`/`_handoffArticle`/`_cleanup`）——flush 掉 in-flight 會讓在線回應變無主 settle、提早滿足下一交易的 expect（live race）。prefetch anchor onFail 用 `flushPendingKind('prefetch')`，不誤殺排隊中的交易。
7b. **凍結延遲必須有界**（2026-08「畫面停住、顯示處理中，過一陣子才復原」）。三道，缺一即復發：
   - **`_timedOut` 的探針分支只重新武裝 soft**（`probeTimeoutMs` 預設 2000），**不得 `_armBoth`**——舊碼在探針時重給一份完整 hard ⇒ 單一命令最壞 2×hard（~20s）。hard 是送出當下就定死的絕對截止。上限＝`max(hard, soft+probe)`。
   - **前景交易凍結畫面時要 `queue.expedite(250)` 催 in-flight 的背景 prefetch**（`_expediteBackground`，只對 `kind` 以 `prefetch` 開頭者；`_freezeForTransaction`/`_beginOpen`/`_beginOpenPinned` 三處）。`_freezeForTransaction` 只 `flushPending`（不變量 7 禁止 flush in-flight）⇒ 交易只是排進 pending，畫面卻已 frozen＋吞鍵，得等背景 prefetch 走完整個 soft/hard 預算才送出第一個 byte（連按翻頁後開文／離板必踩）。`expedite` 只縮短 soft → 觸發既有 `\f` 探針（必有回應），**刻意不提前 `_finish`**（提前 finish＝無主 settle，正是不變量 7 的 live race）。
   - **全面快速失敗預算**（2026-08-25）：PTT 正常 RTT 約 90ms＋`SETTLE_MS` 50ms，超過這個量級的沉默就該馬上問一次，而不是坐等秒級 timeout。列表側具名常數（`list_session.js`）：`CMD_PROBE_AFTER_MS=250`（soft＝探針觸發器）、`CMD_PROBE_WINDOW_MS=600`、`CMD_HARD_MS=1200`；背景 prefetch 同樣 250/600 但 `PREFETCH_HARD_MS=1500`。**例外：`native-key`／`native-paste`／`native-input` 維持 `NATIVE_PASSTHROUGH_MS=3000`**——它們不凍畫面（原生鏡像已在畫面上），唯一職責是撐住 functionMode 的 settle 吸收直到自己的回應落地，砍短就是 state churn。舊的「縮 soft 會提高 markEdge 假邊界風險」由不變量 7g 的完整幀守門抵銷。
   守護：`command_queue.test.js`「探針不得重新武裝 hard」「expedite …不提前 finish」＋`list_session.test.js`「背景 prefetch 在線時開文」＋`list_command_budget.test.js`（表格式：每一腿的預算與 \f 契約）。
7c. **frozen 看門狗＝「無進展」計時**（`_armFrozenWatchdog`，`FROZEN_WATCHDOG_MS=2500`，**每完成一腿（`queue.onSettle` 回 `'done'`）就重新武裝**，`_freezeForTransaction`/`_beginOpen`/`_beginOpenPinned` 武裝，只 `_cleanup` 拆）：任何「回呼從未觸發」或「reducer 對該事件無轉移」的路徑都會永久 frozen＝畫面永遠不重繪＋全吞鍵。已知洞：`_openFailed` 的 `open-timeout` 只有 `opening` 有轉移，其他狀態 `return stay` ⇒ actions 空。到期若仍 frozen／opening → `_degradeToNative('指令逾時…')`。不在 frozen 時＝no-op ⇒ 不需在每個解凍點清除。**改成「有進展就重算」是把 12s 砍到 2.5s 的前提**：`_beginOpenPinned` 一次交易可能排十幾腿（每列一個 `open-pinned-step`），固定絕對上限會誤殺合法的多腿開文。
7d. **「讀取中…」膠囊的擁有權**：`_moveSelection` 在到邊且 queue 非 idle 時 `_setLoading(true)`，**其 serverOp 出口 `_requestEnd`/`_requestHome` 的 onDone 與 onFail 都必須 `_setLoading(false)`**——onDone 會設 `_edgeUp/_edgeDown`，之後不再重新評估該分支 ⇒ 膠囊永久卡在右下角直到開文／切原生／離板。↑ 在 buffer 頂端的 wrap 語意就會送 `jump-end`，極易踩到。
7e. **共用 queue 的 `flush()` 靜默會洩漏別人的旗標**：`CommandQueue` 由 ListSession 與 `AidNavigation` 共用，list 的 `_cleanup`/`_enterFunctionMode`/`_handoffArticle`/斷線都 `flush()`（不呼叫 onFail）⇒ in-flight 的 AID 命令被丟掉、`aidNavigation.active` 永遠 true ⇒ `term_view.onKeyDown` 吞掉**全部**鍵盤並一直閃「AID 跳文中」，無法自行復原。修法＝命令層 opt-in 的 `onFlushed`（flush 對其他命令仍靜默）。守護：`aid_navigation.test.js`。
7f. **診斷**：`CommandQueue` 的 `opts.onEvent` 接到 `app.debugRecorder?.log('queue.'+name, info)`（`pttchrome.jsx`），info 帶 `{kind, sinceSentMs, pendingLen, probed}`。recorder 預設 null＝零成本；下次回報卡住時請對方按 Debug 錄製鈕重現，時間軸直接指出哪個 kind 卡住、多久、done/miss/timeout。
7g. **跳號腿一律 `fullRepaint: true`，且 miss 只能由完整幀定讞**（2026-08-25「開文偶發凍四秒」）。兩半缺一不可：
   - **零回應跳號**：跳到真游標**已經所在**的序號時畫面零差異 ⇒ server 送 0 bytes ⇒ `term_buf` 的 settle timer 只由 server 活動 re-arm（不變量 2b）⇒ 沒 settle ⇒ expect 永不被評估，只能苦等軟逾時。錄製檔 `ptt-debug-20260825-105701#t=12562`：prefetch 錨定腿剛把游標跳到 2381，open-jump 又跳 2381 ⇒ 凍 4094ms（其中 4002ms 純空等）。→ **keys 形如 `<數字>\r` 的每一腿都必須 `fullRepaint: true`**（目前八腿：`open-jump`、`open-pinned-jump`、`jump-number`、`jump-end`、`jump-home`、`prefetch-anchor-*`、`native-sync-jump`、`leave-sync-jump`），另加 `open-pinned-end`（游標已在底部時 End 同樣零回應）。**expect 不變**：協定 §6 M1——`redrawwin` 重繪的是 server 虛擬螢幕「現狀」，跳號後底列仍空 ⇒ 永遠不會變成 clean-list，park 指紋（不變量 3）仍是唯一判準。**翻頁腿（`prefetch-up/down`）刻意不掛**：有動的翻頁本來就確定性回應，附 \f 只是流量×2；`native-key`／`native-paste`／`native-input` 也不掛（bytes 是使用者任意輸入，且 §8.2 明訂 `view_postinfo` 這類交易不可帶 `fullRepaint`）。
   - **`isCompleteFrame` 守門**（`command_queue.js` 可注入，預設 `() => true`；`pttchrome.jsx` 注入 `changedRows.size >= rows`）：探針從 4000ms 提前到 250ms 之後，「探針送出後的下一個 settle 就是探針的答案」不再成立——慢速連線上指令自己的真回應常常晚於探針才到，而**部分幀不是「我在哪」的答案**。沒這道守門，那種幀會被判定讞 miss → 常態誤降級原生。判準來源：\f 的 `redrawwin` 回應固定以 `ESC[H ESC[2J` 開頭，而 `term_buf` 的 erase-display `case 2` 走 `_touchRows(0, rows-1)` ⇒ 全螢幕清除必然讓 `changedRows` 涵蓋所有列。非完整幀改用**探針窗**重新武裝並計數，上限 `MAX_PROBE_EXTENSIONS=1`（最壞 ≈ 250+600+600，仍在 2500ms 看門狗之內，沒有無限延長的路）。守門失效的退路是 hard timeout → `onFail('timeout')`，只可能把 miss 延後到硬上限，**不可能卡死**。
   守護：`list_command_budget.test.js`（跳號腿 \f 契約＋真 CommandQueue 的零回應重現）、`command_queue.test.js`「isCompleteFrame…」一組。
8. CommandQueue timer 要包 wrapper（Illegal invocation）。
9. `_renderScreenLines` list 分支傳 `{pageState:2}`；**dropHidden=false**（黑名單已在 `visibleListIndices` 前置過濾，視窗切片本來就不含隱藏列）。
10. `visibleListIndices` 與 `screen_annotations#computeAnnotations` PAGE_LIST 分支同規則——**此同步只在好讀列表視窗（`enhance.listEasyReading` 為 true）成立**：好讀視窗刪除文＋黑名單無條件隱藏（`isDeletedListRow`＝作者欄 `-`；刪除文開文永無 article → 必 wedge，故比照黑名單隱藏）。**原生模式（無 listEasyReading）刻意分歧**：刪除文原生顯示（不隱藏不反黑）、黑名單改渲染成被刪除樣式通知列「（本文已被黑名單） <作者>」（`blacklistNoticeText`；作者＋標題黑名單皆適用；全形括號＋raw 前綴保留游標標記 → 不歪不位移）。`listEasyReading` **只在 term_view 的 buffer/frozen 視窗 render 呼叫傳入**（`:442`/`:446`）；native／functionMode 鏡像**不傳** → 走原生規則（通知列），故「好讀暫時切回原生」與純原生一致（不再變回反黑）。守護：`screen_dropHidden.test.js`（雙模）＋`row_render.test.js`（通知列渲染＋forceWidth）＋`comment_parse.test.js`（`blacklistNoticeText` raw 前綴/全形括號）。
12. **非白名單鍵＝keyClass `passthrough` → `_beginNativePassthrough`**：reducer 先轉 functionMode（sync 腿在途吸收 settle＋frozen 吞鍵——非 native！閃現原生一幀＝黑名單/刪除文裸露），有序號選取且 ≠`_serverNum` 時先 `_enqueueCursorSyncJump('native-sync-jump')`（jump＋key **不可同 tick 直送**：pttbbs typeahead 跳繪，協定 §2），onDone/onFail 皆 `_enterFunctionMode`＋raw 代送原鍵（onFail 也送＝顯性降級，原生鏡像所見即所得）。**`_serverNum` 快路徑**沿用：選取＝`_serverNum`（seed/re-seed/resume facts、prefetch 落地都會教；native 出走/article/探針 fail＝null）→ 免 sync 腿零 round-trip 直切。pinned/無選取＝免 sync 直切＋代送。Ctrl 組合＝不代送、事件放行原生鍵盤（`bytes == null` 分支自 2026-08 起**只服務 Ctrl 組合**）。**勿再為個別鍵寫模擬交易**（relative 配對／mark／search 模擬都試過並移除）。守護：`list_keys.test.js`。
12b. **剪貼簿鍵不得進 passthrough，貼上不得裸送**（2026-08「AID 文章碼要貼兩次」）。兩半缺一即復發：
   - `onKeyDown` 的剪貼簿早退除了 Ctrl-C/A/V/X，**必須含 Shift+Insert**（app 自己的 i18n `alert_pasteShortcutText` 就是叫使用者用它）。它不是 ctrl 組合 ⇒ 舊碼落 `passthrough` → `_beginNativePassthrough` 的 **`e.preventDefault()` 會取消瀏覽器的貼上預設動作** ⇒ `#t` 收不到 `paste` 事件、`App.onDOMPaste` 永不觸發，PTT 只收到 `keyEventToBytes` 產出的 `\x1b[2~`。畫面切原生卻沒貼上任何東西，使用者得貼第二次（那次才成功——此時 `listRenderMode` 已是 native、hook 根本不被呼叫）。**純 `Insert`（無 shift）維持 passthrough**。
   - 貼上本身要走 `ListSession.onPaste`（T3b）而非 `view.onTextInput` 裸送：裸送會與 in-flight prefetch/jump 競態（typeahead，協定 §2），且 buffer 模式渲染的是累積清單 ⇒ **PTT 畫的 prompt 看不見**，要等某個 settle 觸發 catch-all 才現形。使用者讀成「沒反應」再貼一次 → AID 被 append 進同一個 prompt（`#1gIeu-3A1gIeu-3A` → 找不到文章）。
   - 正規化規則放 `string_util.normalizePasteText`（`term_view.onTextInput` 與 `onPaste` 共用），兩條路徑必須送出**逐 byte 相同**的內容；`CommandQueue` 的 send 綁 raw `conn.send`（不做 u2b）⇒ `onPaste` 自行 `u2b`＋`ansiHalfColorConv`，順序照 `telnet.js#convSend`。
   守護：`list_keys.test.js`（Shift+Insert 放行＋純 Insert 反向）、`list_paste.test.js`（sync 腿／快路徑／降級／吞鍵有提示／回傳值／bytes 等值）、`string_util.test.js`（normalizePasteText）、`easy-reading-list.offline.spec.js`（真瀏覽器一次貼上只送一次、無 `\x1b[2~`）。
   文章好讀同源缺口：`_onKeyDown` 只對 `e.key.length === 1` 進 functionMode，貼上不是按鍵 ⇒ prompt 被長頁蓋住。修在 `App.onPasteDone`（送出前先 `easyReading._enterFunctionMode()`）。
   序列化操作（AID 跳文／長推文）在途時**連 `ListSession.onPaste` 都不准進**（那會排進同一條 CommandQueue）：守門在 `App.onPasteDone` 開頭，條件走 `serialized_op_gate.serializedOpHint`（四條送字入口共用，見 12d 末）。
12c. **送不出 byte 的鍵不得進 passthrough**（2026-08「按 Caps Lock/F2 畫面跑掉」；與 12b 同型，該處是 Shift+Insert）：`_classifyKey` 開頭 `keyEventToBytes(e) == null → keyClass 'ignore'`（吞掉、不轉態、**不 preventDefault**——F12 開發者工具／CapsLock 的 OS 行為留給瀏覽器）。舊碼把 CapsLock／F1–F12／NumLock／ScrollLock／不可映射 Ctrl+Shift 全歸 passthrough → 落 `bytes == null` 分支 → **跳過 cursor sync 腿直接 `_enterFunctionMode()`**：畫面瞬間換成 server 真實 24 行（本地導覽零網路，真游標通常停在背景 prefetch 的遠處頁面）＝畫面跑掉，外加黏性 hold＋拋 cache（不變量 15），而 server 從頭到尾沒動——該分支假設的「事件放行後原生鍵盤路徑會送出去」對這些鍵不成立（`TermKeyboard._onKeyDown` 對 KeyMap miss 且 `key.length !== 1` 一律回 false）。判準必須綁 `keyEventToBytes`（＝送出路徑本身），**不可改成硬列鍵清單**（會與送出路徑漂移）。文章好讀的同源守門是 `e.key.length === 1`（`easy_reading.js`）。同批修的還有白名單缺 read.c 導覽同義鍵（`空白`/`N`/`P`/`n`/`p`/`$` 原本落 passthrough，翻頁被當成切原生）。守護：`list_keys.test.js`（dead keys／同義鍵等價／Ctrl-P 反向）、`easy-reading-list.offline.spec.js`。
12d. **IME 送字不得裸送**（2026-08-31「切到中文輸入法打字，整個畫面就卡住」；與 12b 同型，只是 payload 來自組字而非剪貼簿）。兩半缺一即復發：
   - 送出要走 `ListSession.noteTextInput`（T3c）而非 `view.onTextInput` 裸 `_convSend`。IME 的 keydown `e.key` 是 `'Process'`（keyCode 229），`term_view.keyEventFilter` 第一條就把它擋在 `onKeyDown` 之外 ⇒ `_classifyKey` 的 passthrough（一鍵切原生）**對 IME 永遠不觸發**。裸送的後果與 12b 逐字相同：與 in-flight prefetch/jump 競態（typeahead，協定 §2），且 buffer 模式渲染的是累積清單 ⇒ **PTT 畫的 prompt 看不見**。使用者這次讀成「整個畫面卡住」。
   - `term_view.onTextInput` 的 `isPasting` 分支**不得重複攔截**：貼上已經在 `App.onPasteDone` 問過 `listSession.onPaste`，這裡再問一次就是同一段文字送兩次。
   - **序列化操作（AID 跳文／長推文）在途時，四條送字入口一律吞掉並給提示**：`term_view.onKeyDown`／`onTextInput`、`App.onFunctionKey`／`onPasteDone`，條件與提示文字統一在 `serialized_op_gate.serializedOpHint(core)`（2026-09-01；在那之前只有前兩條有守門，IME 與貼上照樣裸送——長推文期間 IME 是被進度遮罩的 `modalShown` **間接**擋住的巧合，AID 跳文不開 modal ⇒ 整段裸送）。守護 `tests/unit/serialized_op_gate.test.js`＋`aid_back_ui.offline.spec.js`／`long_push.offline.spec.js`。
   同一次修法還補了 `#t`（注音組字框）的落點：buffer/frozen 幀沒有可錨的列，見「視圖模型」節與 `docs/easy-reading.md`「游標／`#t` 的錨點契約」禁止事項 4。守護：`list_text_input.test.js`、`term_view_text_input.test.js`、`row_anchor.test.js`、`easy-reading-list.offline.spec.js`「中文輸入法（離線）」。

13. `relabelListCursorRow` ＝**依 resolved num 把 cells[0,7) 重寫成 `%7d` 右對齊**（pttbbs `readdoent` 的 `prints("%7d", num)`），且對**每一列編號列**都跑（不只游標列）。一次覆蓋三種污染：(a) 兩代游標蓋格；(b) partial-redraw 留白的高位格（`"  51281"` ← 351281——`pageArticleNums` 的 monotonicity repair 只修 `nums` 不修 cell；舊全形 `●` 佔兩格剛好蓋住此瑕疵，換半形 `>` 後露出成「> 51281」）；(c) 短序號（`/` 搜尋結果 531 → `"    531"`）。**勿再回頭用 prefix 拼接**——舊法會把序號末兩位灌進行首並存進 map（污染跨頁殘留）。
11. edge 確認（markEdge/_requestEnd）後要 `_forceRedraw`——pinned 門控開啟需要重繪才可見。
15. **原生 excursion＝cache 失效**：`_enterFunctionMode` 一律清 `_boardName`（與 `_serverNum=null` 對稱）——原生任意鍵可改寫清單內容/序號空間（Z/a/A/`/` 的 MODE_SELECT 皆獨立序號空間，協定 §8），回 clean-list 若板名同＋落點恰在舊 buffer 內走純 resume 會把舊條目 merge 進新清單（症狀：多輪搜尋後清單混雜、點舊序號開文 jump expect 永不中→timeout）。守護：`list_keys.test.js`「native excursion 一律拋棄 cache」（含反向守護：leave 交易 resume 不 rebuild）。passthrough 走 `_enterFunctionMode` → 自動涵蓋。
16. **last-read 高亮＝title-match（pttbbs 真實邏輯）＋normalize-on-store＋decorate-on-render**：真實邏輯在 `3rd_script/pttbbs/mbbsd/bbs.c` `readdoent`——`strcmp(currtitle, subject_ex(title))==0` 的**每一列**都塗 `1;3c`（c 依該列自身 title_type：`□`=1紅 `R:`=3黃 `轉`=6青 `鎖`=5紫 `ˇ`=2綠），範圍 mark→行尾、**不含 author 欄**；author 亮白 `1;37`＝`isonline`（作者在線），與 last-read 無關；currtitle per-login 全域、讀完文即設 subject。⇒ **同主題多列同亮是正常行為**，單一列號游標模型必然殘紅（勿再回頭做 `_lastReadNum`）。現行模型：map 永存去色列（`normalizeLastReadListRow`；**雙豁免＝[8,12) 推文數欄 ＋ [17,29) 作者欄**——`paintLastReadListRow` 只重畫 [29,)，作者欄若被壓回預設就再也還原不了 isonline 亮白）；session 記 **`_lastReadTitle`**（`subjectOfListRow`＝title 區去 mark＋防禦性 loop 剝 `Re:`/`Fw:`，＝pttbbs `subject_ex` 等價）；教學雙路——frame-taught（`isLastReadStyledListRow` 命中 fg∈{1,2,3,5,6}→`noteLastRead(subject)`）＋**主動教學**（`_beginOpen`/`_beginOpenPinned` 開文成功 onDone 直教，堵 partial 幀無樣式列的洞）；render（`buildListWindowLines`）對 subject 命中的**每列** clone 重上 `paintLastReadListRow`（色＝`listRowMarkFg` 由該列自身 mark 推，author 欄不動；subject 以 `row._subject` memoize）。生命週期：只有 cleanup 歸零；seed/rebuild/resume 一律保留（currtitle 全域、title 與序號空間無關，新幀自動重教）。守護：`list_accumulate.test.js`（殘留＋欄位豁免＋游標共存＋同主題多列紅黃並亮＋換篇退色＋isonline 不誤觸＋**isonline＋last-read 同列作者亮白保留（accumulate/游標實況/render 三面）**＋subject/markFg 純函式）、`list_session.test.js` 生命週期。
14. **T2 輸入 overlay（`promptListInput`）鍵收束要焦點無關**：input.focus() 在 setTimeout，focus 生效前的 Esc/Enter 落在 `#t`、被全域 handler 的 overlay 守門整個忽略（防鍵漏 server）→ overlay 卡死。修法＝overlay 期間掛 window **capture** keydown：Esc/Enter 直接 finish、其他鍵導焦點回 input（`term_view.js`；soak 站 7 曾穩定踩中）。
17. **無編號列的 clean-list 幀不得驅動 seed／rebuild／resume**（2026-08-20 錄製檔 `20260820-015809`「列表好讀卡在一頁、PgUp 沒反應」）：進板時 pttbbs getkeep 還原的閱讀位置若剛好在板尾，`readdoent` 只畫得出那幾列**置底文**就 `clrtobot`（該幀 entry 區零編號列，但通過不變量 3a 的板尾短頁放寬 → 判 clean-list）。seed 之後 `listLineNums` 全 null ⇒ `bufferEdgeNum` 回 null ⇒ **錨定式 prefetch 的每一條腿都在 `_enqueuePrefetch` 的 `base == null` 靜默 return**（`_startFill`／`_maybeFill`／`_maybeDemand` 全走這裡），`_requestEnd` 的 `anchor == null` 同理，`_demandDownIfWindowShort` 又被「畫面有 ★ ⇒ `_edgeDown=true`」擋掉。使用者端的症狀＝導覽鍵在那兩三列裡原地打轉、**零網路、零重繪、連「讀取中…」膠囊都不亮**（`_moveSelection` 的 `!queue.idle` 不成立），唯一逃生口是 Home 的 `serverOp`；切原生（flush＋鏡像）或進出文章（re-seed）才會恢復——正是回報的三個現象。
   修法＝reducer 事件帶 `hasNumberedRow`（`hasNumberedEntryRow(facts)`，單點推導自 `facts.nums`；**勿改成由 `_collectFacts` 預先塞進 facts**——呼叫端會手組 facts）：idle 不 engage、functionMode／suspended 的 clean-list 一律 stay 鏡像原生、active 板名同 stay／板名異 `enter-function-mode`。停在原生無風險：使用者原生翻一頁就拿到有編號的幀，下一個 settle 自動 engage。
   **與不變量 3a 的分界**：3a 放寬的是「板尾最後一頁只剩 1 列編號＋置底＋空白」，**編號列 ≥1 是底線**；分類器本身**不動**（改它會讓板尾無主 settle 回頭誤降級）。`_enqueuePrefetch` 的無錨點分支另留一則 `listSession.noAnchor` 診斷（不變量 7f），下次同型卡死可直接在錄製檔看到。守護：`list_session.test.js`「無編號列的 clean-list 幀…」三條（分類器不變／落點只有置底文不 engage／板尾 1 列編號仍 engage）＋ reducer 全枚舉的 `hasNumberedRow:false` 四列。

## 已知限制

rows≠24 不 engage。MODE_SELECT（`/` 搜尋清單）＝`_selectMode` 子狀態：序號空間獨立（協定 §8），進出各強制 rebuild（`_boardName=null`）；**退出落點＝帳號已讀進度，非進 select 前位置**（協定 §8 live 事實）——fill 只向上，退回後 buffer 可能整段低於進板頁；**seed／rebuild 落點頁不滿版（下方空白列）時自動 demand-down 補頁**（共用 `_demandDownIfWindowShort`）——不補頁時，初次進版落在看板中段會導致向下 prefetch 的 markEdge 不觸發→`_edgeDown` 停 false→置底文整條被門控隱藏；**滿版落點不得探測**——板尾零回應 PgDn 的 timeout→`\f` 探針會與 hard timeout race 出無主 settle → 誤入 functionMode（live 實測）。（`/` 搜尋走 passthrough 原生打字，convSend 自帶 u2b；passthrough 代送的非 ASCII 單字元同樣先 `u2b`。）

## 素材再錄

`$env:RECORD_MODE='list'; $env:RECORD_BOARD='C_Chat'; $env:RECORD_NAME='cchat-list-nav'; $env:RECORD_LIST_SCRIPT='nav'; yarn record:cassette`（guest 滿加 `RECORD_ALLOW_LOGIN=1`）。
pinned 卷＝`RECORD_NAME='cchat-list-pinned' RECORD_LIST_SCRIPT='pinned'`（要求該板置底 ≥3 篇）。
mark 卷＝`RECORD_NAME='cchat-list-mark' RECORD_LIST_SCRIPT='mark'`；search 卷＝`RECORD_NAME='cchat-list-search' RECORD_LIST_SCRIPT='search'`（需 `RECORD_ALLOW_LOGIN=1`＋帳密）。
**素材世代**：主名四卷（`cchat-list-{nav,pinned,mark,search}`）是 2026-08-12 重錄的**新 `>` 游標**世代，所有 offline 測試預設吃它們；`-wide` 四卷是重錄前的**舊 `●`** 世代，改名保留，只被「舊 ● 游標素材仍能 engage（雙支援）」那一條測試使用。重錄時**只換主名、不要動 `-wide`**——那是 `parseListArticleNum`/`parseListArticleNumLoose`/`serverCursorWidth` 三處兩代分支的唯一真瀏覽器覆蓋（實測：拿掉 loose 的 `●` strip，該條就會在 listLen=20 餓死）。
nav 腳本＝10 step（start/jump/pageup/jump/pageup/jump/open/back/jumpsame/pageup）。重放門控 map 在 `tests/e2e/helpers/replay.js#replayListCassette`（**jump/jumpsame 按 step.num 精確比對**）。offline 編排與 runtime 決策耦合：改 fill/demand 邏輯時 spec 內 prefetchCount／按鍵序列要重算（例：視窗 demand 觸發比舊選取邊距早——PgUp 一次即觸發，spec 只按一次就吃掉一對錨定命令，見 spec 內註解）。
