// Unit tests for detectMentions (src/js/mention_parse.js): finding X(Twitter)
// @handle candidates in a screen row. Fake TermChar cells only need `ch` and
// `isLeadByte` (the parser walks columns, never the DBCS tables).

import { detectMentions } from "../../src/js/mention_parse";

const cell = (ch, isLeadByte = false) => ({ ch, isLeadByte });
// ASCII string → one single-byte cell per char.
const ascii = str => str.split("").map(c => cell(c));
// A Big5 DBCS character → [lead, trail] pair (isLeadByte on the first).
const dbcs = (lead, trail) => [cell(lead, true), cell(trail, false)];

describe("detectMentions", () => {
  test("plain @handle at line start", () => {
    expect(detectMentions(ascii("@jack ok"))).toEqual([
      { startCol: 0, endCol: 5, handle: "jack" }
    ]);
  });

  test("@handle after whitespace, columns are exclusive-end", () => {
    // h0 i1 sp2 @3 j4 a5 c6 k7 sp8
    expect(detectMentions(ascii("hi @jack "))).toEqual([
      { startCol: 3, endCol: 8, handle: "jack" }
    ]);
  });

  test("@handle right after a DBCS (Chinese) char is a legal prefix", () => {
    // DBCS occupies cols 0-1, '@' at col 2.
    const row = [...dbcs("\xa4", "\xa4"), ...ascii("@jack")];
    expect(detectMentions(row)).toEqual([
      { startCol: 2, endCol: 7, handle: "jack" }
    ]);
  });

  test("email a@b.com is NOT a mention (word char before @)", () => {
    expect(detectMentions(ascii("mail a@b.com x"))).toEqual([]);
  });

  test("Big5 trail byte 0x40 ('@') is never read as a mention start", () => {
    // A DBCS char whose trail byte is 0x40 = '@', followed by "jack". The trail
    // byte sits at col 1 but is skipped with its lead byte, so no phantom @jack.
    const row = [...dbcs("\xa4", "\x40"), ...ascii("jack")];
    expect(detectMentions(row)).toEqual([]);
  });

  test("@@ and bare @ are rejected", () => {
    expect(detectMentions(ascii("@@jack"))).toEqual([]);
    expect(detectMentions(ascii("look @ this"))).toEqual([]);
  });

  test("all-digit handle is rejected", () => {
    expect(detectMentions(ascii("score @123 pts"))).toEqual([]);
  });

  test("handle length boundary: 15 ok, 16 rejected", () => {
    const h15 = "a".repeat(15);
    const h16 = "a".repeat(16);
    expect(detectMentions(ascii("@" + h15 + " "))).toEqual([
      { startCol: 0, endCol: 16, handle: h15 }
    ]);
    expect(detectMentions(ascii("@" + h16 + " "))).toEqual([]);
  });

  test("handle stops at first non-handle char; following Chinese ends it", () => {
    // "@jack的" — DBCS after the handle ends it cleanly at the handle's last col.
    const row = [...ascii("@jack"), ...dbcs("\xaa", "\xba")];
    expect(detectMentions(row)).toEqual([
      { startCol: 0, endCol: 5, handle: "jack" }
    ]);
  });

  test("multiple mentions on one row keep correct columns", () => {
    // @a0..1 sp2 and @bob at 3..? : "@a @bob"
    // @0 a1 sp2 @3 b4 o5 b6
    expect(detectMentions(ascii("@a @bob"))).toEqual([
      { startCol: 0, endCol: 2, handle: "a" },
      { startCol: 3, endCol: 7, handle: "bob" }
    ]);
  });

  test("underscores and mixed case allowed; lowercase not forced here", () => {
    expect(detectMentions(ascii("@Foo_Bar9!"))).toEqual([
      { startCol: 0, endCol: 9, handle: "Foo_Bar9" }
    ]);
  });

  test("empty / null input", () => {
    expect(detectMentions(null)).toEqual([]);
    expect(detectMentions([])).toEqual([]);
  });
});
