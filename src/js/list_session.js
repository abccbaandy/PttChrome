// List easy reading v4 — the pure decision layer (this file, top half) and the
// ListSession owner class (bottom half, added in M6).
//
// Three principles (docs/easy-reading-list.md; blueprint was docs/handoff):
//   A. Content classification: the settle event only decides WHEN to evaluate;
//      WHAT the screen is comes from content predicates (screen fingerprints,
//      docs/pttbbs-screen-protocol.md §3/§5) — never from timing heuristics.
//   B. Explicit state machine: transitionListSession is the single source of
//      truth for mode changes; render/keyboard read the resulting state instead
//      of guessing from pageState.
//   C. Serialized commands: machine keys go through CommandQueue one in-flight
//      at a time (pttbbs typeahead skips repaints when keys race — protocol §2).
// Misclassification always degrades toward NATIVE (functionMode mirrors the raw
// screen), never toward a stale buffer.
import {
  parseListAuthor,
  parseListTitle,
  matchTitleBlacklist,
  pageArticleNums,
  isPinnedListRow,
  isDeletedListRow,
  rowToText,
} from './comment_parse';
import { parseStatusRow, parseListRow } from './string_util';
import { readValuesWithDefault } from './pref_storage';
import {
  moveListCursorWindow,
  normalizeListWindow,
  windowVisibleSequence,
} from './list_window';

// ---------------------------------------------------------------------------
// Screen classification (pure)
// ---------------------------------------------------------------------------

// Board name from the row-0 title bar: 「…看板《C_Chat》…」. The reversed title
// is repainted on every board switch (protocol §4 TITLE_REDRAW), so this is the
// aliasing guard for accumulated article numbers across boards.
const BOARD_NAME_RE = /《([^《》]+)》/;
export function parseBoardName(row0Text) {
  if (!row0Text) return null;
  const m = row0Text.match(BOARD_NAME_RE);
  return m ? m[1] : null;
}

// Classify one settled screen from plain facts. facts = {
//   rowTexts:  string[] (getRowText for every row),
//   curX, curY: settle cursor park position (term_buf settleSnapshot),
//   rows:      row count,
//   row0Reversed, row2Reversed: bool (caller runs buf.isUnicolor — kept out of
//              here so the classifier stays free of TermBuf),
// } → { kind: 'clean-list'|'article'|'menu'|'prompt'|'transient', boardName }
//
// clean-list fingerprint (protocol doc §3/§5, all five must hold):
//   row0 reversed title with a parsable 《board》, row2 reversed header with
//   「編號」, ≥3 parsable article numbers in the entry area, the cursor parked
//   in the entry area at col ≤ 1, and the bottom feeter containing 「文章選讀」.
// Deliberately NOT parseListRow — that matches the BOARD MENU footer (v3 trap
// #3); and 「郵件選讀」 (mail) must not engage, hence the exact feeter text.
export function classifyListScreen(facts) {
  const { rowTexts, curX, curY, rows, row0Reversed, row2Reversed } = facts;
  const lastRowText = rowTexts[rows - 1] || '';
  const boardName = parseBoardName(rowTexts[0]);

  if (
    row0Reversed &&
    boardName != null &&
    row2Reversed &&
    (rowTexts[2] || '').indexOf('編號') >= 0 &&
    lastRowText.indexOf('文章選讀') >= 0 &&
    curY >= 3 &&
    curY <= rows - 2 &&
    curX <= 1
  ) {
    const nums = pageArticleNums(rowTexts, curY);
    let count = 0;
    for (let i = 3; i <= rows - 2; ++i) if (nums[i] != null) ++count;
    if (count >= 3) return { kind: 'clean-list', boardName };
  }

  // Article (pmore): the bottom status row 「瀏覽 第 x/y 頁 …」 is decisive.
  if (parseStatusRow(lastRowText)) return { kind: 'article', boardName };

  // Menus: top-level 【主功能表】/【分類看板】/【精華文章】 titles, or the
  // board-MENU footer parseListRow matches (the thing clean-list must NOT use).
  const row0 = rowTexts[0] || '';
  if (
    row0.indexOf('【主功能表】') === 0 ||
    row0.indexOf('【分類看板】') === 0 ||
    row0.indexOf('【精華文章】') === 0 ||
    parseListRow(lastRowText)
  ) {
    return { kind: 'menu', boardName };
  }

  // Prompt: the server parked the cursor on the bottom row = it is waiting for
  // input there (protocol §5) — search prompts, jump-to-number, y/N questions.
  if (curY === rows - 1) return { kind: 'prompt', boardName };

  return { kind: 'transient', boardName };
}

// Classify one settle window's dirty-row burst (term_buf settleSnapshot
// .changedRows — the rows the SERVER wrote during the quiet period). This is a
// fast-path HINT only: completion decisions always use the final screen
// predicate above (classifyListScreen), never the burst shape — WS proxy
// coalescing can merge responses (protocol §4, §6 unknown).
//   cursor-move:  exactly the old+new cursor rows, all inside the entry area.
//   page-turn:    move(3,0)+clrtobot repaint — rows 3..rows-1 all dirty, the
//                 row0-2 header untouched.
//   full-repaint: clear() — header dirty too, whole screen covered.
export function classifyListBurst({ changedRows, curY, rows }) {
  if (!changedRows || changedRows.size === 0) return 'other';
  const has = r => changedRows.has(r);
  const headerTouched = has(0) || has(1) || has(2);

  let entryFull = true;
  for (let r = 3; r <= rows - 1; ++r) {
    if (!has(r)) {
      entryFull = false;
      break;
    }
  }
  if (!headerTouched && entryFull) return 'page-turn';

  if (headerTouched && entryFull && has(0) && has(1) && has(2)) {
    let all = true;
    for (let r = 0; r <= rows - 1; ++r) {
      if (!has(r)) {
        all = false;
        break;
      }
    }
    if (all) return 'full-repaint';
  }

  if (changedRows.size <= 2) {
    let inEntry = true;
    changedRows.forEach(r => {
      if (r < 3 || r > rows - 2) inEntry = false;
    });
    if (inEntry && curY >= 3 && curY <= rows - 2) return 'cursor-move';
  }

  return 'other';
}

// ---------------------------------------------------------------------------
// State machine (pure reducer)
// ---------------------------------------------------------------------------

