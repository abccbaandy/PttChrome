// Navigation history for AID jumps — the "go back to where I came from" stack.
//
// PTT itself has NO notion of a jump origin: mbbsd/read.c#select_by_aid only
// moves the cursor inside currboard and a cross-board jump is a real board
// switch (mbbsd/read.c:367, and see docs/pttbbs-screen-protocol.md §8.1). So
// "back" can only be a SECOND navigation, replayed from a description of where
// we were. That is exactly what BePTT does (a global stack of key sequences,
// replayed on the Android back press); the difference here is that the replay
// runs through CommandQueue with a per-step expect instead of being sent blind.
//
// What an entry stores is therefore an ANCHOR — how to get back — never any
// screen data:
//   kind 'aid'   #<aid> is the server-side identity of an article: immune to
//                deletions shifting numbers AND to a `/` search having renumbered
//                the list (MODE_SELECT is a separate numbering space —
//                mbbsd/read.c:661-665). Two sources: the article was ITSELF
//                reached by an AID jump (NavHistory.landed()), or — the normal
//                case — aid_navigation asked the server for it with the Q
//                post-info box before leaving (upgradePendingOriginAid).
//   kind 'num'   board + article number + subject. Covers the common "opened
//                from the list" case. Numbers DO shift when posts are deleted,
//                so the landing must be verified against `subject` before the
//                article is opened (aid_navigation._enqueueNumberJump).
//   kind 'board' board only: replay `s<board>` and stop on the list. pttbbs
//                keeps a per-board cursor (getkeep, mbbsd/read.c:105/1171 — an
//                unbounded link block, never evicted within a session), so the
//                cursor is still parked on the article we left. Deliberately
//                NOT auto-opened: unlike the other two kinds nothing here
//                identifies the article, so we hand the last keypress back to
//                the user.
//
// The begin/commit split is the whole safety story: a run that fails NEVER
// pushes and NEVER pops. Any failure, or any navigation we did not drive
// (the user pressing ← back to the list, a board switch, a disconnect), clears
// the WHOLE stack — a stale anchor would send the user somewhere wrong, which
// is far worse than losing the ability to go back.

// Anchor for "the article we are leaving right now", picked by priority.
// Pure function: everything it needs is passed in, so it is unit-testable
// without any of the live objects.
//
//   landed       {board, aid} of the current article when it was reached by an
//                AID jump (NavHistory.landed()); null otherwise
//   list         {board, num, subject} from ListSession.currentAnchor()
//   articleBoard view._articleBoard (null inside 站內信 — its header has no 看板)
//   targetBoard  where the jump is going (same-board jumps invalidate 'board')
//   lineIndex    scroll position as a line index (see aid_navigation), or null
// The number/subject an aid anchor carries as its fallback. Only accepted when
// the list session is talking about the SAME board and it knows the subject:
// _enqueueNumberJump opens blindly without a subject to verify, and a number
// from another board would open a random article there.
function numberFallback(list, board) {
  const ok =
    list &&
    list.num != null &&
    list.subject &&
    list.board &&
    board &&
    String(list.board).toLowerCase() === String(board).toLowerCase();
  return ok
    ? { num: list.num, subject: list.subject }
    : { num: null, subject: null };
}

export function chooseAnchor(input) {
  const inp = input || {};
  const lineIndex = inp.lineIndex == null ? null : inp.lineIndex;
  const landed = inp.landed;
  const list = inp.list;
  if (landed && landed.board && landed.aid) {
    // Keep the number as a FALLBACK even though the aid wins: pttbbs cannot
    // #-search a pinned (置底) post at all (mbbsd/read.c:404's own FIXME), and
    // aid_navigation drops back to the number when that search misses.
    const spare = numberFallback(list, landed.board);
    return {
      kind: 'aid',
      board: landed.board,
      aid: landed.aid,
      num: spare.num,
      subject: spare.subject,
      lineIndex: lineIndex,
      label: '#' + landed.aid
    };
  }

  if (list && list.num != null) {
    // The list session loses _boardName on any native excursion (the Q
    // post-info box is enough) while keeping the selected number, so fall back
    // to the article header's board — the post we are leaving is the one that
    // number points at, in the board its own header names.
    const board = list.board || inp.articleBoard;
    if (board) {
      return {
        kind: 'num',
        board: board,
        aid: null,
        num: list.num,
        subject: list.subject || null,
        lineIndex: lineIndex,
        label: board + ' 第 ' + list.num + ' 篇'
      };
    }
  }

  const board = inp.articleBoard;
  if (board) {
    // Same-board jump: the forward `#<aid>` overwrites this board's getkeep
    // cursor, so "go back to the board and the cursor is still there" is no
    // longer true — the anchor would be a lie. Better no back button at all.
    const targetLower = inp.targetBoard
      ? String(inp.targetBoard).toLowerCase()
      : null;
    if (!targetLower || String(board).toLowerCase() !== targetLower) {
      return {
        kind: 'board',
        board: board,
        aid: null,
        num: null,
        subject: null,
        lineIndex: lineIndex,
        label: board + ' 看板'
      };
    }
  }

  return null; // 站內信, or a same-board jump with nothing better — no back.
}

