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

// Pure decision for leaving functionMode, evaluated on each settle (screenSettled)
// while functionMode is on. Side-effect free so it can be regression-tested.
//   'resume' — back to a clean article reading page (status row at the bottom with the
//              cursor parked on it): turn functionMode off and resume the accumulated
//              long page (same article).
//   'leave'  — the screen settled into a board LIST (2) or MENU (1): the user navigated
//              out of the post; drop easy-reading per-post state and let the normal
//              settle re-enable pick up the next article.
//   'stay'   — anything else (the prompt/menu is still up, or an editor/pass screen
//              5/6/0, or a transient): keep mirroring native.
export function functionModeExitDecision({ pageState, isStatusRow, curY, lastRowNum }) {
  if (pageState === 3 && isStatusRow && curY === lastRowNum) return 'resume';
  if (pageState === 1 || pageState === 2) return 'leave';
  return 'stay';
}

export function EasyReading(core, view, termBuf) {
  this._core = core;
  this._view = view;
  this._termBuf = termBuf;

  this._turnPageLines = 22;

  this.easyReadingReachedPageEnd = false;
  this.sendCommandAfterUpdate = '';
  this.ignoreOneUpdate = false;
  // Identity ("第 a~b 行" range) of the page we last issued a PageDown FROM. Used by
  // the settle-driven recovery (_onScreenSettled) to dedup against the per-frame fast
  // path so a slow PTT response never gets a double page-down (which would skip a
  // page). Reset per article (enterEasyReading / leaveCurrentPost).
  this._lastPagedDownSignature = null;
  // functionMode: while the user is interacting with a native PTT prompt/menu/editor
  // triggered from inside the article (r 回應、X/% 推文、y 收暫存檔…), we stop the
  // easy-reading accumulation/overlay illusion and mirror the native 24-row screen
  // LIVE so whatever PTT draws appears exactly as native. Entered key-driven
  // (_onKeyDownProcessUI default → _enterFunctionMode), exited by content judgement on
  // settle (_evalFunctionModeExit). buf.pageLines is preserved throughout so the
  // accumulated long page resumes without re-paging. See docs/easy-reading.md.
  this._functionMode = false;
  this._savedScrollTop = null;

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
  // Exposed on term_buf so term_view.redraw / onKeyDown can read it (mirrors the
  // show*Text flags above). Setting this._functionMode writes buf.easyReadingFunctionMode.
  bindProperty(this._termBuf, 'easyReadingFunctionMode', this, '_functionMode');

  this._termBuf.addEventListener('change', this._onChanged.bind(this));
  this._termBuf.addEventListener('viewUpdate', this._onViewUpdated.bind(this));
  // Auto re-enable is driven by the debounced pageState (see nextEasyReadingState),
  // fired once per settle edge — not by every per-frame 'change'.
  this._termBuf.addEventListener('pageStateSettled', this._onPageStateSettled.bind(this));
  // Settle-driven page-down recovery: 'screenSettled' fires every quiet window (even
  // while pageState stays 3), catching the case where the per-frame loop stalled
  // because the cursor parked on the status row in a content-less (changed=false)
  // frame _onChanged never sees. See _onScreenSettled and docs/easy-reading.md.
  this._termBuf.addEventListener('screenSettled', this._onScreenSettled.bind(this));
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

  // functionMode mirrors the native screen LIVE (term_view.redraw handles rendering);
  // the auto-paging row-state machine must NOT run here (no page-downs while a prompt
  // is up). Exit is decided on settle by _evalFunctionModeExit.
  if (this._functionMode)
    return;

  this._applyRowState(this._computeRowState());
};

