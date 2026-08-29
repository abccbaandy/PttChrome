// Window math (src/js/list_window.js) — v5 behavior-level guards.
//
// v5 合約下 read.c lockstep 參考模擬器與全枚舉比對已退役（parity 合約廢棄，
// docs/easy-reading-list.md 核心原則）。此處只鎖使用者可感知的行為症狀：
// PgUp 游標停新頁頂、頂端 wrap、底端 clamp、邊未確認時交給 server。
import {
  listCursorPos,
  moveListCursorWindow,
  scrollListWindow,
  normalizeListWindow,
  windowVisibleSequence,
  pruneListToSegment,
  labelListCursor,
  LIST_FROM_TOP,
} from '../../src/js/list_window';

// Drive moveListCursorWindow (0-based) with both edges confirmed (= the whole
// board is buffered).
function ours(state, op, len, B) {
  return moveListCursorWindow(state, op, {
    len,
    bodyRows: B,
    atTop: true,
    atBottom: true,
  });
}

describe('moveListCursorWindow（v5 行為級守護）', () => {
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

describe('labelListCursor', () => {
  function cell(ch) {
    return { ch, isLeadByte: false };
  }
  // pttbbs b9a5029f 起官方游標＝STR_CURSOR ">"（半形單格，stuff.c#cursor_show），
  // 只蓋 %7d 序號的前導空格 ⇒ 我們畫的假游標比照，序號完整可見、欄位不位移。
  test('paints the half-width > over cell 0 only', () => {
    const row = [cell(' '), cell('3'), cell('4'), cell('9')];
    labelListCursor(row);
    expect(row[0]).toEqual({ ch: '>', isLeadByte: false });
    expect(row[1].ch).toBe('3'); // 序號最高位不再被蓋
    expect(row[2].ch).toBe('4');
    expect(row[3].ch).toBe('9');
  });
  test('too-short / missing rows are ignored', () => {
    expect(() => labelListCursor(null)).not.toThrow();
    expect(() => labelListCursor([])).not.toThrow();
  });
});

describe('scrollListWindow（平滑捲動的跨列位移，web 慣例）', () => {
  const ctx = { len: 100, bodyRows: 20 };

  test('視窗位移，游標留在原本那一列（不被拖著跑）', () => {
    // top=40 cursor=45 → 往下 3 列：游標仍在視窗內 [43,62]
    expect(scrollListWindow({ top: 40, cursor: 45 }, 3, ctx)).toEqual({
      top: 43,
      cursor: 45,
    });
  });

  test('游標被推出視窗時夾回邊緣那一列', () => {
    // 往下捲到游標落在視窗上緣之上 → 游標被推到新的 top
    expect(scrollListWindow({ top: 40, cursor: 41 }, 5, ctx)).toEqual({
      top: 45,
      cursor: 45,
    });
    // 往上捲同理，夾在視窗最後一列
    expect(scrollListWindow({ top: 40, cursor: 58 }, -5, ctx)).toEqual({
      top: 35,
      cursor: 54,
    });
  });

  test('底端貼齊：最後一列停在畫面最下方，不捲進空白區（與 pgdn 刻意不同）', () => {
    const r = scrollListWindow({ top: 75, cursor: 80 }, 20, ctx);
    expect(r.top).toBe(80); // len - bodyRows
    expect(r.cursor).toBe(80);
    // 已經貼底了就完全不動
    expect(scrollListWindow(r, 5, ctx)).toEqual({ top: 80, cursor: 80 });
  });

  test('頂端夾在 0', () => {
    expect(scrollListWindow({ top: 3, cursor: 5 }, -10, ctx)).toEqual({
      top: 0,
      cursor: 5,
    });
  });

  test('從 pgdn 留下的 over-scroll 位置往下捲，視窗不得往回跳', () => {
    // pgdn 可以把 top 推到 len-1（下面全是空白補列）；此時往下捲只能停住。
    const r = scrollListWindow({ top: 99, cursor: 99 }, 4, ctx);
    expect(r).toEqual({ top: 99, cursor: 99 });
    // 往上捲則正常
    expect(scrollListWindow({ top: 99, cursor: 99 }, -4, ctx)).toEqual({
      top: 95,
      cursor: 99,
    });
  });

  test('緩衝區比一頁短時 top 恆為 0（不會捲出空白）', () => {
    const short = { len: 5, bodyRows: 20 };
    expect(scrollListWindow({ top: 0, cursor: 2 }, 5, short)).toEqual({
      top: 0,
      cursor: 2,
    });
  });

  test('空序列／零位移原樣回傳', () => {
    expect(scrollListWindow({ top: 0, cursor: 0 }, 3, { len: 0, bodyRows: 20 })).toEqual({
      top: 0,
      cursor: 0,
    });
    expect(scrollListWindow({ top: 7, cursor: 9 }, 0, ctx)).toEqual({
      top: 7,
      cursor: 9,
    });
  });
});
