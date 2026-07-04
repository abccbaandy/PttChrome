// List easy reading — native-parity window math (pure, no DOM / no TermChar
// prototype knowledge beyond plain property writes).
//
// CORE PRINCIPLE (docs/easy-reading-list.md): the list easy reading experience
// must be indistinguishable from the native list except for hidden (blacklisted)
// rows. Every function here is a direct port of pttbbs mbbsd/read.c semantics
// (cursor_pos read.c:170-195, key ops read.c:842-880) over the FILTERED row
// sequence — with no blacklist the sequence equals the native one, so the two
// modes are provably identical (tests/unit/list_window.test.js runs a read.c
// reference simulator against these ops step-by-step).
//
// Coordinate space: "positions" are 0-based indices into the visible sequence
// (blacklist-filtered, pinned-gated). read.c is 1-based with top_ln >= 1; the
// port keeps the same arithmetic shifted by one.

// read.c i_read_key: new_top defaults to 10 — a jump lands the cursor 10 rows
// below the window top ("畫面中上方").
export const LIST_FROM_TOP = 10;

// cursor_pos(read.c:170): clamp the target, keep the window when the target is
// already inside it, otherwise re-anchor top = target - fromTop (>= 0).
// Returns { top, cursor } or null when the sequence is empty.
export function listCursorPos(state, val, fromTop, len, bodyRows) {
  if (!len) return null;
  if (val > len - 1) val = len - 1;
  if (val < 0) val = 0;
  const top = state ? state.top : 0;
  if (val >= top && val < top + bodyRows && top >= 0 && top < len) {
    return { top: top, cursor: val };
  }
  let newTop = val - fromTop;
  if (newTop < 0) newTop = 0;
  return { top: newTop, cursor: val };
}

// One navigation op over the window, exactly read.c:842-880.
//   op ∈ 'up' | 'down' | 'pgup' | 'pgdn' | 'home' | 'end'
//   ctx = { len, bodyRows, atTop, atBottom }
//     atTop/atBottom: the buffer edge is the CONFIRMED board edge (_edgeUp /
//     _edgeDown). Only then may an op wrap or land "at the board end" locally;
//     otherwise the op that needs rows we don't hold returns a serverOp so the
//     session fetches like native would ('end' = jump+End, 'home' = jump 1).
// Returns { top, cursor, serverOp } (top/cursor unchanged when serverOp set).
export function moveListCursorWindow(state, op, ctx) {
  const len = ctx.len;
  const B = ctx.bodyRows;
  const stay = { top: state.top, cursor: state.cursor, serverOp: null };
  if (!len) return stay;
  let val;
  let fromTop;
  switch (op) {
    case 'up':
      if (state.cursor <= 0) {
        // read.c KEY_UP at the first line wraps to last_line (board end).
        if (!ctx.atBottom) return { top: state.top, cursor: state.cursor, serverOp: 'end' };
        val = len - 1;
        fromTop = B - 1;
      } else {
        val = state.cursor - 1;
        fromTop = B - 2;
      }
      break;
    case 'down':
      // read.c KEY_DOWN: crs+1, clamped by cursor_pos — no wrap at the end.
      val = state.cursor + 1;
      fromTop = 1;
      break;
    case 'pgup':
      val = state.top - B;
      fromTop = 0;
      break;
    case 'pgdn':
      val = state.top + B;
      fromTop = 0;
      break;
    case 'home':
      if (!ctx.atTop) return { top: state.top, cursor: state.cursor, serverOp: 'home' };
      val = 0;
      fromTop = 0;
      break;
    case 'end':
      if (!ctx.atBottom) return { top: state.top, cursor: state.cursor, serverOp: 'end' };
      val = len - 1;
      fromTop = B - 1;
      break;
    default:
      return stay;
  }
  const r = listCursorPos(state, val, fromTop, len, B);
  return r ? { top: r.top, cursor: r.cursor, serverOp: null } : stay;
}

// Enforce the native invariant "cursor is always inside the window" after the
// buffer changed underneath us (merge / evict / restore): keep top when it
// still contains the cursor, otherwise re-anchor with the jump rule (fromTop).
export function normalizeListWindow(top, cursor, len, bodyRows) {
  if (!len) return null;
  if (cursor > len - 1) cursor = len - 1;
  if (cursor < 0) cursor = 0;
  if (top < 0 || top > len - 1 || cursor < top || cursor >= top + bodyRows) {
    top = cursor - LIST_FROM_TOP;
    if (top < 0) top = 0;
  }
  return { top: top, cursor: cursor };
}

// Pinned-row gating (native parity): 置底文 exist only on the board's LAST page
// (read.c: bottom_line..last_line). They may enter the navigable sequence only
// once the bottom buffer edge is the CONFIRMED board end — otherwise an old
// page would render with the pinned tail glued right under it.
// `visible` = ascending absolute listLines indices surviving the blacklist;
// `nums` = buf.listLineNums (null = pinned). Returns the gated sequence.
export function windowVisibleSequence(visible, nums, edgeDown) {
  if (edgeDown) return visible;
  const out = [];
  for (let i = 0; i < visible.length; ++i) {
    if (nums[visible[i]] != null) out.push(visible[i]);
  }
  return out;
}

// Contiguity guard: article numbers are POSITIONAL, consecutive integers, so a
// hole in the sorted number set = pages we never fetched. The window must never
// render across a hole (native never does); keep only the contiguous segment
// containing `aroundNum` (fallback: the segment holding the largest number) and
// drop the rest — demand re-fetches a dropped side later. Mutates numMap.
// Returns { prunedUp, prunedDown } so the caller can clear the edge flags.
export function pruneListToSegment(numMap, aroundNum) {
  const r = { prunedUp: false, prunedDown: false };
  if (!numMap || numMap.size === 0) return r;
  const nums = Array.from(numMap.keys()).sort((a, b) => a - b);
  let hasHole = false;
  for (let i = 1; i < nums.length; ++i) {
    if (nums[i] !== nums[i - 1] + 1) {
      hasHole = true;
      break;
    }
  }
  if (!hasHole) return r;
  const pivot = aroundNum != null && numMap.has(aroundNum) ? aroundNum : nums[nums.length - 1];
  // Walk out from the pivot to the segment bounds.
  let lo = pivot;
  while (numMap.has(lo - 1)) --lo;
  let hi = pivot;
  while (numMap.has(hi + 1)) ++hi;
  for (let i = 0; i < nums.length; ++i) {
    if (nums[i] < lo) {
      numMap.delete(nums[i]);
      r.prunedUp = true;
    } else if (nums[i] > hi) {
      numMap.delete(nums[i]);
      r.prunedDown = true;
    }
  }
  return r;
}

// Paint the native cursor bullet onto (a CLONE of) the selected row: the
// full-width ● occupies cells [0,1] exactly like the server draws it
// (stuff.c cursor_show, STR_CURSOR2). `leadCh`/`trailCh` are the two Big5
// bytes of ● (u2b('●') — computed by the caller; string_util needs the global
// conversion tables, so the bytes are injected to keep this pure/unit-testable).
// Inverse of term_view's relabelListCursorRow. Attributes are left as the row
// had them (native outs() the bullet with the current attrs too).
export function labelListCursorBullet(row, leadCh, trailCh) {
  if (!row || row.length < 2) return;
  row[0].ch = leadCh;
  row[0].isLeadByte = true;
  row[1].ch = trailCh;
  row[1].isLeadByte = false;
}