// Run the pure per-frame row-state machine against the CURRENT term_buf state.
// Reads the live cursor / last-row parse, returns the rowState the caller applies.
// Shared by _onChanged (fast path, per redraw frame) and _onScreenSettled (recovery,
// per quiet window) so both drive the exact same decision.
EasyReading.prototype._computeRowState = function() {
  const lastColNum = this._termBuf.cols - 1;
  const lastRowNum = this._termBuf.rows - 1;
  const lastRowText = this._termBuf.getRowText(lastRowNum, 0, this._termBuf.cols);
  const row22Text = this._termBuf.getRowText(22, 0, this._termBuf.cols);
  const lastRowFirstCh = this._termBuf.lines[lastRowNum][0];
  return nextEasyReadingRowState({
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
};

// Apply a computed rowState back onto term_buf / this. Idempotent on a stable frame.
EasyReading.prototype._applyRowState = function(rowState) {
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

// Identity of the article page currently shown, taken from the status row's
// "目前顯示: 第 a~b 行" range (unique per page; advances on every page-down). Returns
// null off a status row. Used to dedup the per-frame send against the settle recovery.
EasyReading.prototype._currentPageSignature = function() {
  const lastRowText = this._termBuf.getRowText(this._termBuf.rows - 1, 0, this._termBuf.cols);
  const s = parseStatusRow(lastRowText);
  return s ? (s.rowIndexStart + '~' + s.rowIndexEnd) : null;
};

// Settle-driven page-down recovery. Fired once per quiet window (term_buf 'screenSettled'),
// i.e. after BOTH content and the cursor have stopped. The per-frame fast path
// (_onChanged) can stall: PTT parks the cursor on the bottom status row in a
// content-less (changed=false) notify, so the 'change'/'viewUpdate' events never fire
// for that frame and the next PageDown is never queued, truncating the accumulated
// page (most often on the heavy first article after login). When the screen is stable
// we re-evaluate the SAME pure decision and, if a page-down is warranted AND we have
// not already paged down from THIS exact page, send it — the page signature dedups
// against the fast path so a slow PTT response cannot trigger a double page-down (which
// would skip a page). See docs/easy-reading.md.
EasyReading.prototype._onScreenSettled = function() {
  if (!this._enabled)
    return;
  // While mirroring native (functionMode), the only thing settle decides is whether to
  // leave functionMode — never a page-down. Handle it first (the pageState !== 3 guard
  // below would otherwise skip the editor/menu screens we need to evaluate).
  if (this._functionMode) {
    this._evalFunctionModeExit();
    return;
  }
  if (this._termBuf.pageState !== 3)
    return;
  if (this.sendCommandAfterUpdate)  // a command is mid-flight (incl. skipOne) — let the frame loop drive
    return;
  if (this.easyReadingReachedPageEnd)
    return;

  const rowState = this._computeRowState();
  this._applyRowState(rowState);  // fix any cursor-dependent flag against the now-stable cursor

  if (rowState.sendCommandAfterUpdate && rowState.sendCommandAfterUpdate !== 'skipOne') {
    const sig = this._currentPageSignature();
    if (sig && sig !== this._lastPagedDownSignature) {
      this._lastPagedDownSignature = sig;
      this._send(rowState.sendCommandAfterUpdate);
    }
    // A settle-path send has no following 'viewUpdate' to flush the queue, so never
    // leave the command queued — it would re-fire on the next frame's viewUpdate.
    this.sendCommandAfterUpdate = '';
  }
};

// Enter functionMode: stop the easy-reading illusion and mirror the native 24-row
// screen LIVE. Called from _onKeyDownProcessUI when the user presses a key that falls
// through to native and may open a prompt/menu (r/X/%/y…). Saves the current scroll so
// _evalFunctionModeExit('resume') can restore the reading position, then forces one
// repaint so the native screen shows immediately (before PTT's response arrives).
EasyReading.prototype._enterFunctionMode = function() {
  if (this._functionMode)
    return;
  console.log('enter function mode');
  // Drop any in-flight auto page-down so it can't fire (via _onViewUpdated) while we
  // are mirroring a native prompt.
  this.sendCommandAfterUpdate = '';
  this._savedScrollTop = this._view.mainDisplay.scrollTop;
  this._functionMode = true;
  this._termBuf.lineChangeds.fill(true);
  this._termBuf.changed = true;
  this._termBuf.notify();
};

// Decide (pure functionModeExitDecision) and act when functionMode settles. 'resume'
// turns it off and replays one render so accumulatePageLines continues the SAME article
// (prevPageState=3 → continuation branch; findPageOverlap dedups the unchanged screen to
// a no-op append), then restores the saved scroll. 'leave' drops per-post state so the
// normal settle re-enable handles the next article. 'stay' keeps mirroring native.
EasyReading.prototype._evalFunctionModeExit = function() {
  const lastRowNum = this._termBuf.rows - 1;
  const lastRowText = this._termBuf.getRowText(lastRowNum, 0, this._termBuf.cols);
  const decision = functionModeExitDecision({
    pageState: this._termBuf.pageState,
    isStatusRow: !!parseStatusRow(lastRowText),
    curY: this._termBuf.cur_y,
    lastRowNum
  });
  if (decision === 'stay')
    return;
  console.log('exit function mode: ' + decision);
  this._functionMode = false;
  if (decision === 'resume') {
    this._termBuf.prevPageState = 3;  // force accumulatePageLines continuation branch
    this._termBuf.lineChangeds.fill(true);
    this._termBuf.changed = true;
    this._termBuf.notify();
    if (this._savedScrollTop != null)
      this._view.mainDisplay.scrollTop = this._savedScrollTop;
  } else {  // 'leave'
    this.startedEasyReading = false;
    this.leaveCurrentPost();
    this._termBuf.lineChangeds.fill(true);
    this._termBuf.changed = true;
    this._termBuf.notify();
  }
  this._savedScrollTop = null;
};

EasyReading.prototype._onViewUpdated = function(e) {
  console.log('view update');
  if (this.sendCommandAfterUpdate) {
    console.log("send:" + this.sendCommandAfterUpdate);
    if (this.sendCommandAfterUpdate != 'skipOne') {
      // Record which page this PageDown was issued from so the settle recovery
      // (_onScreenSettled) knows this page is already handled and won't double-send.
      this._lastPagedDownSignature = this._currentPageSignature();
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
  // New post → forget the previous post's page identity so its first page-down is
  // never suppressed as a "same page" by the settle recovery.
  this._lastPagedDownSignature = null;
  this._functionMode = false;
  this._savedScrollTop = null;
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
  this._functionMode = false;
  this._savedScrollTop = null;
  // Force accumulatePageLines down its "new article" branch (restart pageLines as
  // the whole screen) instead of the same-article continuation branch, and start
  // page accumulation from empty.
  this._termBuf.prevPageState = 0;
  this._termBuf.pageLines = [];
  // Fresh article → no page has been paged-down from yet (see settle recovery dedup).
  this._lastPagedDownSignature = null;
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
  this._functionMode = false;
  this._savedScrollTop = null;
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

EasyReading.prototype._scrollBottom = function() {
  this._view.mainDisplay.scrollTop = this._view.mainDisplay.scrollHeight;
  return true;
};

EasyReading.prototype._onKeyDownProcessUI = function(e) {
  var stop = false;
  // Configurable "switch to native at bottom" key (default End; $/G kept as fixed
  // vi aliases). When the pref is off we don't preventDefault, so the key falls
  // through to the native terminal (term_view.onKeyDown continues past us).
  if (!e.ctrlKey && !e.altKey) {
    const prefs = readValuesWithDefault();
    if (prefs.easyReadingEndSwitchNative &&
        (e.key === prefs.easyReadingEndSwitchKey || e.key === '$' || e.key === 'G')) {
      this.switchToNativeAtBottom();
      e.preventDefault();
      return;
    }
  }
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
      // "Switch to native at bottom" is handled at the top of this function
      // (configurable key + on/off pref). When that did NOT fire (pref off, or the
      // pressed key isn't the configured switch key), End/$/G still jump to the
      // article bottom — but stay in easy reading, like the official term. Symmetric
      // with Home/0/g (_scrollTop).
      case 'End':
      case '$':
      case 'G':
        stop = this._scrollBottom();
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
        // Any other key falls through to native PTT and may open an in-post prompt /
        // menu / editor (r 回應、X/% 推文、y 收暫存檔…). Switch to functionMode so we
        // mirror whatever PTT draws LIVE (no hardcoded overlay, no per-prompt parsing);
        // do NOT preventDefault — the key still reaches PTT. Exit is content-judged on
        // settle (_evalFunctionModeExit).
        if (e.key.length === 1) {
          this._enterFunctionMode();
        }
        break;
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
      if (readValuesWithDefault().easyReadingEndSwitchNative) {
        this.switchToNativeAtBottom();
      } else {
        // pref off → jump to bottom but stay in easy reading (official term behavior)
        this._scrollBottom();
      }
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
