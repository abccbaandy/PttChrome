// Terminal View

import { TermKeyboard } from './term_keyboard';
import { cursorColorForBg } from './cursor_color';
import { DEFAULT_HIGHLIGHT_BG, cursorHighlightClasses, highlightColStart, resolveHighlightRow } from './cursor_highlight';
import { clickableColStart, cursorCss, CUR_BACK, CUR_POINTER, CUR_AUTO, EXIT_COL_END } from './mouse_regions';
import { functionKeyRows, parseFunctionKeys } from './footer_keys';
import { exitBandRect } from './mouse_geometry';
import { renderOverlayRow, renderScreen } from './term_ui';
import { i18n } from './i18n';
import { setTimer, TRACE } from './util';
import { u2b, parseStatusRow, normalizePasteText } from './string_util';
import { rowToText, parseArticleHeader, findPageOverlap, resolvePageOverlap, decideAccumulateBranch, classifyPageTransition, pageArticleNums, isPinnedListRow, parseListArticleNumLoose, hasServerCursorMark } from './comment_parse';
import { mergeListPage, flattenListBuffer, evictListBuffer, pinnedRowKey, MAX_LIST_ROWS, isLastReadStyledListRow, normalizeLastReadListRow, paintLastReadListRow, subjectOfListRow } from './list_session';
import { labelListCursor, pruneListToSegment, LIST_HEADER_ROWS } from './list_window';
import { readValuesWithDefault } from './pref_storage';
import { cursorOffsets } from './cursor_anchor';
import { cursorGeomSample } from './debug_recorder';
import { isDocumentForeground } from './notification_gate';
import icon128 from '../icon/icon_128.png';
import cursorBack from '../cursor/back.png';

const DEFINE_INPUT_BUFFER_SIZE = 12;

// enhance 旗標，只給「好讀累積長頁」（buf.pageLines）那兩個 render 分支用。
// 意思是：這批列是 cloneRow 出來的**快照**，append 之後永遠不會再被寫入，所以
// 「列物件參考相同 ⇒ 內容相同」成立 → Screen 可以拿它做增量標註／元素快取
// （見 src/js/screen_annotate_cache.js）。
// 原生 24 列畫面與列表視窗**不可以**帶這個旗標：那裡的列是 term_buf 就地改寫的
// 活 buffer，參考一路不變但內容每幀都在變，套快取會一直畫出上一幀的內容。
// 凍結成模組常數（而不是每次 new 一個 literal）純粹是省一次配置。
const STABLE_ROWS = Object.freeze({ stableRows: true });

// 「這一幀沒有任何列要上游標底色」。共用同一個凍結物件 → Screen 的 useState 以
// Object.is 比較，連續的「不上色」不會白白觸發 render。
// col＝底色從第幾欄畫起（0 = 整列），與可點區同源，見 cursor_highlight.highlightColStart。
const NO_CURSOR_HIGHLIGHT = Object.freeze({ row: -1, cls: null, col: 0 });

// Snapshot-clone a screen row (TermChar[]) for retention in buf.pageLines. The live
// 24-row buffer is overwritten as PTT repaints, so accumulated rows must be copied.
// A JSON clone would strip the TermChar PROTOTYPE methods (isStartOfURL / getColor /
// getFg…) that <Row>/LinkSegmentBuilder call at render time — the easy-reading page
// is now drawn through <Screen>, so those methods must survive. Copy each char's own
// (primitive) data props onto a fresh object that keeps the same prototype: a real
// content snapshot that is still a method-bearing TermChar.
function cloneRow(row) {
  return row.map(function(ch) {
    return Object.assign(Object.create(Object.getPrototypeOf(ch)), ch);
  });
}

// How many cells the SERVER's cursor mark covers on this row. Two generations
// (comment_parse.js LIST_CURSOR_* block): the old full-width ● is a DBCS pair
// (isLeadByte on cell 0) covering [0,1]; the new half-width ">" (pttbbs b9a5029f,
// STR_CURSOR) covers [0] only. Read it off the cell itself rather than the glyph so
// a '>'-covered 7-digit number (col 0 would then hold a digit) still measures 1.
function serverCursorWidth(row) {
  return row.length && row[0].isLeadByte ? 2 : 1;
}

// Board-list sequence-number column: pttbbs `bbs.c#readdoent` opens every article
// row with prints("%7d", num) → cells [0,7), right-aligned, space-padded.
var LIST_NUM_COL_END = 7;

// Repaint a cloned row's sequence-number column from the number the accumulator
// resolved for it, so the stored row always shows the FULL number in native "%7d"
// form. Three things can corrupt those cells on the wire, and this one write fixes
// all of them (nums[i] != null already proves the row IS a numbered article row):
//   1. cursor mark — old full-width ● swallowed cells [0,1] incl. the top digit;
//      new half-width '>' covers cell 0 (the padding space).
//   2. partial redraw — the server can leave the leading digit cell blank after the
//      cursor moves off a row ("  51281" for 351281); pageArticleNums' monotonicity
//      repair recovers the NUMBER but nothing used to repair the cells, so the row
//      rendered a digit short. Invisible while our cursor was the 2-cell ●, plainly
//      visible ("> 51281") once it became 1-cell '>'.
//   3. short numbers (`/` search results, e.g. 531) — right-aligning into the same
//      7-wide field reproduces the native "    531" exactly, which is what the old
//      prefix-splicing logic kept getting wrong (the "/搜尋後行首出現數字" bug).
// Attributes are untouched (native prints the number with the row's own attrs).
function relabelListCursorRow(row, fullNum) {
  if (fullNum == null || row.length < LIST_NUM_COL_END) return;
  var s = String(fullNum);
  if (s.length > LIST_NUM_COL_END) return; // wider than the field: leave as painted
  var padded = ('       ' + s).slice(-LIST_NUM_COL_END);
  for (var c = 0; c < LIST_NUM_COL_END; ++c) {
    row[c].ch = padded[c];
    row[c].isLeadByte = false;
  }
}

// Restore a cloned cursor-on-★pinned row's cursor cells to the spaces they
// covered (a pinned row has no number to relabel — the mark sat over plain
// padding), so the accumulated row renders identically to its cursor-free form.
function blankListCursorMark(row) {
  for (var c = 0, w = serverCursorWidth(row); c < w && c < row.length; ++c) {
    row[c].ch = ' ';
    row[c].isLeadByte = false;
  }
}