export function NavHistory(opts) {
  this._max = (opts && opts.max) || 8;
  this._stack = [];
  // {board, aid} of the article currently open, when it is known — i.e. we
  // navigated to it ourselves by AID. Feeds the level-1 anchor of the NEXT
  // jump, which is what makes A→B→C→back→back work with exact anchors.
  this._landed = null;
  // A run in flight: nothing is written to the stack until it lands.
  this._pending = null;
}

NavHistory.prototype = {
  depth: function() {
    return this._stack.length;
  },

  // No back while a run is in flight: the position is unknown until it lands
  // (this is also what keeps the back button hidden mid-navigation).
  canGoBack: function() {
    return !this._pending && this._stack.length > 0;
  },

  peek: function() {
    return this._stack.length ? this._stack[this._stack.length - 1] : null;
  },

  landed: function() {
    return this._landed;
  },

  // origin may be null (nothing worth going back to, e.g. 站內信): the jump
  // still runs, it just won't be reversible.
  beginJump: function(origin, target) {
    this._pending = { type: 'jump', origin: origin || null, target: target };
  },

  // The Q post-info box answered with the AID of the article we are LEAVING
  // (aid_navigation._enqueueOriginAid). Promote the in-flight origin anchor to
  // the aid tier — the only one immune to article numbers shifting, and the
  // only one that survives a `/` search at all (MODE_SELECT numbers live in a
  // separate space, mbbsd/read.c:661-665, so a num anchor captured there sends
  // the user to a different article on the way back).
  //
  // The existing num/subject/lineIndex ride along as the fallback: pttbbs
  // cannot #-search a pinned post (mbbsd/read.c:404 FIXME), so the aid tier
  // must not be a downgrade for those.
  //
  // board may be null when the box printed a non-board name (currboard empty):
  // the old anchor's board is then reused. With no board at all we do NOT
  // upgrade — an aid anchor without a board cannot be navigated to (the AID
  // search only ever looks inside currboard).
  upgradePendingOriginAid: function(board, aid, lineIndex) {
    const p = this._pending;
    if (!p || p.type !== 'jump' || !aid) return;
    const prev = p.origin;
    const useBoard = board || (prev && prev.board) || null;
    if (!useBoard) return;
    p.origin = {
      kind: 'aid',
      board: useBoard,
      aid: aid,
      num: prev ? prev.num : null,
      subject: prev ? prev.subject : null,
      // With no previous anchor there is nothing to inherit, so the caller
      // hands over the scroll position it captured before the mirrors went up.
      lineIndex: prev ? prev.lineIndex : lineIndex == null ? null : lineIndex,
      label: '#' + aid
    };
  },

  commitJump: function() {
    const p = this._pending;
    this._pending = null;
    if (!p || p.type !== 'jump') return;
    if (p.origin) {
      this._stack.push(p.origin);
      if (this._stack.length > this._max) this._stack.shift();
    }
    this._landed =
      p.target && p.target.board && p.target.aid
        ? { board: p.target.board, aid: p.target.aid }
        : null;
  },

  // Returns the anchor to navigate to, or null when there is nothing to go
  // back to. The entry stays on the stack until commitBack(): a failed back
  // must not consume it (it is cleared by abort() instead — see the header).
  beginBack: function() {
    if (!this.canGoBack()) return null;
    const entry = this.peek();
    this._pending = { type: 'back', entry: entry };
    return entry;
  },

  commitBack: function() {
    const p = this._pending;
    this._pending = null;
    if (!p || p.type !== 'back') return null;
    const entry = this._stack.pop() || null;
    // Only an aid anchor tells us the identity of the article we landed on;
    // after a num/board return the next jump falls back to a lower level.
    this._landed =
      entry && entry.kind === 'aid'
        ? { board: entry.board, aid: entry.aid }
        : null;
    return entry;
  },

  // A run failed: our position is unknown, so every anchor below is suspect.
  abort: function() {
    this._pending = null;
    this._stack.length = 0;
    this._landed = null;
  },

  // A navigation we did not drive (user left the post, board switch, menu,
  // disconnect). Same effect as abort; separate name so call sites read right.
  invalidate: function() {
    this.abort();
  }
};

export default NavHistory;