// States: idle → active ⇄ functionMode; active → opening → suspended → active.
//   idle:         not engaged (native render, native keys).
//   active:       buffer render (accumulated listLines), local navigation.
//   functionMode: whole-screen native LIVE mirror, ALL keys pass through —
//                 the catch-all self-heal target for anything unexpected.
//   opening:      frozen render while the serialized open-article commands run.
//   suspended:    an article is open (article easy reading or native renders);
//                 the accumulated buffer is kept for restore.
//
// Events (plain data; the session precomputes every boolean so this table is
// exhaustively unit-enumerable):
//   { type:'settle', kind, boardNameMatch, inFlightKind,
//     landedNumInBuffer, engageEligible }
//   { type:'key', keyClass: 'nav'|'open'|'open-pinned'|'other' }
//   { type:'pref-off' } | { type:'open-timeout' }
//
// Returns { next, actions[] } — action names are interpreted by ListSession.
// Misroutes always fall toward functionMode/native (principle: self-heal).
export function transitionListSession(state, event) {
  const stay = { next: state, actions: [] };

  if (event.type === 'pref-off') {
    return state === 'idle' ? stay : { next: 'idle', actions: ['cleanup'] };
  }

  switch (state) {
    case 'idle': {
      if (
        event.type === 'settle' &&
        event.kind === 'clean-list' &&
        event.engageEligible
      ) {
        return { next: 'active', actions: ['seed', 'start-fill'] };
      }
      return stay;
    }

    case 'active': {
      if (event.type === 'settle') {
        switch (event.kind) {
          case 'clean-list':
            // Accumulation already happened in redraw; a board switch (s-jump,
            // MODE_SELECT filtered list) rebuilds to stop number aliasing.
            return event.boardNameMatch
              ? { next: 'active', actions: ['continue-fill'] }
              : { next: 'active', actions: ['rebuild'] };
          case 'article':
            // Hand off to article easy reading (its own settled 2→3 edge fires
            // independently — zero new coupling; without it the native article
            // renders).
            return { next: 'suspended', actions: ['handoff-article'] };
          case 'menu':
            // A settled menu = we left the board. Exit directly: routing it
            // through functionMode (the old catch-all) needs ANOTHER settle to
            // reach idle, and a static menu screen never produces one — the ←
            // 離板 response can interleave with an in-flight prefetch's jump
            // repaint (jump settle → resume bounce → menu settle lands here),
            // wedging functionMode forever (live soak).
            return { next: 'idle', actions: ['cleanup'] };
          default:
            // prompt/transient: explainable while a serialized command is
            // mid-flight (a slow multi-write response can settle half-painted);
            // otherwise catch-all self-heal to the native mirror (waterball,
            // 動態看板, misclassification — everything lands here).
            return event.inFlightKind
              ? stay
              : { next: 'functionMode', actions: ['enter-function-mode'] };
        }
      }
      if (event.type === 'key') {
        switch (event.keyClass) {
          case 'nav':
            return { next: 'active', actions: ['move-selection'] };
          case 'open':
            return { next: 'opening', actions: ['begin-open'] };
          case 'open-pinned':
            // Pinned rows have no number to jump to; the serialized-safe path
            // is End (last page, deterministic regardless of new arrivals) →
            // locate the target pinned row by CONTENT on the settled screen →
            // arrow steps → Enter (see _beginOpenPinned).
            return { next: 'opening', actions: ['begin-open-pinned'] };
          case 'relative':
            // [ ] = with a numbered selection: serialized jump→key pair over a
            // FROZEN window snapshot (not the native mirror — flashing the raw
            // screen un-hides blacklist/deleted rows for the pair's duration).
            // Settle semantics stay functionMode's: in-flight settles are
            // absorbed, the completing clean-list resumes with the landed
            // cursor, and _resumeAfterRelative handles the miss/timeout ends.
            return { next: 'functionMode', actions: ['begin-relative'] };
          default:
            // Any other key: native passthrough (the key itself is NOT
            // preventDefaulted — it goes to the server, we just mirror).
            return { next: 'functionMode', actions: ['enter-function-mode'] };
        }
      }
      return stay;
    }

    case 'functionMode': {
      if (event.type === 'settle') {
        switch (event.kind) {
          case 'clean-list':
            // A serialized relative command ([ ] = jump→key pair) is mid-flight:
            // its own jump-landing settle must not bounce us back to active —
            // keep mirroring until the pair completes (the completing settle
            // reads inFlightKind null and resumes with the LANDED cursor).
            if (event.inFlightKind) return stay;
            // Content-decided exit. If the landed cursor row is an article we
            // already hold AND we are on the same board, the page overwrite (in
            // redraw) is enough; otherwise rebuild from the current page
            // (covers `s` board jumps and `/` MODE_SELECT number aliasing).
            return event.landedNumInBuffer && event.boardNameMatch
              ? { next: 'active', actions: ['resume-buffer'] }
              : { next: 'active', actions: ['resume-buffer', 'rebuild'] };
          case 'article':
            // User opened an article natively while mirrored.
            return { next: 'suspended', actions: ['handoff-article'] };
          case 'menu':
            // Left the board: clean up entirely, back to native life.
            return { next: 'idle', actions: ['cleanup'] };
          default:
            return stay; // prompt/transient: keep mirroring (like native)
        }
      }
      return stay; // keys never route here — the keyboard hook is off in native
    }

    case 'opening': {
      if (event.type === 'settle') {
        // clean-list settles mid-open (jump prompt echoes, the cursor landing
        // on the target) are consumed by the CommandQueue expects — the reducer
        // just waits for the article.
        if (event.kind === 'article') {
          return { next: 'suspended', actions: ['handoff-article'] };
        }
        return stay;
      }
      if (event.type === 'open-timeout') {
        // Self-heal: abandon the open, mirror whatever the server shows.
        return { next: 'functionMode', actions: ['enter-function-mode'] };
      }
      // Serialization: user keys are swallowed while the open commands are in
      // flight (sub-second; the timeout above self-heals a wedged open).
      if (event.type === 'key') return stay;
      return stay;
    }

    case 'suspended': {
      if (event.type === 'settle') {
        switch (event.kind) {
          case 'clean-list':
            // Back from the article: the maps were kept — no rebuild, restore
            // the selection to the article we opened.
            return { next: 'active', actions: ['restore'] };
          case 'menu':
            return { next: 'idle', actions: ['cleanup'] };
          default:
            return stay; // article page turns / prompts inside the article
        }
      }
      return stay;
    }

    default:
      return stay;
  }
}

// ---------------------------------------------------------------------------
// Accumulation / selection primitives (pure, ported from the v3 wip branch)
// ---------------------------------------------------------------------------

// Pure list-buffer accumulation core (no DOM / no TermChar). A board page contributes
// `entries`: { num:int|null, key:string|null, row:any }. Numbered rows (num!=null) are
// written into `numMap` keyed by article number, OVERWRITING any existing entry — so a
// re-painted page's live changes (推文數, `v` 已讀標記) replace the stale clone. Number-
// less ★pinned rows go into `pinnedMap` keyed by their TITLE slice (`key`) — NOT the
// whole row text: the push-count column of a pinned row changes live, and a text-keyed
// map would then grow a duplicate row (v3 design bug 5a). Mutates the maps in place.
export function mergeListPage(numMap, pinnedMap, entries) {
  for (let i = 0; i < entries.length; ++i) {
    const e = entries[i];
    if (e.num != null) numMap.set(e.num, e.row);
    else if (e.key != null) pinnedMap.set(e.key, e.row);
  }
}

// Pure flatten of the accumulated maps into parallel render arrays. Numbered rows ASCEND
// by article number (oldest→newest, matching native top→bottom); ★pinned rows follow at
// the very bottom in insertion order (they sit below the newest article on the board, so
// scrolling toward older content naturally moves the selection away from them). Returns
// { lines, nums } parallel arrays; nums is null for the pinned tail rows.
export function flattenListBuffer(numMap, pinnedMap) {
  const sortedNums = Array.from(numMap.keys()).sort((a, b) => a - b);
  const lines = [];
  const nums = [];
  for (let i = 0; i < sortedNums.length; ++i) {
    lines.push(numMap.get(sortedNums[i]));
    nums.push(sortedNums[i]);
  }
  pinnedMap.forEach(function(row) {
    lines.push(row);
    nums.push(null);
  });
  return { lines, nums };
}

// Pure "stop prefetching?" decision. We page until enough VISIBLE (non-blacklisted)
// rows are accumulated (`target`), but cap total pages (`maxPages`) so a board with a
// high blacklist hit rate can't page forever. End-of-board (cursor didn't move on a
// page command) is detected separately by the queue expect and is authoritative.
export function shouldStopListPrefetch({ visibleCount, target, pageCount, maxPages }) {
  return visibleCount >= target || pageCount >= maxPages;
}

