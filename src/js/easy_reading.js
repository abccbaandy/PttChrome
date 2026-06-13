import {
  parseReplyText,
  parsePushInitText,
  parseReqNotMetText,
  parseStatusRow
} from './string_util';
import { readValuesWithDefault } from './pref_storage';

// Pure decision for auto-enabling easy reading, evaluated once per settle edge
// (term_buf 'pageStateSettled'), not per redraw frame. Kept side-effect free so it
// can be regression-tested in tests/unit/easy_reading_logic.test.js.
//
// It operates on term_buf's DEBOUNCED pageState stream: settledPageState only
// advances once the screen has been quiet for SETTLE_MS, so the transient
// half-painted frames (empty last row -> pageState 0) that PTT emits while painting
// an article never appear here. That lets us use a clean, edge-correct "settled into
// an article (3) from a list/menu" check without the transient-frame race the old
// `cameFromList` latch had to work around. Because it is edge-triggered (the caller
// only invokes it on a settle transition), the in-post flicker after
// switchToNativeAtBottom (still pageState 3, settled stays 3 → no new edge) can no
// longer re-enable against the user's choice; likewise a pass/edit/normal screen
// (5/6/0) is excluded, so e.g. returning from in-article help does not re-enable.
// See docs/easy-reading.md.
export function nextEasyReadingState({ settledPageState, prevSettledPageState, enabled, enablePref, supported }) {
  // Re-enable when we settled INTO an article (3) FROM a screen you open articles
  // from: a board LIST (2) or a MENU (1). The 1 covers 精華區 (essence): its top
  // level (首列【精華文章】) settles to MENU(1) and sub-folder listings to MENU(1)
  // or LIST(2) — both let you Enter straight into an article. Without the 1, after
  // switchToNativeAtBottom inside 精華區 the next article arrives on a 1->3 (not
  // 2->3) edge, so easy reading never re-enabled — stuck native until you backed out
  // to a real board list. 主功能表/分類看板 are also MENU(1) but you can't open an
  // article directly from them (you pass through a board LIST first), so a 1->3 edge
  // in practice only comes from 精華區.
  return settledPageState === 3 &&
    (prevSettledPageState === 2 || prevSettledPageState === 1) &&
    !enabled && enablePref && supported;
}

// Pure per-frame row-state machine for _onChanged: given the current pageState,
// cursor position and which kind of status/push/reply row the screen shows (the
// parse results are computed by the caller and passed in as booleans, keeping this
// free of string_util/DOM), decide the next easy-reading render flags. Returns the
// next flag values plus three control signals: `pageStateOverride` (5 when a
// non-article "press any key" screen is detected, else null), `consumeIgnoreOneUpdate`
// (clear the one-shot suppression), and `halt` (the caller had an early return here —
// purely informational now since nothing follows the apply). Side-effect free so the
// branchy logic is regression-tested in tests/unit/easy_reading_logic.test.js.
export function nextEasyReadingRowState({
  pageState, startedEasyReading, showReplyText, showPushInitText,
  reachedPageEnd, sendCommandAfterUpdate, ignoreOneUpdate,
  curX, curY, lastRowNum, lastColNum,
  isReqNotMetRow, isStatusRow, isPushInitRow, isReplyRow,
  lastRowFirstChFg, lastRowFirstChBg
}) {
  let pageStateOverride = null;
  let consumeIgnoreOneUpdate = false;
  let halt = false;

  // dealing with page state jump to 0 because last row wasn't updated fully
  if (pageState == 3) {
    startedEasyReading = true;
  } else if (startedEasyReading && isReqNotMetRow) {
    showPushInitText = true;
  } else {
    showReplyText = false;
    showPushInitText = false;
    startedEasyReading = false;
  }

  if (startedEasyReading) {
    if (curY == lastRowNum && curX == lastColNum) {
      if (ignoreOneUpdate) {
        consumeIgnoreOneUpdate = true;
        halt = true;
      } else if (isStatusRow) {
        if (lastRowFirstChBg == 4 && lastRowFirstChFg == 7) {
          reachedPageEnd = true;
        } else {
          reachedPageEnd = false;
          if (!sendCommandAfterUpdate) {
            // send page down
            sendCommandAfterUpdate = '\x1b[6~';
          }
        }
      } else if (!showPushInitText) { // only if not showing last row text
        pageStateOverride = 5;
        startedEasyReading = false;
      }
    } else if (curY == lastRowNum) {
      if (!showPushInitText) {
        if (isPushInitRow) {
          showPushInitText = true;
        } else {
          showPushInitText = false;
          halt = true;
        }
      }
    } else if (curY == 22) {
      if (isReplyRow) {
        showReplyText = true;
      } else {
        showReplyText = false;
        halt = true;
      }
    } else {
      // last line hasn't changed
      halt = true;
    }
  }

  return {
    startedEasyReading, showReplyText, showPushInitText, reachedPageEnd,
    sendCommandAfterUpdate, pageStateOverride, consumeIgnoreOneUpdate, halt
  };
}

