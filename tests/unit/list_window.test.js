// Native-parity window math (src/js/list_window.js).
//
// The heart of this suite is the read.c REFERENCE SIMULATOR: a direct 1-based
// transcription of pttbbs mbbsd/read.c cursor_pos (read.c:170-195) + the key
// ops (read.c:842-880). moveListCursorWindow must match it step-for-step over
// every op sequence — with no blacklist the visible sequence equals the native
// line space, so this IS the "無黑名單時兩模式無可感知差異" guarantee at the
// navigation-logic layer (core principle, docs/easy-reading-list.md).
import {
  listCursorPos,
  moveListCursorWindow,
  normalizeListWindow,
  windowVisibleSequence,
  pruneListToSegment,
  labelListCursorBullet,
  LIST_FROM_TOP,
} from '../../src/js/list_window';

// ---------------------------------------------------------------------------
// read.c reference simulator (1-based, exactly the C code shape)
// ---------------------------------------------------------------------------

// cursor_pos(locmem, val, from_top): read.c:170-195 minus the paint calls.
function refCursorPos(mem, val, fromTop, lastLine) {
  if (!lastLine) return;
  if (val > lastLine) val = lastLine;
  if (val <= 0) val = 1;
  if (val >= mem.top && val < mem.top + mem.pLines) {
    mem.crs = val;
    return;
  }
  mem.top = val - fromTop;
  if (mem.top <= 0) mem.top = 1;
  mem.crs = val;
}

// One i_read_key nav op: read.c:842-880 (new_top defaults to 10).
function refOp(mem, op, lastLine) {
  let val;
  let fromTop = 10;
  switch (op) {
    case 'up':
      if (mem.crs <= 1) {
        val = lastLine;
        fromTop = mem.pLines - 1;
      } else {
        val = mem.crs - 1;
        fromTop = mem.pLines - 2;
      }
      break;
    case 'down':
      val = mem.crs + 1;
      fromTop = 1;
      break;
    case 'pgup':
      val = mem.top - mem.pLines;
      fromTop = 0;
      break;
    case 'pgdn':
      val = mem.top + mem.pLines;
      fromTop = 0;
      break;
    case 'home':
      val = 0;
      fromTop = 0;
      break;
    case 'end':
      val = lastLine;
      fromTop = mem.pLines - 1;
      break;
    default:
      return;
  }
  refCursorPos(mem, val, fromTop, lastLine);
}

// Drive moveListCursorWindow (0-based) with both edges confirmed (= the whole
// board is buffered, the no-blacklist native-parity setup).
function ours(state, op, len, B) {
  return moveListCursorWindow(state, op, {
    len,
    bodyRows: B,
    atTop: true,
    atBottom: true,
  });
}

describe('moveListCursorWindow ≡ read.c reference (dual-mode parity)', () => {
  const OPS = ['up', 'down', 'pgup', 'pgdn', 'home', 'end'];

  function compareSequence(len, B, seq, startTop, startCrs) {
    const mem = { top: startTop + 1, crs: startCrs + 1, pLines: B };
    let st = { top: startTop, cursor: startCrs };
    seq.forEach((op, step) => {
      refOp(mem, op, len);
      st = ours(st, op, len, B);
      expect({ step, op, top: st.top, cursor: st.cursor }).toEqual({
        step,
        op,
        top: mem.top - 1,
        cursor: mem.crs - 1,
      });
    });
  }

  test('every single op from every window state (exhaustive, len=55 B=20)', () => {
    const len = 55;
    const B = 20;
    for (let top = 0; top < len; ++top) {
      for (let crs = top; crs < Math.min(top + B, len); ++crs) {
        for (const op of OPS) compareSequence(len, B, [op], top, crs);
      }
    }
  });

  test('long pseudo-random op walks stay in lockstep', () => {
    // Deterministic LCG so failures reproduce.
    let s = 42;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (const len of [1, 5, 19, 20, 21, 60, 300]) {
      const B = 20;
      const seq = [];
      for (let i = 0; i < 400; ++i) seq.push(OPS[Math.floor(rnd() * OPS.length)]);
      compareSequence(len, B, seq, 0, 0);
    }
  });

  test('pgup lands the cursor on the new page TOP (the reported symptom)', () => {
    // top=40, cursor=45 → PgUp: top=20, cursor=20 (read.c: new_top=0).
    const r = ours({ top: 40, cursor: 45 }, 'pgup', 100, 20);
    expect(r).toEqual({ top: 20, cursor: 20, serverOp: null });
  });

  test('up at the global first line wraps to the end (read.c KEY_UP)', () => {
    const r = ours({ top: 0, cursor: 0 }, 'up', 100, 20);
    expect(r).toEqual({ top: 99 - 19, cursor: 99, serverOp: null });
  });

  test('down at the last line stays (no wrap, read.c clamp)', () => {
    const r = ours({ top: 80, cursor: 99 }, 'down', 100, 20);
    expect(r).toEqual({ top: 80, cursor: 99, serverOp: null });
  });

  test('unconfirmed edges defer to the server instead of faking a local jump', () => {
    const ctx = { len: 100, bodyRows: 20, atTop: false, atBottom: false };
    expect(moveListCursorWindow({ top: 40, cursor: 45 }, 'end', ctx).serverOp).toBe('end');
    expect(moveListCursorWindow({ top: 40, cursor: 45 }, 'home', ctx).serverOp).toBe('home');
    // up at the buffer's first row without a confirmed bottom = would wrap →
    // must go to the server too (the wrap target is the real board end).
    expect(moveListCursorWindow({ top: 0, cursor: 0 }, 'up', ctx).serverOp).toBe('end');
    // …but plain moves inside the buffer stay local.
    expect(moveListCursorWindow({ top: 40, cursor: 45 }, 'up', ctx).serverOp).toBe(null);
  });

  test('empty sequence is inert', () => {
    const r = moveListCursorWindow({ top: 0, cursor: 0 }, 'down', {
      len: 0,
      bodyRows: 20,
      atTop: true,
      atBottom: true,
    });
    expect(r).toEqual({ top: 0, cursor: 0, serverOp: null });
  });
});

