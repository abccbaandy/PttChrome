// Click-to-navigate for PTT article-code (AID) links in easy reading.
//
// Clicking a "#1gIeu-3A" link (detected by aid_parse.js, rendered by
// Row/LinkSegmentBuilder) drives the native key sequence a user would type:
//   s <board> ⏎   (board jump — works from INSIDE the article too, so no
//                  leave-article step is needed; always taken, even for the
//                  same board: one code path, and the s-search is forgiving)
//   # <aid> ⏎     (AID search — cursor lands on the target row)
//   ⏎             (open the article)
//
// …but ONLY when the pager is in currstat == READING. mbbsd/more.c:102-112 gates
// both s (RET_SELECTBRD) and # (RET_SELECTAID) on it, so inside a 站內信
// (currstat == RMAIL) they are DONOTHING and "s<board>\r" gets eaten KEY BY KEY
// as pager hotkeys instead (Y=回信給所有人, X/%=推文, T=改標題, E=編輯…) — a
// misfire, not just a no-op (回報實錄 ptt-debug-20260813: 畫面直接跳到另一封信).
// So the sequence is preceded by an ESCAPE preamble whenever the footer does not
// prove READING (parsePagerFooterContext, single-directional — see string_util):
//   ← × n         (back out one level per press until 【主功能表】)
// 主功能表 is the only safe place to resume from: mbbsd/menu.c:498 routes s in
// MMENU/TMENU/XMENU to ReadSelect() → do_select() → a real board entry, whereas
// mbbsd/board.c:1902's s (看板列表/我的最愛/分類看板) is a SEARCH that only moves
// the cursor. The price is that ReadSelect() calls Read(), which shows the board's
// 進板畫面 + pressanykey on this session's first entry (mbbsd/bbs.c:4482-4492) —
// the in-article path never does (more.c:177 calls Select() alone) — so the
// via-menu board jump also dismisses those. See _enqueueBoardJump.
// Each step is a serialized CommandQueue command completed by CONTENT (an
// expect over the settle facts), exactly like list_session's transactions.
// While the sequence runs, user input is blocked (`active` is checked at the
// term_view/pttchrome input entry points) and the REAL native screen is
// mirrored live: the article easy reading enters functionMode, and an engaged
// list session is parked in its own functionMode via beginExternalNavigation()
// so its reducer stays out of the way (clean-list settles stay; the final
// article settle takes the normal handoff).
//
// Failures are visible, never silently retried (v5 convention): any step's
// onFail unlocks input, flashes a banner and leaves the native screen as-is —
// the easy-reading/list state machines self-converge from whatever shows.

// Going BACK (the same machinery in reverse)
// ------------------------------------------
// PTT keeps no jump origin, so "back" is a SECOND navigation replayed from an
// anchor captured before we left — exactly BePTT's design (a stack of key
// sequences, replayed on the back press), except every step is verified by
// content here instead of being sent blind. The stack lives in nav_history.js;
// the only difference between a forward jump and a back run is the middle step
// (_enqueueMiddle): #<aid>, <num> or nothing at all.
//
// The capture ORDER is an invariant: the anchor must be read BEFORE
// _enterFunctionMode() / beginExternalNavigation(), because the latter clears
// list_session's _boardName/_serverNum (list_session.js#_enterFunctionMode).
//
// A num anchor is verified against the landing row's subject before ⏎ goes
// out: article numbers shift when posts are deleted, and opening the WRONG
// article is far worse than stopping on the list.

import { parseStatusRow, parsePagerFooterContext } from './string_util';
import { subjectOfListText } from './list_session';
import { NavHistory, chooseAnchor } from './nav_history';
import { parsePostInfoAid } from './aid_parse';

// AID search rejected: pttbbs answers with a press-any-key message instead of
// a clean list. Belt-and-braces text guard for the (unlikely) case the message
// still classifies as clean-list.
const AID_NOT_FOUND_RE = /找不到|不正確/;

// ← as the terminal sees it. Backs out exactly one level everywhere the escape
// preamble can run (pmore, i_read list, domenu) and is a no-side-effect dismiss
// on a pressanykey screen.
const KEY_LEFT = '\x1b[D';

// 主功能表 title (term_buf.setPageState / classifyListScreen use the same literal).
// Exported for deep_link_controller, which uses "row 0 starts with this" as its
// one and only "the user is logged in" signal.
export const MAIN_MENU_TITLE = '【主功能表】';

// The board's 進板畫面 tail: mbbsd/bbs.c#Read → pressanykey(). Same literals
// term_buf.setPageState matches for pageState 5.
const PRESS_ANY_KEY_RE = /請按任意鍵繼續|請按 空白鍵 繼續/;