export function EasyReading(core, view, termBuf) {
  this._core = core;
  this._view = view;
  this._termBuf = termBuf;

  this._turnPageLines = 22;

  this.easyReadingReachedPageEnd = false;
  this.sendCommandAfterUpdate = '';
  this.ignoreOneUpdate = false;

  function bindProperty(target, name, obj, prop) {
    if (!prop) prop = name;
    Object.defineProperty(obj, prop, {
      get: function() { return target[name]; },
      set: function(val) { target[name] = val; }
    });
  }
  bindProperty(this._view, 'useEasyReadingMode', this, '_enabled');
  bindProperty(this._termBuf, 'startedEasyReading', this);
  bindProperty(this._termBuf, 'easyReadingShowReplyText', this);
  bindProperty(this._termBuf, 'easyReadingShowPushInitText', this);

  this._termBuf.addEventListener('change', this._onChanged.bind(this));
  this._termBuf.addEventListener('viewUpdate', this._onViewUpdated.bind(this));
  // Auto re-enable is driven by the debounced pageState (see nextEasyReadingState),
  // fired once per settle edge — not by every per-frame 'change'.
  this._termBuf.addEventListener('pageStateSettled', this._onPageStateSettled.bind(this));
};

// Fired once per term_buf settle edge. Auto-enable easy reading when we have just
// settled from a board list (2) into an article (3) with the pref on.
EasyReading.prototype._onPageStateSettled = function() {
  const values = readValuesWithDefault();
  const shouldEnable = nextEasyReadingState({
    settledPageState: this._termBuf.settledPageState,
    prevSettledPageState: this._termBuf.prevSettledPageState,
    enabled: this._enabled,
    enablePref: values.enableEasyReading,
    supported: this._core.connectedUrl.easyReadingSupported
  });
  if (shouldEnable) {
    this.enterEasyReading();
  }
};

EasyReading.prototype._onChanged = function(e) {
  console.log("page state: " + this._termBuf.prevPageState + "->" + this._termBuf.pageState);
  const values = readValuesWithDefault()
  // Auto-enable is handled on the settle edge (_onPageStateSettled, see
  // nextEasyReadingState). Here we only react to the pref being turned off
  // mid-post: flipping _enabled alone would switch back to the React renderScreen
  // path while #mainContainer still holds the DOM that easy reading mutated
  // directly, so React keeps updating detached Row nodes and the view freezes.
  // Run the full exit recipe instead.
  if (!values.enableEasyReading && this._enabled) {
    this.exitEasyReading();
  }

  if (!this._enabled)
    return;

  const lastColNum = this._termBuf.cols - 1;
  const lastRowNum = this._termBuf.rows - 1;
  const lastRowText = this._termBuf.getRowText(lastRowNum, 0, this._termBuf.cols);
  const row22Text = this._termBuf.getRowText(22, 0, this._termBuf.cols);
  const lastRowFirstCh = this._termBuf.lines[lastRowNum][0];
  const rowState = nextEasyReadingRowState({
    pageState: this._termBuf.pageState,
    startedEasyReading: this.startedEasyReading,
    showReplyText: this.easyReadingShowReplyText,
    showPushInitText: this.easyReadingShowPushInitText,
    reachedPageEnd: this.easyReadingReachedPageEnd,
    sendCommandAfterUpdate: this.sendCommandAfterUpdate,
    ignoreOneUpdate: this.ignoreOneUpdate,
    curX: this._termBuf.cur_x,
    curY: this._termBuf.cur_y,
    lastRowNum,
    lastColNum,
    isReqNotMetRow: !!parseReqNotMetText(lastRowText),
    isStatusRow: !!parseStatusRow(lastRowText),
    isPushInitRow: !!parsePushInitText(lastRowText),
    isReplyRow: !!parseReplyText(row22Text),
    lastRowFirstChFg: lastRowFirstCh.getFg(),
    lastRowFirstChBg: lastRowFirstCh.getBg()
  });

  this.startedEasyReading = rowState.startedEasyReading;
  this.easyReadingShowReplyText = rowState.showReplyText;
  this.easyReadingShowPushInitText = rowState.showPushInitText;
  this.easyReadingReachedPageEnd = rowState.reachedPageEnd;
  this.sendCommandAfterUpdate = rowState.sendCommandAfterUpdate;
  if (rowState.consumeIgnoreOneUpdate)
    this.ignoreOneUpdate = false;
  if (rowState.pageStateOverride !== null)
    this._termBuf.pageState = rowState.pageStateOverride;
};

