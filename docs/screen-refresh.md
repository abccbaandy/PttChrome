# 重新整理（看板列表／文章列表／文章／首頁儀表板）

入口：桌機 F5／⌘R（`term_view.onKeyDown` → `App.screenRefresh.refresh('key')`）、手機工具列「重整」
（`'toolbar'`）、手機下拉（`pull_refresh.js`，`'pull'`）。三個入口同一個判準與同一道冷卻：
`src/js/screen_refresh.js`。

## PTT 有沒有原生的重新整理？——沒有（讀碼 CONFIRMED，`3rd_script/pttbbs` 2026-10-13 master）

| 畫面 | 資料何時重讀 | 結論 |
|---|---|---|
| 任何畫面的 `Ctrl-L` | `mbbsd/io.c#system_key_hook`：`redrawwin(); refresh();` 回 `KEY_INCOMPLETE` | 只把 server 端的虛擬畫面原封重送，**不重讀任何資料** |
| 文章列表（`read.c`＋`psb.c`） | `psb_sync_cache`：只在 `cmd.reload` 或 base（頁首）改變時呼叫 `read_loader` | 停在同一頁按什麼都看不到新文章；只有換頁、或 FULLUPDATE/NEWDIRECT/DIRCHANGED 類的回傳值會重讀 |
| 看板列表（`board.c`） | 未讀旗標 `NBRD_UNREAD` 只在 `check_newpost`（載入清單時）算；人氣 `get_boardheader` 每次 render 讀 | 要看新文章旗標就得 `brdnum = -1` ＋ reload |
| 文章（`pmore.c`） | 開文時整份 mmap 進來，之後沒有任何 reload 路徑 | 新推文只能重開文章 |

所以每種畫面挑一條**沒有副作用、游標原地不動**的原生路徑：

| 畫面 | 送出 | 為什麼是它（讀碼） |
|---|---|---|
| 文章列表 | `s` → 等 CompleteBoard prompt → `<本板>⏎` | `bbs.c#do_select` → `enter_board` → 回 `NEWDIRECT` ⇒ `read_apply_mode` reload；`read_exec_noitem` 先存 `crs_ln/top_ln`，`getkeep(currdirect)` 還原 ⇒ 游標原地；這條**不經 `Read()`** ⇒ 不出進板畫面 |
| 看板列表 | `/` → 等「請輸入看板中文關鍵字」→ `⏎` | `board.c#board_cmd_search_keyword`：`getdata_buf` 以原關鍵字為預設值，⏎ 原樣送出 ⇒ `brdnum = -1; reload` ⇒ 未讀旗標與人氣重算；`ctx->curr` 保留（newflag 模式下 loader 會跳到第一個未讀，與原生一致） |
| 文章 | `aid_navigation.refresh()`：（免費網址列或 `Q` 取 AID）→ `s<本板>⏎` → `#<AID>⏎` → `⏎` | 與 AID 跳文同一條、每步依畫面內容驗證的序列；落地後還原閱讀位置（見下） |
| 首頁儀表板（主功能表上的面板畫著） | `home_dashboard.fetchFavorites`：`Ctrl+Z f` → 讀頁 →（跳號翻頁）→ 回游標 → `q` | 面板本來就靠這條抓我的最愛；面板的「更新」鈕也改走這個入口（同一道冷卻），見 `docs/home-dashboard.md` |
| 文章（從搜尋結果／文摘開的） | 列表好讀記錄的身後列表 `mode:'select'` ⇒ `←`（pager FULLUPDATE，游標不動）→ `⏎`；`Q` 把我們丟回子列表（標題列 `系列《`／`文摘《`）⇒ 關框＋`⏎` | 子列表裡 `#` 被拒、`s<板>` 回來仍是子列表（協定 §8.1）；這兩條保住身後的搜尋結果。都不中時走上一列，`#` 前先 ← 離開子列表 |

**為什麼文章不用 `←→`（live 文小幫手的做法）**：← 回列表後游標停在原本的 `crs_ln`，但列表
重讀之後同一個序號可能已經是別篇——置底文在有新文時整排往後挪一號、上方有文被刪時所有
序號往前縮——→ 會**靜默開錯篇**。AID 是唯一跨重讀不變的身分（`docs/deep-link.md`、`nav_history.js`）。