// Pure selection movement over the VISIBLE (rendered, non-hidden) rows. `visibleIndices`
// is the ascending list of absolute listLines indices that survive the blacklist drop;
// `currentAbs` is the currently-selected absolute index (may be -1/stale). Returns the
// new absolute index after moving `delta` visible steps, clamped to the ends. When the
// current selection is not itself visible (e.g. it got blacklisted) we snap to the
// nearest visible row in the direction of travel before stepping. Returns -1 only when
// there are no visible rows at all.
export function moveListSelection(visibleIndices, currentAbs, delta) {
  if (!visibleIndices.length) return -1;
  let pos = visibleIndices.indexOf(currentAbs);
  if (pos === -1) {
    // The current selection was dropped (e.g. it just got blacklisted). Find the
    // insertion point: `idx` = first visible row whose absolute index is > currentAbs
    // (== count of visible rows strictly before it). A single step then lands on the
    // visible neighbour in the direction of travel — moving down → first row below,
    // moving up → last row above — and that snap consumes one unit of `delta`.
    let idx = 0;
    while (idx < visibleIndices.length && visibleIndices[idx] < currentAbs) idx++;
    if (delta > 0) {
      pos = idx;
      delta -= 1;
    } else if (delta < 0) {
      pos = idx - 1;
      delta += 1;
    } else pos = idx < visibleIndices.length ? idx : idx - 1;
  }
  let next = pos + delta;
  if (next < 0) next = 0;
  if (next > visibleIndices.length - 1) next = visibleIndices.length - 1;
  return visibleIndices[next];
}

// ---------------------------------------------------------------------------
// ListSession — the single owner (class half; pure layer above)
// ---------------------------------------------------------------------------

// Same shape as easy_reading.js's private bindProperty: expose obj[prop] as a
// live view of target[name] so term_view/redraw can read buf.listRenderMode
// without importing this module's instance.
function bindProperty(target, name, obj, prop) {
  if (!prop) prop = name;
  Object.defineProperty(obj, prop, {
    get: function() {
      return target[name];
    },
    set: function(val) {
      target[name] = val;
    }
  });
}

// Initial background fill is capped LOW: the window render is cheap, but every
// prefetch is still two server roundtrips — 2-3 pages cover the first screens;
// demand fetches the rest as the user actually navigates.
const FILL_MAX_PAGES = 3;
// Total-row cap: bounds the map / flatten / visibleListIndices cost. The end
// FARTHEST from the selection is evicted; demand re-fetches it later.
export const MAX_LIST_ROWS = 300;
// Passthrough keys that act RELATIVE to the server cursor and therefore get a
// jump-to-selection prefix first (see _syncServerCursor). Deliberately NOT all
// other-keys: absolute/leaving commands (←/q/s/digits) must go out alone.
const RELATIVE_COMMAND_KEYS = ['[', ']', '='];

// Adaptive soft timeout for the SECOND leg of a serialized pair, seeded by the
// first (jump) leg's measured round-trip. A miss with ZERO server response can
// only end by timeout (a repeated bottom-row message is a zero-content settle,
// gated by invariant 1) — a fixed 3000ms reads as「按了沒反應」on a fast link.
// 4×rtt keeps a wide safety factor; the floor absorbs jitter, the ceiling is
// the old fixed value (slow links keep the old behavior).
export function adaptiveTimeoutMs(rttMs) {
  const t = 4 * rttMs;
  if (!(t >= 800)) return 800; // also catches NaN/negative
  return t > 3000 ? 3000 : t;
}

// Owner of list easy reading. Subscribes to term_buf 'screenSettled' and runs:
//   settle → snapshot+facts → queue.onSettle (command completion first)
//          → event booleans → transitionListSession → execute actions.
// Owns: state, the selection (by article NUMBER, stable across prepends), the
// board name (aliasing guard), and listRenderMode (bindProperty onto term_buf;
// 'native' | 'buffer' | 'frozen' — redraw/onKeyDown key off it, never off
// pageState).
export function ListSession(core, view, termBuf, queue) {
  this._core = core;
  this._view = view;
  this._termBuf = termBuf;
  this._queue = queue;

  this.state = 'idle';
  this._renderMode = 'native';
  this._boardName = null;
  this._selectedNum = null; // numbered selection (article number)
  this._selectedPinnedKey = null; // pinned-row selection (title key)
  this._topNum = null; // window-top anchor (article number; native top_ln)
  this._restoreNum = null; // selection to restore after an article
  this._restorePinnedKey = null; // ditto for a pinned selection
  this._restoreTopNum = null; // window top to restore (native getkeep top_ln)
  this._fillTarget = 0;
  this._fillPages = 0;
  this._edgeUp = false;
  this._edgeDown = false;
  // Contiguity-prune pivot override while a far jump is in flight (End/Home):
  // the jump's landing page is DISCONTIGUOUS with the buffer by design, and the
  // prune must keep the TARGET segment, not the one the cursor came from.
  // undefined = no override (prune around the selection).
  this._prunePivotOverride = undefined;
  // Prefetch chain: after a completed same-direction prefetch page command the
  // server cursor position is KNOWN (the landed row) — the next prefetch may
  // skip the anchor-jump leg and send PgUp/PgDn directly (halving the
  // round-trips). ANY other server interaction invalidates the knowledge →
  // _breakChain() at every such point (flush callers, other enqueues, settles
  // with no in-flight command, buffer rebuilds). null = must anchor.
  this._chainState = null; // { dir: -1|1, lastLanded: number }
  // Last measured prefetch round-trip (ms) — seeds the adaptive page timeout
  // so the final "no more pages" probe fails fast instead of waiting 3s.
  this._lastPrefetchRtt = null;

  bindProperty(this, '_renderMode', termBuf, 'listRenderMode');
  termBuf.addEventListener('screenSettled', this._onScreenSettled.bind(this));
}

