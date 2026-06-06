// Pure-logic unit tests for the Enhanced Add-on. These run without DOM/network
// (jest, node env) so they are stable — unlike the live-PTT e2e specs.
//
// The headline regression here is the easy-reading "原PO 高亮 bleeds into a whole
// column" bug: a non-author row must NEVER inherit the author id range. Both render
// paths now funnel through annotateComment(), so guarding it guards both.

import {
  parseComment,
  parseArticleAuthor,
  parseListAuthor,
  parseBlacklist,
  FloorCounter,
  annotateComment,
  COMMENT_USERID_COL
} from "../../src/js/comment_parse";

describe("parseComment", () => {
  test("推/噓/→ with id", () => {
    expect(parseComment("推 abc: hi")).toEqual({ type: "推", userid: "abc" });
    expect(parseComment("噓 Foo: x")).toEqual({ type: "噓", userid: "foo" });
    expect(parseComment("→ wowBenny: y")).toEqual({
      type: "→",
      userid: "wowbenny"
    });
  });
  test("non-comment rows → null", () => {
    expect(parseComment("作者  wowbenny (x) 看板 C_Chat")).toBeNull();
    expect(parseComment("")).toBeNull();
    expect(parseComment(null)).toBeNull();
  });
});

describe("parseArticleAuthor", () => {
  test("header line → lower-cased 原PO id", () => {
    expect(parseArticleAuthor("作者  wowBenny (nick) 看板 C_Chat")).toBe(
      "wowbenny"
    );
  });
  test("non-header lines → null", () => {
    expect(parseArticleAuthor("推 wowbenny: hi")).toBeNull();
    expect(parseArticleAuthor("標題  [問題] ...")).toBeNull();
  });
});

describe("parseListAuthor", () => {
  test("author column 17-28", () => {
    // " 352960 + 4 6/05 HarunoYukino R: ..." → author at col 17, width 12.
    const row = " 352960 + 4 6/05 HarunoYukino R: foo";
    expect(parseListAuthor(row)).toBe("harunoyukino");
  });
  test("fail-safe → null when not a plain id", () => {
    expect(parseListAuthor("       ")).toBeNull();
  });
});

describe("FloorCounter", () => {
  test("seq overall, sub per type", () => {
    const c = new FloorCounter();
    expect(c.next("推")).toEqual({ seq: 1, sub: 1, type: "推" });
    expect(c.next("推")).toEqual({ seq: 2, sub: 2, type: "推" });
    expect(c.next("噓")).toEqual({ seq: 3, sub: 1, type: "噓" });
    expect(c.next("→")).toEqual({ seq: 4, sub: 1, type: "→" });
    c.reset();
    expect(c.next("推")).toEqual({ seq: 1, sub: 1, type: "推" });
  });
});

describe("parseBlacklist", () => {
  test("newline-separated, lower-cased, trimmed", () => {
    const set = parseBlacklist("Foo\n  bar \n\nBAZ");
    expect([...set].sort()).toEqual(["bar", "baz", "foo"]);
  });
});

describe("annotateComment", () => {
  const baseCtx = () => ({
    blacklist: new Set(),
    showFloorNumbers: true,
    floorCounter: new FloorCounter(),
    highlightAuthor: true,
    articleAuthor: "wowbenny",
    selectedPusher: null
  });

  test("non-comment row → null", () => {
    expect(annotateComment("作者 wowbenny", baseCtx())).toBeNull();
  });

  test("原PO comment → author id range = exactly the user id columns", () => {
    const ann = annotateComment("→ wowbenny: hi", baseCtx());
    expect(ann.userid).toBe("wowbenny");
    expect(ann.authorIdStart).toBe(COMMENT_USERID_COL); // 3
    expect(ann.authorIdEnd).toBe(COMMENT_USERID_COL + "wowbenny".length); // 11
    expect(ann.pusher).toBe("wowbenny");
  });

  // REGRESSION: the easy-reading whole-column bleed. A different pusher must get
  // NO author range even when processed right after a 原PO row with a shared ctx.
  test("non-原PO row never inherits the author id range", () => {
    const ctx = baseCtx();
    annotateComment("→ wowbenny: hi", ctx); // 原PO first
    const other = annotateComment("推 hsiung9: yo", ctx); // then someone else
    expect(other.userid).toBe("hsiung9");
    expect(other.authorIdStart).toBeUndefined();
    expect(other.authorIdEnd).toBeUndefined();
  });

  test("highlightAuthor off → no author range", () => {
    const ctx = baseCtx();
    ctx.highlightAuthor = false;
    expect(annotateComment("→ wowbenny: hi", ctx).authorIdStart).toBeUndefined();
  });

  test("floors advance for every comment including blacklisted", () => {
    const ctx = baseCtx();
    ctx.blacklist = new Set(["spammer"]);
    const a = annotateComment("推 alice: 1", ctx);
    const bl = annotateComment("推 spammer: 2", ctx);
    const b = annotateComment("推 bob: 3", ctx);
    expect(a.floor.seq).toBe(1);
    expect(bl.hidden).toBe(true);
    expect(bl.floor.seq).toBe(2); // blacklisted still occupies a floor
    expect(b.floor.seq).toBe(3); // numbering stays absolute
  });

  test("showFloorNumbers off → no floor, counter untouched", () => {
    const ctx = baseCtx();
    ctx.showFloorNumbers = false;
    expect(annotateComment("推 alice: 1", ctx).floor).toBeUndefined();
  });

  test("selectedPusher → whole-row highlight only for the matching id", () => {
    const ctx = baseCtx();
    ctx.selectedPusher = "alice";
    expect(annotateComment("推 alice: 1", ctx).pusherHighlight).toBe(true);
    expect(annotateComment("推 bob: 2", ctx).pusherHighlight).toBeUndefined();
  });
});
