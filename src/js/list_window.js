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

// 渲染後的 24 列畫面裡，body（可選取的文章列）從第幾列開始。頭 3 列是快取的
// header、最後 1 列是快取的 footer（_bodyRows() = rows - 4 的另一半）。
// 「渲染列號 ↔ body index」的換算（滑鼠座標、游標底色）一律用它，不要再散落魔數 3。
export const LIST_HEADER_ROWS = 3;

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

// 依列位移（平滑捲動跨列時用；web 慣例，**不是** read.c 的操作，所以刻意不進
// moveListCursorWindow
// 的 switch）：視窗位移 `lines` 列，**游標被視窗推著走** —— 能不動就不動，被推到
// 視窗外才夾回邊緣那一列。游標必須留在視窗內（normalizeListWindow 的不變量），
// 否則下一幀就會以游標為準把視窗重錨回去、把剛捲的距離整個吃掉。
//
// 與 pgdn 的刻意差異：底端**貼齊**（top 上限 = len - bodyRows，最後一列落在畫面
// 最下方），不像 pgdn 那樣可以一路捲到「只剩最後一列在最上方、下面全是空白列」。
// 慢速捲動時看著清單流進空白區很怪，而 read.c parity 在 v5 合約下本來就不再要求
// （docs/easy-reading-list.md 核心原則）。鍵盤 PgUp/PgDn 語意不受影響。
//
// 不產生 serverOp：到邊就停，靠 ListSession 的 demand 去補頁（同 pgup/pgdn）。
export function scrollListWindow(state, lines, ctx) {
  const len = ctx.len;
  const B = ctx.bodyRows;
  if (!len || !lines) return { top: state.top, cursor: state.cursor };
  const maxTop = Math.max(0, len - B);
  let top;
  if (lines > 0) {
    // 已經在 pgdn 造成的 over-scroll 位置（top > maxTop）時，往下捲**不可以**把
    // 視窗往回拉：夾在 max(maxTop, 現值) ⇒ 最多就是停住。
    top = Math.min(state.top + lines, Math.max(maxTop, state.top));
  } else {
    top = Math.max(state.top + lines, 0);
  }
  let cursor = state.cursor;
  if (cursor < top) cursor = top;
  const lastVisible = Math.min(top + B - 1, len - 1);
  if (cursor > lastVisible) cursor = lastVisible;
  return { top: top, cursor: cursor };
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

// Paint the native cursor mark onto (a CLONE of) the selected row, exactly like
// the server draws it: `mbbsd/stuff.c#cursor_show` does `outs(STR_CURSOR)` at
// column 0, and STR_CURSOR is the half-width ">" (include/common.h). One cell —
// it covers the leading padding space of the "%7d" sequence-number column, so the
// number stays fully visible and no later column shifts.
//
// It used to be the full-width ● (STR_CURSOR2, cells [0,1], swallowing the top
// digit); pttbbs `b9a5029f` "cleanup(cursor): Always do CURSOR_ASCII" retired the
// UF_CURSOR_ASCII flag and made ">" the only cursor site-wide, so we follow suit.
// ASCII ⇒ no u2b/Big5 bytes needed, unlike the old bullet.
//
// Inverse of term_view's relabelListCursorRow. Attributes are left as the row had
// them (native outs() the mark with the current attrs too).
export function labelListCursor(row) {
  if (!row || !row.length) return;
  row[0].ch = '>';
  row[0].isLeadByte = false;
}
