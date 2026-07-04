// Terminal View

import { TermKeyboard } from './term_keyboard';
import { termInvColors } from './term_buf';
import { renderOverlayRow, renderScreen } from './term_ui';
import { i18n } from './i18n';
import { setTimer } from './util';
import { wrapText, u2b, parseStatusRow } from './string_util';
import { rowToText, parseArticleAuthor, findPageOverlap, resolvePageOverlap, pageArticleNums, isPinnedListRow } from './comment_parse';
import { mergeListPage, flattenListBuffer, evictListBuffer, pinnedRowKey, MAX_LIST_ROWS } from './list_session';

const ENTER_CHAR = '\r';
const ESC_CHAR = '\x15'; // Ctrl-U
const DEFINE_INPUT_BUFFER_SIZE = 12;

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

// Repaint a cloned board-list cursor row's leading cells so it shows the full article
// number instead of the ●cursor bullet that covers its top digit. The full-width ●
// occupies cells [0,1]; the visible digits start at cell 2. Given the recovered full
// number, fill [0,1] right-aligned with the missing high-order prefix (e.g. recovered
// 349886, visible "49886" → prefix "3" → cells become " 3", yielding " 349886"). Only
// touches the two bullet cells; everything after is the row's own text.
function relabelListCursorRow(row, fullNum) {
  if (fullNum == null || row.length < 3) return;
  var vis = '';
  for (var j = 2; j < row.length && row[j].ch >= '0' && row[j].ch <= '9'; ++j) vis += row[j].ch;
  var full = String(fullNum);
  var prefix = full.length > vis.length ? full.slice(0, full.length - vis.length) : '';
  var fill = ('  ' + prefix).slice(-2); // right-align into the 2 bullet cells
  for (var c = 0; c < 2; ++c) {
    row[c].ch = fill[c];
    row[c].isLeadByte = false;
  }
}

// Restore a cloned cursor-on-★pinned row's two bullet cells to the spaces they
// covered (a pinned row has no number to relabel — the ● sat over plain
// padding), so the accumulated row renders identically to its cursor-free form.
function blankListCursorBullet(row) {
  for (var c = 0; c < 2 && c < row.length; ++c) {
    row[c].ch = ' ';
    row[c].isLeadByte = false;
  }
}