export function TermView() {
  //new pref - start
  this.bbsWidth = 0;
  this.bbsHeight = 0;
  this.dbcsDetect = true;
  // 游標底色（pref mouseBrowsingHighlightColor）→ color.css 的 bN。滑鼠 hover 與
  // 鍵盤游標共用同一個顏色，對映在 cursor_highlight.highlightClass。
  // 歷史坑：這個欄位曾經**只被寫入從未被讀**（React 化時斷鏈），使用者選什麼色
  // 畫面都是硬寫的綠色 b2。動這條路徑時務必確認 applyCursorHighlight 仍讀得到它。
  this.highlightBG = DEFAULT_HIGHLIGHT_BG;
  // 鍵盤操作時也標示游標所在列（pref keyboardCursorHighlight，預設開）。
  this.keyboardCursorHighlight = true;
  // 游標所在列的樣式層（pref cursorRowBrighten / cursorRowBackground）。上面兩個
  // 是「哪一列」的來源層，這兩個是「畫什麼」，兩層正交、兩種樣式可同時開。
  // 值須與 pref_storage.js DEFAULT_PREFS 一致。
  this.cursorRowBrighten = true;
  this.cursorRowBackground = false;
  this.charset = 'big5';
  // 滑鼠子開關（pref mouseLeftClick / mouseMiddleClick / mouseWheel）。總開關是
  // buf.useMouseBrowsing，gating 一律走 mouse_regions.resolveMouseGates。
  // 值域：mouseMiddleClick 0=關閉 1=貼上 2=左方向鍵；mouseWheel 0=關閉 1=上下頁。
  // mouseWheelSmoothScroll：滾輪平滑捲動，只作用於文章列表好讀模式（見 pref_storage）。
  this.mouseLeftClick = true;
  this.mouseMiddleClick = 0;
  this.mouseWheel = 1;
  this.mouseWheelSmoothScroll = true;
  // 防誤觸模式（pref mouseMisclickGuard，預設開）：可點區＝底色區的起始欄，
  // 決策在 mouse_regions.clickableColStart。
  this.mouseMisclickGuard = true;
  // 功能鍵可點（pref mouseFunctionKeys）。與總開關 and 過之後才決定要不要算
  // functionKeyRows（見 _renderScreenLines）。
  this.mouseFunctionKeys = true;
  //this.highlightFG = 7;
  this.fontFitWindowWidth = false;
  //new pref - end

  this.bbsViewMargin = 0;

  this.buf = null;
  this.bbscore = null;
  this.page = null;

  // Cursor
  this.cursorX = 0;
  this.cursorY = 0;

  // **刻意留在 view**：這是 EasyReading._enabled 的 bindProperty 來源（easy_reading.js
  // constructor），同時被 redraw 的分支判斷／list_session／debug_recorder／e2e 探針當
  // 公開旗標讀（docs/easy-reading.md）。搬進 easy_reading.js 等於拆掉那個契約。
  // 手動開關一律走 App.switchToEasyReadingMode / exitEasyReading，勿直接翻這個旗標。
  this.useEasyReadingMode = false;
  this.easyReadingKeyDownKeyCode = 0;

  // List easy reading hides the PTT cursor while the buffer render owns the
  // screen (the real cursor points into the 24-row buffer, not the long list).
  this._cursorHidden = false;

  // 列表好讀模式的游標底色座標（都是「渲染後的 24 列」列號，與 server 幾何無關）：
  //   _listCursorRow 虛擬游標列，由 buildListWindowLines 每次組視窗時寫入
  //   _listHoverRow  滑鼠停留列，由 onListMouseMove 寫入（-1 ＝ 沒停在可點的列上）
  this._listCursorRow = -1;
  this._listHoverRow = -1;

  // 游標底色的「誰最後動誰贏」仲裁狀態（決策在 js/cursor_highlight.js）：
  //   _highlightMover  'mouse' | 'keyboard'，最後移動的是誰
  //   _highlightMode   上一次套用時的模式，用來排除模式切換造成的假移動
  //   _lastCursorRow   上一次套用時的鍵盤游標列（native=buf.cur_y、listBuffer=_listCursorRow）
  this._highlightMover = 'mouse';
  this._highlightMode = null;
  this._lastCursorRow = -1;

  // 這一幀的 `.main` 裝的是不是「固定格線的一整螢幕」（原生／functionMode 原生鏡像／
  // 列表好讀視窗）。好讀的累積長頁不是 —— 它是一份可自由捲動的長文，第 N 列與格線
  // 第 N 列毫無關係，`buf.cur_y` 在那裡指不到任何一列，所以**閃爍游標整個隱藏**
  // （_applyCursorVisibility）。文章內的輸入情境不受影響：按任何單字元鍵都會先進
  // functionMode 鏡像原生 24 列（easy_reading._onKeyDownProcessUI），那是格線幀。
  // 只有真的重畫畫面的分支才改它。
  this._gridRender = true;

  // 閃爍游標抑制（autoHideBlinkCursor）：PTT 自己畫了 '>' 游標的畫面（列表／選單）
  // 不需要再疊一個閃爍游標。與 _cursorHidden 是**兩個獨立來源**，用 OR 合併於
  // _applyCursorVisibility —— 不可共用一個旗標：_cursorHidden 會讓 updateCursorPos
  // 提早 return（位置不再更新），而 list_session 的 showCursor() 會把它清掉，
  // 連帶把這裡的抑制狀態一起清掉。
  this._cursorSuppressed = false;

  // 這一幀的 (cur_x, cur_y) 落在格線外（PTT 偶爾會把 cur_x 送成 cols）。第四個獨立
  // 來源，同樣 OR 進 _applyCursorVisibility。**必須是「藏起來」而不是「不更新」**：
  // 舊版在這裡直接 early-return，游標仍然可見卻停在上一次的座標 ⇒ 畫面已經換了、
  // 游標還留在原地，看起來就是「戳出反白輸入匡」。
  this._cursorOutOfRange = false;

  // 上一次送進 debug 錄製器的游標座標，用來做「真的動了才取樣」的節流。
  this._lastGeomKey = null;
  this.autoHideBlinkCursor = true; // 須與 pref_storage.js DEFAULT_PREFS 一致

  // Work mode (enableWorkMode) repaints the screen in grays via CSS only, so the
  // cursor's inline color has to be told about it — see cursor_color.js. Kept in
  // sync by App.onPrefChange → setWorkMode.
  this.workModeActive = false;

  // Sticky "we are in a board-list context" flag for blacklist hiding. Pressing v
  // (設定已讀未讀記錄) overlays a prompt on the list whose status row no longer
  // parses as LIST(2), so the per-frame pageState gate alone would un-hide every
  // blacklisted row for the whole duration of that prompt. Updated in
  // _renderScreenLines: true on LIST(2), false on MENU(1)/READING(3), unchanged on
  // transient/overlay states (0/5/6) so list hiding survives across them.
  this._inBoardListContext = false;

  // Enhanced Add-on: comment blacklist (lower-cased Set) + floor numbering.
  // Set from prefs via App.onPrefChange. Floor numbers are computed at render time
  // by Screen#computeAnnotations (a fresh FloorCounter walks the whole `lines`); in
  // easy reading `lines` is the full accumulated pageLines, so cross-page numbering
  // falls out naturally — no persistent counter on the view is needed.
  this.blacklist = new Set();
  // Title keyword blacklist (lower-cased keyword array). Board-list only: hides any
  // post whose title contains one of the keywords. Set via App.onPrefChange.
  this.titleBlacklist = [];
  this.showFloorNumbers = true;
  // 好讀「連續同作者推文合併」：render 層合併（Screen#computeAnnotations +
  // comment_merge.js），僅好讀文章頁生效。Set via App.onPrefChange.
  this.mergeSameAuthorComments = true;
  // 裝置端 AI（Chrome Prompt API）總開關。每個 AI 子功能的生效條件都是
  // `enableAi && <子開關>`，AND 在下面 _renderScreenLines 匯總（單一 choke point）。
  // Set via App.onPrefChange.
  this.enableAi = false;
  // 好讀「左圖右文」的裝置端 AI 校正開關。只是「讓 AI 浮動按鈕出得來」，實際推論
  // 仍要使用者按下該按鈕。Set via App.onPrefChange.
  this.enableCaptionAi = false;
  // Same-author comment highlighting: tint comments written by the 原PO.
  // _articleAuthor is parsed from the article header (first page only) and kept
  // across page-downs; see redraw().
  this.highlightAuthorComments = true;
  // Auto-fix broken URLs: detect URLs broken by injected spaces / missing scheme /
  // split file extension and show a repaired clickable link below (src/js/url_fix.js).
  this.enableAutoFixUrl = true;
  // Bare-domain auto-link: linkify a domain written without scheme AND without a
  // path ("indiegametw.com") in place (src/js/bare_domain.js). Both modes.
  this.enableBareDomainLink = true;
  // 裸網域的裝置端 AI 複核（Chrome Prompt API）：只能**撤掉**規則已允許的連結
  // （單向收縮），關閉／不支援時結果恆等於純規則結果。Set via App.onPrefChange.
  this.enableUrlAi = false;
  // Auto-link X(Twitter) @handles (format-valid ones) in article body/comments.
  // Existence verification is currently off — see Screen.js / docs/enhanced-addon.md.
  this.enableXMention = true;
  this._articleAuthor = null;
  // Board of the article being read (same header line); fallback board for a
  // boardless #AID link. Assigned by the App like flashListHint etc.
  this._articleBoard = null;
  this.onAidClick = null;
  // Pusher highlight: lower-cased id of the pusher whose comments are currently
  // highlighted (whole row), or null. Set by togglePusherHighlight on click.
  this._selectedPusher = null;
  // Monotonic id bumped only when a NEW article's first page starts accumulating
  // (accumulatePageLines new-article branch). Stable across same-article page-downs
  // and forced redraws, so Screen can reset the "enlarge all images" toggle on
  // article change / re-entry WITHOUT resetting on every concat'd page-down (which
  // would happen if it keyed off the `lines` reference). See Screen.js.
  this._articleInstanceId = 0;
  // Article-line number ("目前顯示: 第 S~E 行") of the LAST row currently in buf.pageLines
  // (= previous accumulated screen's rowIndexEnd), or null when not tracking. Used by
  // accumulatePageLines to size cross-page overlap from PTT's absolute row numbers
  // instead of purely from content — see comment_parse.resolvePageOverlap.
  this._accEndRow = null;
  // Page signature ("S~E") of the last screen actually accumulated into buf.pageLines.
  // EasyReading._onScreenSettled compares it with the settled screen's signature to
  // detect "this server response never reached accumulatePageLines" (its cursor park
  // landed in a cursor-only notify window, so redraw was never called for it) and
  // forces one redraw. Reset with the rest of the tracking in hideEasyReadingOverlays.
  this._lastAccumulatedSig = null;


  this.lineWrap = 78;

  //this.DBDetection = false;
  this.blinkOn = false;

  // React
  this.componentScreen = {
    setCursorHighlight() {},
    setSelectedPusher() {},
    notifyLayoutChanged() {},
  };

  this.selection = null;
  this.input = document.getElementById('t');
  this.BBSWin = document.getElementById('BBSWindow');
  this.enablePicPreview = true;
  this.scaleX = 1;
  this.scaleY = 1;

  var dynamicStyle = document.createElement('style');
  document.head.appendChild(dynamicStyle);
  this.dynamicCss = dynamicStyle.sheet;

  // for cpu efficiency
  this.innerBounds = { width: 0, height: 0 };
  this.firstGridOffset = { top: 0, left: 0 };

  // for notifications
  this.enableNotifications = true;
  // Deep link 交接通知（標題閃爍 + 系統通知）。刻意與 enableNotifications 分開：
  // 後者的文案就是「啟用水球通知」，而且在 App.onData 實際是當「要不要解析水球
  // 封包」的閘門在用；兩者的騷擾曲線也不同（水球高頻、交接低頻且可操作 —— 不通知
  // 等於功能靜默失效）。見 pref_storage.deepLinkHandoffNotify。
  this.deepLinkHandoffNotify = true;
  this.titleTimer = null;
  this.notif = null;
  // 閃爍前的原始 document.title，停止時還原用。null = 現在沒在閃。
  this._flashBaseTitle = null;

  Object.defineProperty(this, 'mainContainer', {
    get: function() { return document.getElementById('mainContainer') },
  });

  var mainDisplay = document.createElement('div');
  mainDisplay.setAttribute('class', 'main');
  this.BBSWin.appendChild(mainDisplay);
  this.mainDisplay = mainDisplay;

  // React 的專用容器。**不可以讓 React 直接 render 進 `.main`**：React 19 在 root
  // container 首次 mount 的 commit 會執行 `container.textContent = ''`
  // （react-dom-client 的 HostRoot mutation phase）⇒ 任何預先放進 `.main` 的節點
  // （下面那顆 #cursor）第一次 render 就被清光。切一層自己的容器，React 只擁有它。
  var screenRoot = document.createElement('div');
  screenRoot.setAttribute('id', 'screenRoot');
  mainDisplay.appendChild(screenRoot);
  this.screenRoot = screenRoot;

  // 閃爍游標。**住在 `.main` 裡面，和列共用同一棵 DOM 樹、同一個座標系**——捲動由
  // `.main` 一起帶著走、縮放由 `.main` 的 transform 一起套。歷史上它掛在 #BBSWindow
  // （fixed）底下、用格線公式算絕對座標，於是每次捲動／縮放都要補一個補償項，漏一條
  // 就「推文時游標戳出反白輸入匡」（cbee3f5 → 865b828 修了兩輪仍復發）。
  //
  // 位置**錨在該列真正被畫出來的節點**（updateCursorPos → _rowAnchor → offsetTop），
  // 不是 `cur_y*chh`：後者只是「這一列應該在哪」的算術模型，與 layout 的實際結果之間
  // 沒有任何守門，任一列的 line box 被撐大就整批脫鉤（見 js/cursor_anchor.js 開頭）。
  //
  // **不要再把它搬回 .main 外面，也不要再引入任何 scrollTop／scale／列高補償。**
  // 守護：tests/e2e/offline/cursor_shape.offline.spec.js
  var bbsCursor = document.createElement('div');
  bbsCursor.setAttribute('id', 'cursor');
  bbsCursor.setAttribute('class', 'terminal_display');
  mainDisplay.appendChild(bbsCursor);
  this.bbsCursor = bbsCursor;

  var lastRowDiv = document.createElement('div');
  lastRowDiv.setAttribute('id', 'easyReadingLastRow');
  // 只建**空的** wrapper span，內容一律由 _mirrorStatusRowToFooter 填（真狀態列
  // 的即時鏡像，含真實顏色與功能鍵）。這個 wrapper 不可省：setSingleChild 寫的是
  // lastRowDiv.childNodes[0]，而 `#easyReadingLastRow > span` 的 CSS 也掛在它身上。
  //
  // 這裡曾經放一串寫死的假 footer（`(y)回應 (X%)推文 (←)離開`）＋一句上游待辦「找個
  // 方法更新它」。mirror 上線後那是假需求：#easyReadingLastRow 預設 display:none，唯一把它
  // 設成 block 的地方在 mirror 已經填好內容之後 ⇒ 那串字從來不會被看到。
  lastRowDiv.appendChild(document.createElement('span'));
  this.lastRowDiv = lastRowDiv;
  this.BBSWin.appendChild(lastRowDiv);

  // 文章左側「點這裡離開」的提示帶。
  //
  // 刻意**不放進 Screen/#mainContainer**，而是與 easyReadingLastRow 一樣當
  // BBSWindow 底下的獨立 div：
  //   1. .main 是好讀長頁的捲動容器，放裡面的 absolute 子元素會跟著內容捲走；
  //   2. 三種 render 分支（原生 24 列／好讀長頁／列表虛擬視窗）要行為一致，掛在
  //      scroller 之上就與分支無關；
  //   3. 原生模式 Screen 每幀都在 re-render，hover 布林不該進 React state。
  // 幾何由 setTermFontSize 寫（與 clientToPos 同源，見 mouse_geometry.js），
  // 樣式（含硬需求 pointer-events:none）在 css/main.css。
  var exitHintBand = document.createElement('div');
  exitHintBand.setAttribute('id', 'exitHintBand');
  this.exitHintBand = exitHintBand;
  this.BBSWin.appendChild(exitHintBand);

  this.mainDisplay.style.border = '0px';
  this.setFontFace('MingLiu,monospace');

  this._keyboard = new TermKeyboard(
    this.checkLeftDB.bind(this),
    this.checkCurDB.bind(this),
    this._send.bind(this));

  this.input.addEventListener('compositionstart', (e) => {
    this.onCompositionStart(e);
    this.bbscore.setInputAreaFocus();
  }, false);

  this.input.addEventListener('compositionend', (e) => {
    this.onCompositionEnd(e);
    this.bbscore.setInputAreaFocus();
    // Some browsers fire another input event after composition; some not.
    // The strategy here is to ignore the inputs during composition.
    // Instead, we pull all input text at composition end, and clear input text.
    // So if input event do fire after composition end, we'll get a empty string.
    this.onInput(e);
  }, false);

  // _listInputWrap: while the list T2 input overlay (search keyword / jump
  // number) is open it OWNS the keyboard — the global handlers must not touch
  // events (keypress would leak chars to the server) and, critically, the
  // keyup handler below must not steal focus back to #t (that wedge ate every
  // keystroke: first keyup refocused #t, all further keys hit the frozen
  // swallow — the「/ 搜尋打不了字」bug).
  let shouldAcceptInput = () =>
    !this.bbscore.modalShown &&
    !this.bbscore.contextMenuShown &&
    !this._listInputWrap;
  let keyEventFilter = (e) => {
    // On both Mac and Windows, control/alt+key will be sent as original key
    // code even under IME.
    // Char inputs will be handler on input event.
    // We can safely ignore those IME keys here.
    if (e.keyCode == 229)
      return false;

    // 下面兩條是 iOS 來的，但**刻意保留**：專案目標是主流桌機瀏覽器（CLAUDE.md），
    // 不為手機做相容，而這兩條在桌機 IME 也在作用（isComposition 期間吞掉非控制鍵），
    // 移除有風險、零收益。不要再把它當待辦。

    // iOS sends the keydown that starts composition as key code 0. Ignore it.
    if (e.keyCode == 0)
      return false;

    // iOS sends backspace when composing. Disallow any non-control keys during it.
    if (this.isComposition && !e.ctrlKey && !e.altKey)
      return false;

    // Don't process meta keys, like Mac's command key.
    if (e.metaKey)
      return false;

    return true;
  };

  addEventListener('keypress', (e) => {
    if (!shouldAcceptInput() || !keyEventFilter(e))
      return;
    this._keyboard.onKeyPress(e);
  });

  addEventListener('keydown', (e) => {
    if (!shouldAcceptInput() || !keyEventFilter(e))
      return;

    // disable auto update pushthread if any command is issued;
    if (!e.altKey) this.bbscore.onDisableLiveHelperModalState();

    if(e.keyCode > 15 && e.keyCode < 19)
      return; // Shift Ctrl Alt (19)
    this.onKeyDown(e);
  }, false);

  addEventListener('keyup', (e) => {
    // We don't need to handle code 229 here, as it should be already composing.

    if (!shouldAcceptInput())
      return;
    if(e.keyCode > 15 && e.keyCode < 19)
      return; // Shift Ctrl Alt (19)
    // set input area focus whenever key down even if there is selection
    this.bbscore.setInputAreaFocus();
  }, false);

  this.input.addEventListener('input', (e) => {
    this.onInput(e);
  }, false);
}