EasyReading.prototype._onViewUpdated = function(e) {
  console.log('view update');
  if (this.sendCommandAfterUpdate) {
    console.log("send:" + this.sendCommandAfterUpdate);
    if (this.sendCommandAfterUpdate != 'skipOne') {
      this._send(this.sendCommandAfterUpdate);
    }
    this.sendCommandAfterUpdate = '';
  }
};

// "Leaving this post" hook: stays in easy reading (does NOT touch _enabled) but
// resets the per-post render state. Called directly by the in-post key/mouse
// handlers, and transitively by switchToEasyReadingMode (pttchrome.js:344) on every
// manual exit. Zeroing prevPageState forces the next article down
// accumulatePageLines' "new article" branch (restart pageLines) even on a direct
// article->article jump with no list in between. Auto re-enable is now edge-triggered
// on the settle stream (nextEasyReadingState), so there is no latch to clear here.
// See docs/easy-reading.md.
EasyReading.prototype.leaveCurrentPost = function() {
  console.log('leave curent post');
  if (!this.easyReadingReachedPageEnd) {
    this.ignoreOneUpdate = true;
  }
  this._termBuf.prevPageState = 0;
};

EasyReading.prototype.stopEasyReading = function() {
  console.log('stop easy reading');
  this.sendCommandAfterUpdate = 'skipOne';
};

EasyReading.prototype._send = function(data) {
  this._view.conn.send(data);
};

// Temporarily leave easy reading: switch back to native rendering and jump to
// the bottom of the post. Auto-paging stops, so the native in-post search ('/')
// and navigation become usable. Easy reading is re-enabled automatically by
// _onPageStateSettled when the next post settles in from a list (settled 2 -> 3).
EasyReading.prototype.switchToNativeAtBottom = function() {
  console.log('switch to native at bottom');
  // jump to the bottom of the post with native End
  this._send('\x1b[4~');
  this.exitEasyReading();
};

// Single entry point that turns easy reading ON for the current article, symmetric
// with exitEasyReading(). Driven by _onPageStateSettled (the settle edge), which
// fires AFTER the first page has painted and the screen went quiet — i.e. outside
// the normal per-frame 'change' loop. So, unlike the old inline `_enabled = true`,
// we must replay one render+viewUpdate cycle ourselves to (a) repaint the
// already-drawn page in easy-reading mode and (b) kick off the auto page-down loop.
EasyReading.prototype.enterEasyReading = function() {
  console.log('enter easy reading');
  this._enabled = true;
  // Force accumulatePageLines down its "new article" branch (restart pageLines as
  // the whole screen) instead of the same-article continuation branch, and start
  // page accumulation from empty.
  this._termBuf.prevPageState = 0;
  this._termBuf.pageLines = [];
  // Mark every row dirty so the forced redraw actually paints (update() only redraws
  // changed rows), then replay a full notify so 'change' (_onChanged sets the first
  // page-down) and 'viewUpdate' (_onViewUpdated sends it) both fire.
  this._termBuf.lineChangeds.fill(true);
  this._termBuf.changed = true;
  this._termBuf.notify();
};

// Full recipe to leave easy reading rendering. Single exit point: every code path
// that turns easy reading off mid-post (End/$/G, ContextMenu 取消好讀, pref-off)
// MUST go through this; see docs/enhanced-addon.md 踩坑 #11. NOTE the transitive
// chain: this -> _core.switchToEasyReadingMode() -> easyReading.leaveCurrentPost()
// (pttchrome.js:344), which resets per-post render state. Easy to miss — that
// hidden hop is what an earlier bug tripped on.
EasyReading.prototype.exitEasyReading = function() {
  console.log('exit easy reading');
  // stop any pending/in-flight auto page down
  this.sendCommandAfterUpdate = '';
  // Switch off easy reading and restore the native view. switchToEasyReadingMode()
  // restores the overlay rows / padding / pageLines and forces a full redraw via
  // Ctrl-L. Both modes now render through <Screen> (React owns #mainContainer), so
  // turning easy reading off just re-renders with the 24-row screen and React
  // reconciles the long accumulated page down — no unmount hack needed any more
  // (the old vdom-desync freeze is gone now that nothing mutates #mainContainer
  // by hand).
  this._enabled = false;
  this._core.switchToEasyReadingMode();
};

