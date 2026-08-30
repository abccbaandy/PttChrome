// List easy reading — 導覽序列與游標標記（pure, no DOM / no TermChar prototype
// knowledge beyond plain property writes）。
//
// Coordinate space: "positions" are 0-based indices into the visible sequence
// (blacklist-filtered, pinned-gated).
//
// **視窗數學（read.c 的 cursor_pos / 24 列視窗 / 游標被視窗推著走）已於
// 2026-08-30 整組退場**：畫面改成「整段序列畫進一個捲動視口、捲動交給瀏覽器」，
// 游標與捲動位置解耦（網頁式語意），於是 `listCursorPos` / `moveListCursorWindow`
// / `normalizeListWindow` / `scrollListWindow` 全部沒有消費端。鍵盤導覽的落點
// 現在算在 `ListSession._moveSelection`（serverOp 的邊界判準照抄 read.c:842-880
// 未變），捲動數學在 `js/list_scroll.js`。

// 渲染後的 24 列畫面裡，body（可選取的文章列）從第幾列開始。頭 3 列是快取的
// header、最後 1 列是快取的 footer（_bodyRows() = rows - 4 的另一半）。
// 「渲染列號 ↔ body index」的換算（滑鼠座標、游標底色）一律用它，不要再散落魔數 3。
export const LIST_HEADER_ROWS = 3;

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