ListSession.prototype = {
  // ---- settle pipeline -----------------------------------------------------

  _onScreenSettled: function() {
    const snap = this._termBuf.settleSnapshot;
    // A settle window with ZERO server-written rows AND no server cursor move
    // is a purely local repaint — those must never drive state transitions nor
    // feed the queue's expects. A cursor-only window (cursorMoved, zero rows)
    // IS a real response tail: when a response's content window and its final
    // cursor-park escape straddle a >SETTLE_MS gap, the response settles twice
    // and the second settle carries the authoritative park position — dropping
    // it starves the queue (the offline jump-anchor wedge).
    if (
      snap &&
      snap.changedRows &&
      snap.changedRows.size === 0 &&
      !snap.cursorMoved
    )
      return;
    const facts = this._collectFacts(snap);
    // Server activity with NO command of ours in flight = external interaction
    // (user key passthrough, server-initiated repaint): the server cursor may
    // have moved — the prefetch chain's landed position is no longer trusted.
    // Checked BEFORE onSettle so a completing command's own settle (inFlight
    // still set here) never breaks the chain it is about to extend.
    if (!this._queue.inFlightKind) this._breakChain();
    // Command completion first, so the reducer sees inFlightKind post-account
    // and a completed open/prefetch can chain its next command before we act.
    this._queue.onSettle(snap, facts);
    this._dispatch(this._settleEvent(facts), facts);
  },

  // One facts object per settle: everything the classifier, the queue expects
  // and the reducer need, computed once. curX/curY come from the frozen settle
  // snapshot (the server's cursor park position for THIS response).
  _collectFacts: function(snap) {
    const buf = this._termBuf;
    const rowTexts = [];
    for (let r = 0; r < buf.rows; ++r) rowTexts.push(buf.getRowText(r, 0, buf.cols));
    const facts = {
      rowTexts: rowTexts,
      curX: snap ? snap.curX : buf.cur_x,
      curY: snap ? snap.curY : buf.cur_y,
      rows: buf.rows,
      row0Reversed: buf.isUnicolor(0, 0, 29),
      row2Reversed: buf.isUnicolor(2, 0, buf.cols - 10)
    };
    const cls = classifyListScreen(facts);
    facts.kind = cls.kind;
    facts.boardName = cls.boardName;
    facts.nums = pageArticleNums(rowTexts, facts.curY);
    facts.cursorRowNum =
      facts.curY >= 0 && facts.curY < facts.nums.length ? facts.nums[facts.curY] : null;
    return facts;
  },

  _settleEvent: function(facts) {
    return {
      type: 'settle',
      kind: facts.kind,
      boardNameMatch: facts.boardName != null && facts.boardName === this._boardName,
      inFlightKind: this._queue.inFlightKind,
      landedNumInBuffer:
        facts.cursorRowNum != null &&
        (this._termBuf.listLineNums || []).indexOf(facts.cursorRowNum) !== -1,
      engageEligible: this._engageEligible()
    };
  },

  // pref on ∧ standard 24-row term (v1 bypass otherwise) ∧ the article easy
  // reading is not mid-post (startedEasyReading tracks an actually-open post;
  // view.useEasyReadingMode stays latched true between posts, so it is NOT the
  // right guard here).
  _engageEligible: function() {
    return (
      !!readValuesWithDefault().enableEasyReadingList &&
      this._termBuf.rows === 24 &&
      !this._termBuf.startedEasyReading
    );
  },

  _dispatch: function(event, facts) {
    const r = transitionListSession(this.state, event);
    this.state = r.next;
    for (let i = 0; i < r.actions.length; ++i) this._runAction(r.actions[i], facts);
  },

  _runAction: function(action, facts) {
    switch (action) {
      case 'seed':
        return this._seed(facts);
      case 'start-fill':
        return this._startFill();
      case 'continue-fill':
        return this._maybeFill();
      case 'rebuild':
        return this._rebuild(facts);
      case 'handoff-article':
        return this._handoffArticle();
      case 'enter-function-mode':
        return this._enterFunctionMode();
      case 'resume-buffer':
        return this._resumeBuffer(facts);
      case 'restore':
        return this._restore();
      case 'cleanup':
        return this._cleanup();
      // 'move-selection' / 'begin-open*' carry key context; executed in onKeyDown.
      case 'move-selection':
      case 'begin-open':
      case 'begin-open-pinned':
        return;
      default:
        return;
    }
  },

  // ---- external entry points ------------------------------------------------

  // Pref flipped ON while the screen sits still (no settle will come): evaluate
  // the current screen as if it just settled. Also used right after connect.
  evaluateNow: function() {
    if (this.state !== 'idle') return;
    const facts = this._collectFacts(null);
    this._dispatch(this._settleEvent(facts), facts);
  },

  // Pref flipped OFF / disconnect: single exit (mirrors exitEasyReading rigor).
  disable: function() {
    this._dispatch({ type: 'pref-off' }, null);
  },

  // Keyboard, called from term_view.onKeyDown ONLY while renderMode is
  // buffer/frozen (native modes never route here — full passthrough).
  onKeyDown: function(e) {
    // Modifier combos (copy/paste/select-all…) belong to the app-level handlers
    // right after this hook; never intercept them.
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    if (this.state === 'opening') {
      // Serialized open in flight: swallow everything (sub-second; the open
      // timeout self-heals a wedged one). Letting keys through would race the
      // jump/enter sequence — the exact v3 failure mode.
      e.preventDefault();
      return;
    }
    if (this.state === 'functionMode' && this._renderMode === 'frozen') {
      // A relative-command pair is in flight behind the frozen snapshot:
      // swallow user keys, same as 'opening' — letting them through would race
      // the serialized jump/key bytes (typeahead, protocol §2).
      e.preventDefault();
      return;
    }
    if (this.state !== 'active') return;

    const key = this._classifyKey(e);
    if (key.class !== 'other') e.preventDefault();

    const r = transitionListSession(this.state, { type: 'key', keyClass: key.class });
    this.state = r.next;
    for (let i = 0; i < r.actions.length; ++i) {
      const a = r.actions[i];
      if (a === 'move-selection') this._moveSelection(key.op);
      else if (a === 'begin-open') this._beginOpen();
      else if (a === 'begin-open-pinned') this._beginOpenPinned();
      else if (a === 'begin-relative') this._beginRelative(e.key);
      else this._runAction(a, null);
    }
  },

  // 'begin-relative' executor: freeze the window snapshot (no native flash —
  // the raw mirror would un-hide blacklist/deleted rows), flush any prefetch,
  // then enqueue the serialized jump→key pair. The cursor stays hidden (we
  // never left our render). Exits: hit → resume-buffer; miss/timeout →
  // _resumeAfterRelative; article/menu → handoff/cleanup set their own modes.
  _beginRelative: function(keyChar) {
    this._breakChain();
    this._prunePivotOverride = undefined; // flush is silent — reset here
    this._queue.flush();
    this._renderMode = 'frozen';
    this._view.hideCursor();
    this._forceRedraw();
    this._beginRelativeCommand(keyChar);
  },

  // Cursor-relative commands ([ ] = 同標題上/下篇/首篇) act from the server's
  // REAL cursor, which local zero-network navigation leaves behind — so the key
  // needs a jump-to-selection first. The pair MUST be serialized through the
  // queue: sending "N\r[" in one tick trips pttbbs typeahead (input buffer
  // non-empty → repaints skipped, protocol §2) and the screen freezes while the
  // server state moves (the「[ 卡住但其實跳了」bug). Flow: _beginRelative
  // already ran (flush + frozen snapshot) → jump (expect the park fingerprint)
  // → key (any settle = its response) → that settle's reducer pass sees
  // inFlightKind null and resumes with the LANDED cursor (native parity).
  // Failures fall back through _resumeAfterRelative — self-healing.
  // ONLY RELATIVE_COMMAND_KEYS take this path: serializing e.g. ← (leave
  // board) would delay/duplicate responses around the menu exit (live soak).
  _beginRelativeCommand: function(keyChar) {
    const num = this._selectedNum;
    if (num == null) return;
    const self = this;
    const t0 = Date.now();
    this._queue.enqueue({
      keys: String(num) + '\r',
      kind: 'relative-sync-jump',
      expect: function(snap, facts) {
        // Jump-landing park fingerprint (protocol §4 ✚, same as open-jump).
        return (
          facts.cursorRowNum === num &&
          facts.curY >= 3 &&
          facts.curY <= facts.rows - 2 &&
          facts.curX <= 1
        );
      },
      timeoutMs: 4000,
      onDone: function() {
        self._queue.enqueue({
          keys: keyChar,
          kind: 'relative-command',
          // Any settle IS the response: a same-title hit repaints the list
          // (clean-list) and the reducer resumes with the landed cursor; a
          // miss paints only a bottom-row message (prompt/transient) which
          // leaves the reducer in functionMode — the deferred check below
          // pulls us back to the buffer render (the screen would otherwise
          // sit in the native mirror, un-hiding blacklist/deleted rows, until
          // some future transition).
          expect: function() {
            return true;
          },
          // A zero-response miss can only end by this timeout — scale it to
          // the link speed measured on the jump leg we just completed.
          timeoutMs: adaptiveTimeoutMs(Date.now() - t0),
          // onDone runs BEFORE the same settle's reducer dispatch — defer the
          // check one tick so a clean-list resume wins first.
          onDone: function() {
            setTimeout(function() {
              self._resumeAfterRelative();
            }, 0);
          },
          // Zero response (server ignored the key): back to the buffer view.
          onFail: function() {
            self._resumeAfterRelative();
          }
        });
      },
      // Jump failed (deleted target / weird screen): do NOT send the key from
      // an unknown cursor position (the original bug) — just resume the view.
      onFail: function() {
        self._resumeAfterRelative();
      }
    });
  },

  // A relative-command pair ended without a clean-list settle to resume on
  // (same-title miss = message row only, or timeout). The jump leg already
  // parked the real cursor on our selection, so the buffer view is consistent
  // — re-enter it with unchanged anchors instead of idling in the native
  // mirror (where hidden rows reappear). The bottom-row message is dropped
  // (the cached feeter renders instead) — native shows it until the next key.
  _resumeAfterRelative: function() {
    if (this.state !== 'functionMode') return; // reducer already routed us
    this.state = 'active';
    this._renderMode = 'buffer';
    this._view.hideCursor();
    this._forceRedraw();
  },

  // Key → native read.c op (executed by moveListCursorWindow).
  _classifyKey: function(e) {
    switch (e.key) {
      case 'ArrowUp':
      case 'k':
        return { class: 'nav', op: 'up' };
      case 'ArrowDown':
      case 'j':
        return { class: 'nav', op: 'down' };
      case 'PageUp':
        return { class: 'nav', op: 'pgup' };
      case 'PageDown':
        return { class: 'nav', op: 'pgdn' };
      case 'Home':
        return { class: 'nav', op: 'home' };
      case 'End':
        return { class: 'nav', op: 'end' };
      case 'Enter':
      case 'ArrowRight':
        return { class: this._selectedNum == null ? 'open-pinned' : 'open' };
      default:
        // Cursor-relative commands with a numbered selection are serialized
        // (jump → key via the queue): we own the bytes, so the key itself must
        // NOT pass through (typeahead would swallow the repaints — the「[ 卡住」
        // bug). A pinned selection has no number to jump to → passthrough.
        if (
          RELATIVE_COMMAND_KEYS.indexOf(e.key) !== -1 &&
          this._selectedNum != null
        )
          return { class: 'relative' };
        return { class: 'other' };
    }
  },

  // Wheel (routed from App.mouse_scroll with the native pref mapping already
  // applied): execute the op through the SAME nav path as the keyboard.
  onWheel: function(op) {
    if (this.state !== 'active' || this._renderMode !== 'buffer') return;
    this._moveSelection(op);
  },

  // ---- actions ---------------------------------------------------------------

  _seed: function(facts) {
    this._breakChain();
    this._view.resetListAccumulation();
    this._termBuf.listLines = [];
    this._termBuf.listLineNums = [];
    this._boardName = facts.boardName;
    this._restoreNum = null;
    this._edgeUp = false;
    this._edgeDown = false;
    this._fillPages = 0;
    this._renderMode = 'buffer';
    this._view.hideCursor();
    this._seedAnchors(facts);
    this._forceRedraw(); // synchronous: accumulates this page into the buffer
    if (this._selectedNum == null && this._selectedPinnedKey == null)
      this._selectLastNumbered();
  },

  _rebuild: function(facts) {
    this._breakChain();
    this._view.resetListAccumulation();
    this._termBuf.listLines = [];
    this._termBuf.listLineNums = [];
    this._boardName = facts ? facts.boardName : this._boardName;
    this._edgeUp = false;
    this._edgeDown = false;
    this._fillPages = 0;
    this._seedAnchors(facts);
    this._forceRedraw();
    if (this._selectedNum == null && this._selectedPinnedKey == null)
      this._selectLastNumbered();
    this._maybeFill();
  },

  // Adopt the native screen's cursor + window top as our anchors (facts from a
  // clean-list settle): the window then renders EXACTLY what native shows.
  // The bottom edge is confirmed when a ★pinned row is on screen — 置底文 exist
  // only on the board's last page (read.c bottom_line..last_line); without any
  // pinned row the edge stays unknown and demand discovers it later.
  _seedAnchors: function(facts) {
    this._selectedNum = facts ? facts.cursorRowNum : null;
    this._selectedPinnedKey = null;
    this._topNum = null;
    if (facts) {
      for (let r = 3; r <= facts.rows - 2; ++r) {
        if (facts.nums[r] != null) {
          this._topNum = facts.nums[r];
          break;
        }
      }
      let hasPinned = false;
      for (let r = 3; r <= facts.rows - 2; ++r) {
        const t = facts.rowTexts[r] || '';
        if (t.indexOf('★') >= 0 && isPinnedListRow(t)) {
          hasPinned = true;
          break;
        }
      }
      if (hasPinned) this._edgeDown = true;
      if (this._selectedNum == null) {
        const ct = facts.rowTexts[facts.curY] || '';
        if (isPinnedListRow(ct) && ct.indexOf('★') >= 0) {
          this._selectedPinnedKey = pinnedRowKey(ct);
          return;
        }
      }
    }
  },

  _startFill: function() {
    this._fillTarget = readValuesWithDefault().easyReadingListPrefetchCount || 0;
    this._fillPages = 0;
    this._maybeFill();
  },

  // Background fill: page UP (older articles — we enter at the newest) until
  // enough visible rows, the page cap, or the top edge. One command at a time,
  // chained via onDone — never in parallel with anything.
  _maybeFill: function() {
    if (this.state !== 'active') return;
    if (this._edgeUp) return;
    if (!this._queue.idle) return;
    if (
      shouldStopListPrefetch({
        visibleCount: this._visibleIndices().length,
        target: this._fillTarget,
        pageCount: this._fillPages,
        maxPages: FILL_MAX_PAGES
      })
    )
      return;
    this._enqueuePrefetch(true, 'fill');
  },

  // Demand prefetch: keep TWO full pages of rows buffered beyond the window in
  // the direction of travel (one page was too late — the fetch only started
  // once the user was about to hit the edge, so every boundary crossing waited
  // out the full serialized round-trips; two pages of headroom lets the chain
  // finish before the user gets there). Only the direction of travel is
  // extended — in a small buffer everything is "near" both edges.
  _maybeDemand: function(direction) {
    if (this.state !== 'active' || !this._queue.idle) return;
    const seq = this._sequence();
    if (!seq.length) return;
    const pos = this._windowPos(seq);
    if (!pos) return;
    const B = this._bodyRows();
    if (direction < 0 && pos.top < 2 * B && !this._edgeUp)
      this._enqueuePrefetch(true, 'key');
    else if (
      direction > 0 &&
      seq.length - (pos.top + B) < 2 * B &&
      !this._edgeDown
    )
      this._enqueuePrefetch(false, 'key');
  },

  // term_view.accumulateListLines evicted rows past MAX_LIST_ROWS on this end:
  // clear the edge flag so demand can re-fetch the dropped segment. The buffer
  // edge moved under the chain → its landed reference may now be discontiguous
  // with the surviving segment: re-anchor.
  noteEvicted: function(direction) {
    if (direction < 0) this._edgeUp = false;
    else this._edgeDown = false;
    this._chainState = null;
  },

  // Invalidate the prefetch chain: the server cursor is no longer where the
  // last prefetch left it (another command went out / an external response
  // arrived / the buffer was rebuilt). The next prefetch re-anchors (two legs).
  _breakChain: function() {
    this._chainState = null;
  },

  // Pivot for pruneListToSegment (term_view.accumulateListLines): normally the
  // selection's segment survives; while an End jump is in flight the override
  // is null (= keep the LARGEST-number segment, the landing page), while a
  // Home jump keeps article 1's segment.
  prunePivot: function() {
    return this._prunePivotOverride !== undefined
      ? this._prunePivotOverride
      : this._selectedNum;
  },

  // ANCHORED prefetch (v4-stabilize bug 3: 往上讀卡住/亂跳頁). The single real
  // cursor may sit anywhere after an open/functionMode excursion — blindly
  // paging from there fetches pages around the CURSOR, filling the middle of
  // the buffer instead of extending the edge the user is scrolling toward (and
  // mid-buffer insertions defeat the top-only scroll compensation). So every
  // prefetch is a serialized command PAIR:
  //   1. jump to the buffer-edge article number (re-home the real cursor; the
  //      jump-settle fingerprint is park-in-entry + target number — the bottom
  //      row stays EMPTY until the next response, protocol doc §4 ✚);
  //   2. PgUp/PgDn — cursor number moving past the anchor = a new page (edge
  //      growth guaranteed contiguous), unchanged = the board edge.
  // CHAINED same-direction prefetch skips leg 1: the previous page command's
  // landed cursor is a confirmed server position (nothing else touched the
  // server since — _breakChain() guards every such point), so a direct
  // PgUp/PgDn extends the edge contiguously with ONE round-trip. The reference
  // point for moved/edge is then the last landed row instead of the anchor
  // (a PgDn parks the cursor on the NEW page's TOP, not the buffer's bottom
  // edge — anchor equality would misread every chained page as edge).
  // origin picks the CHAIN rule for the next page (each is self-bounding, so a
  // chain never crosses triggers — that would make the offline gating and the
  // stop condition nondeterministic):
  //   'fill' → _maybeFill (target / page-cap bounded)
  //   'key'  → _maybeDemand (stops once the headroom margin is buffered)
  _enqueuePrefetch: function(up, origin) {
    const dir = up ? -1 : 1;
    const chained = this._chainState !== null && this._chainState.dir === dir;
    const base = chained
      ? this._chainState.lastLanded
      : bufferEdgeNum(this._termBuf.listLineNums, dir);
    if (base == null) return;
    const self = this;
    const markEdge = function() {
      if (up) self._edgeUp = true;
      else self._edgeDown = true;
      self._chainState = null;
      // A confirmed bottom edge un-gates the pinned tail (windowVisibleSequence)
      // — repaint so 置底文 appear, exactly like native's last page.
      self._forceRedraw();
    };
    if (!chained) {
      const t0 = Date.now();
      this._queue.enqueue({
        keys: String(base) + '\r',
        kind: up ? 'prefetch-anchor-up' : 'prefetch-anchor-down',
        expect: function(snap, facts) {
          return (
            facts.cursorRowNum === base &&
            facts.curY >= 3 &&
            facts.curY <= facts.rows - 2 &&
            facts.curX <= 1
          );
        },
        timeoutMs: 4000,
        onDone: function() {
          self._lastPrefetchRtt = Date.now() - t0;
        },
        // Anchor failed (article deleted / weird screen): drop the queued page
        // command too — paging from an unknown position is exactly the bug.
        onFail: function() {
          markEdge();
          self._queue.flush();
        }
      });
    }
    const t0p = Date.now();
    this._queue.enqueue({
      keys: up ? '\x1b[5~' : '\x1b[6~',
      kind: up ? 'prefetch-up' : 'prefetch-down',
      expect: function(snap, facts) {
        if (facts.kind !== 'clean-list') return false;
        const now = facts.cursorRowNum;
        if (now == null) return false;
        if (up ? now < base : now > base) return { moved: true, landed: now };
        if (now === base) return { edge: true, landed: now };
        return false;
      },
      // The board-edge probe gets ZERO response (cursor already at the end,
      // live-tested) and can only end by this timeout — adapt it to the link
      // speed measured on the previous leg (the fixed 3s was the「近置底更慢」
      // stall). No measurement yet → keep the old conservative value.
      timeoutMs:
        this._lastPrefetchRtt != null
          ? adaptiveTimeoutMs(this._lastPrefetchRtt)
          : 3000,
      onDone: function(r) {
        self._fillPages++;
        self._lastPrefetchRtt = Date.now() - t0p;
        if (r.edge) markEdge();
        else {
          self._chainState = { dir: dir, lastLanded: r.landed };
          if (origin === 'key') self._maybeDemand(dir);
          else self._maybeFill();
        }
      },
      // Prefetch timeout is BENIGN: treat as the edge and stop paging that way
      // — never flips the mode (the user keeps scrolling what we have).
      onFail: markEdge
    });
  },

  // Two-stage serialized open: jump-to-number (expect: cursor landed on it),
  // then Enter (expect: article). The jump prompt's odd settles are EXPECTED
  // inside the opening state — this is why v3's "跳序號亂 settle" is safe here.
  _beginOpen: function() {
    const num = this._selectedNum;
    if (num == null) return;
    this._renderMode = 'frozen';
    this._restoreNum = num;
    this._restorePinnedKey = null;
    this._restoreTopNum = this._topNum;
    this._breakChain();
    this._queue.flush(); // drop any prefetch; content predicates absorb the seam
    const self = this;
    this._queue.enqueue({
      keys: String(num) + '\r',
      kind: 'open-jump',
      expect: function(snap, facts) {
        // Recorded protocol fact (cchat-list-nav 'jump' step): after a number
        // jump PTT clears the prompt line and does NOT repaint the feeter until
        // the next response — the settled screen classifies as transient, never
        // clean-list. Accept the landing by the cursor PARK position (entry
        // area, col ≤ 1, protocol §5) on the target number instead.
        return (
          facts.cursorRowNum === num &&
          facts.curY >= 3 &&
          facts.curY <= facts.rows - 2 &&
          facts.curX <= 1
        );
      },
      timeoutMs: 4000,
      onDone: function() {
        self._queue.enqueue({
          keys: '\r',
          kind: 'open-enter',
          expect: function(snap, facts) {
            return facts.kind === 'article';
          },
          timeoutMs: 4000,
          onFail: function() {
            self._openFailed();
          }
        });
      },
      onFail: function() {
        self._openFailed();
      }
    });
  },

  // Serialized open for a ★pinned row (no article number to jump to).
  //   1. jump to the buffer's LARGEST article number (an article number is a
  //      stable identity — new arrivals don't move it — and a number jump
  //      always gets a deterministic response; the existing park fingerprint);
  //   2. End → the bottom-most row of the last page. NOT sent standalone:
  //      when the real cursor is ALREADY at the bottom, End gets no server
  //      response at all and the open would always time out (live-tested) —
  //      after step 1 the cursor sits on a numbered row above the pinned tail,
  //      so End always moves = always answers. Its expect also requires the
  //      TARGET pinned row on screen (located by CONTENT: isPinnedListRow +
  //      pinnedRowKey equality — never a counted offset);
  //   3. one arrow per row toward it, each step expecting the exact curY, the
  //      last step ALSO re-verifying the cursor row's pinned key;
  //   4. Enter → expect article.
  // Any mismatch waits out the step timeout → _openFailed → functionMode
  // self-heal, same as the numbered open.
  _beginOpenPinned: function() {
    const key = this._selectedPinnedKey;
    const anchor = bufferEdgeNum(this._termBuf.listLineNums, 1);
    if (key == null || anchor == null) {
      this._openFailed();
      return;
    }
    this._renderMode = 'frozen';
    this._restoreNum = null;
    this._restorePinnedKey = key;
    this._restoreTopNum = this._topNum;
    this._breakChain();
    this._queue.flush();
    const self = this;
    let parkY = -1;
    let targetY = -1;
    const fail = function() {
      self._openFailed();
    };
    const enqueueEnter = function() {
      self._queue.enqueue({
        keys: '\r',
        kind: 'open-enter',
        expect: function(snap, facts) {
          return facts.kind === 'article';
        },
        timeoutMs: 4000,
        onFail: fail
      });
    };
    const enqueueSteps = function() {
      if (targetY === parkY) {
        enqueueEnter();
        return;
      }
      const delta = targetY > parkY ? 1 : -1;
      for (let y = parkY + delta; ; y += delta) {
        const stepY = y;
        const isLast = stepY === targetY;
        self._queue.enqueue({
          keys: delta > 0 ? '\x1b[B' : '\x1b[A',
          kind: 'open-pinned-step',
          expect: function(snap, facts) {
            if (facts.curY !== stepY || facts.curX > 1) return false;
            // Final verification before Enter: the cursor row must BE the
            // target pinned row (content identity, not position arithmetic).
            if (isLast && pinnedRowKey(facts.rowTexts[stepY] || '') !== key)
              return false;
            return true;
          },
          timeoutMs: 3000,
          onDone: isLast ? enqueueEnter : undefined,
          onFail: fail
        });
        if (isLast) break;
      }
    };
    const enqueueEnd = function() {
      self._queue.enqueue({
        keys: '\x1b[4~', // End: park on the last page (pinned rows included)
        kind: 'open-pinned-end',
        expect: function(snap, facts) {
          if (facts.curY < 3 || facts.curY > facts.rows - 2 || facts.curX > 1)
            return false;
          for (let r = 3; r <= facts.rows - 2; ++r) {
            const text = facts.rowTexts[r] || '';
            if (isPinnedListRow(text) && pinnedRowKey(text) === key) {
              parkY = facts.curY;
              targetY = r;
              return true;
            }
          }
          return false; // target not on the last page → timeout → self-heal
        },
        timeoutMs: 4000,
        onDone: enqueueSteps,
        onFail: fail
      });
    };
    this._queue.enqueue({
      keys: String(anchor) + '\r',
      kind: 'open-pinned-jump',
      expect: function(snap, facts) {
        // Same jump-landing fingerprint as open-jump / prefetch anchors
        // (protocol §4 ✚: the bottom row stays empty → never clean-list).
        return (
          facts.cursorRowNum === anchor &&
          facts.curY >= 3 &&
          facts.curY <= facts.rows - 2 &&
          facts.curX <= 1
        );
      },
      timeoutMs: 4000,
      onDone: enqueueEnd,
      onFail: fail
    });
  },

  _openFailed: function() {
    this._dispatch({ type: 'open-timeout' }, null);
  },

  _handoffArticle: function() {
    if (this._selectedNum != null) {
      this._restoreNum = this._selectedNum;
      this._restorePinnedKey = null;
    } else if (this._selectedPinnedKey != null) {
      this._restorePinnedKey = this._selectedPinnedKey;
      this._restoreNum = null;
    }
    this._restoreTopNum = this._topNum;
    this._breakChain();
    this._prunePivotOverride = undefined; // flush is silent — reset here
    this._queue.flush();
    this._renderMode = 'native';
    this._view.showCursor();
    // Paint the article: the article easy reading's own settled edge fires on
    // the same settle (pageStateSettled precedes screenSettled) — when it is
    // off, this force paints the plain native article.
    this._forceRedraw();
  },

  _enterFunctionMode: function() {
    this._breakChain();
    this._prunePivotOverride = undefined; // flush is silent — reset here
    this._queue.flush();
    this._renderMode = 'native';
    this._view.showCursor();
    this._forceRedraw();
  },

  _resumeBuffer: function(facts) {
    this._breakChain();
    this._renderMode = 'buffer';
    this._view.hideCursor();
    if (facts && facts.cursorRowNum != null) {
      // Adopt the native screen's cursor AND window top so the buffer render
      // shows exactly the page the user just saw in the mirror (native parity:
      // the mode switch itself must be invisible).
      this._selectedNum = facts.cursorRowNum;
      this._selectedPinnedKey = null;
      for (let r = 3; r <= facts.rows - 2; ++r) {
        if (facts.nums[r] != null) {
          this._topNum = facts.nums[r];
          break;
        }
      }
      for (let r = 3; r <= facts.rows - 2; ++r) {
        const t = facts.rowTexts[r] || '';
        if (t.indexOf('★') >= 0 && isPinnedListRow(t)) {
          this._edgeDown = true;
          break;
        }
      }
    }
    this._forceRedraw();
  },

  _restore: function() {
    this._breakChain();
    this._renderMode = 'buffer';
    this._view.hideCursor();
    if (this._restoreNum != null) {
      this._selectedNum = this._restoreNum;
      this._selectedPinnedKey = null;
      // The restore target may have been evicted by the row cap while we were
      // away — fall back to the newest row instead of a dangling selection.
      if (this._resolveSelectedIndex() === -1) this._selectLastNumbered();
    } else if (this._restorePinnedKey != null) {
      this._selectedNum = null;
      this._selectedPinnedKey = this._restorePinnedKey;
      if (this._resolveSelectedIndex() === -1) this._selectLastNumbered();
    }
    // Native getkeep parity: restore the window top too, so leaving the
    // article shows the list EXACTLY as it was (the article must not appear
    // to have moved to the bottom of the page).
    this._topNum = this._restoreTopNum;
    this._forceRedraw();
  },

  _cleanup: function() {
    this._breakChain();
    this._queue.flush();
    this._renderMode = 'native';
    this._boardName = null;
    this._selectedNum = null;
    this._selectedPinnedKey = null;
    this._topNum = null;
    this._restoreNum = null;
    this._restorePinnedKey = null;
    this._restoreTopNum = null;
    this._edgeUp = false;
    this._edgeDown = false;
    this._fillPages = 0;
    this._prunePivotOverride = undefined;
    this._view.resetListAccumulation();
    this._termBuf.listLines = [];
    this._termBuf.listLineNums = [];
    this._view.showCursor();
    this._forceRedraw();
  },

  // ---- window navigation ------------------------------------------------------

  // The window's body row count: the native list body (rows 3..rows-2 on a
  // 24-row screen = 20 entries, pttbbs p_lines).
  _bodyRows: function() {
    return this._termBuf.rows - 4;
  },

  // The navigable sequence: blacklist-filtered absolute listLines indices,
  // pinned tail gated behind a confirmed bottom edge (native parity: 置底文
  // exist only on the board's last page).
  _sequence: function() {
    return windowVisibleSequence(
      this._visibleIndices(),
      this._termBuf.listLineNums || [],
      this._edgeDown
    );
  },

  // Resolve the persisted (topNum, selection) anchors into sequence positions,
  // normalized to the native cursor-in-window invariant. Returns null when the
  // sequence is empty.
  _windowPos: function(seq) {
    if (!seq.length) return null;
    const nums = this._termBuf.listLineNums || [];
    let cursorAbs = this._resolveSelectedIndex();
    let cursor = seq.indexOf(cursorAbs);
    if (cursor === -1) {
      // Selection lost (blacklisted / evicted / pinned re-gated): snap to the
      // nearest surviving row, same rule as moveListSelection.
      const snapped = moveListSelection(seq, cursorAbs, 0);
      cursor = snapped === -1 ? seq.length - 1 : seq.indexOf(snapped);
    }
    let top = -1;
    if (this._topNum != null) {
      const topAbs = nums.indexOf(this._topNum);
      if (topAbs !== -1) top = seq.indexOf(topAbs);
    }
    return normalizeListWindow(top, cursor, seq.length, this._bodyRows());
  },

  // Persist window positions back as content anchors (number / pinned key):
  // anchors survive prepends and evictions, positions don't.
  _setWindow: function(seq, top, cursor) {
    const nums = this._termBuf.listLineNums || [];
    const cursorAbs = seq[cursor];
    this._selectedNum = nums[cursorAbs];
    this._selectedPinnedKey =
      nums[cursorAbs] == null ? this._pinnedKeyAt(cursorAbs) : null;
    const topAbs = seq[top];
    this._topNum = topAbs != null ? nums[topAbs] : null;
  },

  // The render contract with term_view.buildListWindowLines(): the 20 body
  // slots as absolute listLines indices (null = blank filler row, native
  // short-page parity) + the cursor row's absolute index.
  getWindowView: function() {
    const seq = this._sequence();
    const pos = this._windowPos(seq);
    if (!pos) return null;
    this._setWindow(seq, pos.top, pos.cursor);
    const B = this._bodyRows();
    const body = [];
    for (let i = pos.top; i < pos.top + B; ++i) {
      body.push(i < seq.length ? seq[i] : null);
    }
    return { body: body, cursorAbs: seq[pos.cursor] };
  },

  // Local navigation (zero network when the rows are buffered): one native
  // read.c op over the window, then directional demand keeps a page of
  // headroom. Ops that need rows beyond a confirmed edge go to the server
  // (serverOp), exactly like native would.
  _moveSelection: function(op) {
    const seq = this._sequence();
    const pos = this._windowPos(seq);
    if (!pos) return;
    const r = moveListCursorWindow(pos, op, {
      len: seq.length,
      bodyRows: this._bodyRows(),
      atTop: this._edgeUp,
      atBottom: this._edgeDown
    });
    if (r.serverOp === 'end') return this._requestEnd();
    if (r.serverOp === 'home') return this._requestHome();
    this._setWindow(seq, r.top, r.cursor);
    this._forceRedraw();
    const direction = op === 'up' || op === 'pgup' || op === 'home' ? -1 : 1;
    this._maybeDemand(direction);
  },

  // Native End (read.c KEY_END: new_ln = last_line, which INCLUDES the pinned
  // tail). We don't hold the board end yet — fetch it with a single always-
  // answered command: a number jump far past the newest article lands the real
  // cursor on last_line (search_num clamps to max, read.c:190-210), pulling
  // the last page (pinned rows included) into the buffer. Then apply End
  // locally. (A bare End times out when the cursor is already at the bottom —
  // zero response, live-tested — the over-jump always answers.)
  _requestEnd: function() {
    if (!this._queue.idle) return;
    const anchor = bufferEdgeNum(this._termBuf.listLineNums, 1);
    if (anchor == null) return;
    this._breakChain(); // a non-prefetch command moves the server cursor
    const self = this;
    this._prunePivotOverride = null; // keep the landing (max-number) segment
    this._queue.enqueue({
      keys: '99999999\r',
      kind: 'jump-end',
      expect: function(snap, facts) {
        // Jump landing fingerprint (protocol §4 ✚: bottom row stays empty →
        // transient, never clean-list): parked in the entry area, on a row at
        // or past our previous bottom edge (a pinned row parses as null num).
        return (
          facts.curY >= 3 &&
          facts.curY <= facts.rows - 2 &&
          facts.curX <= 1 &&
          (facts.cursorRowNum == null || facts.cursorRowNum >= anchor)
        );
      },
      timeoutMs: 4000,
      onDone: function() {
        // The landed page IS the board end (last_line): confirm the edge, then
        // land the local cursor there like native End.
        self._prunePivotOverride = undefined;
        self._edgeDown = true;
        const seq = self._sequence();
        if (!seq.length) return;
        const B = self._bodyRows();
        let top = seq.length - B;
        if (top < 0) top = 0;
        self._setWindow(seq, top, seq.length - 1);
        self._forceRedraw();
      },
      // Benign failure: keep the window where it was (native would too if the
      // server didn't answer).
      onFail: function() {
        self._prunePivotOverride = undefined;
      }
    });
  },

  // Native Home (read.c KEY_HOME: new_ln = 0 → clamped to line 1). Article 1
  // always exists (numbers re-compact on deletion) and a number jump always
  // answers — one command, then apply Home locally.
  _requestHome: function() {
    if (!this._queue.idle) return;
    this._breakChain(); // a non-prefetch command moves the server cursor
    const self = this;
    this._prunePivotOverride = 1; // keep article 1's (landing) segment
    this._queue.enqueue({
      keys: '1\r',
      kind: 'jump-home',
      expect: function(snap, facts) {
        return (
          facts.cursorRowNum === 1 &&
          facts.curY >= 3 &&
          facts.curY <= facts.rows - 2 &&
          facts.curX <= 1
        );
      },
      timeoutMs: 4000,
      onDone: function() {
        self._prunePivotOverride = undefined;
        self._edgeUp = true;
        const seq = self._sequence();
        if (!seq.length) return;
        self._setWindow(seq, 0, 0);
        self._forceRedraw();
      },
      onFail: function() {
        self._prunePivotOverride = undefined;
      }
    });
  },

  // Absolute listLines index of the current selection. Numbered selections
  // resolve by NUMBER (stable across prepends); pinned selections by title key.
  _resolveSelectedIndex: function() {
    const nums = this._termBuf.listLineNums || [];
    if (this._selectedNum != null) return nums.indexOf(this._selectedNum);
    if (this._selectedPinnedKey != null) {
      const lines = this._termBuf.listLines || [];
      for (let i = 0; i < nums.length; ++i) {
        if (nums[i] == null && this._pinnedKeyAt(i) === this._selectedPinnedKey)
          return i;
      }
    }
    return -1;
  },

  _pinnedKeyAt: function(idx) {
    const lines = this._termBuf.listLines || [];
    const text = lines[idx] ? rowToText(lines[idx]) : '';
    return pinnedRowKey(text);
  },

  _selectLastNumbered: function() {
    const nums = this._termBuf.listLineNums || [];
    for (let i = nums.length - 1; i >= 0; --i) {
      if (nums[i] != null) {
        this._selectedNum = nums[i];
        this._selectedPinnedKey = null;
        return;
      }
    }
  },

  _visibleIndices: function() {
    const lines = this._termBuf.listLines || [];
    const texts = [];
    for (let i = 0; i < lines.length; ++i) texts.push(rowToText(lines[i]));
    return visibleListIndices(texts, this._view.blacklist, this._view.titleBlacklist);
  },

  // ---- misc -------------------------------------------------------------------

  _forceRedraw: function() {
    this._termBuf.lineChangeds.fill(true);
    this._termBuf.changed = true;
    this._termBuf.notify();
  }
};

