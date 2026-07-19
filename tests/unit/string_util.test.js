// Pure-logic unit tests for string_util.wrapText (vitest, 纯逻辑 — no DOM/网路).
//
// Regression guard for the CodeQL "incomplete string escaping" fix: the group
// width calculation in wrapText() must replace ALL tabs (and CR/LF), not just
// the first. With the missing `g` flag, a group holding multiple tabs was
// under-measured, so a line that should wrap stayed on one row.

import { wrapText, normalizeCopyText } from "../../src/js/string_util";

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

// Guards the copy pipeline (App.doCopy → navigator.clipboard.writeText):
// extracted from the pre-Clipboard-API doCopy so the exact normalization
// semantics survive the execCommand('copy') removal.
describe("normalizeCopyText", () => {
  it("converts \\r\\n and bare \\n to BBS \\r line endings", () => {
    expect(normalizeCopyText("a\r\nb\nc")).toBe("a\rb\rc");
  });

  it("strips trailing spaces before a line break", () => {
    expect(normalizeCopyText("a   \nb  \r\nc")).toBe("a\rb\rc");
  });

  it("keeps text without line breaks unchanged", () => {
    expect(normalizeCopyText("hello world")).toBe("hello world");
  });

  // ANSI copies (copyAnsi) must keep their exact byte sequence — no line-ending
  // or whitespace rewriting once an escape char is present.
  it("passes ANSI text through untouched", () => {
    const ansi = "\x1b[1;33mhi  \r\nthere\x1b[m";
    expect(normalizeCopyText(ansi)).toBe(ansi);
  });
});