EasyReading.prototype._onKeyDown = function(e) {
  if (!this._enabled || !this.startedEasyReading)
    return;

  this._onKeyDownProcessUI(e);
  if (e.defaultPrevented)
    return;

  var stop = false;
  if (!e.ctrlKey && !e.altKey) {
    switch (e.key) {
      case 'Backspace':
      case 'ArrowUp':
        this._send('\x1b[D\x1b[A\x1b[C');
        stop = true;
        break;
      case 'ArrowDown':
        this._send('\x1b[D\x1b[B\x1b[C');
        stop = true;
        break;
    }
  } else if (e.ctrlKey && !e.altKey) {
    switch (e.key) {
      case 'h':
        this._send('\x1b[D\x1b[A\x1b[C');
        stop = true;
        break;
    }
  }
  if (stop)
    e.preventDefault();
};

EasyReading.prototype._scrollBy = function(lines) {
  var cont = this._view.mainDisplay;
  if (lines < 0 && cont.scrollTop == 0)
    return false;
  if (lines > 0 && cont.scrollTop >=
    this._view.mainContainer.clientHeight -
      this._view.chh * this._termBuf.rows)
    return false;
  cont.scrollTop += this._view.chh * lines;
  return true;
};

EasyReading.prototype._scrollTop = function() {
  this._view.mainDisplay.scrollTop = 0;
  return true;
};

EasyReading.prototype._onKeyDownProcessUI = function(e) {
  var stop = false;
  if (!e.ctrlKey && !e.altKey) {
    switch (e.key) {
      case 'Backspace':
        stop = this._scrollBy(-this._turnPageLines);
        if (!stop)
          this.leaveCurrentPost();
        break;
      case 'ArrowRight':
      case ' ':
      case 't':
        stop = this._scrollBy(this._turnPageLines);
        if (!stop)
          this.leaveCurrentPost();
        break;
      case 'PageUp':
        this._scrollBy(-this._turnPageLines);
        stop = true;
        break;
      case 'PageDown':
        this._scrollBy(this._turnPageLines);
        stop = true;
        break;
      case 'ArrowLeft':
        this.stopEasyReading();
        break;
      case 'ArrowUp':
        stop = this._scrollBy(-1);
        if (!stop)
          this.leaveCurrentPost();
        break;
      case 'Enter':
      case 'ArrowDown':
        stop = this._scrollBy(1);
        if (!stop)
          this.leaveCurrentPost();
        break;
      case 'k':
        this._scrollBy(-1);
        stop = true;
        break;
      case 'j':
        this._scrollBy(1);
        stop = true;
        break;
      case 'Home':
      case '0':
      case 'g':
        stop = this._scrollTop();
        break;
      case 'End':
      case '$':
      case 'G':
        this.switchToNativeAtBottom();
        stop = true;
        break;
      case 'Tab':
        stop = true;
        break;
      default:
        if ("abf=+-[]ABF".indexOf(e.key) >= 0) {
          this.leaveCurrentPost();
          break;
        }
        if ("123456789hops;,./\\H#OP:<>".indexOf(e.key) >= 0) {
          stop = true;
          break;
        }
    }
  } else if (e.ctrlKey && !e.altKey) {
    switch (e.key) {
      case 'f':
        this._scrollBy(this._turnPageLines);
        stop = true;
        break;
      case 'b':
        this._scrollBy(-this._turnPageLines);
        stop = true;
        break;
      case 'h':
        stop = this._scrollBy(-this._turnPageLines);
        if (!stop)
          this.leaveCurrentPost();
        break;
      default:
        if ("@^_?".indexOf(e.key) >= 0) {
          stop = true;
          break;
        }
    }
  }
  if (stop)
    e.preventDefault();
};

EasyReading.prototype._onMouseClick = function(e) {
  if (!this._enabled || !this.startedEasyReading)
    return;
  var stop = false;
  // XXX Should not use term buffer to track mouse cursor.
  switch (this._termBuf.mouseCursor) {
    case 0:
    case 1: // Arrow Left
      this.stopEasyReading();
      break;
    case 2: // Page Up
      this._scrollBy(-this._turnPageLines);
      stop = true;
      break;
    case 3: // Page Down
      this._scrollBy(this._turnPageLines);
      stop = true;
      break;
    case 4: // Home
      this._scrollTop();
      stop = true;
      break;
    case 5: // End
      this.switchToNativeAtBottom();
      stop = true;
      break;
    case 6:
    case 7:
      break;
    case 8: // [
    case 9: // ]
    case 10: // =
    case 12: // Refresh post / pushed texts
    case 13: // Last post with the same title (LIST)
    case 14: // Last post with the same title (READING)
      this.leaveCurrentPost();
      break;
    default: // Do nothing
      break;
  }
  if (stop)
    e.preventDefault();
};
