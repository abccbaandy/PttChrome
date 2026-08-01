// Click-to-navigate for PTT article-code (AID) links in easy reading.
//
// Clicking a "#1gIeu-3A" link (detected by aid_parse.js, rendered by
// Row/LinkSegmentBuilder) drives the native key sequence a user would type:
//   s <board> ⏎   (board jump — works from INSIDE the article too, so no
//                  leave-article step is needed; always taken, even for the
//                  same board: one code path, and the s-search is forgiving)
//   # <aid> ⏎     (AID search — cursor lands on the target row)
//   ⏎             (open the article)
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

import { parseStatusRow } from './string_util';

// AID search rejected: pttbbs answers with a press-any-key message instead of
// a clean list. Belt-and-braces text guard for the (unlikely) case the message
// still classifies as clean-list.
const AID_NOT_FOUND_RE = /找不到|不正確/;

export function AidNavigation(core, view, termBuf, queue) {
  this._core = core;
  this._view = view;
  this._termBuf = termBuf;
  this._queue = queue;
  // True while the key sequence is in flight — input entry points check this
  // (term_view.onKeyDown / App.onMouse_click / wheel) and swallow everything.
  this.active = false;
}

AidNavigation.prototype = {
  _hint: function(msg, ms) {
    if (this._view.flashListHint) this._view.flashListHint(msg, ms || 4000);
  },

  _fail: function(msg) {
    this.active = false;
    this._hint('AID 跳文失敗：' + msg + '（已停在原生畫面）');
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
    this.active = true;
    this._hint('跳至 #' + aid + ' (' + board + ')…', 15000);

    // Show the REAL native screen while we drive it. The article easy reading's
    // functionMode is the existing live-mirror mechanism; when we leave the
    // post its settle logic runs leaveCurrentPost, and the final 2→3 settle
    // edge re-enables easy reading on the TARGET article — zero new coupling.
    this._core.easyReading._enterFunctionMode();
    // Park an engaged list session in its functionMode (native mirror,
    // nativeHold, queue flushed) so the shared queue is empty and its reducer
    // absorbs our intermediate clean-list settles. Must run BEFORE we enqueue.
    if (this._core.listSession) this._core.listSession.beginExternalNavigation();

    this._enqueueBoardJump(aid, board, String(board).toLowerCase());
  },

  // Step 1: s <board> ⏎ — the board-search jump, sent from INSIDE the article
  // (pmore handles s directly). Lands on the target board's clean list; a
  // candidate menu / typo never satisfies the expect and ends as a visible
  // miss on the probed full frame.
  _enqueueBoardJump: function(aid, board, boardLower) {
    const self = this;
    this._queue.enqueue({
      keys: 's' + board + '\r',
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
      expect: function(snapshot, facts) {
        return (
          facts.kind === 'clean-list' &&
          facts.boardName != null &&
          facts.boardName.toLowerCase() === boardLower
        );
      },
      onDone: function() {
        self._enqueueAidSearch(aid);
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
  _enqueueAidSearch: function(aid) {
    const self = this;
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
        self._enqueueOpen(aid);
      },
      onFail: function(reason) {
        self._fail(
          reason === 'miss' ? '找不到文章 #' + aid : 'AID 搜尋逾時'
        );
      }
    });
  },

  // Step 3: ⏎ opens the article under the cursor. The article settle also
  // drives the normal handoffs (list session → suspended; easy reading
  // re-enters on its settled edge), so finishing here is just an unlock.
  _enqueueOpen: function(aid) {
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
        // Replace the long-lived "跳至…" progress banner (15s) with a short
        // confirmation so it fades right away instead of lingering into the
        // opened article.
        self._hint('已跳至 #' + aid, 1200);
      },
      onFail: function(reason) {
        self._fail('開啟文章失敗（' + reason + '）');
      }
    });
  }
};

export default AidNavigation;