export function TermView() {
  //new pref - start
  this.bbsWidth = 0;
  this.bbsHeight = 0;
  this.dbcsDetect = true;
  this.highlightBG = 2;
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
  // Same-author comment highlighting: tint comments written by the 原PO.
  // _articleAuthor is parsed from the article header (first page only) and kept
  // across page-downs; see redraw().
  this.highlightAuthorComments = true;
  // Auto-fix broken URLs: detect URLs broken by injected spaces / missing scheme /
  // split file extension and show a repaired clickable link below (src/js/url_fix.js).
  this.enableAutoFixUrl = true;
  // Auto-link X(Twitter) @handles (format-valid ones) in article body/comments.
  // Existence verification is currently off — see Screen.js / docs/enhanced-addon.md.
  this.enableXMention = true;
  this._articleAuthor = null;
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

  this.curRow = 0;
  this.curCol = 0;

  this.lineWrap = 78;

  //this.DBDetection = false;
  this.blinkOn = false;

  // React
  this.componentScreen = {
    setCurrentHighlighted() {},
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

  let shouldAcceptInput = () => !this.bbscore.modalShown && !this.bbscore.contextMenuShown;
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
      var parsedAuthor = parseArticleAuthor(rowToText(lines[0]));
      if (parsedAuthor) this._articleAuthor = parsedAuthor;
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
        //   buffer: accumulate the currently painted board page into buf.listLines
        //           (ascending by article number, overwrite-per-repaint) and render
        //           the whole scrollable list — blacklisted rows dropped entirely
        //           (dropHidden, no blank line).
        //   frozen: an article open is in flight — render the EXISTING buffer
        //           untouched so the jump-prompt/clear transients never pollute it
        //           (v3's "進出文章瞬間版面亂").
        // Keep the scroll position (unlike the article→list path): the list grows
        // while prefetching and must not jump. enhance pageState is pinned to 2 so
        // list annotations (blacklist) apply even on transient frames.
        this.hideEasyReadingOverlaysKeepPage();
        if (this.buf.listRenderMode === 'buffer') {
          // Scroll-anchor: an UPWARD prefetch prepends older rows above the
          // viewport (shoving content down), and a top-end EVICT removes rows
          // above it (yanking content up). Record the pre-render top number +
          // scrollHeight; any top-number change compensates by the height
          // delta — positive for a prepend, negative for a top evict.
          var prevH = this.mainDisplay ? this.mainDisplay.scrollHeight : 0;
          var prevTop = (this.buf.listLineNums && this.buf.listLineNums.length) ? this.buf.listLineNums[0] : null;
          this.accumulateListLines();
          this._renderScreenLines(this.buf.listLines, /* dropHidden */ true, /* inlinePreview */ false, /* hoverPreview */ false, { pageState: 2 });
          var newTop = (this.buf.listLineNums && this.buf.listLineNums.length) ? this.buf.listLineNums[0] : null;
          if (this.mainDisplay && prevTop != null && newTop != null && newTop !== prevTop) {
            this.mainDisplay.scrollTop += this.mainDisplay.scrollHeight - prevH;
          }
        } else {
          this._renderScreenLines(this.buf.listLines || [], /* dropHidden */ true, /* inlinePreview */ false, /* hoverPreview */ false, { pageState: 2 });
        }
        // Re-apply the JS selection highlight (renderScreen made a fresh component).
        // scroll=false: never yank the user's scroll while pages stream in.
        if (this.bbscore.listSession) this.bbscore.listSession.applyHighlight(false);
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
        this._renderScreenLines(this.buf.pageLines, /* dropHidden */ true, /* inlinePreview */ true, /* hoverPreview */ false);
      } else {
        // Native screen, OR easy reading sitting on a list/menu (pageState != 3):
        // one fixed screen. Hide the easy-reading overlay rows first when on.
        // Native shows images on HOVER (per enablePicPreview pref), no inline; the
        // easy-reading list/menu shows neither (matches the old hideEasyReading path).
        if (this.useEasyReadingMode) this.hideEasyReadingOverlays();
        this._renderScreenLines(
          /* a fresh copy for componentWillReceiveProps */ lines.slice(),
          /* dropHidden */ false,
          /* inlinePreview */ false,
          /* hoverPreview */ this.useEasyReadingMode ? false : this.enablePicPreview
        );
        this.setHighlightedRow(this.buf.nowHighlight);
      }
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
          highlightAuthor: this.highlightAuthorComments,
          articleAuthor: this._articleAuthor,
          selectedPusher: this._selectedPusher,
          autoFixUrl: this.enableAutoFixUrl,
          enableXMention: this.enableXMention,
          pageState: this.buf.pageState,
          // Floor numbers only count correctly across page-downs in easy reading
          // (its FloorCounter persists). The native per-page counter resets every
          // page → inaccurate, so floors are hidden in native mode (see Screen.js).
          easyReading: this.useEasyReadingMode,
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

  setHighlightedRow: function(row) {
    console.log(`setHighlightedRow: ${row}, this.buf.highlightCursor:${ this.buf.highlightCursor}`);
    if (this.buf.highlightCursor) {
      this.componentScreen.setCurrentHighlighted(row)
    }
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
    if (isPasting) {
      text = text.replace(/\r\n/g, '\r');
      text = text.replace(/\n/g, '\r');
      text = text.replace(/\r/g, ENTER_CHAR);

      if(text.indexOf('\x1b') < 0 && this.lineWrap > 0) {
        text = wrapText(text, this.lineWrap, ENTER_CHAR);
      }

      //FIXME: stop user from pasting DBCS words with 2-color
      text = text.replace(/\x1b/g, ESC_CHAR);
    }
    this._convSend(text);
  },

  onKeyDown: function(e) {
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
        case 'V':
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
    this.bbsCursor.style.display = 'none';
  },

  showCursor: function() {
    this._cursorHidden = false;
    this.bbsCursor.style.display = '';
    this.updateCursorPos();
  },

  // Cursor
  updateCursorPos: function() {
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
    this.bbsCursor.style.color = termInvColors[bg];
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
      icon: require('../icon/icon_128.png'),
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
    if (this.buf.prevPageState == 3) {
      // Same article, paged down: append only the genuinely new tail. PTT re-shows
      // the previous screen's bottom at the top of the new one; resolvePageOverlap
      // measures that overlap so we skip re-adding it.
      var lastRowText = this.buf.getRowText(this.buf.rows-1, 0, this.buf.cols);
      // parseStatusRow gates this to an article reading page AND supplies the absolute
      // row numbers (rowIndexStart/End) that drive de-duplication — see resolvePageOverlap.
      var result = parseStatusRow(lastRowText);
      if (result) {
        var newRows = this.buf.lines.slice(0, -1); // drop the status row
        // Only the last `newRows.length` accumulated rows can overlap, so map just
        // the tail to text (keeps it O(screen), not O(article)).
        var accTail = this.buf.pageLines.slice(-newRows.length).map(rowToText);
        var newTexts = newRows.map(rowToText);
        var maxK = Math.min(accTail.length, newTexts.length);
        // Primary overlap = status-line row numbers (exact regardless of paint state, so
        // a half-painted frame can't shrink k → no duplicate block). findPageOverlap's
        // content result is the cross-check / fallback + drift guard. this._accEndRow is
        // the article-line number of pageLines' last row (prev screen's rowIndexEnd).
        var kContent = findPageOverlap(accTail, newTexts);
        var beginIndex = resolvePageOverlap({
          accEndRow: this._accEndRow,
          statusStart: result.rowIndexStart,
          kContent: kContent,
          maxK: maxK,
          accTail: accTail,
          newTexts: newTexts
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
      }
    } else {
      // First page of a (new) article: restart the accumulated page as this whole
      // screen and clear the per-article pusher selection.
      this._selectedPusher = null;
      // New article (or re-entry into the same article): bump the instance id so
      // Screen resets the enlarge-images toggle back to default small images.
      ++this._articleInstanceId;
      this.buf.pageLines = this.buf.lines.slice(0, -1).map(cloneRow);
      // Seed overlap tracking from this first screen's status row (null if it's a
      // transient non-article frame — resolvePageOverlap then falls back to content).
      var firstStatus = parseStatusRow(
        this.buf.getRowText(this.buf.rows - 1, 0, this.buf.cols)
      );
      this._accEndRow = firstStatus ? firstStatus.rowIndexEnd : null;
    }
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
  // pageArticleNums recovers the ●cursor row's covered digit; cloneRow (not JSON) keeps
  // TermChar methods. The caller (redraw) handles scroll-anchoring when older rows prepend.
  accumulateListLines: function() {
    var buf = this.buf;
    if (!this._listNumMap) this._listNumMap = new Map();
    if (!this._listPinnedMap) this._listPinnedMap = new Map();
    var rowTexts = [];
    for (var r = 0; r < buf.rows; ++r) rowTexts.push(buf.getRowText(r, 0, buf.cols));
    var nums = pageArticleNums(rowTexts, buf.cur_y);
    var entries = [];
    for (var i = 0; i < buf.rows; ++i) {
      if (nums[i] != null) {
        var row = cloneRow(buf.lines[i]);
        // The ●cursor row's leading 2 cells (the bullet) cover the article number's top
        // digit; repaint them from the recovered number so the row renders like the rest
        // (e.g. "●49886" → " 349886") instead of a stray bullet + truncated number.
        if (i === buf.cur_y) relabelListCursorRow(row, nums[i]);
        entries.push({ num: nums[i], key: null, row: row });
      } else if (
        isPinnedListRow(rowTexts[i]) &&
        (i !== buf.cur_y || rowTexts[i].indexOf('★') >= 0)
      ) {
        // ★pinned/置底 row. A cursor row with an UNRECOVERABLE number (no numbered
        // neighbour) also matches the pinned signature (no number + valid author) but
        // carries no ★ — keep excluding those (v3 trap #4: stray ● misfiled as pinned).
        // A genuine pinned row under the cursor still shows its ★ (the ● only covers
        // the two leading padding cells), so it IS collected — otherwise a cursor
        // parked on a pinned row keeps that announcement out of the buffer forever
        // (v4-stabilize bug 2b: 置底文少一篇). Restore the bullet cells to spaces.
        var prow = cloneRow(buf.lines[i]);
        if (i === buf.cur_y) blankListCursorBullet(prow);
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
    var ls = this.bbscore && this.bbscore.listSession;
    var ev = evictListBuffer(this._listNumMap, ls ? ls._selectedNum : null, MAX_LIST_ROWS);
    if (ls && ev.evictedUp) ls.noteEvicted(-1);
    if (ls && ev.evictedDown) ls.noteEvicted(1);
    var flat = flattenListBuffer(this._listNumMap, this._listPinnedMap);
    buf.listLines = flat.lines;
    buf.listLineNums = flat.nums;
  },

  // Clear the list-accumulation maps (fresh board entry / board switch rebuild).
  resetListAccumulation: function() {
    this._listNumMap = null;
    this._listPinnedMap = null;
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
