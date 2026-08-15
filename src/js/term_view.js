// Terminal View

import { TermKeyboard } from './term_keyboard';
import { cursorColorForBg } from './cursor_color';
import { DEFAULT_HIGHLIGHT_BG, highlightClass, resolveHighlightRow } from './cursor_highlight';
import { renderOverlayRow, renderScreen } from './term_ui';
import { i18n } from './i18n';
import { setTimer, TRACE } from './util';
import { u2b, parseStatusRow, normalizePasteText } from './string_util';
import { rowToText, parseArticleHeader, findPageOverlap, resolvePageOverlap, decideAccumulateBranch, classifyPageTransition, pageArticleNums, isPinnedListRow, parseListArticleNumLoose, hasServerCursorMark } from './comment_parse';
import { mergeListPage, flattenListBuffer, evictListBuffer, pinnedRowKey, MAX_LIST_ROWS, isLastReadStyledListRow, normalizeLastReadListRow, paintLastReadListRow, subjectOfListRow } from './list_session';
import { labelListCursor, pruneListToSegment, LIST_HEADER_ROWS } from './list_window';
import { readValuesWithDefault } from './pref_storage';
import icon128 from '../icon/icon_128.png';

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
const NO_CURSOR_HIGHLIGHT = Object.freeze({ row: -1, cls: null });

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
  // 鍵盤操作時也把游標所在列上色（pref keyboardCursorHighlight，預設開）。
  this.keyboardCursorHighlight = true;
  this.charset = 'big5';
  this.middleButtonFunction = 0;
  this.leftButtonFunction = false;
  this.mouseWheelFunction1 = 1;
  this.mouseWheelFunction2 = 2;
  this.mouseWheelFunction3 = 3;
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

  // TODO Move this into easy_reading.js
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

  // 閃爍底線抑制（autoHideBlinkCursor）：PTT 自己畫了 '>' 游標的畫面（列表／選單）
  // 不需要再疊一個閃爍底線。與 _cursorHidden 是**兩個獨立來源**，用 OR 合併於
  // _applyCursorVisibility —— 不可共用一個旗標：_cursorHidden 會讓 updateCursorPos
  // 提早 return（位置不再更新），而 list_session 的 showCursor() 會把它清掉，
  // 連帶把這裡的抑制狀態一起清掉。
  this._cursorSuppressed = false;
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

  this.curRow = 0;
  this.curCol = 0;

  this.lineWrap = 78;

  //this.DBDetection = false;
  this.blinkOn = false;

  // React
  this.componentScreen = {
    setCursorHighlight() {},
  };

  this.selection = null;
  this.input = document.getElementById('t');
  this.bbsCursor = document.getElementById('cursor');
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
  this.titleTimer = null;
  this.notif = null;

  Object.defineProperty(this, 'mainContainer', {
    get: function() { return document.getElementById('mainContainer') },
  });

  var mainDisplay = document.createElement('div');
  mainDisplay.setAttribute('class', 'main');
  this.BBSWin.appendChild(mainDisplay);
  this.mainDisplay = mainDisplay;

  var lastRowDiv = document.createElement('div');
  lastRowDiv.setAttribute('id', 'easyReadingLastRow');
  let spaces = ' '.repeat(80-25);  // TODO: Find a way to update this.
  this.lastRowDivContent = '<span align="left"><span class="q0 b7">' + spaces + '</span><span class="q1 b7">(y)</span><span class="q0 b7">回應</span><span class="q1 b7">(X%)</span><span class="q0 b7">推文</span><span class="q1 b7">(←)</span><span class="q0 b7">離開 </span> </span>';
  lastRowDiv.innerHTML = this.lastRowDivContent;
  this.lastRowDiv = lastRowDiv;
  this.BBSWin.appendChild(lastRowDiv);

  var replyRowDiv = document.createElement('div');
  replyRowDiv.setAttribute('id', 'easyReadingReplyRow');
  this.replyRowDivContent = '<span align="left"></span>';
  replyRowDiv.innerHTML = this.replyRowDivContent;
  this.replyRowDiv = replyRowDiv;
  this.BBSWin.appendChild(replyRowDiv);

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

    // TODO: Since the app is almost useless on mobile devices, we might want
    // to revisit if we want this code.

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
    this.replyRowDiv.style.setProperty('font-family', this.fontFace, 'important');
    document.getElementById('cursor').style.setProperty('font-family', this.fontFace, 'important');
  },

  update: function() {
    this.redraw(false);
  },

  redraw: function(force) {

    //var start = new Date().getTime();
    var cols = this.buf.cols;
    var rows = this.buf.rows;
    var lineChangeds = this.buf.lineChangeds;
    var changedLineHtmlStr = '';
    var changedLineHtmlStrs = [];
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
      // Leaving the article clears any pusher highlight selection.
      this._selectedPusher = null;
    }
    for (var row = 0; row < rows; ++row) {
      var chh = this.chh;
      this.curRow = row;
      // resets color
      var line = lines[row];
      var lineChanged = lineChangeds[row];
      if (lineChanged === false && !force)
        continue;
      var lineUpdated = false;
      var chw = this.chw;

      for (this.curCol = 0; this.curCol < cols; ++this.curCol) {
        // always check all because it's hard to know about openSpan when jump update
        // TODO: maybe set ch.needUpdate false?
        lineUpdated = true;
      }

      if (lineUpdated) {
        lineUpdated = false;
        changedLineHtmlStrs.push(line);
        changedRows.push(row);
        lineChangeds[row] = false;
      }
    }
    if (changedLineHtmlStrs.length > 0) {
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
        this._renderScreenLines(lines.slice(), /* dropHidden */ false, /* inlinePreview */ false, /* hoverPreview */ false);
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
          this._renderScreenLines(windowLines.slice(), /* dropHidden */ false, /* inlinePreview */ false, /* hoverPreview */ false, { pageState: 2, listEasyReading: true });
        } else {
          // No window yet (header cache / buffer still empty — engage races):
          // mirror the native screen; the next clean-list settle re-renders.
          this._renderScreenLines(lines.slice(), /* dropHidden */ false, /* inlinePreview */ false, /* hoverPreview */ false, { pageState: 2, listEasyReading: true });
        }
      } else if (this.useEasyReadingMode && this.buf.startedEasyReading && this.buf.easyReadingShowReplyText) {
        this.updateEasyReadingReplyRow(changedLineHtmlStrs[changedLineHtmlStrs.length-1]);
      } else if (this.useEasyReadingMode && this.buf.startedEasyReading && this.buf.easyReadingShowPushInitText) {
        this.updateEasyReadingPushInitRow(changedLineHtmlStrs[changedLineHtmlStrs.length-1]);
      } else if (this.useEasyReadingMode && this.buf.pageState == 3) {
        // Easy-reading article: accumulate the long page into buf.pageLines (pure
        // JS de-dup, no DOM) then render the whole thing. Blacklisted comment rows
        // are dropped entirely (dropHidden) instead of left as a blank gap.
        // Auto-open images INLINE (the long scroll page) — matches the old
        // appendRows(showsLinkPreview=true) behaviour. Hover preview off (inline
        // already shows them; avoids a duplicate floating popup).
        this.accumulatePageLines();
        this._renderScreenLines(this.buf.pageLines, /* dropHidden */ true, /* inlinePreview */ true, /* hoverPreview */ false, STABLE_ROWS);
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
        this._renderScreenLines(this.buf.pageLines, /* dropHidden */ true, /* inlinePreview */ true, /* hoverPreview */ false, STABLE_ROWS);
      } else {
        // Native screen, OR easy reading sitting on a list/menu (pageState != 3):
        // one fixed screen. Hide the easy-reading overlay rows first when on.
        // Native shows images on HOVER (per enablePicPreview pref), no inline; the
        // easy-reading list/menu shows neither (matches the old hideEasyReading path).
        // (Mid-article transients never reach here — the branch above holds them.)
        if (this.useEasyReadingMode) this.hideEasyReadingOverlays();
        this._renderScreenLines(
          /* a fresh copy for componentWillReceiveProps */ lines.slice(),
          /* dropHidden */ false,
          /* inlinePreview */ false,
          /* hoverPreview */ this.useEasyReadingMode ? false : this.enablePicPreview
        );
      }
      // 游標底色：**所有** render 分支共用一個套用點（原本只有原生分支呼叫，所以
      // 列表好讀與 functionMode 的游標永遠沒有底色）。必須在 _renderScreenLines
      // 之後——Screen 的 ref 要先 commit（react_root 的 flushSync 保證同步）。
      this.applyCursorHighlight();
      this.buf.prevPageState = this.buf.pageState;
    }
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
    this.componentScreen = renderScreen(
      lines,
      this.chh,
      inlinePreview,
      hoverPreview,
      this.mainDisplay,
      Object.assign(
        {
          blacklist: this.blacklist,
          titleBlacklist: this.titleBlacklist,
          showFloorNumbers: this.showFloorNumbers,
          mergeSameAuthorComments: this.mergeSameAuthorComments,
          captionAiEnabled: this.enableAi && this.enableCaptionAi,
          highlightAuthor: this.highlightAuthorComments,
          articleAuthor: this._articleAuthor,
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
          articleId: this._articleInstanceId
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
  // 滑鼠 hover 一律優先。呼叫點：redraw 的每個 render 分支、term_buf.setHighlight
  // （hover 變動）、updateCursorPos（只有游標動、內容沒動的幀）、pref 變更。
  applyCursorHighlight: function() {
    if (!this.buf) return;
    var listMode =
      this.buf.listRenderMode === 'buffer' || this.buf.listRenderMode === 'frozen';
    var mode = listMode
      ? 'listBuffer'
      : (this.useEasyReadingMode && this.buf.pageState === 3 ? 'article' : 'native');
    var row = resolveHighlightRow({
      mode: mode,
      pageState: this.buf.pageState,
      // 滑鼠來源：列表好讀走我們自己算的視窗座標（server 幾何在那裡沒有意義），
      // 原生沿用 term_buf.onMouse_move 設的 nowHighlight。
      mouseEnabled: !!(this.buf.useMouseBrowsing && this.buf.highlightCursor),
      mouseRow: listMode ? this._listHoverRow : this.buf.nowHighlight,
      keyboardEnabled: !!this.keyboardCursorHighlight,
      cursorRow: this.buf.cur_y,
      listCursorRow: this._listCursorRow
    });
    if (TRACE)
      console.log(`applyCursorHighlight: mode=${mode} row=${row} bg=${this.highlightBG}`);
    this.componentScreen.setCursorHighlight(
      row < 0 ? NO_CURSOR_HIGHLIGHT : { row: row, cls: highlightClass(this.highlightBG) }
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
        !this.buf.easyReadingShowReplyText && !this.buf.easyReadingShowPushInitText &&
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
        !this.buf.easyReadingShowReplyText && !this.buf.easyReadingShowPushInitText &&
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

    // TODO: Move this. Make a key event mapper.
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

    this.replyRowDiv.style.fontSize = fontSize;
    this.replyRowDiv.style.width = mainWidth;
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
      this.replyRowDiv.style.webkitTransformOriginX = transOrigin;
      this.lastRowDiv.style.webkitTransformOriginY = '-1100%'; // somehow these are the right value
      this.replyRowDiv.style.webkitTransformOriginY = '-1010%';
    } else {
      this.lastRowDiv.style.webkitTransformOriginY = '';
      this.replyRowDiv.style.webkitTransformOriginY = '';
    }
    this.mainDisplay.style.webkitTransform = scaleCss;
    this.lastRowDiv.style.webkitTransform = scaleCss;
    this.replyRowDiv.style.webkitTransform = scaleCss;

    this.firstGridOffset = this.bbscore.getFirstGridOffsets();

    this.updateReverseScaleCss();
    this.updateCursorPos();
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

  convertMN2XYEx: function(cx, cy) {
    var origin;
    var w = this.innerBounds.width;
    var h = this.innerBounds.height;
    if(this.scaleX!=1 || this.scaleY!=1)
      origin = [((w - (this.chw*this.buf.cols+10)*this.scaleX)/2) + this.bbsViewMargin, ((h - (this.chh*this.buf.rows)*this.scaleY)/2) + this.bbsViewMargin];
    else
      origin = [this.firstGridOffset.left, this.firstGridOffset.top];
    var realX = origin[0] + (cx) * this.chw * this.scaleX;
    var realY = origin[1] + (cy) * this.chh * this.scaleY;
    return [realX, realY];
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
  _applyCursorVisibility: function() {
    this.bbsCursor.style.display =
      (this._cursorHidden || this._cursorSuppressed) ? 'none' : '';
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

  // 列表好讀模式的滑鼠移動。**不走 term_buf.onMouse_move**：那條用 server 的真實
  // 24 列幾何判斷（左緣＝離開、右緣＝翻頁、該列是否為空），而畫面上是我們自己組的
  // 虛擬視窗，兩者的列意義並不對應。這裡只回答一個問題：滑鼠停在哪一個「可點的
  // 文章列」上（→ 上色 + pointer 游標），其餘一律沒有。
  // frozen（開文交易進行中）比照鍵盤：不接受互動，清掉 hover。
  onListMouseMove: function(row) {
    var hover = -1;
    if (this.buf.listRenderMode === 'buffer') {
      var ls = this.bbscore && this.bbscore.listSession;
      var idx = row - LIST_HEADER_ROWS;
      if (ls && idx >= 0 && idx < this.buf.rows - 4) {
        var win = ls.getWindowView();
        // body[idx] == null ＝ 短頁的空白補列，沒有文章可點。
        if (win && win.body[idx] != null) hover = row;
      }
    }
    if (this.buf.BBSWin)
      this.buf.BBSWin.style.cursor = hover >= 0 ? 'pointer' : 'auto';
    if (hover === this._listHoverRow) return;
    this._listHoverRow = hover;
    this.applyCursorHighlight();
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
    // 放在所有 early-return 之前：上色與游標 DOM 無關，就算底線被隱藏也照樣要更新。
    this.applyCursorHighlight();
    if (this._cursorHidden) return;

    var pos = this.convertMN2XYEx(this.buf.cur_x, this.buf.cur_y);
    // if you want to set cursor color by now background, use this.
    if (this.buf.cur_y >= this.buf.rows || this.buf.cur_x >= this.buf.cols)
      return; //sometimes, the value of this.buf.cur_x is 80 :(

    var lines = this.buf.lines;
    var line = lines[this.buf.cur_y];
    var ch = line[this.buf.cur_x];
    var bg = ch.getBg();

    if (this.scaleX == 1 && this.scaleY == 1) {
      this.bbsCursor.style.webkitTransform = 'none';
      this.lastRowDiv.style.webkitTransformOriginY = '';
      this.replyRowDiv.style.webkitTransformOriginY = '';
    } else {
      var scaleCss = 'scale('+this.scaleX+','+this.scaleY+')';
      this.mainDisplay.style.webkitTransform = scaleCss;
      this.lastRowDiv.style.webkitTransform = scaleCss;
      this.replyRowDiv.style.webkitTransform = scaleCss;
      this.bbsCursor.style.webkitTransform = scaleCss;
      this.bbsCursor.style.webkitTransformOriginX = 'left';
      this.lastRowDiv.style.webkitTransformOriginY = '-1100%';
      this.replyRowDiv.style.webkitTransformOriginY = '-1010%';
    }

    this.bbsCursor.style.left = pos[0] + 'px';
    this.bbsCursor.style.top = (pos[1] - this.scaleY) + 'px';
    // if you want to set cursor color by now background, use this.
    this.bbsCursor.style.color = cursorColorForBg(bg, this.workModeActive);
    this.updateInputBufferPos();

  },

  updateInputBufferPos: function() {
    if (this.input.getAttribute('bshow') == '1') {
      var pos = this.convertMN2XYEx(this.buf.cur_x, this.buf.cur_y);
      {
        this.input.style.opacity = '1';
        this.input.style.border = 'double';
        {
          //this.input.style.width  = (this.chh-4)*10 + 'px';
          this.input.style.fontSize = this.chh-4 + 'px';
          //this.input.style.lineHeight = this.chh+4 + 'px';
          this.input.style.height = this.chh + 'px';
        }
      }
      var innerBounds = this.innerBounds;
      var bbswinheight = innerBounds.height;
      var bbswinwidth = innerBounds.width;
      if(bbswinheight < pos[1] + parseFloat(this.input.style.height) + this.chh)
        this.input.style.top = (pos[1] - parseFloat(this.input.style.height) - this.chh)+ 4 +'px';
      else
        this.input.style.top = (pos[1] + this.chh) +'px';

      if(bbswinwidth < pos[0] + parseFloat(this.input.style.width))
        this.input.style.left = bbswinwidth - parseFloat(this.input.style.width)- 10 +'px';
      else
        this.input.style.left = pos[0] +'px';

      //this.input.style.left = pos[0] +'px';
    }
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

  showWaterballNotification: function() {
    if (!this.enableNotifications) {
      return;
    }
    var app = this.bbscore;
    //console.log('message from ' + this.waterball.userId + ': ' + this.waterball.message); 
    var title = app.waterball.userId + ' ' + i18n('notification_said');
    if (this.titleTimer) {
      this.titleTimer.cancel();
      this.titleTimer = null;
    }
    this.titleTimer = setTimer(true, function() {
      if (document.title == app.connectedUrl.site) {
        document.title = title + ' ' + app.waterball.message;
      } else {
        document.title = app.connectedUrl.site;
      }
    }, 1500);
    var options = {
      icon: icon128,
      body: app.waterball.message,
      tag: app.waterball.userId
    };
    this.notif = new Notification(title, options);
    this.notif.onclick = function() {
      window.focus();
    };
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
      renderOverlayRow(this.buf.lines[this.buf.rows-1], this.chh, el);
      this.setSingleChild(this.lastRowDiv.childNodes[0], el);
    }
    this.lastRowDiv.style.display = 'block';
  },

  // Toggle whole-row highlight for all comments by `userid` (click handler).
  // Clicking the selected pusher again clears it; clicking another switches. Both
  // render paths re-apply the .pusherHighlight class from _selectedPusher inside
  // Screen#computeAnnotations now, so a single forced redraw suffices. (In easy
  // reading the redraw re-enters accumulatePageLines on the same screen, which
  // findPageOverlap dedups to a no-op append; only the render reflects the change.)
  togglePusherHighlight: function(userid) {
    if (!userid) return;
    this._selectedPusher = this._selectedPusher === userid ? null : userid;
    this.redraw(true);
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

  // Like hideEasyReadingOverlays but does NOT clear buf.pageLines / padding / scroll.
  // Used by the functionMode native-LIVE render: we only want the overlay rows out of
  // the way while mirroring the native screen; the accumulated long page must survive
  // so _evalFunctionModeExit('resume') can restore it without re-paging the article.
  hideEasyReadingOverlaysKeepPage: function() {
    this.lastRowDiv.style.display = '';
    this.replyRowDiv.style.display = '';
  },

  // Restore the easy-reading overlay rows (footer + reply preview) to their hidden
  // CSS default and clear the accumulated page. Called when easy reading is on but
  // the current screen is a list/menu (pageState != 3); the screen itself is drawn
  // by the caller via _renderScreenLines(buf.lines) — the same single-screen path
  // the native mode uses.
  hideEasyReadingOverlays: function() {
    this.lastRowDiv.style.display = '';
    this.replyRowDiv.style.display = '';
    // 清掉好讀累積翻頁時加在 #mainContainer 的 1em 底部 padding（accumulatePageLines），
    // 否則 .main 仍可捲動，殘留 scrollTop 會把列表列捲上約一格，而絕對定位的 #cursor
    // （用固定 firstGridOffset 算位置、不受 scrollTop 影響）不會跟著動 → 游標低高亮列一格。
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

  updateEasyReadingReplyRow: function(row) {
    var el = document.createElement('span');
    el.style = "background-color:black;";
    renderOverlayRow(row, this.chh, el);
    this.setSingleChild(this.replyRowDiv.childNodes[0], el);
    this.replyRowDiv.style.display = 'block';
  },

  updateEasyReadingPushInitRow: function(row) {
    var el = document.createElement('span');
    el.style = "background-color:black;";
    renderOverlayRow(row, this.chh, el);
    this.setSingleChild(this.lastRowDiv.childNodes[0], el);
  },

  setSingleChild: function(par, child) {
    while (par.childNodes.length > 0)
      par.removeChild(par.lastChild);
    par.appendChild(child);
  }

};