// Identity key for a ★pinned/置底 row. Author + title: the push-count column
// changes live (a whole-row key would duplicate the row on repaint — v3 bug 5a),
// while a title-only key COLLAPSES two announcements that share a truncated
// title (v4-stabilize bug 2a: 置底文少一篇). realignListColumns inside the two
// parsers makes the cursor variant (● covering the head) key-equal to the clean
// row. Used by BOTH term_view.accumulateListLines (map key) and
// ListSession._pinnedKeyAt (selection identity) — must stay the same function.
export function pinnedRowKey(text) {
  const author = parseListAuthor(text) || '';
  const title = parseListTitle(text) || text || '';
  return author + '|' + title;
}

// Evict numbered rows over the cap, dropping from the end FARTHEST from the
// selection (the selection itself always survives; a null selection = pinned
// tail = bottom, so the top is farthest). Mutates numMap in place; the pinned
// map is never evicted (a handful of rows at most). Returns which end(s) got
// dropped so the session can clear the matching _edgeUp/_edgeDown flag —
// demand must be able to re-fetch an evicted segment.
export function evictListBuffer(numMap, selectedNum, cap) {
  const r = { evictedUp: false, evictedDown: false };
  if (!numMap || numMap.size <= cap) return r;
  const nums = Array.from(numMap.keys()).sort((a, b) => a - b);
  const sel = selectedNum == null ? Infinity : selectedNum;
  let lo = 0;
  let hi = nums.length - 1;
  let excess = nums.length - cap;
  while (excess-- > 0) {
    if (sel - nums[lo] >= nums[hi] - sel) {
      numMap.delete(nums[lo++]);
      r.evictedUp = true;
    } else {
      numMap.delete(nums[hi--]);
      r.evictedDown = true;
    }
  }
  return r;
}

