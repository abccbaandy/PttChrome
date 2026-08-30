// 導覽序列與游標標記（src/js/list_window.js）。
//
// 視窗數學（read.c 的 cursor_pos / 24 列視窗 / 游標被視窗推著走）已於 2026-08-30
// 整組退場——畫面改成「整段序列 + 瀏覽器原生捲動」，游標與捲動解耦。鍵盤導覽的
// 落點語意改由 list_session.test.js「鍵盤導覽（游標與捲動解耦）」守護，捲動數學
// 在 list_scroll.test.js。這裡只剩三件與捲動無關的事。
import {
  windowVisibleSequence,
  pruneListToSegment,
  labelListCursor,
} from '../../src/js/list_window';

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
