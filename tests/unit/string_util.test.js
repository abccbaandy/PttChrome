// Pure-logic unit tests for string_util.wrapText (jest, node env — no DOM/网路).
//
// Regression guard for the CodeQL "incomplete string escaping" fix: the group
// width calculation in wrapText() must replace ALL tabs (and CR/LF), not just
// the first. With the missing `g` flag, a group holding multiple tabs was
// under-measured, so a line that should wrap stayed on one row.

import { wrapText } from "../../src/js/string_util";

describe("wrapText group-width measurement", () => {
  // "ab\t\t" forms one group (word + trailing tabs). Each tab is 4 columns →
  // width 2 + 8 = 10, exactly filling maxLen, so "cd" must spill to a new line.
  // Pre-fix (no `g`) only the first tab counted (width 7) → no wrap.
  it("counts every tab in a group when wrapping", () => {
    expect(wrapText("ab\t\tcd", 10, "\n")).toBe("ab\t\t\ncd");
  });

  it("does not wrap when the group still fits", () => {
    expect(wrapText("ab\tcd", 10, "\n")).toBe("ab\tcd");
  });

  // Plain ASCII below the limit is returned unchanged.
  it("leaves short ASCII untouched", () => {
    expect(wrapText("hello", 10, "\n")).toBe("hello");
  });
});