// Escape presses allowed before giving up. 站內信 needs 3 (信件內容 → 信件列表 →
// 郵件選單 → 主功能表); the slack covers deeper nests. A cap is mandatory: with an
// over-quota mailbox mbbsd/menu.c:493 turns ← in the MAIL menu into 'R' (forced
// back into reading mail), so the screen keeps changing but never reaches MMENU.
const MAX_ESCAPE_STEPS = 6;

// 進板畫面 pager + its pressanykey = 2 keys; the slack absorbs a multi-page one.
const MAX_ENTER_DISMISS = 3;

// Dismisses the Q post-info box's pressanykey() (= vmsg(NULL), which consumes
// exactly ONE key — mbbsd/vtuikit.c:439-455).
//
// It CANNOT be \f: Ctrl-L is swallowed by mbbsd/io.c#system_key_hook (:196-203)
// which answers KEY_INCOMPLETE, and vkey() loops on that (:432-434) — the byte
// never reaches any key handler, it only forces a redraw. That is precisely why
// \f is a safe universal probe everywhere else, and precisely why it can never
// dismiss a pressanykey (live-verified 2026-08-15: the box stayed up, the
// following 's' was eaten as the dismissal and the board name was then typed
// into the pager as hotkeys — 'h' 說明 / 'a' 作者下一篇).
//
// Space is inert for us on both possible screens: page-down on the article list
// we are about to leave anyway, page-down in the pager if the box never came up.
// ← must NOT be used: leaking one to the list would leave the board.
const KEY_DISMISS = ' ';

function screenSignature(rowTexts) {
  return (rowTexts || []).join('\n');
}

// One navigation run, threaded through every step instead of the old
// (aid, board, boardLower, …) parameter chain:
//   target: where we are going — a forward jump's { board, kind:'aid', aid },
//           or a nav_history anchor when going back
//   boardLower: the case-insensitive board comparison key (landing expects)
//   dir: 'forward' (an AID link click) | 'back' (the back button / shortcut)
// Only `target.kind` decides the middle step (_enqueueMiddle); everything else
// — the escape preamble, the board jump, the 進板畫面 dismissals, the final ⏎ —
// is shared byte for byte between the two directions.
function makeRun(target, dir) {
  return {
    target: target,
    boardLower: String(target.board).toLowerCase(),
    dir: dir
  };
}

export function AidNavigation(core, view, termBuf, queue, history) {
  this._core = core;
  this._view = view;
  this._termBuf = termBuf;
  this._queue = queue;
  this._history = history || new NavHistory();
  // True while the key sequence is in flight — input entry points check this
  // (term_view.onKeyDown / App.onMouse_click / wheel) and swallow everything.
  this.active = false;
  // One-shot: swallow the leaveCurrentPost our own landing causes (noteLeftPost).
  this._ownedLeave = false;
}