describe('listCursorPos', () => {
  test('inside the window: top unchanged', () => {
    expect(listCursorPos({ top: 10 }, 15, 0, 100, 20)).toEqual({ top: 10, cursor: 15 });
  });
  test('outside: re-anchor top = val - fromTop, floored at 0', () => {
    expect(listCursorPos({ top: 10 }, 50, 10, 100, 20)).toEqual({ top: 40, cursor: 50 });
    expect(listCursorPos({ top: 50 }, 3, 10, 100, 20)).toEqual({ top: 0, cursor: 3 });
  });
  test('clamps the target to [0, len-1]', () => {
    expect(listCursorPos({ top: 0 }, 500, 0, 30, 20)).toEqual({ top: 29, cursor: 29 });
    // clamped-to-0 target falls OUTSIDE top=5's window → re-anchor (read.c same)
    expect(listCursorPos({ top: 5 }, -4, 0, 30, 20)).toEqual({ top: 0, cursor: 0 });
  });
  test('empty → null', () => {
    expect(listCursorPos({ top: 0 }, 0, 0, 0, 20)).toBeNull();
  });
});

describe('normalizeListWindow', () => {
  test('keeps a window that still contains the cursor', () => {
    expect(normalizeListWindow(10, 15, 100, 20)).toEqual({ top: 10, cursor: 15 });
  });
  test('re-anchors with the jump rule when the cursor escaped', () => {
    expect(normalizeListWindow(10, 45, 100, 20)).toEqual({
      top: 45 - LIST_FROM_TOP,
      cursor: 45,
    });
    expect(normalizeListWindow(-1, 5, 100, 20)).toEqual({ top: 0, cursor: 5 });
  });
  test('clamps a stale cursor into the sequence', () => {
    expect(normalizeListWindow(0, 500, 30, 20)).toEqual({ top: 29 - LIST_FROM_TOP, cursor: 29 });
  });
  test('empty → null', () => {
    expect(normalizeListWindow(0, 0, 0, 20)).toBeNull();
  });
});

describe('windowVisibleSequence (pinned gating, native last-page parity)', () => {
  const nums = [10, 11, 12, null, null]; // two pinned tail rows
  test('bottom edge unconfirmed → pinned rows are NOT navigable', () => {
    expect(windowVisibleSequence([0, 1, 2, 3, 4], nums, false)).toEqual([0, 1, 2]);
  });
  test('confirmed board end → pinned tail appears (last page)', () => {
    expect(windowVisibleSequence([0, 1, 2, 3, 4], nums, true)).toEqual([0, 1, 2, 3, 4]);
  });
  test('respects the incoming blacklist filter', () => {
    expect(windowVisibleSequence([0, 2, 4], nums, false)).toEqual([0, 2]);
  });
});

describe('pruneListToSegment (window never spans a fetch hole)', () => {
  function mapOf(nums) {
    const m = new Map();
    nums.forEach(n => m.set(n, 'row' + n));
    return m;
  }
  test('contiguous buffer untouched', () => {
    const m = mapOf([5, 6, 7, 8]);
    expect(pruneListToSegment(m, 6)).toEqual({ prunedUp: false, prunedDown: false });
    expect(m.size).toBe(4);
  });
  test('keeps the pivot segment, drops the rest', () => {
    const m = mapOf([1, 2, 3, 50, 51, 52, 90, 91]);
    expect(pruneListToSegment(m, 51)).toEqual({ prunedUp: true, prunedDown: true });
    expect(Array.from(m.keys()).sort((a, b) => a - b)).toEqual([50, 51, 52]);
  });
  test('null pivot keeps the largest-number segment (End landing)', () => {
    const m = mapOf([1, 2, 3, 90, 91]);
    expect(pruneListToSegment(m, null)).toEqual({ prunedUp: true, prunedDown: false });
    expect(Array.from(m.keys()).sort((a, b) => a - b)).toEqual([90, 91]);
  });
  test('pivot not in the map falls back to the largest segment', () => {
    const m = mapOf([1, 2, 3, 90, 91]);
    pruneListToSegment(m, 42);
    expect(Array.from(m.keys()).sort((a, b) => a - b)).toEqual([90, 91]);
  });
  test('empty map inert', () => {
    expect(pruneListToSegment(new Map(), 1)).toEqual({ prunedUp: false, prunedDown: false });
  });
});

describe('labelListCursorBullet', () => {
  function cell(ch) {
    return { ch, isLeadByte: false };
  }
  test('paints the DBCS bullet pair over cells [0,1] only', () => {
    const row = [cell(' '), cell('3'), cell('4'), cell('9')];
    labelListCursorBullet(row, '\xA1', '\xB3');
    expect(row[0]).toEqual({ ch: '\xA1', isLeadByte: true });
    expect(row[1]).toEqual({ ch: '\xB3', isLeadByte: false });
    expect(row[2].ch).toBe('4');
    expect(row[3].ch).toBe('9');
  });
  test('too-short / missing rows are ignored', () => {
    expect(() => labelListCursorBullet(null, 'a', 'b')).not.toThrow();
    expect(() => labelListCursorBullet([{ ch: 'x' }], 'a', 'b')).not.toThrow();
  });
});