本篇沒有 AID（極舊文章）時：`Q` 的資訊框已經把我們丟回列表、且那個 `FULLUPDATE` 本身就 reload
了列表 ⇒ 關框＋⏎ 重開游標下那篇（`reopenAfterPostInfo`），提示「依列表位置重開」講明。

**列表好讀／看板列表平滑捲動接管中**：兩種列表的重整都是凍結交易、**落地即回**（`resumeOnLanding`，
`docs/easy-reading-list.md`「落地即回好讀」）——最後一步從 prompt 送出（CompleteBoard／關鍵字 prompt），
重畫完的列表那一幀直接回好讀，不切原生（prompt 不畫給使用者看）、不等靜置探針。`s<本板>⏎` 那一步是進板，
預算用 `aid_navigation.SLOW_STEP_BUDGET`（同 AID 跳文的進板）。

### 閱讀位置

- 好讀模式：原本已讀到文末（`easyReadingReachedPageEnd` 且捲到底 2 列內）⇒ `requestScrollToBottom()`
  （黏住文末＝新推文就在眼前）；否則 `requestScrollRestore(lineIndex)` 回到同一列。
- 原生 pmore：狀態列 100% ⇒ 重開後送原生 End；否則停在第一頁（pmore 沒有可靠的「跳到第 N 行」入口）。
- 好讀 pref 開著、使用者當下切在原生 ⇒ 重開後回到好讀（與 AID 跳文同一個 `ensureEnabledOnArticle`）。

## 什麼畫面接手（`refreshTargetFromFacts`，認不出 ⇒ 不接）

- 文章：pager 狀態列＋footer 證明 READING（`parsePagerFooterContext`；超長文 footer 被擠掉時，
  列表好讀自己開的這篇算數）＋已知看板。**站內信／精華區不接**：站內信是 `more.c` 依 currstat 擋掉
  `s` 與 `#`；看板精華區（文章列表的 `z`，`bbs.c#b_man`）不 `setutmpmode`，currstat 還是 READING ⇒
  footer 跟看板文章一字不差，但 `s`／`#`／`Q` 都只會讓 `announce_cmd_select` 的迴圈 break 回精華區
  選單 ⇒ 靠「最近一張選單／列表是【精華文章】」認（`TermBuf.pagerFromEssence`／`pagerContext()`
  回 `'essence'`，不會被列表好讀的證據升級）。同一個旗標也關掉推文鍵攔截、右鍵長推文與複製本篇
  連結、手機工具列的推／回／分享／同主題。
- 文章列表：非輸入欄、標題列讀得到 ASCII 板名；caption 是「系列文章」（搜尋結果 MODE_SELECT）或
  「文摘列表」⇒ 不接（`s` 會離開那個模式）。**已知限制**：舊版 caption 一律「文章選讀」，分不出
  搜尋結果 ⇒ 那種畫面重整會回到完整列表。
- 看板列表：`classifyBoardListScreen` 認得的畫面。熱門看板與分類子層畫面完全相同分不出，`/` 在
  熱門看板會被 vmsg 拒絕 ⇒ 第二步的 ⏎ 正好關掉訊息，提示「熱門看板不支援重新整理」。
- 首頁儀表板：`home_dashboard` 的 `state.visible`（它自己認主功能表）。最先判定；抓最愛途中畫面在我的最愛上也算首頁 ⇒ 送出被忙碌提示擋下。
- 其他（面板收起後的原生主功能表、信箱列表、prompt 開著、編輯器…）：不接。F5 交還瀏覽器（連線中 beforeunload 會先問），
  工具列不顯示「重整」。

## 鍵盤（F5 攔截）

- 接手：`F5`、`⌘R`（`isRefreshKeyEvent`）。pref `refreshKeyIntercept`（預設開）。
- 刻意不接：`Shift/Ctrl+F5`、`⌘⇧R`（強制重載，留給瀏覽器當逃生門）；`Ctrl+R` 一直是 PTT 的 `^R`
  （回水球），本來就不會重載網頁。