AidNavigation.prototype = {
  _hint: function(msg, ms) {
    if (this._view.flashListHint) this._view.flashListHint(msg, ms || 4000);
  },

  _fail: function(msg) {
    this.active = false;
    // Where we ended up is unknown, so every anchor below is suspect: drop the
    // whole stack rather than offer a back that lands somewhere wrong.
    this._history.abort();
    this._updateBackButton();
    this._hint('AID 跳文失敗：' + msg + '（已停在原生畫面）');
  },

  // The back affordance is a pure projection of (active, stack) — never
  // toggled by hand. Safe to call before term_view grows the overlay API.
  _updateBackButton: function() {
    const view = this._view;
    if (!view || !view.showBackButton || !view.hideBackButton) return;
    if (this.canGoBack()) {
      const entry = this._history.peek();
      view.showBackButton(entry ? entry.label : '', this.back.bind(this));
    } else {
      view.hideBackButton();
    }
  },

  // --- stack lifecycle notifications (pure: they must not touch the callers'
  // own state). All of them no-op while WE are driving: our own intermediate
  // screens are list/menu screens too.

  // From list_session._onScreenSettled, before queue.onSettle: the user landed
  // on a list or a menu without us — they left the article by themselves, so
  // the anchors no longer describe where they are.
  noteSettle: function(facts) {
    if (this.active || !facts) return;
    if (facts.kind !== 'clean-list' && facts.kind !== 'menu') return;
    this._history.invalidate();
    this._updateBackButton();
  },

  // From easy_reading.leaveCurrentPost: covers the article→article keys
  // ([ ] a b f = + -) that never pass through a list screen.
  //
  // One structural exception (live-verified 2026-08-13, this check is why the
  // first live back run failed): OUR OWN landing produces one of these. The run
  // enters easy reading's functionMode, and when the target article settles the
  // functionMode exit takes its 'leave' branch → leaveCurrentPost(). That fires
  // AFTER onDone has already cleared `active`, so without the one-shot below it
  // wipes the stack we just pushed — every jump would end with no way back.
  noteLeftPost: function() {
    if (this.active) return;
    const list = this._core.listSession;
    // Either way the post on screen is no longer the one the list session
    // opened, so its coordinate must not seed the NEXT anchor.
    if (list && list.noteLeftPost) list.noteLeftPost();
    if (this._ownedLeave) {
      this._ownedLeave = false;
      return;
    }
    this._history.invalidate();
    this._updateBackButton();
  },

  // Disconnect: the session (and pttbbs's per-board getkeep cursors) is gone.
  reset: function() {
    this._history.abort();
    this._updateBackButton();
  },

  // Whole native screen as one string — the escape steps decide "did ← actually
  // move us a level?" by content, never by timing (v5). \f (fullRepaint) makes
  // every judged frame complete, so an unchanged signature really means unchanged.
  _screenSignature: function() {
    const buf = this._termBuf;
    const rowTexts = [];
    for (let r = 0; r < buf.rows; ++r) rowTexts.push(buf.getRowText(r, 0, buf.cols));
    return screenSignature(rowTexts);
  },

  // Already at 主功能表 (the escape preamble's destination). Same literal test
  // _enqueueEscape's expect uses, read straight off the native buffer.
  _atMainMenu: function() {
    const buf = this._termBuf;
    return buf.getRowText(0, 0, buf.cols).indexOf(MAIN_MENU_TITLE) === 0;
  },

  // 'reading' → s/# are live in this pager; anything else → escape preamble.
  // Deliberately single-directional (see string_util.parsePagerFooterContext):
  // 'unknown' (footer squeezed out) degrades to the SLOW path, never the fast one.
  _pagerContext: function() {
    const buf = this._termBuf;
    return parsePagerFooterContext(buf.getRowText(buf.rows - 1, 0, buf.cols));
  },

  // board may be null when the #AID had no suffix AND the article header was
  // never parsed — nothing to navigate to, tell the user instead of guessing.
  start: function(aid, board) {
    if (this.active) return;
    if (!board) {
      this._hint('AID 跳文：無法判斷目標看板');
      return;
    }
    if (!this._termBuf.startedEasyReading) {
      // AID links only render in easy reading; a click that somehow arrives
      // outside an open post (stale DOM during a transition) is ignored.
      return;
    }
    // ORDER INVARIANT: capture where we are BEFORE _begin() parks the list
    // session (beginExternalNavigation → _enterFunctionMode clears _boardName
    // and _serverNum). Nothing is pushed until the run lands (commitJump).
    const lineIndex = this._currentLineIndex();
    this._history.beginJump(this._captureOriginAnchor(board, lineIndex), {
      board: board,
      aid: aid
    });
    this._hint('跳至 #' + aid + ' (' + board + ')…', 15000);
    const run = makeRun({ board: board, kind: 'aid', aid: aid }, 'forward');
    // Carried so _enqueueOriginAid can hand the scroll position to an anchor
    // built from nothing (same-board jump, 站內信): chooseAnchor returned null
    // there, so there is no previous anchor to inherit it from.
    run.originLineIndex = lineIndex;
    this._begin(run);
  },

  // A jump asked for from OUTSIDE the terminal (a deep link — see
  // deep_link_controller.js). Same machinery, three differences from start():
  //   - not gated on startedEasyReading: a deep link is normally consumed right
  //     after login, at 主功能表, where no article is open at all. start()'s
  //     gate would make it silently do nothing.
  //   - no origin anchor. beginJump(null, …) is legal (nav_history) and means
  //     no "← 返回" pill afterwards — correct, there IS no article to go back
  //     to. When the user IS reading something, the caller uses start() instead
  //     so the Q step captures a real anchor.
  //   - Q is skipped: with no origin anchor there is nothing to upgrade.
  // Returns whether the run was started (false = busy / bad arguments).
  startExternal: function(aid, board) {
    if (this.active) return false;
    if (!aid || !board) return false;
    this._history.beginJump(null, { board: board, aid: aid });
    this._hint('跳至 #' + aid + ' (' + board + ')…', 15000);
    const run = makeRun({ board: board, kind: 'aid', aid: aid }, 'forward');
    run.originLineIndex = null;
    run.external = true;
    this._begin(run);
    return true;
  },

  // Back to the article the last jump started from. Deliberately NOT gated on
  // startedEasyReading: the target article may be rendering natively (the user
  // toggled easy reading off), and the sequence drives the native screen anyway.
  back: function() {
    if (this.active) return;
    const anchor = this._history.beginBack();
    if (!anchor) {
      this._hint('沒有可返回的文章');
      return;
    }
    this._hint('返回 ' + anchor.label + '…', 15000);
    this._begin(makeRun(anchor, 'back'));
  },

  // Is a back run available right now (drives the button / the shortcut)?
  canGoBack: function() {
    return !this.active && this._history.canGoBack();
  },

  // The anchor for the article we are leaving, by priority (nav_history
  // .chooseAnchor). Must run before the mirrors are entered — see start().
  _captureOriginAnchor: function(targetBoard, lineIndex) {
    const ls = this._core.listSession;
    return chooseAnchor({
      landed: this._history.landed(),
      list: ls && ls.currentAnchor ? ls.currentAnchor() : null,
      articleBoard: this._view._articleBoard,
      targetBoard: targetBoard,
      lineIndex: lineIndex
    });
  },

  // Scroll position as a LINE index rather than pixels: the article is re-read
  // from the server on the way back, so a raw scrollTop would only be right if
  // every row rendered at exactly the same height again.
  _currentLineIndex: function() {
    const disp = this._view.mainDisplay;
    const chh = this._view.chh;
    if (!disp || !chh) return null;
    return Math.round(disp.scrollTop / chh);
  },

  // Shared entry for every run: lock input, put the REAL native screen on
  // screen, then pick the fast (in-article s) or slow (escape preamble) path.
  _begin: function(run) {
    this.active = true;
    this._updateBackButton(); // active → hidden: no second run mid-flight
    // Claim the leaveCurrentPost that our own landing will produce — see
    // noteLeftPost. Armed here (not on success) so a failed run's exit is
    // absorbed too; _fail clears the stack anyway.
    this._ownedLeave = true;

    // Show the REAL native screen while we drive it. The article easy reading's
    // functionMode is the existing live-mirror mechanism; when we leave the
    // post its settle logic runs leaveCurrentPost, and the final 2→3 settle
    // edge re-enables easy reading on the TARGET article — zero new coupling.
    this._core.easyReading._enterFunctionMode();
    // Park an engaged list session in its functionMode (native mirror,
    // nativeHold, queue flushed) so the shared queue is empty and its reducer
    // absorbs our intermediate clean-list settles. Must run BEFORE we enqueue.
    if (this._core.listSession) this._core.listSession.beginExternalNavigation();

    // Already where the escape preamble would have taken us. Skipping it is not
    // just an optimisation: _enqueueEscape SENDS ← and only then judges, and ←
    // at 主功能表 moves the highlight onto G)oodbye (see its own comment on
    // overshoot). The deep-link entry point lands here almost every time — the
    // link is usually opened right after logging in.
    if (this._atMainMenu()) {
      this._enqueueBoardJump(run, true, false);
      return;
    }
    if (this._pagerContext() !== 'reading') {
      // Not a board article (站內信 / 精華區 / footer squeezed out): Q would
      // describe something that is not a post we could ever navigate back to,
      // and s/# are dead here anyway. Straight to the escape preamble.
      this._enqueueEscape(run, 0, this._screenSignature());
      return;
    }
    // run.external: no origin anchor was captured (startExternal), so there is
    // nothing for the Q answer to upgrade — spend the command on the jump.
    if (run.dir === 'forward' && !run.external) {
      this._enqueueOriginAid(run);
      return;
    }
    this._enqueueBoardJump(run, false, false);
  },

  // Step 0 (forward jumps only): Q → the post-info box, which is the ONLY way
  // to learn the AID of the article we are leaving (mbbsd/more.c:70 →
  // bbs.c#view_postinfo:3691-3705). That AID becomes the back anchor, and it is
  // the only anchor that survives a `/` search: MODE_SELECT renumbers the list
  // into its own space (read.c:661-665), so a number captured there points at a
  // different article once `s<board>` drops us back on the real list.
  // Same trick BePTT uses for ground truth (see docs/enhanced-addon.md §B).
  //
  // Best effort by design: every failure just continues WITHOUT the upgrade, so
  // the worst case is exactly today's behaviour. Only a flush (the navigation
  // context itself is gone) is fatal, like every other step.
  _enqueueOriginAid: function(run) {
    const self = this;
    this.queryPostAid({
      kind: 'aid-origin-info',
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      onDone: function(info) {
        if (info) {
          self._history.upgradePendingOriginAid(
            info.board,
            info.aid,
            run.originLineIndex
          );
          self._updateBackButton();
        }
        // dismissFirst: the box's pressanykey is still waiting, so the board
        // jump is prefixed with the dismissal instead of spending a command.
        self._enqueueBoardJump(run, false, true);
      },
      onFail: function() {
        // Degrade, never fail: the jump itself is still perfectly doable, the
        // back anchor just stays at whatever tier chooseAnchor picked.
        self._enqueueBoardJump(run, false, true);
      }
    });
  },

  // The Q post-info transaction itself, shared by the jump's anchor upgrade
  // above and by "複製本篇連結" (deep_link_controller): the three non-obvious
  // constraints — no fullRepaint, a pressanykey tail IS the answer "this post
  // has no AID", and the box may only be dismissed with KEY_DISMISS — must
  // exist in exactly one place.
  //
  // onDone receives { aid, board } (board may be null) or null. Dismissing the
  // box is the CALLER's job: the jump folds it into its next command, a caller
  // with no next command must send dismissPostInfo() itself or the user is left
  // staring at the box.
  queryPostAid: function(handlers) {
    this._queue.enqueue({
      keys: 'Q',
      kind: handlers.kind || 'aid-post-info',
      // NO fullRepaint: the appended \f would be eaten by view_postinfo's
      // closing pressanykey() and the box would be gone by the time the screen
      // settles — we would read the list back instead of the AID.
      fullRepaint: false,
      onFlushed: handlers.onFlushed,
      timeoutMs: 2500,
      expect: function(snapshot, facts) {
        for (let r = 0; r < facts.rowTexts.length; ++r) {
          const info = parsePostInfoAid(facts.rowTexts[r]);
          if (info) return { info: info };
        }
        // Box is up but this post has no AID (bbs.c:3707 prints a bare frame
        // line). A real answer — stop waiting and move on without an upgrade.
        const lastRow = facts.rowTexts[facts.rows - 1] || '';
        return PRESS_ANY_KEY_RE.test(lastRow) ? { info: null } : false;
      },
      onDone: function(result) {
        handlers.onDone(result.info);
      },
      onFail: function(reason) {
        handlers.onFail(reason);
      }
    });
  },

  // Put the reader back on the post after a Q that was asked purely to LEARN the
  // AID (「複製本篇連結」). Reading the info box is not free: mbbsd/bbs.c:2375-2377
  // answers RET_DOQUERYINFO with `view_postinfo(...); return FULLUPDATE;` — the
  // FULLUPDATE leaves the pager and repaints the LIST. So after Q the user is on
  // the article list no matter what, with the cursor still parked on the post
  // (i_read never moved it). Two keys put it back:
  //   ␣  dismiss the box's pressanykey → the list
  //   ⏎  reopen the post under the cursor
  // The jump path never needed this because its next step (s<board>) is a list
  // command anyway — which is exactly why this only showed up once the copy
  // action started using the same Q (live-verified 2026-08-16: 複製完就跳出文章).
  //
  // lineIndex (optional): the reading position to restore once the post has
  // grown back — same one-shot easy reading uses for an AID back run.
  reopenAfterPostInfo: function(lineIndex, handlers) {
    const self = this;
    const h = handlers || {};
    this._queue.enqueue({
      keys: KEY_DISMISS,
      kind: 'aid-post-info-dismiss',
      fullRepaint: true,
      onFlushed: h.onFlushed,
      timeoutMs: 4000,
      // The list is where Q leaves us; a still-article frame means the box was
      // never up (nothing to dismiss) and we are already home.
      expect: function(snapshot, facts) {
        if (facts.kind === 'clean-list') return { onList: true };
        if (facts.kind === 'article') return { onList: false };
        return !!parseStatusRow(facts.rowTexts[facts.rows - 1] || '')
          ? { onList: false }
          : false;
      },
      onDone: function(result) {
        if (!result.onList) {
          if (h.onDone) h.onDone();
          return;
        }
        self._enqueueReopen(lineIndex, h);
      },
      onFail: h.onFail || function() {}
    });
  },

  _enqueueReopen: function(lineIndex, h) {
    const self = this;
    this._queue.enqueue({
      keys: '\r',
      kind: 'aid-post-info-reopen',
      fullRepaint: true,
      onFlushed: h.onFlushed,
      timeoutMs: 4000,
      expect: function(snapshot, facts) {
        if (facts.kind === 'article') return true;
        return !!parseStatusRow(facts.rowTexts[facts.rows - 1] || '');
      },
      onDone: function() {
        const er = self._core.easyReading;
        if (lineIndex && er && er.requestScrollRestore)
          er.requestScrollRestore(lineIndex);
        if (h.onDone) h.onDone();
      },
      onFail: h.onFail || function() {}
    });
  },

  // Step 0 (only when the pager is not currstat == READING): ← until 【主功能表】.
  // One press per command so every level is confirmed by CONTENT before the next
  // key goes out — a blind burst would be typeahead-swallowed (protocol §1/§2)
  // and could overshoot into 主功能表's ← (which highlights G)oodbye).
  _enqueueEscape: function(run, step, prevSig) {
    const self = this;
    this._queue.enqueue({
      keys: KEY_LEFT,
      kind: 'aid-escape',
      fullRepaint: true,
      // Same reason as the other steps: flush() is silent by contract, and a
      // dropped command would leave `active` stuck true (every keystroke
      // swallowed at the term_view entry point, with no way back).
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: 4000,
      expect: function(snapshot, facts) {
        if ((facts.rowTexts[0] || '').indexOf(MAIN_MENU_TITLE) === 0)
          return { menu: true };
        const sig = screenSignature(facts.rowTexts);
        // Unchanged screen = ← did nothing (or was swallowed): NOT a level up.
        // Stay in flight → probe → miss → visible fail, never a silent retry.
        return sig === prevSig ? false : { sig: sig };
      },
      onDone: function(result) {
        if (result.menu) {
          self._enqueueBoardJump(run, true, false);
          return;
        }
        if (step + 1 >= MAX_ESCAPE_STEPS) {
          self._fail('退不回主功能表（層數過多）');
          return;
        }
        self._enqueueEscape(run, step + 1, result.sig);
      },
      onFail: function(reason) {
        self._fail('退不回主功能表（' + reason + '）');
      }
    });
  },

  // Dismiss the 進板畫面 that ReadSelect() → Read() shows on this session's first
  // entry to a board (mbbsd/bbs.c:4482-4492: more(notes) then pressanykey()).
  // ← leaves the pmore pager AND satisfies pressanykey, so one key handles both.
  _enqueueEnterBoardDismiss: function(run, round) {
    const self = this;
    this._queue.enqueue({
      keys: KEY_LEFT,
      kind: 'aid-board-enter',
      fullRepaint: true,
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: 4000,
      expect: this._boardLandingExpect(run.boardLower),
      onDone: function(result) {
        self._onBoardLanding(run, result, round);
      },
      onFail: function(reason) {
        self._fail('進入看板 ' + run.target.board + ' 失敗（' + reason + '）');
      }
    });
  },

  // Shared by the via-menu board jump and its dismiss rounds: the landing is the
  // target board's clean list; a 進板畫面 or a pressanykey tail is a known
  // intermediate, everything else keeps waiting.
  _boardLandingExpect: function(boardLower) {
    return function(snapshot, facts) {
      if (
        facts.kind === 'clean-list' &&
        facts.boardName != null &&
        facts.boardName.toLowerCase() === boardLower
      )
        return { landed: true };
      const lastRow = facts.rowTexts[facts.rows - 1] || '';
      if (PRESS_ANY_KEY_RE.test(lastRow)) return { dismiss: true };
      // We are between 主功能表 and the list here, so an article screen can only
      // be the 進板畫面 pager — the target post is still two commands away.
      if (facts.kind === 'article') return { dismiss: true };
      // The OTHER shape of the same 進板畫面. mbbsd/bbs.c#Read:4470 shows the
      // board notes with more(buf, NA), and NA == PMORE_AUTO_EXIT
      // (pmore.c:199-200) — that mode draws NO footer prompt, so the bottom row
      // is blank and the cursor parks there ⇒ classifyListScreen says 'prompt',
      // not 'article'. Live-verified 2026-08-16 on Steam: with only the three
      // checks above, the whole jump wedged here (probe → miss → 「切換看板失敗」),
      // which is exactly what a deep link opened from a cold start hits, every
      // time, on any board that has notes.
      //
      // Still 主功能表 in row 0 means we never left it (the s was swallowed, or
      // the board name was rejected): NOT a 進板畫面, and a ← there would only
      // move the highlight onto G)oodbye. Keep waiting → probe → visible miss.
      if (
        facts.kind === 'prompt' &&
        (facts.rowTexts[0] || '').indexOf(MAIN_MENU_TITLE) !== 0
      )
        return { dismiss: true };
      return false;
    };
  },

  _onBoardLanding: function(run, result, round) {
    if (result.landed) {
      this._enqueueMiddle(run);
      return;
    }
    if (round + 1 >= MAX_ENTER_DISMISS) {
      this._fail('進板畫面未關閉（' + run.target.board + '）');
      return;
    }
    this._enqueueEnterBoardDismiss(run, round + 1);
  },

  // The board is now open on its clean list: pick the step that parks the
  // cursor on the target article. Anchor kinds, in order of trust — see
  // nav_history.js for why the number needs verifying and the board kind stops.
  _enqueueMiddle: function(run) {
    const target = run.target;
    if (target.aid) {
      this._enqueueAidSearch(run);
      return;
    }
    if (target.num != null) {
      this._enqueueNumberJump(run);
      return;
    }
    this._finishAtList(run);
  },

  // Board-only anchor: pttbbs restored this board's cursor for us (getkeep,
  // mbbsd/read.c:105/1171), so the article we left is under the cursor — but
  // nothing here IDENTIFIES it, so the last keypress is the user's to make.
  _finishAtList: function(run) {
    this.active = false;
    this._history.commitBack();
    this._updateBackButton();
    this._hint(
      '已回到 ' + run.target.board + ' 看板，游標停在原文章（按 Enter 開啟）',
      6000
    );
  },

  // Back step (num anchor): <num> ⏎ parks the cursor on that article number.
  // Same landing fingerprint as list_session's open-jump (the number prompt
  // leaves the footer blank, so the classifier says 'transient' on a perfectly
  // good landing — judge by the parked cursor, not by kind).
  _enqueueNumberJump: function(run) {
    const self = this;
    const num = run.target.num;
    const board = run.target.board;
    this._queue.enqueue({
      keys: String(num) + '\r',
      kind: 'aid-num-jump',
      fullRepaint: true,
      // Shared queue: flush() is silent by contract, and a dropped command
      // would leave `active` stuck true (every keystroke swallowed).
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: 4000,
      expect: function(snapshot, facts) {
        if (facts.cursorRowNum !== num) return false;
        if (facts.curY < 3 || facts.curY > facts.rows - 2) return false;
        if (facts.curX > 1) return false;
        return { facts: facts };
      },
      onDone: function(result) {
        const facts = result.facts;
        const rowText = facts.rowTexts[facts.curY] || '';
        // Article numbers shift when posts are deleted. If the subject under
        // the cursor is not the one we left, this is NOT that article: stop on
        // the list instead of opening whatever moved into the slot.
        if (
          run.target.subject &&
          subjectOfListText(rowText) !== run.target.subject
        ) {
          self.active = false;
          self._history.abort();
          self._updateBackButton();
          self._hint(
            '原文章位置已變動（可能已被刪除），已停在 ' + board + ' 列表',
            6000
          );
          return;
        }
        self._enqueueOpen(run);
      },
      onFail: function(reason) {
        self._fail(
          reason === 'miss'
            ? '找不到第 ' + num + ' 篇（原文章可能已被刪除）'
            : '跳序號逾時'
        );
      }
    });
  },

  // Step 1: s <board> ⏎ — the board-search jump. Lands on the target board's
  // clean list; a candidate menu / typo never satisfies the expect and ends as a
  // visible miss on the probed full frame.
  //   viaMenu=false: sent from INSIDE the article (pmore handles s directly,
  //     more.c:177 → Select() only). No 進板畫面 is possible → the expect stays
  //     exactly what it always was.
  //   viaMenu=true:  sent at 主功能表 after the escape preamble (menu.c:498 →
  //     ReadSelect() → do_select() + Read()), so the landing may be preceded by
  //     the board's 進板畫面 + pressanykey — dismissed by _onBoardLanding.
  //   dismissFirst: the Q post-info box is still up (its pressanykey is waiting
  //     for exactly one key), so the sequence is prefixed with a space — see
  //     KEY_DISMISS for why that key and not \f. Sent in the SAME write as the
  //     rest: pttbbs drains the whole input buffer without pausing, so the
  //     dismissal and the board switch land in one output burst and the screen
  //     never settles in between.
  _enqueueBoardJump: function(run, viaMenu, dismissFirst) {
    const self = this;
    const board = run.target.board;
    const boardLower = run.boardLower;
    this._queue.enqueue({
      keys: (dismissFirst ? KEY_DISMISS : '') + 's' + board + '\r',
      kind: 'aid-board-jump',
      fullRepaint: true,
      // The queue is SHARED with list_session, whose cleanup / native-mirror
      // switches / disconnect all call flush() — which is silent by contract
      // (no onFail). Without this hook the dropped step would leave `active`
      // stuck true forever and every keystroke swallowed at the term_view
      // entry point, with no way back.
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: 6000,
      expect: viaMenu
        ? this._boardLandingExpect(boardLower)
        : function(snapshot, facts) {
            return (
              facts.kind === 'clean-list' &&
              facts.boardName != null &&
              facts.boardName.toLowerCase() === boardLower
            );
          },
      onDone: function(result) {
        if (viaMenu) self._onBoardLanding(run, result, 0);
        else self._enqueueMiddle(run);
      },
      onFail: function(reason) {
        self._fail('切換看板 ' + board + ' 失敗（' + reason + '）');
      }
    });
  },

  // Step 2: # <aid> ⏎ — the in-board AID search. Success = the cursor parks on
  // a parsable article row in the entry area with the board title still up.
  // NOT gated on kind === 'clean-list': the AID-jump landing leaves the bottom
  // footer row BLANK (the # prompt cleared it and the jump repaint doesn't
  // redraw it — live-verified 2026-07-10, even after a \f probe), so the
  // classifier reads 'transient' on a perfectly good landing. "Not found"
  // parks the cursor on the bottom message row instead → cursorRowNum null →
  // probe → miss.
  _enqueueAidSearch: function(run) {
    const self = this;
    const aid = run.target.aid;
    this._queue.enqueue({
      keys: '#' + aid + '\r',
      kind: 'aid-search',
      fullRepaint: true,
      // The queue is SHARED with list_session, whose cleanup / native-mirror
      // switches / disconnect all call flush() — which is silent by contract
      // (no onFail). Without this hook the dropped step would leave `active`
      // stuck true forever and every keystroke swallowed at the term_view
      // entry point, with no way back.
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: 4000,
      expect: function(snapshot, facts) {
        if (facts.boardName == null) return false;
        if (facts.cursorRowNum == null) return false;
        if (facts.curY < 3 || facts.curY > facts.rows - 2) return false;
        const lastRow = facts.rowTexts[facts.rows - 1] || '';
        if (AID_NOT_FOUND_RE.test(lastRow)) return false;
        return true;
      },
      onDone: function() {
        self._enqueueOpen(run);
      },
      onFail: function(reason) {
        // Going back, the anchor may carry a number as a spare (nav_history
        // .upgradePendingOriginAid): pttbbs cannot #-search a PINNED post at
        // all (mbbsd/read.c:404's own FIXME), so an aid miss there is expected
        // rather than "we are lost" — try the number, or at least stop on the
        // board's list instead of dropping the whole stack.
        if (run.dir === 'back' && reason === 'miss') {
          if (run.target.num != null) {
            self._enqueueNumberJump(run);
            return;
          }
          self._finishAtList(run);
          return;
        }
        self._fail(
          reason === 'miss' ? '找不到文章 #' + aid : 'AID 搜尋逾時'
        );
      }
    });
  },

  // Step 3: ⏎ opens the article under the cursor. The article settle also
  // drives the normal handoffs (list session → suspended; easy reading
  // re-enters on its settled edge), so finishing here is just an unlock.
  _enqueueOpen: function(run) {
    const self = this;
    this._queue.enqueue({
      keys: '\r',
      kind: 'aid-open',
      fullRepaint: true,
      // The queue is SHARED with list_session, whose cleanup / native-mirror
      // switches / disconnect all call flush() — which is silent by contract
      // (no onFail). Without this hook the dropped step would leave `active`
      // stuck true forever and every keystroke swallowed at the term_view
      // entry point, with no way back.
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: 4000,
      expect: function(snapshot, facts) {
        if (facts.kind === 'article') return true;
        // Some posts open straight onto a short page whose bottom row is the
        // reading status row even if the classifier hesitates — accept that too.
        const lastRow = facts.rowTexts[facts.rows - 1] || '';
        return !!parseStatusRow(lastRow);
      },
      onDone: function() {
        self.active = false;
        // ORDER INVARIANT: unlock `active` FIRST, then hand over to easy reading.
        // easy_reading._send's first gate is `if (aidNavigation.active) return`, so
        // calling enterEasyReading() before the unlock would let the PageDown its
        // replayed notify queues be swallowed whole — the article would sit on page
        // one with the paging transaction already marked in-flight.
        //
        // And BEFORE requestScrollRestore below: the restore is driven by
        // _onViewUpdated, which only runs while easy reading is accumulating.
        //
        // Why this call is needed at all: the target article arrives on a 0→3
        // settle edge (the preceding AID-search screen has a blank footer row —
        // see _enqueueAidSearch — so it settles as pageState 0), which
        // nextEasyReadingState deliberately does not accept. See
        // nextEasyReadingExternalLanding.
        if (self._core.easyReading && self._core.easyReading.ensureEnabledOnArticle)
          self._core.easyReading.ensureEnabledOnArticle(true);
        // Only here — with the article really open — does the stack move.
        if (run.dir === 'back') {
          const entry = self._history.commitBack();
          self._updateBackButton();
          // Reading position: easy reading re-reads the article from the top
          // and grows it page by page, so this is a REQUEST that lands once
          // enough of the post has accumulated (easy_reading#requestScrollRestore).
          if (entry && entry.lineIndex && self._core.easyReading.requestScrollRestore)
            self._core.easyReading.requestScrollRestore(entry.lineIndex);
          self._hint('已返回 ' + (entry ? entry.label : ''), 1200);
        } else {
          self._history.commitJump();
          self._updateBackButton();
          // Replace the long-lived "跳至…" progress banner (15s) with a short
          // confirmation so it fades right away instead of lingering into the
          // opened article.
          self._hint('已跳至 #' + run.target.aid, 1200);
        }
      },
      onFail: function(reason) {
        self._fail('開啟文章失敗（' + reason + '）');
      }
    });
  }
};

export default AidNavigation;