TermView.prototype = {

  onBlink: function() {
    this.blinkOn=true;
    //   if(this.buf && this.buf.changed)
    this.buf.queueUpdate(true);
    //   else this.update();
  },

  setBuf: function(buf) {
    this.buf=buf;
  },

  setConn: function(conn) {
    this.conn=conn;
  },

  _send: function(data) {
    if (this.conn)
      this.conn.send(data);
  },

  _convSend: function(data) {
    if (this.conn)
      this.conn.convSend(data);
  },

  setCore: function(core) {
    this.bbscore=core;
  },

  _isConnected: function() {
    return this.bbscore.isConnected() && !!this.conn;
  },

  setFontFace: function(fontFace) {
    this.fontFace = fontFace;
    this.input.style.setProperty('font-family', this.fontFace, 'important');
    this.mainDisplay.style.setProperty('font-family', this.fontFace, 'important');
    this.lastRowDiv.style.setProperty('font-family', this.fontFace, 'important');
    document.getElementById('cursor').style.setProperty('font-family', this.fontFace, 'important');
  },

  update: function() {
    this.redraw(false);
  },

  redraw: function(force) {

    //var start = new Date().getTime();
    var rows = this.buf.rows;
    var lineChangeds = this.buf.lineChangeds;
    // 這一幀要重畫哪幾列。2026-08 之前這個陣列算出來就丟掉（只取 length > 0 當
    // 布林），而且 ch.needUpdate 是 sticky 的 ⇒ 幾乎恆等於全部列。去 sticky 之後
    // 它是真的 dirty 集合，往下傳給 render 層做逐列 patch（見
    // render/screen.js#_buildNodes）。force ⇒ 自然收錄全部列。
    var changedRows = [];

    var lines = this.buf.lines;
    // Track the 原PO id for same-author comment highlighting. The "作者" header
    // only appears on the first page of an article, so keep the last parsed value
    // across page-downs; a new article's first page overwrites it.
    if (this.buf.pageState === 3) {
      // Author AND board come from the SAME header line ("作者 x (y) 看板 Z"), so
      // they are adopted as one event: a 站內信 header has no 看板 field and must
      // therefore CLEAR the board, not inherit the previous post's (a boardless
      // #AID in a mail would otherwise jump to an unrelated board). null = not a
      // header row (a later page) → keep both across page-downs.
      var header = parseArticleHeader(rowToText(lines[0]));
      if (header) {
        this._articleAuthor = header.author;
        this._articleBoard = header.board;
      }
    } else {
      // Leaving the article clears any pusher highlight selection. 只設欄位就好：
      // 這裡跑在 _renderScreenLines **之前**，下面那次 render 會把新值同步進
      // ScreenController（update ⇒ _selectedPusher ⇒ 收尾 _appliedPusher 對帳）。
      // 在這裡呼叫 setSelectedPusher 只會對即將被丟掉的上一幀節點白做一次 O(n)。
      this._selectedPusher = null;
    }
    for (var row = 0; row < rows; ++row) {
      if (lineChangeds[row] === false && !force)
        continue;
      changedRows.push(row);
      lineChangeds[row] = false;
    }
    if (changedRows.length > 0) {
      // Single render path: BOTH modes draw through <Screen> (React owns
      // #mainContainer). The only difference is which `lines` we hand it — a single
      // fixed screen (native, or a list/menu while easy reading is on) or the
      // growing accumulated article page (easy reading, pageState 3). The two
      // easy-reading overlay rows (footer / reply preview) are separate divs and
      // are still drawn imperatively below.
      if (this.useEasyReadingMode && this.buf.easyReadingFunctionMode) {
        // functionMode: mirror the native 24-row screen LIVE so any PTT prompt / menu /
        // editor triggered from inside the article (回應至選單、推文、收暫存檔、編輯器…)
        // shows EXACTLY as native — no hardcoded overlay, no per-prompt parsing. Hide
        // the easy-reading overlays but KEEP buf.pageLines intact (do NOT clear) so
        // _evalFunctionModeExit('resume') can resume the accumulated long page without
        // re-paging. Reset scroll so the 24-row screen is visible at the top (the long
        // page may have been scrolled down). See easy_reading.js functionMode + docs.
        this.hideEasyReadingOverlaysKeepPage();
        this.mainDisplay.scrollTop = 0;
        this._gridRender = true;
        // changedRows：lines 直接來自 buf.lines ⇒ 列號一一對應，可以照實回報。
        // 這一支實際上不會生效（pageState 仍是 3，render 層的守門
        // screen_annotations.annotationsAreRowIndependent 一律拒絕 READING），
        // 刻意照傳是為了「呼叫端只回報事實，能不能用由守門一處決定」。
        this._renderScreenLines(lines.slice(), /* dropHidden */ false, /* inlinePreview */ false, /* hoverPreview */ false, { changedRows: changedRows });
      } else if (
        (this.buf.listRenderMode === 'buffer' || this.buf.listRenderMode === 'frozen') &&
        this.buf.pageState !== 3
      ) {
        // List easy reading (v4, ListSession owns the mode; see list_session.js).
        // pageState 3 (article) frames MUST fall through to the article branches
        // below even while frozen: during opening→suspended there is a settle-lag
        // window in which a latched article easy reading is ALREADY fast-path
        // paging — if frozen shadowed those frames, accumulatePageLines would
        // miss the article's first pages forever (v4-stabilize bug 1: 進文章只剩
        // 底部 1~2 頁). Non-article transients (jump prompt echoes) still render
        // the frozen buffer, which is the whole point of frozen.
        //
        // NATIVE-PARITY WINDOW render (core principle, docs/easy-reading-list.md):
        //   buffer: accumulate the currently painted board page into the maps,
        //           then render a fixed 24-row page — cached header/footer +
        //           the session's 20-row window slice over the blacklist-
        //           filtered buffer, cursor row decorated with the native ●.
        //           No DOM scrolling, no highlight bar, no scroll anchoring:
        //           buffer growth cannot move the window (number anchors).
        //   frozen: an article open is in flight — render the LAST window
        //           untouched so the jump-prompt/clear transients never pollute
        //           it (v3's "進出文章瞬間版面亂").
        // enhance pageState is pinned to 2 so list annotations apply even on
        // transient frames. dropHidden=false: the window slice is already
        // blacklist-filtered (visibleListIndices), nothing left to hide.
        this.hideEasyReadingOverlaysKeepPage();
        if (this.mainDisplay) this.mainDisplay.scrollTop = 0;
        this._gridRender = true;
        var windowLines = null;
        if (this.buf.listRenderMode === 'buffer') {
          this.accumulateListLines();
          windowLines = this.buildListWindowLines();
        } else {
          windowLines = this._listWindowLines || null;
        }
        if (windowLines) {
          // listEasyReading: THIS render IS the easy-reading window → deleted/blacklist
          // rows are hidden (好讀模式全部隱藏; the window is already blacklist-filtered
          // by visibleListIndices, so mostly belt-and-braces). The functionMode / native
          // mirror paths below do NOT pass it → they use the native rules (deleted shown,
          // blacklist → 通知列), so a temporary switch back to native inside easy reading
          // stays consistent with pure native mode.
          // rowIdentityStable：視窗的每一列都是 cloneRow 快照（存進 _listNumMap /
          // _listPinnedMap / header・footer cache 之後就不再就地改寫，見
          // buildListWindowLines 的註解）⇒ 列參考相同即內容相同，render 層可以
          // 直接沿用上一幀的節點。frozen 幀原封沿用整份 _listWindowLines，24 列
          // 全部命中。
          // 次列位移（平滑捲動）：body 區交給自己的視口節點，offsetPx 就是它的
          // scrollTop。overscan 由實際列數推導 —— frozen 幀沿用的是快照，不能
          // 再去問 session 現在的 frac。
          var lsBodyRows = this.buf.rows - 4;
          var lsSession = this.bbscore && this.bbscore.listSession;
          this._renderScreenLines(windowLines.slice(), /* dropHidden */ false, /* inlinePreview */ false, /* hoverPreview */ false, {
            pageState: 2,
            listEasyReading: true,
            rowIdentityStable: true,
            listScroll: {
              bodyStart: LIST_HEADER_ROWS,
              bodyRows: lsBodyRows,
              viewportPx: lsBodyRows * this.chh,
              offsetPx:
                (lsSession && lsSession.scrollFrac && lsSession.scrollFrac()) || 0,
              overscan: windowLines.length > LIST_HEADER_ROWS + lsBodyRows + 1
            }
          });
        } else {
          // No window yet (header cache / buffer still empty — engage races):
          // mirror the native screen; the next clean-list settle re-renders.
          // **不可以**帶 rowIdentityStable：這裡畫的是 buf.lines（term_buf 就地
          // 改寫的活 buffer），列參考相同不代表內容相同。上面那一行長得很像，別
          // 順手複製過來。它走的是 changedRows 那條路（下方 enhanceOverrides）。
          this._renderScreenLines(lines.slice(), /* dropHidden */ false, /* inlinePreview */ false, /* hoverPreview */ false, { pageState: 2, listEasyReading: true, changedRows: changedRows });
        }
      } else if (this.useEasyReadingMode && this.buf.pageState == 3) {
        // Easy-reading article: accumulate the long page into buf.pageLines (pure
        // JS de-dup, no DOM) then render the whole thing. Blacklisted comment rows
        // are dropped entirely (dropHidden) instead of left as a blank gap.
        // Auto-open images INLINE (the long scroll page) — matches the old
        // appendRows(showsLinkPreview=true) behaviour. Hover preview off (inline
        // already shows them; avoids a duplicate floating popup).
        this.accumulatePageLines();
        if (!this.buf.pageLines.length) {
          // 防黑守門：累積頁是空的（accumulatePageLines 判這幀 incomplete → 'skip'，
          // 而先前的累積又被誰清掉了）。把空陣列丟給 <Screen> 就是渲染 0 列 ＝ **整頁
          // 全黑**，而且 prompt 幀的游標永遠不在 (rows-1, cols-1)，complete 再也不會
          // 成立 ⇒ 黑到離開文章為止（實例：在 X 推文的輸入框上關設定頁，見
          // switchModePlan 的註解與 tests/e2e/offline/pref_close_in_prompt.offline.spec.js）。
          // 沒有東西可顯示時一律退回原生 24 列——與 functionMode 分支同構。
          this.hideEasyReadingOverlaysKeepPage();
          if (this.mainDisplay) this.mainDisplay.scrollTop = 0;
          this._gridRender = true;
          // 同 functionMode 分支：pageState 3 ⇒ 守門會拒絕，照實回報而已。
          this._renderScreenLines(lines.slice(), /* dropHidden */ false, /* inlinePreview */ false, /* hoverPreview */ false, { changedRows: changedRows });
        } else {
          this._gridRender = false;
          this._renderScreenLines(this.buf.pageLines, /* dropHidden */ true, /* inlinePreview */ true, /* hoverPreview */ false, STABLE_ROWS);
        }
      } else if (
        this.useEasyReadingMode &&
        this.buf.settledPageState === 3 &&
        this.buf.pageLines.length
      ) {
        // TRANSIENT dip out of pageState 3 while still inside the article. pageState is
        // a per-frame classification and setPageState needs parseStatusRow to match the
        // bottom row, so a footer caught mid-repaint (pfterm patches it per cell) or a
        // momentarily blank last row drops it to 0/2 for one frame. The old code fell
        // into the native branch below, which calls hideEasyReadingOverlays() and thus
        // THREW AWAY buf.pageLines — the whole accumulated long page — and the next
        // complete frame then rebuilt from the CURRENT page, silently losing everything
        // before it. settledPageState is the debounced value (still 3 until the screen
        // has been quiet on a non-article page for SETTLE_MS), so while it says 3 we
        // just keep showing the accumulated page and accumulate nothing. Teardown for a
        // real exit moved to EasyReading._teardownAccumulationOffArticle (settle-driven).
        this._gridRender = false;
        this._renderScreenLines(this.buf.pageLines, /* dropHidden */ true, /* inlinePreview */ true, /* hoverPreview */ false, STABLE_ROWS);
      } else {
        // Native screen, OR easy reading sitting on a list/menu (pageState != 3):
        // one fixed screen. Hide the easy-reading overlay rows first when on.
        // Native shows images on HOVER (per enablePicPreview pref), no inline; the
        // easy-reading list/menu shows neither (matches the old hideEasyReading path).
        // (Mid-article transients never reach here — the branch above holds them.)
        if (this.useEasyReadingMode) this.hideEasyReadingOverlays();
        this._gridRender = true;
        this._renderScreenLines(
          /* a fresh copy for componentWillReceiveProps */ lines.slice(),
          /* dropHidden */ false,
          /* inlinePreview */ false,
          /* hoverPreview */ this.useEasyReadingMode ? false : this.enablePicPreview,
          // 逐列 patch 真正生效的地方：原生列表／選單按住 ↑↓ 時 pttbbs 只重畫
          // 游標的前後兩列，其餘 ~22 列直接沿用上一幀的節點。
          { changedRows: changedRows }
        );
      }
    }
    // 游標底色：**所有** render 分支共用一個套用點（原本只有原生分支呼叫，所以
    // 列表好讀與 functionMode 的游標永遠沒有底色）。必須在 _renderScreenLines
    // 之後——ScreenController 的節點要先進 DOM。
    //
    // 這兩行**刻意放在 if 之外**：needUpdate 去 sticky 之後「changed 為真、卻沒有
    // 任何一列變髒」的幀真的會出現（insertLine 的 cur_y >= scrollEnd 分支、
    // clear(param) 的 param 不在 {0,1,2} 時），而 setPageState 讀的是 cur_x/cur_y
    // ⇒「內容零 dirty、pageState 卻變了」可達。那種幀漏寫 prevPageState 會讓下一幀
    // 的 decideAccumulateBranch 讀到過期值 ⇒ 好讀從文章中段重建 pageLines（上面
    // 的內容整段消失，見 docs/easy-reading.md）。
    // componentScreen 守門：首幀就零 dirty 時它還沒被建出來。
    if (this.componentScreen) this.applyCursorHighlight();
    this.buf.prevPageState = this.buf.pageState;
    //var time = new Date().getTime() - start;
    //console.log(time);

  },

  // Render `lines` into #mainContainer via <Screen>. dropHidden=true removes
  // blacklisted rows from the layout (easy-reading long page); false keeps them as
  // visibility:hidden to preserve the fixed native grid. inlinePreview auto-opens
  // image links inline (easy-reading article); hoverPreview shows them on hover
  // (native, per enablePicPreview). The per-row enhance logic (blacklist / floor /
  // author / pusher highlight) lives entirely in Screen#computeAnnotations now,
  // shared by both modes.
  _renderScreenLines: function(lines, dropHidden, inlinePreview, hoverPreview, enhanceOverrides) {
    // Maintain the sticky board-list context (see constructor). LIST enters it,
    // MENU/READING leave it, everything else (overlay prompts, transient frames)
    // keeps the previous value so blacklist hiding persists across e.g. the v prompt.
    const ps = this.buf.pageState;
    if (ps === 2) this._inBoardListContext = true;
    else if (ps === 1 || ps === 3) this._inBoardListContext = false;
    // 功能鍵可點：**全專案唯一**算 functionKeyRows 的地方（這個函式是七條 render
    // 分支共用的 enhance choke point）。
    //
    // `!ov.stableRows` 是關鍵守門：帶 STABLE_ROWS 的兩條分支畫的是好讀累積長頁
    // （buf.pageLines，數千列），那裡沒有「最後一列＝狀態列」這回事，而且它們吃
    // 增量快取 —— 永不給這個欄位，快取零風險。
    // pageState 用 override 優先（列表好讀的視窗幀把它 pin 成 2），沒有才用 buf 的。
    const ov = enhanceOverrides || {};
    let fnRows = null;
    if (!ov.stableRows && this.mouseFunctionKeys && this.buf.useMouseBrowsing) {
      fnRows = functionKeyRows(
        ov.pageState != null ? ov.pageState : this.buf.pageState,
        lines.length
      );
    }
    this.componentScreen = renderScreen(
      lines,
      this.chh,
      inlinePreview,
      hoverPreview,
      this.screenRoot,
      Object.assign(
        {
          blacklist: this.blacklist,
          titleBlacklist: this.titleBlacklist,
          showFloorNumbers: this.showFloorNumbers,
          mergeSameAuthorComments: this.mergeSameAuthorComments,
          captionAiEnabled: this.enableAi && this.enableCaptionAi,
          highlightAuthor: this.highlightAuthorComments,
          articleAuthor: this._articleAuthor,
          // 高亮本身**不由這條路生效**（它不進 annotationsKey，見
          // js/screen_annotate_cache.js）。這裡帶進去是給 ScreenController 當
          // 新建時的種子＋每幀對帳的來源；即時切換走 setSelectedPusher。
          selectedPusher: this._selectedPusher,
          autoFixUrl: this.enableAutoFixUrl,
          bareDomainLink: this.enableBareDomainLink,
          urlAiEnabled:
            this.enableAi && this.enableBareDomainLink && this.enableUrlAi,
          // 同一個 enableUrlAi 子開關也管 URL 修復的 gray 候選複核（方向相反：
          // 那邊是 AI 答 true 才放行，見 url_ai_logic.js）。
          fixAiEnabled:
            this.enableAi && this.enableAutoFixUrl && this.enableUrlAi,
          enableXMention: this.enableXMention,
          pageState: this.buf.pageState,
          // Floor numbers only count correctly across page-downs in easy reading
          // (its FloorCounter persists). The native per-page counter resets every
          // page → inaccurate, so floors are hidden in native mode (see Screen.js).
          easyReading: this.useEasyReadingMode,
          // AID auto-link click → in-app navigation (aid_navigation.js); the App
          // assigns this.onAidClick at startup (view-optional callback pattern).
          onAidClick: this.onAidClick,
          dropHidden: dropHidden,
          inListContext: this._inBoardListContext,
          // Stable per-article id; Screen resets the enlarge-images toggle when it
          // changes (new article / re-entry), not on every page-down.
          articleId: this._articleInstanceId,
          // 功能鍵按鈕：哪幾列要掃 ＋ 點下去交給誰（App 在啟動時指派
          // this.onFunctionKey，與 onAidClick 同一種 view-optional callback 慣例；
          // **引用必須穩定**，annotationsKey.refs 與 outerHTML 節點重用都靠它）。
          functionKeyRows: fnRows,
          onFunctionKey: this.onFunctionKey
        },
        // List easy reading pins pageState:2 so computeAnnotations applies list
        // blacklist rules to the accumulated buffer even on transient frames.
        enhanceOverrides || {}
      )
    );
  },

  // 游標底色的**唯一**套用入口（滑鼠 hover 與鍵盤游標共用）。
  //
  // 三個模式的游標來源完全不同，故先判模式再交給純函式決策（cursor_highlight.js）：
  //   listBuffer 我們自己組的 24 列虛擬視窗 → 虛擬游標列 _listCursorRow
  //              （由 buildListWindowLines 記下；frozen 沿用上一份快照的值）
  //   article    好讀累積長頁 → 不上色（沒有「游標列」的概念）
  //   native     原生畫面 → server 真游標列 buf.cur_y（只在選單／列表）
  // 呼叫點：redraw 的每個 render 分支、term_buf.setHighlight（hover 變動）、
  // updateCursorPos（只有游標動、內容沒動的幀）、pref 變更。
  //
  // source === 'mouse' ＝ 這次是**真的滑鼠移動**（onListMouseMove / term_buf 的 hover
  // 列變動），滑鼠因此重新取得優先權。鍵盤沒有對應事件可掛（游標是 server 畫的），
  // 改以「鍵盤游標列變了」推導；模式切換時 native 的 cur_y 與 listBuffer 的虛擬游標
  // 列是兩套列號，列號變動不算使用者移動游標，故先比對 mode。
  applyCursorHighlight: function(source) {
    if (!this.buf) return;
    var listMode =
      this.buf.listRenderMode === 'buffer' || this.buf.listRenderMode === 'frozen';
    var mode = listMode
      ? 'listBuffer'
      : (this.useEasyReadingMode && this.buf.pageState === 3 ? 'article' : 'native');
    var kbRow = listMode ? this._listCursorRow : this.buf.cur_y;
    if (source === 'mouse')
      this._highlightMover = 'mouse';
    else if (mode === this._highlightMode && kbRow !== this._lastCursorRow)
      this._highlightMover = 'keyboard';
    this._highlightMode = mode;
    this._lastCursorRow = kbRow;
    var row = resolveHighlightRow({
      mode: mode,
      pageState: this.buf.pageState,
      // 滑鼠來源：列表好讀走我們自己算的視窗座標（server 幾何在那裡沒有意義），
      // 原生沿用 term_buf.onMouse_move 設的 nowHighlight。
      mouseEnabled: !!(this.buf.useMouseBrowsing && this.buf.highlightCursor),
      mouseRow: listMode ? this._listHoverRow : this.buf.nowHighlight,
      keyboardEnabled: !!this.keyboardCursorHighlight,
      cursorRow: this.buf.cur_y,
      listCursorRow: this._listCursorRow,
      lastMover: this._highlightMover,
      // PTT 開著輸入框就整個畫面不上色（見 cursor_highlight 的 inputPrompt）。
      // **只在 native 取用**：列表好讀畫的是 ListSession 自組的虛擬視窗，server 的
      // 真游標座標在那組畫面上沒有意義，拿它判會誤關掉正常的光棒。
      inputPrompt: mode === 'native' && this.buf.isCursorOnInputField()
    });
    // 底色寬度＝可點區寬度（使用者 2026-08 定案）。**不分 lastMover** —— 鍵盤游標
    // 與滑鼠 hover 共用同一個寬度，否則同一個畫面上兩種光棒不一樣長。
    var col = highlightColStart({
      mode: mode,
      pageState: this.buf.pageState,
      misclickGuard: !!(this.buf.useMouseBrowsing && this.mouseMisclickGuard)
    });
    // 樣式層：兩種都關掉時 cls 是空字串 ⇒ 直接當成「不標示」，省掉整條
    // render/patch（也讓 Screen._toggleRowClass 不必處理空 token）。
    var cls = cursorHighlightClasses({
      brighten: !!this.cursorRowBrighten,
      background: !!this.cursorRowBackground,
      colorIndex: this.highlightBG
    });
    if (TRACE)
      console.log(`applyCursorHighlight: mode=${mode} row=${row} col=${col} cls=${cls}`);
    this.componentScreen.setCursorHighlight(
      row < 0 || !cls
        ? NO_CURSOR_HIGHLIGHT
        : { row: row, cls: cls, col: col }
    );
  },

  onInput: function(e) {
    if (this.bbscore.modalShown || this.bbscore.contextMenuShown)
      return;
    if (this.isComposition) {
      // beginning chrome 55, we no longer can update input buffer width on compositionupdate
      // so we update it on input event
      this.updateInputBufferWidth();
      return;
    }

    if (this.useEasyReadingMode && this.buf.startedEasyReading &&
        this.easyReadingKeyDownKeyCode == 229 && e.target.value != 'X') { // only use on chinese IME
      e.target.value = '';
      return;
    }
    if (e.target.value) {
      this.onTextInput(e.target.value);
    }
    e.target.value='';
  },

  onTextInput: function(text, isPasting) {
    // 送字給 PTT ≠ 按鍵。好讀模式是在 keydown 決定要不要切成原生鏡像（functionMode），
    // 而 IME（keydown 的 e.key 是 'Process'）與貼上都繞得過那道判斷 → PTT 開了推文／
    // 搜尋 prompt，畫面卻還停在好讀長頁上，使用者看不到輸入框卻打得進去。
    // 見 easy_reading.noteTextInput（含 gate，非文章／好讀關著時為 no-op）。
    if (this.bbscore.easyReading)
      this.bbscore.easyReading.noteTextInput();
    // Normalization lives in string_util.normalizePasteText so the list easy
    // reading paste route (ListSession.onPaste → CommandQueue) sends byte-for-
    // byte the same thing this native route does.
    if (isPasting)
      text = normalizePasteText(text, this.lineWrap);
    this._convSend(text);
  },

  onKeyDown: function(e) {
    // AID navigation in flight: serialized machine keys own the wire — a user
    // key would race them (typeahead, protocol §2). Swallow with a banner.
    if (this.bbscore.aidNavigation && this.bbscore.aidNavigation.active) {
      e.preventDefault();
      this.flashListHint('AID 跳文中，請稍候…');
      return;
    }
    // 長推文送出中：同一條理由（X → 型別 → 內容 → y 的配對不能被插隊）。進度
    // 遮罩會讓 shouldAcceptInput() 先擋下大部分按鍵，這裡是同條件的自保。
    if (this.bbscore.longPush && this.bbscore.longPush.active) {
      e.preventDefault();
      this.flashListHint('長推文送出中，請稍候…');
      return;
    }
    // "返回原文" hotkey (pref aidNavBackKey, default F9). Claimed BEFORE every
    // other handler because it must work in easy reading AND native, in a post
    // or on a list. Safe to claim: F-keys have no KeyMap entry, so they never
    // reach PTT anyway (term_keyboard.keyEventToBytes returns null for them).
    // With no back stack this is a no-op hint, not a swallowed key.
    if (this.bbscore.aidNavigation && !e.ctrlKey && !e.altKey && !e.metaKey &&
        e.key === readValuesWithDefault().aidNavBackKey) {
      e.preventDefault();
      this.bbscore.aidNavigation.back();
      return;
    }
    // 「複製本篇連結」hotkey (pref deepLinkCopyKey, default F2). Claimed here for
    // the same reason as the one above: an F-key never reaches PTT anyway, and
    // it must work in easy reading as well as native.
    if (this.bbscore.deepLinkController && !e.ctrlKey && !e.altKey && !e.metaKey &&
        e.key === readValuesWithDefault().deepLinkCopyKey) {
      e.preventDefault();
      this.bbscore.deepLinkController.copyCurrentPostLink();
      return;
    }
    // Switch-to-native is a TOGGLE: the gate below owns the key while easy reading is
    // on, and this owns it while we are back in native inside a post. Without it there
    // is no way back into easy reading for the current post at all — the user has to
    // walk out to a list and open another one ("半永久原生模式"). functionMode is
    // excluded (we are already mirroring native there, and _evalFunctionModeExit will
    // resume on its own), and pageState 3 keeps it out of lists/menus/editors.
    if (!this.useEasyReadingMode && !this.buf.easyReadingFunctionMode &&
        this.buf.pageState === 3 && !e.ctrlKey && !e.altKey &&
        this.bbscore.easyReading &&
        this.bbscore.easyReading.tryReenterFromNative(e)) {
      e.preventDefault();
      return;
    }
    if (this.useEasyReadingMode && this.buf.startedEasyReading &&
        !this.buf.easyReadingFunctionMode) {
      this.easyReadingKeyDownKeyCode = e.keyCode;
      this.bbscore.easyReading._onKeyDown(e);
      if (e.defaultPrevented)
        return;
    }

    // List easy reading (v4): only the buffer/frozen render owns keys — in
    // native (idle / list functionMode) this hook never fires, so every key
    // (Enter included) reaches PTT unchanged, which is what makes the native
    // mirror correct by construction.
    if ((this.buf.listRenderMode === 'buffer' || this.buf.listRenderMode === 'frozen') &&
        this.bbscore.listSession) {
      this.bbscore.listSession.onKeyDown(e);
      if (e.defaultPrevented)
        return;
    }

    // 這裡只剩「本 app 自己要吃掉的鍵」。真正的分流在上面：列表好讀交給
    // listSession.onKeyDown、文章好讀交給 easyReading._onKeyDown，沒被攔下的一律
    // 原封落到 _keyboard.onKeyDown 送給 PTT。
    var stop = false;
    if (!e.ctrlKey && !e.altKey) {
      switch (e.key) {
        case 'End': //End
          // Only swallow End when the live-update helper actually handles it
          // (onToggleLiveHelperModalState returns true). When the helper isn't
          // running it's a noop returning undefined → fall through to native End,
          // so End keeps jumping to the bottom in list/article (see bug: End dead
          // in list/article whenever endTurnsOnLiveUpdate was enabled).
          if ((this.bbscore.buf.pageState == 2 || this.bbscore.buf.pageState == 3) &&
            this.bbscore.endTurnsOnLiveUpdate &&
            this.bbscore.onToggleLiveHelperModalState()) {
            stop = true;
          }
          break;
      }
    } else if (e.ctrlKey && !e.altKey && !e.shiftKey) {
      switch (e.key.toLowerCase()) {
        case 'c':
          if (!window.getSelection().isCollapsed) { //^C , do copy
            var selectedText = window.getSelection().toString().replace(/\u00a0/g, " ");
            this.bbscore.doCopy(selectedText);
            stop = true
          }
          break;
        case 'a':
          this.bbscore.doSelectAll();
          stop = true;
          break;
      }
    } else if (e.ctrlKey && !e.altKey && e.shiftKey) {
      switch (e.key.toLowerCase()) {
        // 'v', not 'V': the switch subject is toLowerCase()'d, so the old 'V'
        // case never matched — Ctrl-Shift-V fell through to term_keyboard's
        // CtrlShiftMap['v'] = 22 and sent a bare ^V to PTT instead of pasting.
        case 'v':
          this.bbscore.doPaste();
          stop = true;
          break;
      }
    }
    if (stop) {
      e.preventDefault();
      return;
    }

    this._keyboard.onKeyDown(e);
    if (e.defaultPrevented)
      return;
  },

  setTermFontSize: function(cw, ch) {
    var innerBounds = this.innerBounds;
    // 字級 pref 與視窗 resize 都經過這裡，而 mainDisplay 的寬度是 chw*cols ⇒ chw 一變
    // 圖片的顯示寬度就變，好讀佔位盒記的高度（pinned）全部過期。見
    // render/screen.js#notifyLayoutChanged。
    var widthChanged = this.chw !== cw;
    this.chw = cw;
    this.chh = ch;
    var fontSize = this.chh + 'px';
    var mainWidth = (this.chw * this.buf.cols + 10) + 'px';
    this.mainDisplay.style.fontSize = fontSize;
    this.mainDisplay.style.lineHeight = fontSize;
    this.bbsCursor.style.fontSize = fontSize;
    this.bbsCursor.style.lineHeight = fontSize;
    this.mainDisplay.style.overflowX = 'hidden';
    this.mainDisplay.style.overflowY = 'auto';
    this.mainDisplay.style.textAlign = 'left';
    this.mainDisplay.style.width = mainWidth;
    this.mainDisplay.style.height = (this.chh * this.buf.rows + 10) + 'px';

    this.lastRowDiv.style.fontSize = fontSize;
    this.lastRowDiv.style.width = mainWidth;

    if (this.chh*this.buf.rows < innerBounds.height)
      this.mainDisplay.style.marginTop = ((innerBounds.height-this.chh*this.buf.rows)/2) + this.bbsViewMargin + 'px';
    else
      this.mainDisplay.style.marginTop =  this.bbsViewMargin + 'px';
    if (this.fontFitWindowWidth) {
      this.scaleX = Math.floor(innerBounds.width / (this.chw*this.buf.cols+10) * 100)/100;
      this.scaleY = Math.floor(innerBounds.height / (this.chh*this.buf.rows) * 100)/100;
    } else {
      this.scaleX = 1;
      this.scaleY = 1;
    }

    var scaleCss = 'none';
    if (this.scaleX != 1 || this.scaleY != 1) {
      //this.mainDisplay.style.transform = 'scaleX('+this.scaleX+')'; // chrome not stable support yet!
      scaleCss = 'scale('+this.scaleX+','+this.scaleY+')';
      var transOrigin = 'left';
      {
        transOrigin = 'center';
      }
      this.mainDisplay.style.webkitTransformOriginX = transOrigin;
      this.lastRowDiv.style.webkitTransformOriginX = transOrigin;
      this.lastRowDiv.style.webkitTransformOriginY = '-1100%'; // somehow these are the right value
    } else {
      this.lastRowDiv.style.webkitTransformOriginY = '';
    }
    this.mainDisplay.style.webkitTransform = scaleCss;
    this.lastRowDiv.style.webkitTransform = scaleCss;

    this.firstGridOffset = this.bbscore.getFirstGridOffsets();

    this.updateExitHintBandGeometry();
    this.updateReverseScaleCss();
    this.updateCursorPos();

    if (widthChanged) this.componentScreen.notifyLayoutChanged();
  },

  // 提示帶的水平幾何。**必須與 App.clientToPos 同源**（兩者都走
  // mouse_geometry），否則帶子亮著卻點不到、或點得到卻沒亮。高度由 CSS 給
  // （top:0; height:100%，BBSWindow 是 position:fixed 的定位容器）。
  // 帶子不參與 .main 的 transform，所以寬度自己乘 scaleX —— 這也是 cellWidth 做的事。
  updateExitHintBandGeometry: function() {
    if (!this.exitHintBand) return;
    var rect = exitBandRect({
      innerWidth: this.innerBounds.width,
      chw: this.chw,
      cols: this.buf.cols,
      scaleX: this.scaleX,
      scaleY: this.scaleY,
      firstGridLeft: this.firstGridOffset && this.firstGridOffset.left
    });
    this.exitHintBand.style.left = rect.left + 'px';
    this.exitHintBand.style.width = rect.width + 'px';
  },

  // 文章左側可退出的視覺提示。開關時機見 term_buf.onMouse_move / clearHighlight、
  // onListMouseMove、App.onPrefChange、App.setModalOpen、window blur。
  setExitAffordance: function(on) {
    if (!this.exitHintBand) return;
    this.exitHintBand.classList.toggle('active', !!on);
  },

  updateReverseScaleCss: function() {
    var rule = 'img.hyperLinkPreview { ' +
      '-webkit-transform: scale(' + Math.floor(1/this.scaleX*100)/100 + ',' +
      Math.floor(1/this.scaleY*100)/100+');' +
      ' }';
    while (this.dynamicCss.cssRules.length > 0) {
      this.dynamicCss.deleteRule(0);
    }
    this.dynamicCss.insertRule(rule, this.dynamicCss.cssRules.length);
  },

  checkLeftDB: function() {
    if (this.dbcsDetect && this.buf.cur_x>1) {
      var lines = this.buf.lines;
      var line = lines[this.buf.cur_y];
      var ch = line[this.buf.cur_x-2];
      if (ch.isLeadByte)
        return true;
    }
    return false;
  },

  checkCurDB: function() {
    if (this.dbcsDetect) {// && this.buf.cur_x<this.buf.cols-2){
      var lines = this.buf.lines;
      var line = lines[this.buf.cur_y];
      var ch = line[this.buf.cur_x];
      if (ch.isLeadByte)
        return true;
    }
    return false;
  },

  // Hide the blinking PTT cursor while the list buffer render owns the screen:
  // the real cursor tracks the 24-row buffer (wherever the last prefetch left
  // it), which is meaningless — and misleading — on the accumulated long list.
  // showCursor restores it and repaints the position.
  hideCursor: function() {
    this._cursorHidden = true;
    this._applyCursorVisibility();
  },

  showCursor: function() {
    this._cursorHidden = false;
    this._applyCursorVisibility();
    this.updateCursorPos();
  },

  // 唯一寫 #cursor display 的地方。inline 'none' 蓋過 CSS 的 .blink--active 規則
  // （main.css），設回 '' 就把顯示權交還給每秒 toggle class 的閃爍機制。
  // 四個獨立來源做 OR：手動隱藏（list_session）、PTT 自己畫了游標（autoHideBlinkCursor）、
  // 這一幀不是格線畫面（好讀累積長頁 —— 格線座標在那裡沒有意義，見 _gridRender）、
  // 以及游標座標落在格線外（_cursorOutOfRange，見宣告處）。
  _applyCursorVisibility: function() {
    this.bbsCursor.style.display =
      (this._cursorHidden || this._cursorSuppressed || !this._gridRender ||
       this._cursorOutOfRange) ? 'none' : '';
  },

  // 每幀重算（TermBuf.notify）：PTT 游標可能在「終端機游標沒移動、但該列被重畫」的
  // frame 出現或消失，所以不能只掛在 updateCursorPos（posChanged）上。
  // 成本＝一格查表。
  refreshCursorVisibility: function() {
    var suppressed = false;
    if (this.autoHideBlinkCursor && this.buf) {
      var line = this.buf.lines[this.buf.cur_y];
      suppressed = !!line && hasServerCursorMark(line, this.buf.cur_x);
    }
    this._cursorSuppressed = suppressed;
    this._applyCursorVisibility();
  },

  // autoHideBlinkCursor 被切換（App.onPrefChange）：立刻重算，不必等下一個 frame。
  setAutoHideBlinkCursor: function(on) {
    this.autoHideBlinkCursor = !!on;
    this.refreshCursorVisibility();
  },

  // Work mode toggled (App.onPrefChange): repaint the cursor right away so the
  // color follows the new palette even if no screen update is coming.
  setWorkMode: function(on) {
    this.workModeActive = !!on;
    if (this.buf) this.updateCursorPos();
  },

  // 列表好讀模式的滑鼠移動。**不走 term_buf.onMouse_move**：那條依 server 的真實
  // 24 列幾何判斷（可點列範圍、該列是否為空），而畫面上是我們自己組的虛擬視窗，
  // 兩者的列意義並不對應。這裡只回答一個問題：滑鼠停在哪一個「可點的文章列」上。
  // frozen（開文交易進行中）比照鍵盤：不接受互動，清掉 hover。
  //
  // 底色與 pointer 的**範圍**一致（防誤觸開＝標題欄、關＝整列，見
  // mouse_regions.clickableColStart），但**條件**不同：底色只要停在可點的列上就給，
  // pointer 還要 mouseLeftClick 也開著。底色的 gate 在 applyCursorHighlight
  // （唯一真相源），這裡只 gate 總開關與 pointer。
  onListMouseMove: function(row, col) {
    var hover = -1;
    if (this.buf.useMouseBrowsing && this.buf.listRenderMode === 'buffer') {
      var ls = this.bbscore && this.bbscore.listSession;
      var idx = row - LIST_HEADER_ROWS;
      // row === buf.rows ＝ 平滑捲動時視口底部露出的那一小條（overscan 列，
      // 渲染 index 24）。它一樣是使用者看得到、點得到的列 ⇒ 底色也要標得到，
      // 「可點範圍＝標示範圍」的合約才成立（docs/mouse.md）。
      if (ls && row === this.buf.rows) {
        var ovWin = ls.getWindowView();
        if (ovWin && ovWin.overscanAbs != null) hover = row;
      } else if (ls && idx >= 0 && idx < this.buf.rows - 4) {
        var win = ls.getWindowView();
        // body[idx] == null ＝ 短頁的空白補列，沒有文章可點。
        if (win && win.body[idx] != null) hover = row;
      }
    }
    // 左側退出帶（cols 0..EXIT_COL_END）：與原生列表同一個手勢，同樣**不看
    // misclickGuard**（見 mouse_regions.resolveMouseRegion 的 case 2/4）。
    // 只在「可點的文章列」上成立 —— header／footer 那幾列有功能鍵按鈕，
    // 不該同時是退出區，這樣「提示帶亮＝點得下去」的合約才成立。
    var iconsEnabled = !!(this.buf.useMouseBrowsing && this.mouseLeftClick);
    var onExitBand = hover >= 0 && col >= 0 && col < EXIT_COL_END;
    if (onExitBand) {
      // 退出帶上沒有「hover 到哪一列」的概念（與文章一致），底色收掉。
      hover = -1;
      if (this.buf.BBSWin)
        this.buf.BBSWin.style.cursor = cursorCss(CUR_BACK, {
          backUrl: cursorBack,
          iconsEnabled: iconsEnabled
        });
      this.setExitAffordance(iconsEnabled);
    } else {
      var clickable =
        hover >= 0 &&
        !!this.mouseLeftClick &&
        col >= clickableColStart(2, !!(this.buf.useMouseBrowsing && this.mouseMisclickGuard));
      // 兩個字面值改走 cursorCss（唯一真相源），總開關關掉時連 pointer 都不給。
      if (this.buf.BBSWin)
        this.buf.BBSWin.style.cursor = cursorCss(
          clickable ? CUR_POINTER : CUR_AUTO,
          { backUrl: cursorBack, iconsEnabled: iconsEnabled }
        );
      // 離開退出帶就要關掉；不關的話從文章切回列表也會留下殘影。
      this.setExitAffordance(false);
    }
    // 滑鼠動了 ⇒ 由滑鼠持有底色。早退（同一列內移動）只在**滑鼠本來就持有**時成立：
    // 鍵盤剛把底色搶走的話，即使 hover 列沒變也要重新套用，否則在同一列內晃動滑鼠
    // 永遠拿不回來。
    var wasMouse = this._highlightMover !== 'keyboard';
    this._highlightMover = 'mouse';
    if (hover === this._listHoverRow && wasMouse) return;
    this._listHoverRow = hover;
    this.applyCursorHighlight('mouse');
  },

  // Lightweight fading toast for the list easy-reading closed interaction
  // (v5: a non-whitelisted key is a no-op with a hint — list_session.js
  // onKeyDown). One reusable fixed div, inline-styled so it needs no CSS file
  // and cannot leak into the terminal layout.
  // `ms` optional: banners (T4 waterball / transaction degrade) linger longer
  // than the default key-hint fade.
  flashListHint: function(msg, ms) {
    var el = this._listHintEl;
    if (!el) {
      el = document.createElement('div');
      // 樣式全走 inline（見上面註解），class 只是給測試一個穩定的抓手 —— 沒有它，
      // 這個提示在 e2e 裡只能靠「body 底下最後一個沒有 id 的 div」定位。
      el.className = 'ListHint';
      el.style.cssText =
        'position:fixed;left:50%;bottom:48px;transform:translateX(-50%);' +
        'background:rgba(20,20,20,.88);color:#eee;padding:6px 14px;' +
        'border-radius:6px;font-size:14px;z-index:2000;pointer-events:none;' +
        'transition:opacity .4s;opacity:0;max-width:80%;';
      document.body.appendChild(el);
      this._listHintEl = el;
    }
    el.textContent = msg;
    el.style.opacity = '1';
    if (this._listHintTimer) clearTimeout(this._listHintTimer);
    this._listHintTimer = setTimeout(function() {
      el.style.opacity = '0';
    }, ms || 1800);
  },

  // Reusable list "loading" indicator (v5/M4, contract #4): shown while a
  // serialized transaction freezes the render and while a demand prefetch is
  // filling past a window edge (list_session._setLoading). Small fixed pill in
  // the bottom-right corner — the frozen 24-row screen itself stays untouched.
  setListLoading: function(on) {
    var el = this._listLoadingEl;
    if (on && !el) {
      el = document.createElement('div');
      el.style.cssText =
        'position:fixed;right:16px;bottom:16px;background:rgba(20,20,20,.85);' +
        'color:#ffd;padding:4px 12px;border-radius:12px;font-size:13px;' +
        'z-index:2000;pointer-events:none;';
      el.textContent = '讀取中…';
      document.body.appendChild(el);
      this._listLoadingEl = el;
    }
    if (el) el.style.display = on ? 'block' : 'none';
  },

  // Persistent (non-fading) overlay line for T2 parameter collection (`v`
  // choice menu). Same styling family as flashListHint; hidden explicitly.
  showListOverlay: function(msg) {
    var el = this._listOverlayEl;
    if (!el) {
      el = document.createElement('div');
      el.style.cssText =
        'position:fixed;left:50%;bottom:88px;transform:translateX(-50%);' +
        'background:rgba(20,40,70,.92);color:#fff;padding:8px 16px;' +
        'border-radius:6px;font-size:14px;z-index:2000;pointer-events:none;' +
        'max-width:80%;';
      document.body.appendChild(el);
      this._listOverlayEl = el;
    }
    el.textContent = msg;
    el.style.display = 'block';
  },

  hideListOverlay: function() {
    if (this._listOverlayEl) this._listOverlayEl.style.display = 'none';
    if (this._listInputWrap) {
      this._listInputWrap.remove();
      this._listInputWrap = null;
    }
  },

  // "返回原文" pill for the AID back stack (aid_navigation.js). Shown exactly
  // while a back run is available; hidden while one is in flight.
  //
  // Three integration points, all of them old traps in this app:
  //   - flashListHint's family is `pointer-events:none`, so this needs its own
  //     element with pointer-events/cursor of its own — it is CLICKABLE.
  //   - `nomouse_command` keeps App.checkClass from treating the pill as
  //     terminal area (mouse browsing would send keys to PTT under the click).
  //   - the click is stopped here: window-level capture listeners (mousedown /
  //     click in pttchrome.jsx) otherwise steal focus back to the hidden input.
  showBackButton: function(label, onClick) {
    var el = this._aidBackEl;
    if (!el) {
      el = document.createElement('div');
      el.className = 'nomouse_command';
      el.style.cssText =
        'position:fixed;left:16px;bottom:16px;background:rgba(20,40,70,.92);' +
        'color:#fff;padding:6px 14px;border-radius:16px;font-size:13px;' +
        'z-index:2000;pointer-events:auto;cursor:pointer;user-select:none;' +
        'max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      el.addEventListener('mousedown', function(e) {
        e.stopPropagation();
        e.preventDefault();
      });
      el.addEventListener('click', function(e) {
        e.stopPropagation();
        e.preventDefault();
        if (el._onClick) el._onClick();
      });
      document.body.appendChild(el);
      this._aidBackEl = el;
    }
    el._onClick = onClick;
    el.textContent = label ? '← 返回 ' + label : '← 返回原文';
    el.title = '返回跳轉前的文章';
    el.style.display = 'block';
  },

  hideBackButton: function() {
    if (this._aidBackEl) this._aidBackEl.style.display = 'none';
  },

  // Modal-ish input overlay for T2 keyword/number collection (`/` search,
  // number jump). Owns its own keyboard: Enter → cb(trimmed value or null),
  // Esc → cb(null). Focus returns to the hidden terminal input afterwards.
  promptListInput: function(label, initial, cb) {
    var self = this;
    if (this._listInputWrap) this._listInputWrap.remove();
    var wrap = document.createElement('div');
    wrap.style.cssText =
      'position:fixed;left:50%;bottom:88px;transform:translateX(-50%);' +
      'background:rgba(20,40,70,.95);color:#fff;padding:10px 16px;' +
      'border-radius:6px;font-size:14px;z-index:2001;display:flex;' +
      'align-items:center;gap:8px;';
    var lab = document.createElement('span');
    lab.textContent = label;
    var input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-list-input', '1');
    input.value = initial || '';
    input.style.cssText =
      'background:#111;color:#fff;border:1px solid #557;border-radius:4px;' +
      'padding:2px 8px;font-size:14px;width:180px;outline:none;';
    wrap.appendChild(lab);
    wrap.appendChild(input);
    document.body.appendChild(wrap);
    this._listInputWrap = wrap;
    var finish = function(val) {
      if (self._listInputWrap !== wrap) return; // already closed
      window.removeEventListener('keydown', onWindowKey, true);
      wrap.remove();
      self._listInputWrap = null;
      if (self.bbscore && self.bbscore.setInputAreaFocus)
        self.bbscore.setInputAreaFocus();
      cb(val);
    };
    var handleKey = function(ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        var v = input.value.trim();
        finish(v.length ? v : null);
        return true;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        finish(null);
        return true;
      }
      return false;
    };
    input.addEventListener('keydown', function(ev) {
      ev.stopPropagation();
      handleKey(ev);
    });
    // Focus-independent net (window CAPTURE): the input grabs focus in a
    // setTimeout — a key arriving before that (fast typist / Playwright) lands
    // on #t where the global handlers deliberately ignore everything while the
    // overlay is open, so an early Escape/Enter would vanish and the overlay
    // wedge open. Catch them here regardless of focus; any other key just
    // pulls focus onto the input so the typed char lands in it (finish is
    // guarded, double-handling with the input's own listener is harmless).
    var onWindowKey = function(ev) {
      if (ev.target === input) return; // input's own listener handles it
      if (handleKey(ev)) {
        ev.stopPropagation();
        return;
      }
      if (
        document.activeElement !== input &&
        !ev.ctrlKey &&
        !ev.altKey &&
        !ev.metaKey
      )
        input.focus();
    };
    window.addEventListener('keydown', onWindowKey, true);
    setTimeout(function() {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
  },

  // Cursor
  updateCursorPos: function() {
    // 鍵盤游標底色跟著真游標走，而游標可能在「內容沒變」的幀單獨移動
    // （term_buf.notify 的 posChanged 分支），那種幀不會進 redraw → 底色會落後一步。
    // 放在所有 early-return 之前：上色與游標 DOM 無關，就算閃爍游標被隱藏也照樣要更新。
    this.applyCursorHighlight();
    if (this._cursorHidden) return;

    // PTT 偶爾把 cur_x 送成 cols（原註解：sometimes the value of cur_x is 80）。
    // **藏起來**，不是「不更新」——後者會讓可見的游標停在過期座標上。
    var outOfRange =
      this.buf.cur_y >= this.buf.rows || this.buf.cur_x >= this.buf.cols;
    if (outOfRange !== this._cursorOutOfRange) {
      this._cursorOutOfRange = outOfRange;
      this._applyCursorVisibility();
    }
    if (outOfRange) return;

    var lines = this.buf.lines;
    var line = lines[this.buf.cur_y];
    var ch = line[this.buf.cur_x];
    var bg = ch.getBg();

    // 縮放時 lastRowDiv 的 transform 由 setTermFontSize 寫，但那個 origin hack 只有在
    // 真的縮放的幀才成立，故這裡跟著游標一起維持（沿用原行為，與游標座標無關）。
    if (this.scaleX == 1 && this.scaleY == 1) {
      this.lastRowDiv.style.webkitTransformOriginY = '';
    } else {
      var scaleCss = 'scale('+this.scaleX+','+this.scaleY+')';
      this.mainDisplay.style.webkitTransform = scaleCss;
      this.lastRowDiv.style.webkitTransform = scaleCss;
      this.lastRowDiv.style.webkitTransformOriginY = '-1100%';
    }

    // **座標系合一**：#cursor 是 `.main` 的子元素（見建構子），所以這裡用的就是
    // `.main` 的內容座標 —— 原點在內容左上角。
    //   捲動：#cursor 跟列一起被 `.main` 帶著走 ⇒ 不必扣 scrollTop，連「捲動時要重算」
    //         都不需要（純滾輪不產生 term_buf 更新，舊實作就是這樣漏掉的）。
    //   縮放：`.main` 的 transform: scale() 一併套到游標 ⇒ 不必自己乘 scaleX/scaleY，
    //         也不必複製那套置中原點公式（它與實際 layout 差 5*(1-scaleY) px）。
    //   置中／邊界：marginTop、align=center、+10 的捲軸讓位全部由 `.main` 自己吸收。
    // **垂直位置錨在該列真正被畫出來的節點**（_rowAnchor → offsetTop），不是
    // `cur_y * chh`：後者是「這一列應該在哪」，前者是「實際在哪」，只要有任何一列的
    // line box 被撐大兩者就脫鉤（見 js/cursor_anchor.js 開頭）。
    // 這裡**不可以**再引入任何補償項；要補償就表示又把它搬出 `.main` 了。
    // 守護：tests/e2e/offline/cursor_shape.offline.spec.js
    var anchor = this._rowAnchor(this.buf.cur_y);
    var geo = cursorOffsets({
      row: anchor,
      cur_x: this.buf.cur_x, cur_y: this.buf.cur_y,
      cols: this.buf.cols, rows: this.buf.rows,
      chw: this.chw, chh: this.chh
    });
    this.bbsCursor.style.left = geo.left + 'px';
    this.bbsCursor.style.top = geo.top + 'px';
    // if you want to set cursor color by now background, use this.
    this.bbsCursor.style.color = cursorColorForBg(bg, this.workModeActive);
    this.updateInputBufferPos(anchor);
    this._sampleCursorGeom();
  },

  // 這一幀 buf 第 row 列**真正被畫出來**的節點的 offset（相對 `.main` —— 它是
  // position:relative，也就是 #cursor 的 containing block ⇒ 兩者同一個座標系）。
  //
  // 只在格線幀（_gridRender）才有意義：好讀累積長頁的 srow 是長頁列號，與 buf.cur_y
  // 毫無關係，拿它當錨會錨到隨機一列（那種幀游標本來就整個隱藏，但 #t 還是會讀，
  // 所以這裡要擋在源頭）。量不到就回 null，由 cursorOffsets 退回舊算術。
  //
  // **每次呼叫都現量，不做跨呼叫快取**：layout 會變的時機不只重繪與改字級（延遲載入
  // 的圖片落地、pref 切換 CSS class、字型落地都會），任何以「幀序號」為鍵的快取都會
  // 有吃到過期 offsetTop 的路徑，而那正是本函式要消滅的東西。一次 querySelector +
  // 一次 offset 讀取，成本落在游標移動這個頻率上，可以接受。
  // 同一次 updateCursorPos 之內由呼叫端把結果傳給 updateInputBufferPos，不重複量。
  _rowAnchor: function(row) {
    if (!this._gridRender) return null;
    var cont = this.mainContainer;
    var el = cont
      ? cont.querySelector('[type="bbsrow"][srow="' + row + '"]')
      : null;
    return el ? { offsetTop: el.offsetTop, offsetLeft: el.offsetLeft, el: el } : null;
  },

  // debug 錄製器的幾何取樣。**只在真的在錄、而且游標真的移動了**才做——
  // cursorGeomSample 會 getBoundingClientRect ⇒ 強制 reflow。
  _sampleCursorGeom: function() {
    var rec = this.bbscore && this.bbscore.debugRecorder;
    if (!rec || !rec.isRecording) return;
    var key = this.bbsCursor.style.left + ',' + this.bbsCursor.style.top;
    if (key === this._lastGeomKey) return;
    this._lastGeomKey = key;
    rec.log('cursor.geom', cursorGeomSample(this));
  },

  // 這一幀游標那一格的**螢幕座標**（viewport），給 `#t` 用。
  //
  // `#t` 刻意留在 `.main` **外面**（#BBSWindow 底下，見 index.html 的註解：它平時
  // 在視口外，一旦成為捲動容器的子孫，focus() 就會把長頁捲飛）。既然出不了 `.main`，
  // 就不要另外算一套格線公式 —— 舊的 convertMN2XYEx **完全不扣 .main.scrollTop**，
  // 縮放分支的垂直原點又漏算 10px（誤差 5*(1-scaleY) px），已刪除。
  //
  // 改成錨在該列真正被畫出來的節點的 getBoundingClientRect()：它天然含 scrollTop 與
  // transform: scale()。而 #BBSWindow 是 position:fixed、top/left:0、100%×100%、無
  // border/padding ⇒ **它的 padding box 原點就是 viewport 原點**，所以 viewport
  // 座標可以直接當 `#t`（position:absolute）的 left/top，不需要任何換算。
  //
  // **不要改用 #cursor 的 rect 當錨**：#cursor 基底 CSS 是 display:none，靠
  // body.blink--active 每秒 toggle ⇒ 有一半時間量到全 0。
  //
  // 沒有可錨的列（好讀累積長頁：格線座標在那裡沒有意義，_rowAnchor 回 null）時
  // **不要把框留在 -100000px**：那會讓 OS 的候選字清單跑到瀏覽器自選的角落。改停在
  // `.main` 可視區的左下角 —— 也就是原生輸入列將要出現的位置（任何送得出去的字都會
  // 先讓 easy_reading 進 functionMode 鏡像原生，屆時就改吃精確錨點）。這裡用的是
  // `.main` 自己的矩形，不是「原點公式 + 補償項」。
  _cellClientRect: function(anchor) {
    anchor = anchor || this._rowAnchor(this.buf.cur_y);
    if (!anchor || !anchor.el) {
      if (!this.mainDisplay) return null;
      var m = this.mainDisplay.getBoundingClientRect();
      var h = this.chh * this.scaleY;
      return { left: m.left, top: Math.max(m.top, m.bottom - h), height: h };
    }
    var r = anchor.el.getBoundingClientRect();
    return {
      left: r.left + this.buf.cur_x * this.chw * this.scaleX,
      top: r.top,
      height: r.height || this.chh * this.scaleY
    };
  },

  // anchor 由 updateCursorPos 傳進來（同一次更新只量一次）；獨立呼叫（composition
  // 開始、輸入中改寬度）時自己量。
  updateInputBufferPos: function(anchor) {
    if (this.input.getAttribute('bshow') != '1') return;
    var cell = this._cellClientRect(anchor);
    if (!cell) return;

    this.input.style.opacity = '1';
    this.input.style.border = 'double';
    this.input.style.fontSize = this.chh-4 + 'px';
    this.input.style.height = this.chh + 'px';

    // 邊界 clamp 沿用原行為：塞不下就翻到該格上方／往左靠。基準換成 viewport
    // （#BBSWindow 就是整個 viewport，見上）。
    //
    // 尺寸用 **offsetWidth/Height（外框）而不是 style.height**：#t 是
    // box-sizing:content-box + border:double ⇒ 外框比 style.height 多了邊框那幾 px。
    // 用內容高去翻到上方，框就會壓進該列裡（實測差 8px）。舊實作那個 +4 的補正
    // 就是在補這件事，補不準，已拿掉。
    var bbswinheight = this.innerBounds.height;
    var bbswinwidth = this.innerBounds.width;
    var ih = this.input.offsetHeight || parseFloat(this.input.style.height);
    var iw = this.input.offsetWidth || parseFloat(this.input.style.width) || 0;
    if (bbswinheight < cell.top + cell.height + ih)
      this.input.style.top = (cell.top - ih) + 'px';
    else
      this.input.style.top = (cell.top + cell.height) + 'px';

    if (bbswinwidth < cell.left + iw)
      this.input.style.left = (bbswinwidth - iw - 10) + 'px';
    else
      this.input.style.left = cell.left + 'px';
  },

  updateInputBufferWidth: function() {
    // change width according to input
    var wordCounts = u2b(this.input.value).length;
    // chh / 2 - 2 because border of 1
    var oneWordWidth = (this.chh/2-2);
    var width = oneWordWidth*wordCounts;
    this.input.style.width  = width + 'px';
    var bounds = this.innerBounds;
    if (parseInt(this.input.style.left) + width + oneWordWidth*2 >= bounds.width) {
      this.input.style.left = bounds.width - width - oneWordWidth*2 + 'px';
    }
  },

  onCompositionStart: function(e) {
    //this.input.disabled="";
    this.input.setAttribute('bshow', '1');
    this.updateInputBufferPos();
    this.isComposition = true;
  },

  onCompositionEnd: function(e) {
    //this.input.disabled="";
    this.input.setAttribute('bshow', '0');
    this.input.style.border = 'none';
    this.input.style.width =  '1px';
    this.input.style.height = '1px';
    this.input.style.left =  '-100000px';
    this.input.style.top = '-100000px';
    this.input.style.opacity = '0';
    //this.input.style.top = '0px';
    //this.input.style.left = '-100000px';
    this.isComposition = false;
  },

  fontResize: function() {
    var cols = this.buf ? this.buf.cols : 80;
    var rows = this.buf ? this.buf.rows : 24;

    {
      var width = this.bbsWidth ? this.bbsWidth : this.innerBounds.width;
      var height = this.bbsHeight ? this.bbsHeight : this.innerBounds.height;
      if (width === 0 || height === 0) return; // errors for openning in a new window
      width -= 10; // for scroll bar

      var o_h, o_w, i = 4;
      var nowchh = this.chh;
      var nowchw = this.chw;
      do {
        ++i;
        nowchh = i*2;
        nowchw = i;
        o_h = (nowchh) * rows;
        o_w = nowchw * cols;
      } while (o_h <= height && o_w <= width);
      --i;
      nowchh = i*2;
      nowchw = i;
      this.fixedResize(nowchh);
    }
  },

  fixedResize: function(fontSizePx) {
    // 把列高對齊整數裝置像素，避免小數 devicePixelRatio（如 Windows 顯示縮放 125%
    // → DPR 1.25）下各列邊界被獨立四捨五入而漏出列間黑縫（ASCII 進版圖裂痕）。
    // floor 確保不超出原本 fontResize 算出的可容納高度而裁切末列；DPR=1 時不變。
    var dpr = window.devicePixelRatio || 1;
    let chh = Math.floor(fontSizePx * dpr) / dpr;
    let chw = chh / 2;

    this.setTermFontSize(chw, chh);

    var forceWidthElems = document.querySelectorAll('.wpadding');
    for (var i = 0; i < forceWidthElems.length; ++i) {
      var forceWidthElem = forceWidthElems[i];
      forceWidthElem.style.width = chh + 'px';
    }
  },

  calcTermSizeFromFont: function(fontSizePx) {
    fontSizePx = Math.floor((fontSizePx + 1) / 2) * 2;
    let width = this.bbsWidth ? this.bbsWidth : this.innerBounds.width;
    let height = this.bbsHeight ? this.bbsHeight : this.innerBounds.height;
    return {
      cols: Math.max(80, Math.min(200, Math.floor(2 * (width - 10) / fontSizePx))),
      rows: Math.max(24, Math.min(100, Math.floor(height / fontSizePx)))
    };
  },

  getRowLineElement: function(node) {
    for (let r = node; r && r != r.parentNode; r = r.parentNode) {
      if (r instanceof Element &&
        r.getAttribute('data-type') == 'bbsline') {
        return r;
      }
    }
    return null;
  },

  countCol: function(node, pos) {
    let rowNode = this.getRowLineElement(node);
    if (!rowNode) {
      return { row: 0, col: 0 };
    }

    let col = 0;
    let doCount = function(cur) {
      if (cur == node) {
        col += u2b(cur.textContent.substring(0, pos)).length;
        return false;
      }
      if (cur.nodeName == '#text') {
        col += u2b(cur.textContent).length;
        return true;
      }
      for (let e of cur.childNodes) {
        if (!doCount(e)) {
          return false;
        }
      }
      return true;
    };
    doCount(rowNode);

    return {
      row: parseInt(rowNode.getAttribute('data-row')),
      col: col
    };
  },

  getSelectionColRow: function() {
    let r = window.getSelection().getRangeAt(0);
    return {
      start: this.countCol(r.startContainer, r.startOffset),
      end: this.countCol(r.endContainer, r.endOffset)
    };
  },

  // --- 背景通知（水球 / deep link 交接共用）---------------------------------
  //
  // 三件事必須一起做，所以只能有一份實作：
  //   1. document.title 交替閃爍 —— **沒有通知權限時唯一還有效的手段**。權限只在
  //      PrefModal（勾選通知 pref 時、關閉設定頁時）問，沒進過設定頁的使用者一律
  //      是 'default'，所以這一直是真正在運作的那個通道，不是備援。
  //   2. system Notification —— best effort，任何失敗都只是「沒有系統通知」。
  //      它的 onclick 是**唯一**能把瀏覽器切到本分頁的路：那裡有 user activation，
  //      window.focus() 才叫得動（背景分頁自己呼叫是無效的，見 docs/deep-link.md）。
  //   3. 使用者切回本分頁時全部復原（stopTitleFlash）。
  showBackgroundNotification: function(opts) {
    // 只留最後一則：兩個 interval 會互搶 document.title。先停也讓下面那行讀到的
    // 一定是**使用者原本看到的**標題。
    this.stopTitleFlash();
    // 閃爍的基準是當下的標題，不是 connectedUrl.site：全 app 從來沒有把
    // document.title 設成連線位址過（index.html 的 <title> 一路留著），舊的水球
    // 版本拿 site 當基準，於是第一次 tick 就把標題換成 `wsstelnet://…`，停下來
    // 之後也還原成那串而不是原本的標題。
    var base = document.title;
    this._flashBaseTitle = base;
    var flashText = opts.titleText;
    this.titleTimer = setTimer(true, function() {
      document.title = (document.title === base) ? flashText : base;
    }, 1500);
    this.notif = this._createNotification(opts);  // 可能是 null（沒權限／不支援）
    return !!this.notif;
  },

  // 絕不可 throw：Notification 在非 secure context 根本不存在（`new Notification`
  // 會 ReferenceError，而呼叫鏈的頂端是 App.onData —— 一路炸出去會把整條收包路徑
  // 打斷）。權限是 default/denied 時各家瀏覽器行為也不一致。全部收斂成「回 null」。
  _createNotification: function(opts) {
    try {
      if (typeof Notification === 'undefined') return null;
      if (Notification.permission !== 'granted') return null;
      var notif = new Notification(opts.title, {
        icon: icon128,
        body: opts.body,
        tag: opts.tag
      });
      notif.onclick = function() {
        window.focus();
        if (opts.onClick) opts.onClick();
        notif.close();
      };
      return notif;
    } catch (e) {
      return null;
    }
  },

  // 停閃爍 + 還原標題 + 關掉通知。**全部 null-safe**：舊版 App 的 focus handler
  // 無條件呼叫 `view.notif.close()`，一旦出現「有 titleTimer 但沒有 notif」
  // （＝沒有通知權限，而那正是常態）就 TypeError。
  stopTitleFlash: function() {
    if (this.titleTimer) {
      this.titleTimer.cancel();
      this.titleTimer = null;
    }
    // 只有真的閃過才動標題（沒閃過就沒有東西要還原，別把別人設的標題蓋掉）。
    if (this._flashBaseTitle != null) {
      document.title = this._flashBaseTitle;
      this._flashBaseTitle = null;
    }
    if (this.notif) {
      try {
        this.notif.close();
      } catch (e) {}
      this.notif = null;
    }
  },

  showWaterballNotification: function() {
    if (!this.enableNotifications) {
      return;
    }
    var app = this.bbscore;
    var title = app.waterball.userId + ' ' + i18n('notification_said');
    this.showBackgroundNotification({
      title: title,
      titleText: title + ' ' + app.waterball.message,
      body: app.waterball.message,
      tag: app.waterball.userId
    });
  },

  // Deep link 交接：這個分頁替另一個分頁收下了一個外部連結，而使用者的眼睛在**別
  // 的**分頁上（外部連結一定開新分頁，這裡是背景）。三層都做：
  //   - 頁內橫幅：**不受 pref 控制**。成本為零，而且是使用者切回來之後唯一還看得到
  //     「剛剛發生了什麼」的痕跡。
  //   - 標題閃爍 + 系統通知：受 deepLinkHandoffNotify 控制，且**這個分頁必須不在
  //     前景**。眼睛就在這裡的話通知是純噪音；更要命的是標題閃爍會停不下來——
  //     stopTitleFlash 掛在 window 'focus' 與 'visibilitychange'（見 pttchrome.jsx），
  //     分頁本來就在前景的話那兩個事件都不會再來，得切走再切回來才會停。所以前景
  //     時是連閃爍一起略過，不是只擋系統通知。
  //
  // 時機刻意是「收到交接的當下」而不是「跳完」：這則通知要回答的是「你該去哪個
  // 分頁」，而且接手的分頁若還沒登入，跳轉會被 controller 收著等登入 —— 落地可能
  // 永遠不會發生，使用者卻得先知道有東西在等他。
  notifyDeepLinkHandoff: function(target) {
    var label = '#' + target.aid + ' (' + target.board + ')';
    if (this.flashListHint)
      this.flashListHint(i18n('hint_deepLinkHandoffReceived') + ' ' + label, 8000);
    if (!this.deepLinkHandoffNotify) return false;
    if (isDocumentForeground(document)) return false;
    var title = i18n('notification_deepLinkHandoffTitle');
    return this.showBackgroundNotification({
      title: title,
      titleText: title + ' ' + label,
      body: label,
      tag: 'pttchrome-deeplink-handoff'
    });
  },

  // Accumulate the easy-reading scroll page into buf.pageLines (pure JS, no DOM).
  // Called only for article pages (pageState 3) from redraw; the actual draw is done
  // by the caller via _renderScreenLines(buf.pageLines). Cross-page de-dup sizes the
  // overlap from PTT's status-line row numbers ("目前顯示: 第 S~E 行") when available,
  // with row-CONTENT comparison (findPageOverlap) as cross-check / fallback — see
  // comment_parse.resolvePageOverlap and docs/enhanced-addon.md.
  accumulatePageLines: function() {
    // The bottom status-row overlay (#easyReadingLastRow, margin-top:-1em) sits over the
    // last viewport row. Reserve one line of bottom padding so the article's last line can
    // scroll clear of it. Critical for a SHORT (single PTT-page) article whose RENDERED
    // height still exceeds the viewport — e.g. an inline image makes it scrollable — which
    // only ever takes the first-page branch below: without padding its last line stays
    // hidden behind the overlay (user sees the final line/最後一行 "disappear", though it
    // IS in pageLines). Both branches are article pages that show the overlay;
    // hideEasyReadingOverlays clears the padding again when we return to a list/menu.
    if (this.mainContainer) this.mainContainer.style.paddingBottom = '1em';
    // parseStatusRow gates this to an article reading page AND supplies the absolute
    // row numbers (rowIndexStart/End) that drive de-duplication — see resolvePageOverlap.
    var lastRowText = this.buf.getRowText(this.buf.rows-1, 0, this.buf.cols);
    var result = parseStatusRow(lastRowText);
    // COMPLETE-RESPONSE GATE (pmore invariant P6, docs/pttbbs-screen-protocol.md §13).
    // pfterm ends every server response with a cursor park at (rows-1, cols-1)
    // (fterm_rawcursor → fterm_rawmove_opt), and it patches the footer per CELL — so a
    // half-painted frame still shows the PREVIOUS page's "第 S~E 行". Accumulating off
    // such a frame writes a stale rowIndexEnd into _accEndRow, and every later overlap
    // is then measured from a wrong baseline (that drift is exactly what forced
    // resolvePageOverlap to grow its 0.5 match-ratio guard). Gate instead: only a frame
    // whose cursor is parked is a complete response. Incomplete frames fall through to
    // render-only below (pageLines untouched → the view simply keeps showing the last
    // accumulated state, no flicker). Same predicate the paging state machine uses
    // (easy_reading.nextEasyReadingRowState), so both agree on what "settled" means.
    var complete = this.buf.cur_y === this.buf.rows - 1 &&
                   this.buf.cur_x === this.buf.cols - 1;
    var newRows = this.buf.lines.slice(0, -1); // drop the status row
    // Only the last `newRows.length` accumulated rows can overlap, so map just
    // the tail to text (keeps it O(screen), not O(article)).
    var accTail = null, newTexts = null, maxK = 0, kContent = 0, headerChanged = false;
    // A gap seek (':N\r') is in flight — see EasyReading._healAtLine. prevPageState may
    // have been poisoned by the goto prompt's frame, so it must not gate the overlap
    // precompute either: without accTail/kContent, resolvePageOverlap loses its content
    // cross-check exactly on the frame that needs it most.
    var healing = !!this.buf.easyReadingHealInFlight;
    if (complete && (this.buf.prevPageState == 3 || healing) && result && this.buf.pageLines.length) {
      accTail = this.buf.pageLines.slice(-newRows.length).map(rowToText);
      newTexts = newRows.map(rowToText);
      maxK = Math.min(accTail.length, newTexts.length);
      kContent = findPageOverlap(accTail, newTexts);
      // Article identity for the self-heal: accumulated first row (作者 header)
      // vs this screen's first row — both non-blank and DIFFERENT ⇒ another
      // article's first page (a half-painted repaint of the same first page has
      // an equal or blank head and must not restart accumulation).
      var accHead = rowToText(this.buf.pageLines[0]).replace(/\s+$/, '');
      var newHead = (newTexts[0] || '').replace(/\s+$/, '');
      headerChanged = accHead !== '' && newHead !== '' && accHead !== newHead;
    }
    // rebuild vs append vs skip lives in a pure function (unit-guarded): the sticky
    // buf.easyReadingPendingReset ([ ]/leaveCurrentPost) is only consumed on a
    // confirmed first article page, and a first page with zero content overlap
    // plus a changed header self-heals to rebuild — both defend the
    // same-title-jump pile-up race (prevPageState=0 eaten by a stale frame →
    // new article concatenated under the old one). See decideAccumulateBranch.
    // P1 check (classifyPageTransition): 'gap' == statusStart ran PAST accEndRow, which
    // a single PageDown can never produce ⇒ a whole screen was swallowed (typeahead
    // skip, P4) and its text is gone for good. Don't append a hole — flag it and let
    // EasyReading._healFromTop re-read the article from the top.
    var transition = classifyPageTransition({
      accEndRow: this._accEndRow,
      statusStart: result ? result.rowIndexStart : null,
      statusEnd: result ? result.rowIndexEnd : null
    });
    var branch = decideAccumulateBranch({
      complete: complete,
      prevPageState: this.buf.prevPageState,
      pendingReset: !!this.buf.easyReadingPendingReset,
      statusStart: result ? result.rowIndexStart : null,
      kContent: kContent,
      hasAcc: this.buf.pageLines.length > 0,
      headerChanged: headerChanged,
      transition: transition,
      healInFlight: healing
    });
    if (branch === 'gap') {
      // Lost page. Leave pageLines untouched (a hole is worse than a stale tail) and
      // raise the flag EasyReading consumes on the next viewUpdate/settle.
      console.log('easy reading: lost page, acc ends at ' + this._accEndRow +
                  ' but screen starts at ' + result.rowIndexStart);
      this.buf.easyReadingGapDetected = true;
      this._mirrorStatusRowToFooter();
      return;
    }
    if (branch === 'append') {
      // Same article, paged down: append only the genuinely new tail. PTT re-shows
      // the previous screen's bottom at the top of the new one; resolvePageOverlap
      // measures that overlap so we skip re-adding it.
      // Primary overlap = status-line row numbers (exact regardless of paint state, so
      // a half-painted frame can't shrink k → no duplicate block). findPageOverlap's
      // content result is the cross-check / fallback + drift guard. this._accEndRow is
      // the article-line number of pageLines' last row (prev screen's rowIndexEnd).
      var beginIndex = resolvePageOverlap({
        accEndRow: this._accEndRow,
        statusStart: result.rowIndexStart,
        kContent: kContent,
        maxK: maxK,
        accTail: accTail || [],
        newTexts: newTexts || newRows.map(rowToText)
      });
      // Snapshot-clone the new tail (see cloneRow). pageLines is BOTH the render
      // source (<Screen lines={pageLines}>) and the selection source (getText reads
      // it, incl. ANSI colours). It keeps the FULL rows even for blacklisted ones,
      // so copy still has the original text — the blacklist drop happens only at
      // render time (Screen dropHidden). A forced redraw (pref/pusher toggle)
      // re-enters here with the same screen; kStatus then equals maxK so beginIndex ==
      // newRows.length and nothing is double-appended.
      this.buf.pageLines = this.buf.pageLines.concat(newRows.slice(beginIndex).map(cloneRow));
      // Advance the tracked article-line position to this screen's end.
      this._accEndRow = result.rowIndexEnd;
      this._lastAccumulatedSig = result.rowIndexStart + '~' + result.rowIndexEnd;
      // The gap seek landed and its rows are spliced in — drop the gate.
      if (healing) this.buf.easyReadingHealInFlight = false;
    } else if (branch === 'rebuild') {
      // First page of a (new) article: restart the accumulated page as this whole
      // screen and clear the per-article pusher selection.
      // Consume the sticky flag only on a CONFIRMED first article page; a stale
      // mid-article frame that lands here (prevPageState!=3) must not eat it, or
      // the race the flag defends against re-opens.
      if (result && result.rowIndexStart === 1)
        this.buf.easyReadingPendingReset = false;
      // 同 redraw 的清空點：只設欄位，由隨後的 render 同步給 ScreenController。
      this._selectedPusher = null;
      // New article (or re-entry into the same article): bump the instance id so
      // Screen resets the enlarge-images toggle back to default small images.
      ++this._articleInstanceId;
      this.buf.pageLines = newRows.map(cloneRow);
      // Seed overlap tracking from this first screen's status row (null if it's a
      // transient non-article frame — resolvePageOverlap then falls back to content).
      this._accEndRow = result ? result.rowIndexEnd : null;
      this._lastAccumulatedSig =
        result ? (result.rowIndexStart + '~' + result.rowIndexEnd) : null;
    }
    // branch === 'skip': transient half-painted frame while continuing — leave the
    // accumulated page untouched (footer mirror below still guards itself).
    // Footer overlay = a LIVE mirror of the REAL bottom status row (page X/Y, %,
    // (h)說明…, with the genuine colours) instead of a hardcoded string, so it always
    // matches what native shows. See _mirrorStatusRowToFooter.
    this._mirrorStatusRowToFooter();
  },

  // Render the real bottom status row (buf.lines[rows-1]) into the footer overlay
  // (#easyReadingLastRow). Guarded by parseStatusRow so a transient half-painted frame
  // (empty last row) never blanks the footer — we keep the previous content then.
  _mirrorStatusRowToFooter: function() {
    var statusText = this.buf.getRowText(this.buf.rows-1, 0, this.buf.cols);
    if (parseStatusRow(statusText)) {
      var el = document.createElement('span');
      el.style = "background-color:black;";
      var statusChars = this.buf.lines[this.buf.rows-1];
      // 功能鍵按鈕：這條路不經 computeAnnotations（見 term_ui.renderOverlayRow），
      // 故在這裡自己解析。gate 與 _renderScreenLines 那邊一致。
      var fnKeys = null;
      if (this.mouseFunctionKeys && this.buf.useMouseBrowsing && this.onFunctionKey) {
        var parsed = parseFunctionKeys(statusChars);
        if (parsed) {
          var onFunctionKey = this.onFunctionKey;
          fnKeys = parsed.map(function(item) {
            return {
              startCol: item.startCol,
              endCol: item.endCol,
              label: item.label,
              onClick: function() { onFunctionKey(item.keyBytes, item.label); }
            };
          });
        }
      }
      renderOverlayRow(statusChars, this.chh, el, fnKeys);
      this.setSingleChild(this.lastRowDiv.childNodes[0], el);
    }
    this.lastRowDiv.style.display = 'block';
  },

  // Toggle whole-row highlight for all comments by `userid` (click handler).
  // Clicking the selected pusher again clears it; clicking another switches.
  //
  // **絕對不要 redraw(true)**（2026-08 修）：高亮曾經是 annotation 的一個欄位，
  // 而 selectedPusher 進了 annotationsKey ⇒ 點一下推文列就讓整份好讀累積長頁全量
  // 重算（含每個 run 的 buildMergedCommentChars）＋每一列節點重建。兩個症狀：
  //   1. 每個 inlinePreviewSlot 被 disposeNode 收掉重建，新 slot 的 pinned=null
  //      ⇒ minHeight 歸零 ⇒ 圖片／影片佔位盒塌陷成 0 高，等 IntersectionObserver
  //      → mount → onLoad → ResizeObserver 這串非同步流程才撐回來（使用者回報：
  //      合併推文的空白區閃爍、隱約看到別行推文）。
  //   2. 節點抽換發生在雙擊的第二個 mousedown **之前** ⇒ 瀏覽器的雙擊選詞落在已被
  //      換掉的節點／位移後的版面上（使用者回報：雙擊選字時好時壞）。
  // 高亮只是一個 class ⇒ 交給 renderer 逐列切換（同 setCursorHighlight 快路徑）。
  togglePusherHighlight: function(userid) {
    if (!userid) return;
    this._selectedPusher = this._selectedPusher === userid ? null : userid;
    this.componentScreen.setSelectedPusher(this._selectedPusher);
  },

  // Accumulate the currently painted board page into buf.listLines for list easy
  // reading. ASCENDING (matches native top→bottom: oldest at top, newest at the bottom,
  // ★pinned rows last). Accumulation is keyed in two maps on the view (reset via
  // resetListAccumulation on fresh board entry; kept across an article open/return so
  // restore is instant):
  //   _listNumMap    number → row — numbered articles, OVERWRITTEN per re-paint so a
  //                                 re-shown page's live changes (推文數 / `v` 已讀標記)
  //                                 replace the stale clone.
  //   _listPinnedMap title  → row — ★pinned/置底 rows. Keyed by the TITLE slice, not the
  //                                 whole row text: the push-count column changes live
  //                                 and a text key would duplicate the row (v3 bug).
  // flattenListBuffer rebuilds buf.listLines/buf.listLineNums (ascending + pinned tail).
  // pageArticleNums recovers the digit an old ● cursor covered; cloneRow (not JSON) keeps
  // TermChar methods. The caller (redraw) handles scroll-anchoring when older rows prepend.
  accumulateListLines: function() {
    var buf = this.buf;
    if (!this._listNumMap) this._listNumMap = new Map();
    if (!this._listPinnedMap) this._listPinnedMap = new Map();
    var rowTexts = [];
    for (var r = 0; r < buf.rows; ++r) rowTexts.push(buf.getRowText(r, 0, buf.cols));
    var nums = pageArticleNums(rowTexts, buf.cur_y);
    var ls = this.bbscore && this.bbscore.listSession;
    var entries = [];
    for (var i = 0; i < buf.rows; ++i) {
      if (nums[i] != null) {
        var row = cloneRow(buf.lines[i]);
        // Normalize the "%7d" number column from the resolved number on EVERY numbered
        // row, not just the cursor row: besides the cursor mark, a partial redraw can
        // blank the leading digit cell of any row (see relabelListCursorRow). The map
        // must always hold a row that renders like a clean native one.
        relabelListCursorRow(row, nums[i]);
        // Server-painted last-read styling = title-match highlight (pttbbs
        // readdoent: every row whose subject equals currtitle, in the row's own
        // mark color — see list_session's styling block). Store the CLEAN row
        // and teach the session the SUBJECT; render re-paints every matching
        // row (buildListWindowLines). Otherwise an off-frame styled row stays
        // colored in the map forever (殘紅).
        if (isLastReadStyledListRow(row)) {
          normalizeLastReadListRow(row);
          if (ls) ls.noteLastRead(subjectOfListRow(row));
        }
        entries.push({ num: nums[i], key: null, row: row });
      } else if (
        isPinnedListRow(rowTexts[i]) &&
        (i !== buf.cur_y || rowTexts[i].indexOf('★') >= 0) &&
        // A mid-response frame can paint the server's cursor mark on a row that is
        // NOT buf.cur_y (jump response: mark drawn, cursor not parked yet) — no
        // neighbour recovery runs, so nums[i] is null and the author column is
        // valid, which matches the pinned signature. Loose-parse tells them
        // apart: digits behind the cursor mark = a covered NUMBERED row. It does NOT
        // strip ★ (see parseListArticleNumLoose), so a genuine pinned row — whose
        // ★ is followed by a bare-integer push-count like "★    4 …" — still reads
        // null and is collected. Without this guard the cursor row is stored (mark
        // included) in the pinned map forever (the「●52880 殘留在置底尾巴」bug).
        parseListArticleNumLoose(rowTexts[i]) == null
      ) {
        // ★pinned/置底 row. A cursor row with an UNRECOVERABLE number (no numbered
        // neighbour — only possible under the old full-width ●, which swallowed the
        // top digit) also matches the pinned signature (no number + valid author) but
        // carries no ★ — keep excluding those (v3 trap #4: stray cursor row misfiled
        // as pinned). A genuine pinned row under the cursor still shows its ★ (the
        // mark only covers leading padding cells), so it IS collected — otherwise a
        // cursor parked on a pinned row keeps that announcement out of the buffer
        // forever (v4-stabilize bug 2b: 置底文少一篇). Restore the cursor cells to spaces.
        var prow = cloneRow(buf.lines[i]);
        if (i === buf.cur_y) blankListCursorMark(prow);
        entries.push({
          num: null,
          key: pinnedRowKey(rowTexts[i]),
          row: prow
        });
      }
    }
    mergeListPage(this._listNumMap, this._listPinnedMap, entries);
    // Row cap: evict the end farthest from the selection so redraw cost stays
    // bounded (a few hundred rows ≈ the native feel). The session must clear
    // the matching edge flag — demand re-fetches an evicted segment later.
    var ev = evictListBuffer(this._listNumMap, ls ? ls._selectedNum : null, MAX_LIST_ROWS);
    if (ls && ev.evictedUp) ls.noteEvicted(-1);
    if (ls && ev.evictedDown) ls.noteEvicted(1);
    // Contiguity guard: the window must never span pages we skipped over (far
    // jumps: End / Home / open-pinned). Keep only the pivot's segment; the
    // dropped side's edge flag is cleared so demand can re-fetch it.
    var pr = pruneListToSegment(this._listNumMap, ls ? ls.prunePivot() : null);
    if (ls && pr.prunedUp) ls.noteEvicted(-1);
    if (ls && pr.prunedDown) ls.noteEvicted(1);
    var flat = flattenListBuffer(this._listNumMap, this._listPinnedMap);
    buf.listLines = flat.lines;
    buf.listLineNums = flat.nums;
    // Cache the surrounding chrome for the window render off clean-list-shaped
    // live frames only (a jump response blanks the bottom row — protocol §4 ✚ —
    // and must not poison the footer cache).
    if (
      (rowTexts[0] || '').indexOf('《') >= 0 &&
      (rowTexts[2] || '').indexOf('編號') >= 0
    ) {
      this._listHeaderRows = [
        cloneRow(buf.lines[0]),
        cloneRow(buf.lines[1]),
        cloneRow(buf.lines[2])
      ];
    }
    if ((rowTexts[buf.rows - 1] || '').indexOf('文章選讀') >= 0) {
      this._listFooterRow = cloneRow(buf.lines[buf.rows - 1]);
    }
  },

  // Assemble the fixed 24-row native-parity list page: cached header (3 rows) +
  // the session's window slice (20 body rows; blank filler past the end, same
  // as a native short page) + cached footer. The cursor row is a clone with the
  // native half-width '>' painted over cell 0 (labelListCursor — the inverse of
  // relabelListCursorRow; matches pttbbs STR_CURSOR since b9a5029f, ASCII so no
  // Big5 conversion is involved). Returns null until the header/footer
  // caches and the buffer exist (caller falls back to the native mirror).
  // Also snapshots the result for the frozen render.
  //
  // **這裡回傳的列物件是 render 層節點重用的身分依據**（enhance.rowIdentityStable
  // → render/screen.js#_buildNodes 的 prevLines[row] === lines[row]）：map／cache
  // 裡的列一旦存進去就**不得就地改寫**。目前所有加工都寫在 cloneRow 出來的新物件
  // 上（relabelListCursorRow / normalizeLastReadListRow / blankListCursorMark），
  // mergeListPage 則是整列覆蓋（map.set）。破壞這條的症狀是「列表視窗畫出上一幀的
  // 內容」（推文數／已讀標記停在舊值）。
  // 另外重用是 **index-keyed**：視窗捲動讓同一個列物件換到別的渲染列號時，
  // prevLines[row] 對不上 ⇒ 自動重畫，data-row 不會錯位。
  buildListWindowLines: function() {
    var ls = this.bbscore && this.bbscore.listSession;
    if (!ls || !this._listHeaderRows || !this._listFooterRow) return null;
    var win = ls.getWindowView();
    if (!win) return null;
    var listLines = this.buf.listLines || [];
    var out = [
      this._listHeaderRows[0],
      this._listHeaderRows[1],
      this._listHeaderRows[2]
    ];
    // Last-read decoration: the map stores CLEAN rows (normalizeLastReadListRow
    // at accumulate); the highlight is re-painted here on a clone of EVERY row
    // whose subject matches the session's _lastReadTitle (pttbbs readdoent's
    // strcmp(currtitle, subject_ex(title)) — same-thread rows all light up),
    // each in its own mark color. Subjects are memoized per stored row object
    // (rows are replaced wholesale on re-accumulate, so the cache never goes
    // stale).
    var lastReadTitle = ls._lastReadTitle;
    this._listCursorRow = -1;
    for (var i = 0; i < win.body.length; ++i) {
      var abs = win.body[i];
      var srcRow = abs == null ? null : listLines[abs];
      var isLastRead = false;
      if (srcRow && lastReadTitle != null) {
        if (srcRow._subject === undefined) srcRow._subject = subjectOfListRow(srcRow);
        isLastRead = srcRow._subject === lastReadTitle;
      }
      if (!srcRow) {
        out.push(this._blankListRow());
      } else if (abs === win.cursorAbs) {
        var cur = cloneRow(srcRow);
        labelListCursor(cur);
        if (isLastRead) paintLastReadListRow(cur);
        // 虛擬游標的**渲染列號**（header 固定 3 列）→ 游標底色的上色目標。
        // frozen 不重算，沿用這份快照的值，與 _listWindowLines 同生命週期。
        this._listCursorRow = LIST_HEADER_ROWS + i;
        out.push(cur);
      } else if (isLastRead) {
        var lr = cloneRow(srcRow);
        paintLastReadListRow(lr);
        out.push(lr);
      } else {
        out.push(srcRow);
      }
    }
    out.push(this._listFooterRow);
    // 平滑捲動的 overscan 列：視口捲掉頂端 frac px 之後，底部會空出同樣高度 ⇒
    // 多畫下一列補滿。**放在 footer 後面**（渲染 index 24）是刻意的：footer 的
    // data-row 必須維持 23（外部契約，見 render_dom_equivalence 的 golden）。
    // render 端（src/render/screen.js#_patchRows）會把它排進 body 視口裡。
    if (win.overscanAbs != null) {
      var ovRow = listLines[win.overscanAbs];
      if (!ovRow) {
        out.push(this._blankListRow());
      } else if (lastReadTitle != null && ovRow._subject === lastReadTitle) {
        var ovLr = cloneRow(ovRow);
        paintLastReadListRow(ovLr);
        out.push(ovLr);
      } else {
        out.push(ovRow);
      }
    }
    this._listWindowLines = out;
    return out;
  },

  // One shared blank TermChar row (default attrs) for short-page filler.
  _blankListRow: function() {
    if (this._listBlankRow) return this._listBlankRow;
    var src = this._listHeaderRows[0];
    var row = cloneRow(src);
    for (var i = 0; i < row.length; ++i) {
      row[i].ch = ' ';
      row[i].isLeadByte = false;
      row[i].resetAttr();
    }
    this._listBlankRow = row;
    return row;
  },

  // Clear the list-accumulation maps (fresh board entry / board switch rebuild).
  resetListAccumulation: function() {
    this._listNumMap = null;
    this._listPinnedMap = null;
    this._listHeaderRows = null;
    this._listFooterRow = null;
    this._listWindowLines = null;
    this._listBlankRow = null;
  },

  // Like hideEasyReadingOverlays but does NOT clear buf.pageLines. Used by the
  // functionMode native-LIVE render: we only want the overlay rows out of the way
  // while mirroring the native screen; the accumulated long page must survive so
  // _evalFunctionModeExit('resume') can restore it without re-paging the article.
  //
  // KeepPage 保的是 **buf.pageLines**，不是 accumulatePageLines 留下的底部 padding
  // —— 那一列 padding 是替 footer overlay 讓位用的，原生鏡像畫面根本沒有 overlay。
  // 留著它，`.main`（height = chh*rows + 10、overflow-y:auto）的內容就變成
  // chh*rows + chh ⇒ **還有 chh-10 px 可捲**，而 App.mouse_scroll 在 pageState 3
  // 時直接放行給瀏覽器（推文提示畫面的 pageState 仍是 3）⇒ 滾輪真的把輸入列捲上去。
  // （2026-08-21 起 #cursor 住在 `.main` 裡、會跟著捲，所以這條不再是游標正確性的
  // 依賴；仍要清 —— 原生鏡像畫面本來就不該有可捲距離。）
  // 回好讀時 accumulatePageLines 每次都會把 padding 設回 '1em'，而且排在
  // _evalFunctionModeExit('resume') 還原 _savedScrollTop 之前，捲動位置照舊還原。
  // 守護：tests/e2e/offline/cursor_shape.offline.spec.js
  hideEasyReadingOverlaysKeepPage: function() {
    this.lastRowDiv.style.display = '';
    if (this.mainContainer) this.mainContainer.style.paddingBottom = '';
  },

  // Restore the easy-reading overlay rows (footer + reply preview) to their hidden
  // CSS default and clear the accumulated page. Called when easy reading is on but
  // the current screen is a list/menu (pageState != 3); the screen itself is drawn
  // by the caller via _renderScreenLines(buf.lines) — the same single-screen path
  // the native mode uses.
  hideEasyReadingOverlays: function() {
    this.lastRowDiv.style.display = '';
    // 清掉好讀累積翻頁時加在 #mainContainer 的 1em 底部 padding（accumulatePageLines），
    // 否則 .main 仍可捲動，殘留 scrollTop 會把列表列捲上約一格。（游標本身已錨在列節點
    // 上、跟著捲，不再受影響；清 padding 是為了畫面本身不該有可捲距離。）
    // 與原生退出路徑 (switchToEasyReadingMode(false), pttchrome.js:355) 保持一致。
    if (this.mainContainer) this.mainContainer.style.paddingBottom = '';
    this.mainDisplay.scrollTop = 0;
    this.buf.pageLines = [];
    // Left the article: drop overlap tracking so a stale row number can't bias the next
    // article's first page-down (see accumulatePageLines / resolvePageOverlap).
    this._accEndRow = null;
    this._lastAccumulatedSig = null;
    this.buf.easyReadingGapDetected = false;
    this.buf.easyReadingHealInFlight = false;
    // Back on a list/menu: the pending article reset (leaveCurrentPost) is moot —
    // prevPageState!=3 already forces rebuild on the next article.
    this.buf.easyReadingPendingReset = false;
  },

  setSingleChild: function(par, child) {
    while (par.childNodes.length > 0)
      par.removeChild(par.lastChild);
    par.appendChild(child);
  }

};