- **瀏覽器網址列旁的重新整理按鈕頁面攔不到**（Web 平台沒有這個 API；只有 beforeunload 能「問」）。
- 冷卻中／線路忙碌時 F5 **仍然吞掉**並提示：使用者要的是重整這個畫面，不該變成整頁重載＝斷線。

## 頻率限制

pttbbs 開源碼查無「同文章／同看板讀取頻率」限制（2026-10-13 master，以 Big5 搜「太快」「頻繁」「稍後再」
「冷卻」等字樣，命中的只有聊天室整理中、註冊錯誤次數、天使公會、系統過載；讀文路徑
`more.c`/`pmore.c`/`read.c`/`board.c` 也沒有任何讀取計數）。PTT 站方
私有的防濫用層（`docs/pttbbs-screen-protocol.md` §11.2）不在開源碼裡，行為未知 ⇒ 保守給一道冷卻：
pref `refreshMinIntervalSec`（預設 5 秒，0 ＝不限制），只在**真的送出**時起算（被拒絕、不支援不算）。

## 手機

- 工具列「重整」與「到底（End）」：`mobile_toolbar.toolbarContextFromFacts` 的 `refresh`／`end`，固定在第 3、4 格
  （`toolbarSlots`），不能用時反灰不藏。重整冷卻中反灰＋倒數秒數（`ScreenRefresh.cooldownLeftMs`／`onCooldown`，
  不論冷卻是工具列、F5 或下拉觸發）。分享移進「更多」。
- 下拉重整（`pull_refresh.js`）：只在 `core.mobile`、非選取模式、無 modal、畫面重整得了、觸點底下的捲動
  視口已在頂端時起手；被動監聽、從不 `preventDefault`；位移阻尼 0.5、門檻 64px、上限 96px；放手才生效，
  拉回去或改成水平就取消。
- **這是 CLAUDE.md「系統原生行為不准模擬」的例外**，理由逐條對照該規範：
  1. 沒有入口可接：Chrome 的 pull-to-refresh 唯一的結果是整頁重載＝斷線＋重新登入，頁面收不到「使用者拉了」、
     也不能把結果換掉；
  2. 觸控事件有完整相位（start/move/end），「放手才生效／拉回取消」做得正確——不是 WheelEvent 缺 phase 那種輸入；
  3. Android 沒有關掉 pull-to-refresh 的系統設定可違反。
  原生那條一定要關，否則兩個一起跑：`main.css` 在手機版面給 `html`／`body` **`overscroll-behavior-y: contain`**
  （只動 y 軸；x 軸返回導航照舊放行，守護 `native_gesture_css.test.js`＋`pull_refresh.test.js`）。

## live 文小幫手是怎麼監控新推文的（對照）

`App.incrementCountToUpdatePushthread`：每秒計數，到設定秒數且 `pageState` 是 2/3 就裸送
`←→End`（`\x1b[D\x1b[C\x1b[4~`）＝離開文章、重開游標下那篇、跳到文末。開啟時先關掉好讀模式
（`exitEasyReading`），任何按鍵都會關掉它（`cancelsLiveHelper`）。沒有任何驗證：上面「為什麼不用 ←→」
那段的開錯篇風險它都有，也沒有頻率保護（最小 1 秒）。本功能沒有改動它。

## 守護

- unit：`screen_refresh.test.js`（判準、按鍵、冷卻、送出序列、忙碌）、`aid_navigation.test.js`「refresh」
  （序列、免費路徑、站內信不接、位置還原、無 AID 退路、失敗訊息）、`mobile_toolbar.test.js(x)`、`pull_refresh.test.js`。
- offline e2e：`screen_refresh.offline.spec.js`（真 F5：預設動作被擋、冷卻提示、關 pref 交還）、
  `mobile_refresh.offline.spec.js`（工具列鈕、CDP 觸控下拉）、`mobile_toolbar.offline.spec.js`（分享在更多裡）、
  `home_dashboard.offline.spec.js`「F5」、`mobile_home_dashboard.offline.spec.js`（首頁的下拉與工具列重整）。
