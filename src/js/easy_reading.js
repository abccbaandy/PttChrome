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
  lastRowFirstChFg, lastRowFirstChBg, pagePercent
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
        // 「已看完整篇」的判準（pttbbs @ efc21a30）：
        //
        // 主判準 = footer 的百分比（P3）。mf_display_footer 算
        //   progress = (int)((dispe - start) * 100 / len)
        // 整數除法使 progress==100 ⟺ dispe >= end ⟺ mf_viewedAll()，**完全等價**。
        //
        // 次判準 = footer 第一段的配色（mf_display_footer 依 mf_viewedAll()/
        // mf_viewedNone() 選色）：
        //   PMORE_COLOR_FOOTER1_VIEWALL  ANSI_COLOR(37;44) → fg 7 / bg 4 ← 這裡
        //   PMORE_COLOR_FOOTER1_VIEWNONE ANSI_COLOR(33;45) → fg 3 / bg 5
        //   PMORE_COLOR_FOOTER1          ANSI_COLOR(34;46) → fg 4 / bg 6
        // 保留為 fallback（pagePercent 拿不到時），但**不再是主判準**：pfterm 是
        // per-cell dirty 更新（P6），(rows-1, 0) 這一格只有在真的變色時才會重畫，
        // 用單一格的顏色推論全域狀態比讀百分比脆弱。
        if (pagePercent >= 100 ||
            (pagePercent == null && lastRowFirstChBg == 4 && lastRowFirstChFg == 7)) {
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

// How many times a settle may re-send a PageDown that produced no response at all.
export const PAGE_DOWN_MAX_RETRIES = 1;

// Pure decision for the auto page-down loop, expressed as a SINGLE IN-FLIGHT
// request/response transaction. See docs/pttbbs-screen-protocol.md §13.
//
// WHY a transaction and not "send whenever the screen looks ready":
//   P4 — pfterm.c#refresh returns WITHOUT drawing while the client still has keys in
//   pttbbs' input buffer (`if (ft.typeahead && fterm_typeahead()) return;`). So if a
//   second PageDown reaches PTT while it is still drawing the answer to the first, the
//   intermediate screen is never sent — that page's text is lost for good. This is the
//   "※ 發信站 / ※ 文章網址 那段消失" report: not a parse bug, a lost screen.
//   The previous code only deduped on the settle path; the fast path (_onViewUpdated)
//   recorded the page signature but never checked it, so any second "complete-looking"
//   frame on the SAME page (functionMode resume's forced notify, a waterball repaint,
//   any other forced notify) fired a duplicate PageDown.
//
// The response ack is the page SIGNATURE — the status row's "第 S~E 行" range, which
// changes on every successful page-down (P1/P2). While it still equals what we sent
// from, the response has not arrived and we must not send again.
//
//   P3 — progress==100 ⟺ mf_viewedAll() (the integer division makes them exactly
//   equivalent), and PMORE_UINAV_FORWARDPAGE returns immediately when viewedAll, i.e.
//   PTT answers a PageDown at the bottom with COMPLETE SILENCE. So percent is the
//   authoritative "stop" signal — more robust than the footer's first-cell colour,
//   which pfterm only repaints when that cell actually changes (P6).
//
//   P6 — only a frame whose cursor is parked at (rows-1, cols-1) is a complete server
//   response; anything else still carries the previous page's footer.
//
// `fromSettle` marks the recovery path: the screen has been quiet for SETTLE_MS, so PTT
// has flushed and is blocked in dogetch — there is no in-flight repaint left for a
// resend to be swallowed by, which makes a BOUNDED retry safe there (and only there).
// Returns the next state alongside the action so the caller stays a thin shim.
export function nextPageDownDecision({
  enabled, functionMode, complete, isStatusRow, pagePercent,
  sig, inFlightSig, retries, fromSettle
}) {
  const keep = { action: 'none', inFlightSig, retries, reachedPageEnd: undefined };
  if (!enabled || functionMode || !complete || !isStatusRow || sig == null)
    return keep;
  if (pagePercent >= 100)
    return { action: 'done', inFlightSig: null, retries: 0, reachedPageEnd: true };
  if (inFlightSig != null && sig === inFlightSig) {
    if (!fromSettle)
      return { action: 'wait', inFlightSig, retries, reachedPageEnd: false };
    if (retries < PAGE_DOWN_MAX_RETRIES)
      return { action: 'retry', inFlightSig, retries: retries + 1, reachedPageEnd: false };
    return { action: 'giveup', inFlightSig, retries, reachedPageEnd: false };
  }
  return { action: 'send', inFlightSig: sig, retries: 0, reachedPageEnd: false };
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
  // Auto-paging transaction state (see nextPageDownDecision). _inFlightSig = the page
  // signature ("第 a~b 行" range) we issued the outstanding PageDown FROM, or null when
  // idle; the response is acked by the signature CHANGING. BOTH the fast path
  // (_onViewUpdated) and the settle recovery (_onScreenSettled) go through it, so a
  // duplicate PageDown — which pttbbs' typeahead skip turns into a permanently lost
  // page (P4) — is impossible. Reset per article (enterEasyReading / leaveCurrentPost).
  this._inFlightSig = null;
  this._pageDownRetries = 0;
  // One gap self-heal per article (see _healFromTop), so a pathological article can
  // never loop on Home.
  this._healedOnce = false;
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
  // ARTICLE BOUNDARY — the only structural place the per-article paging transaction is
  // guaranteed to be reset. Do NOT rely on the key handlers for this: ← leaves an
  // article through stopEasyReading() (never leaveCurrentPost), and while easy reading
  // is already on, opening the next article does NOT go through enterEasyReading()
  // either (nextEasyReadingState requires !enabled). So the previous article's state
  // used to follow the user into the next one, wedging it permanently — see
  // _resetPagingState.
  //
  // Edge-scoped on purpose (3 <-> list/menu only). A mid-article dip (footer caught
  // half-repainted → pageState 0/5 for one settle) must NOT reset: dropping
  // _inFlightSig there would let the SAME page be paged down twice, which is exactly
  // the typeahead-skip page loss (P4) the transaction exists to prevent.
  const settled = this._termBuf.settledPageState;
  const prevSettled = this._termBuf.prevSettledPageState;
  const enteringArticle = settled === 3 && (prevSettled === 1 || prevSettled === 2);
  const leavingArticle = prevSettled === 3 && (settled === 1 || settled === 2);
  if (enteringArticle || leavingArticle)
    this._resetPagingState();

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
  const status = parseStatusRow(lastRowText);
  return nextEasyReadingRowState({
    // P3: progress==100 ⟺ mf_viewedAll(). Authoritative "already at the bottom" signal;
    // the footer colour below stays only as a fallback (see nextEasyReadingRowState).
    pagePercent: status ? status.pagePercent : null,
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
    isStatusRow: !!status,
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
  const s = this._currentPageStatus();
  return s ? (s.rowIndexStart + '~' + s.rowIndexEnd) : null;
};

// parseStatusRow of the CURRENT bottom row (null off an article page).
EasyReading.prototype._currentPageStatus = function() {
  const lastRowText = this._termBuf.getRowText(this._termBuf.rows - 1, 0, this._termBuf.cols);
  return parseStatusRow(lastRowText);
};

// One clean auto-paging transaction per ARTICLE. Every field here is per-post state
// that MUST NOT survive into the next article:
//   _inFlightSig        — the page signature is NOT unique across articles: every
//                         article's first page is "1~22". A leftover "1~22" makes the
//                         next article's first page look like "the response we are
//                         still waiting for" ⇒ 'wait' forever on the fast path,
//                         'giveup' forever on the settle path ⇒ stuck on page 1.
//   _pageDownRetries    — a spent retry budget would carry the giveup into the next
//                         article as well.
//   easyReadingReachedPageEnd — set once an article is read to the bottom
//                         (pagePercent 100); it used to veto the whole settle recovery
//                         for the NEXT article, which is the "很容易卡在第一頁" report.
//   _healedOnce         — each article gets its own single gap self-heal.
// Callers: the settle article boundary (_onPageStateSettled), leaveCurrentPost (the
// article→article jumps that never pass a list: [ ] a b f = + -), enterEasyReading /
// exitEasyReading, and _healFromTop.
EasyReading.prototype._resetPagingState = function() {
  this.sendCommandAfterUpdate = '';
  this.easyReadingReachedPageEnd = false;
  this._inFlightSig = null;
  this._pageDownRetries = 0;
  this._healedOnce = false;
};

// Single gate every auto page-down goes through — both the per-frame fast path
// (_onViewUpdated) and the settle recovery (_onScreenSettled). Gathers the facts,
// runs the pure nextPageDownDecision, writes the resulting transaction state back and
// sends at most one key. See nextPageDownDecision for the pmore invariants behind it.
EasyReading.prototype._maybeSendPageDown = function(keys, fromSettle) {
  const status = this._currentPageStatus();
  const d = nextPageDownDecision({
    enabled: this._enabled,
    functionMode: this._functionMode,
    // P6: the cursor is parked at (rows-1, cols-1) only at the end of a full response.
    complete: this._termBuf.cur_y === this._termBuf.rows - 1 &&
              this._termBuf.cur_x === this._termBuf.cols - 1,
    isStatusRow: !!status,
    pagePercent: status ? status.pagePercent : null,
    sig: status ? (status.rowIndexStart + '~' + status.rowIndexEnd) : null,
    inFlightSig: this._inFlightSig,
    retries: this._pageDownRetries,
    fromSettle: !!fromSettle
  });
  if (d.action === 'none')
    return d.action;
  // Record the transaction's turning points. Without this, every way the auto-paging
  // can stall looks the same in a debug capture — "not a single send event after the
  // article opened" — and there is no way to tell a spent retry budget from a stale
  // reachedPageEnd. 'send'/'wait' are left out: one is visible as the send event
  // itself, the other fires on every frame.
  if (d.action !== 'send' && d.action !== 'wait') {
    this._core.debugRecorder?.log('easyReading.pageDown', {
      action: d.action,
      fromSettle: !!fromSettle,
      sig: status ? (status.rowIndexStart + '~' + status.rowIndexEnd) : null,
      // state BEFORE the decision is applied — that is what explains the action
      wasInFlightSig: this._inFlightSig,
      wasRetries: this._pageDownRetries
    });
  }
  this._inFlightSig = d.inFlightSig;
  this._pageDownRetries = d.retries;
  if (d.reachedPageEnd !== undefined)
    this.easyReadingReachedPageEnd = d.reachedPageEnd;
  if (d.action === 'send' || d.action === 'retry')
    this._send(keys);
  return d.action;
};

// User-driven rescue for a stalled auto-paging transaction, wired to PageDown (key and
// mouse) when the accumulated page cannot scroll any further. Auto-paging is supposed
// to be invisible, but every failure mode of it looks identical to the user — the long
// page just stops growing and PgDn does nothing at all. Clearing the transaction and
// re-issuing is safe here by the same argument as the settle retry: this runs from a
// user keypress, long after PTT flushed its response, so there is no in-flight repaint
// for the key to be swallowed by (P4). Does nothing once the status row says 100%
// (pmore answers a PageDown at the bottom with silence anyway, P3).
EasyReading.prototype._kickPageDown = function() {
  const status = this._currentPageStatus();
  if (!status || status.pagePercent >= 100)
    return;
  this._core.debugRecorder?.log('easyReading.pageDownKick', {
    sig: status.rowIndexStart + '~' + status.rowIndexEnd,
    inFlightSig: this._inFlightSig,
    retries: this._pageDownRetries
  });
  this._inFlightSig = null;
  this._pageDownRetries = 0;
  this._maybeSendPageDown('\x1b[6~', /* fromSettle */ true);
};

// Gap self-heal (pmore invariant P1, raised by term_view.accumulatePageLines as
// buf.easyReadingGapDetected). A page was swallowed — its text will never be sent
// again on its own, so re-read the article from the top: Home is pmore's KEY_HOME →
// mf_goTop (pmore.c:2604), the cheapest deterministic way back to line 1. Bounded to
// once per article so a pathological case can't loop.
EasyReading.prototype._healFromTop = function() {
  this._termBuf.easyReadingGapDetected = false;
  if (this._healedOnce) {
    console.log('easy reading: gap again after healing — leaving the page as is');
    return;
  }
  console.log('easy reading: lost page detected, re-reading from the top');
  this._core.debugRecorder?.log('easyReading.gapHeal');
  this._resetPagingState();
  this._healedOnce = true;  // AFTER the reset — this article's heal budget is spent
  this._termBuf.pageLines = [];
  this._termBuf.easyReadingPendingReset = true;
  this._termBuf.prevPageState = 0;
  if (this._view) {
    this._view._accEndRow = null;
    this._view._lastAccumulatedSig = null;
  }
  this._send('\x1b[1~');  // KEY_HOME → mf_goTop
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
  if (this._termBuf.pageState !== 3) {
    // Settled OFF the article. term_view.redraw deliberately KEEPS the accumulated page
    // while settledPageState is still 3 (a per-frame pageState dip mid-article must not
    // throw the long page away), so the teardown moved here: the debounced state now
    // agrees we really left, and this is the last chance to run it — no further redraw
    // is guaranteed after the list has finished painting.
    this._teardownAccumulationOffArticle();
    return;
  }
  // P1 violated on the last accumulate → a page was lost; nothing else matters.
  if (this._termBuf.easyReadingGapDetected) {
    this._healFromTop();
    return;
  }
  // A response whose cursor park landed in a CURSOR-ONLY notify window never reached
  // redraw (notify only calls view.update() on the 'changed' branch), so its page was
  // never accumulated. The screen is quiet and the cursor parked now, so replay one
  // full repaint — accumulatePageLines then sees a complete frame and appends it.
  const sig = this._currentPageSignature();
  if (sig && this._view && this._view._lastAccumulatedSig !== sig) {
    this._forceRepaint();
    if (this._termBuf.easyReadingGapDetected) {
      this._healFromTop();
      return;
    }
    // _forceRepaint replays 'change'/'viewUpdate', so the fast path has already run
    // the paging decision for this screen; nothing left for the settle path to do.
    return;
  }

  if (this.sendCommandAfterUpdate)  // a command is mid-flight (incl. skipOne) — let the frame loop drive
    return;
  // NOTE: deliberately NO `if (this.easyReadingReachedPageEnd) return;` here. The
  // settle path must be idempotent on the CURRENT screen — "already at the bottom" is
  // re-derived from this screen's status row twice over (pagePercent in
  // _computeRowState and again in nextPageDownDecision, P3), so letting a possibly
  // stale flag veto the whole recovery bought nothing and wedged the next article.
  const rowState = this._computeRowState();
  this._applyRowState(rowState);  // fix any cursor-dependent flag against the now-stable cursor

  if (rowState.sendCommandAfterUpdate && rowState.sendCommandAfterUpdate !== 'skipOne') {
    // A settle-path send has no following 'viewUpdate' to flush the queue, so never
    // leave the command queued — it would re-fire on the next frame's viewUpdate.
    this.sendCommandAfterUpdate = '';
    this._maybeSendPageDown(rowState.sendCommandAfterUpdate, /* fromSettle */ true);
  }
};

// Replay one full repaint of the CURRENT screen.
//
// MUST go through term_buf.notify() rather than view.redraw(true) directly: notify is
// what runs updateCharAttr(), which is where a Big5 lead byte gets its isLeadByte flag.
// A settle can fire between "bytes arrived" and "the 30ms notify timer ran", so a bare
// redraw there would clone rows whose DBCS pairs are not yet marked — rowToText then
// returns raw Big5 (¡° instead of ※), those rows go into pageLines, and the NEXT page's
// overlap comparison against them fails ⇒ overlap 0 ⇒ the shared row is appended twice
// (a duplicated 「※ 文章網址」 line). Caught by the offline split-frame test.
EasyReading.prototype._forceRepaint = function() {
  this._termBuf.lineChangeds.fill(true);
  this._termBuf.changed = true;
  this._termBuf.notify();
};

// Drop the accumulated long page + its padding/scroll once the DEBOUNCED state says we
// are off the article for good. Counterpart to term_view.redraw's transient guard.
EasyReading.prototype._teardownAccumulationOffArticle = function() {
  const view = this._view;
  if (!view || typeof view.hideEasyReadingOverlays !== 'function')
    return;
  const hasPage = !!(this._termBuf.pageLines && this._termBuf.pageLines.length);
  const hasPadding = !!(view.mainContainer && view.mainContainer.style &&
                        view.mainContainer.style.paddingBottom);
  if (!hasPage && !hasPadding)
    return;
  view.hideEasyReadingOverlays();
  this._forceRepaint();
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
    // Resume = SAME article: a leftover pending-reset would make a short article's
    // first page rebuild (drop accumulation) — clear it explicitly.
    this._termBuf.easyReadingPendingReset = false;
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
  // accumulatePageLines (which just ran inside view.update()) may have found a lost
  // page — handle that before anything else, it invalidates the whole transaction.
  if (this._enabled && !this._functionMode && this._termBuf.easyReadingGapDetected) {
    this.sendCommandAfterUpdate = '';
    this._healFromTop();
    return;
  }
  if (this.sendCommandAfterUpdate) {
    const keys = this.sendCommandAfterUpdate;
    this.sendCommandAfterUpdate = '';
    if (keys != 'skipOne') {
      // Fast path goes through the SAME single-in-flight gate as the settle recovery.
      // It used to send unconditionally (recording the signature but never checking
      // it), so a second complete-looking frame on the same page fired a duplicate
      // PageDown → pttbbs typeahead skip → that page's text lost. See
      // nextPageDownDecision.
      console.log("send:" + keys + " -> " + this._maybeSendPageDown(keys, false));
    }
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
  // Sticky companion to the one-shot prevPageState=0 above: redraw overwrites
  // prevPageState every frame, so a stale old-article frame between here and the
  // new article's first page can eat the one-shot and the new article would take
  // the continuation branch (pile-up). This flag is only consumed by
  // accumulatePageLines on a CONFIRMED first article page (statusStart===1) — see
  // decideAccumulateBranch.
  this._termBuf.easyReadingPendingReset = true;
  // New post → a clean auto-paging transaction. Covers the article→article jumps that
  // never pass through a list ([ ] 同標題、a/b/f/=/+/-), which the settle article
  // boundary in _onPageStateSettled cannot see. See _resetPagingState.
  this._resetPagingState();
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
  this._core.debugRecorder?.log('easyReading.enter');
  this._enabled = true;
  this._functionMode = false;
  this._savedScrollTop = null;
  // Force accumulatePageLines down its "new article" branch (restart pageLines as
  // the whole screen) instead of the same-article continuation branch, and start
  // page accumulation from empty.
  this._termBuf.prevPageState = 0;
  this._termBuf.easyReadingPendingReset = true; // sticky twin — see leaveCurrentPost
  this._termBuf.pageLines = [];
  this._termBuf.easyReadingGapDetected = false;
  this._resetPagingState();  // fresh article → nothing in flight, own heal budget
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
  this._core.debugRecorder?.log('easyReading.exit');
  // Stop any pending/in-flight auto page down. This also clears
  // easyReadingReachedPageEnd, which the transitive switchToEasyReadingMode() →
  // leaveCurrentPost() below reads to decide ignoreOneUpdate — so leaving from the
  // bottom now arms that one-shot too. Harmless: it only skips ONE frame's paging
  // decision, and the settle recovery re-runs it right after.
  this._resetPagingState();
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
        // Can't scroll any further AND the article isn't fully loaded ⇒ the auto-paging
        // transaction is stuck, and PgDn would silently do nothing (the reported
        // symptom). Kick it. See _kickPageDown.
        if (!this._scrollBy(this._turnPageLines))
          this._kickPageDown();
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
        // Any other key falls through to native PTT and may open an in-post prompt /
        // menu / editor (r 回應、X/% 推文、y 收暫存檔、h 說明、o 選項、p 播放、\ 色彩、
        // / 搜尋、; 指定頁、: 指定行、# 文章代碼、s 切換看板、數字 指定頁、左右捲 ,.<>…).
        // Switch to functionMode so we mirror whatever PTT draws LIVE (no hardcoded
        // overlay, no per-prompt parsing); do NOT preventDefault — the key still reaches
        // PTT. Exit is content-judged on settle (_evalFunctionModeExit).
        //
        // NOTE: there used to be a `"123456789hops;,./\\H#OP:<>"` swallow list here (an
        // upstream pre-functionMode leftover, robertabcd b346f46) that preventDefault'd
        // all those pmore function keys to a no-op, because the old self-drawn long page
        // had no way to show the native in-place menu they open and would cover it. With
        // functionMode that's solved — those keys now fall through here like any other.
        // Removed so 說明(h)/選單/搜尋/指定頁… work again. See docs/easy-reading.md.
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
      if (!this._scrollBy(this._turnPageLines))
        this._kickPageDown();  // same self-rescue as the PageDown key
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