// The article number at a buffer edge: smallest (direction<0, the "older" top)
// or largest (direction>0, bottom) non-null entry of the ASCENDING nums array.
// null when the buffer holds no numbered rows. Anchored prefetch jumps the real
// cursor here before paging (see _enqueuePrefetch).
export function bufferEdgeNum(nums, direction) {
  if (!nums || !nums.length) return null;
  if (direction < 0) {
    for (let i = 0; i < nums.length; ++i) if (nums[i] != null) return nums[i];
    return null;
  }
  for (let i = nums.length - 1; i >= 0; --i) if (nums[i] != null) return nums[i];
  return null;
}

// Which absolute listLines indices survive the blacklist drop. MUST mirror the
// PAGE_LIST branch of Screen.js#computeAnnotations (the render-side hide): an
// author hit on the parsed author column, else a title-keyword hit. Kept here as
// a pure text function so local navigation can walk exactly the rows the user
// sees. `rowTexts` = listLines mapped through rowToText.
export function visibleListIndices(rowTexts, blacklistSet, titleKeywords) {
  const hasBlacklist = blacklistSet && blacklistSet.size > 0;
  const hasTitle = titleKeywords && titleKeywords.length > 0;
  const out = [];
  for (let i = 0; i < rowTexts.length; ++i) {
    const text = rowTexts[i];
    // Deleted articles ((本文已被刪除) / (已被xxx刪除), author column "-") are
    // hidden unconditionally: they cannot be opened (the serialized open would
    // wedge on them) — treated exactly like a blacklist hit.
    let hide = isDeletedListRow(text);
    if (!hide && hasBlacklist) {
      const author = parseListAuthor(text);
      if (author && blacklistSet.has(author)) hide = true;
    }
    if (!hide && hasTitle) {
      if (matchTitleBlacklist(parseListTitle(text), titleKeywords)) hide = true;
    }
    if (!hide) out.push(i);
  }
  return out;
}
