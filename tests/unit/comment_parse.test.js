// Pure-logic unit tests for the Enhanced Add-on. These run without DOM/network
// (jest, node env) so they are stable — unlike the live-PTT e2e specs.
//
// The headline regression here is the easy-reading "原PO 高亮 bleeds into a whole
// column" bug: a non-author row must NEVER inherit the author id range. Both render
// paths now funnel through annotateComment(), so guarding it guards both.
//
// Second regression: comment detection now REQUIRES a trailing " MM/DD HH:MM"
// timestamp (COMMENT_TIME_RE). Body text written in comment shape and "※ 編輯: …"
// lines have no such timestamp and must not be numbered as floors. Saved articles
// that exposed the bug live in tests/unit/fixtures/ — see fixtures/README.md.

import fs from "fs";
import path from "path";
import {
  parseComment,
  parseArticleAuthor,
  parseListAuthor,
  parseBlacklist,
  FloorCounter,
  annotateComment,
  COMMENT_USERID_COL
} from "../../src/js/comment_parse";
import { parsePushInitText } from "../../src/js/string_util";

// Append a realistic right-aligned timestamp so a row passes the new "must end with
// MM/DD HH:MM" comment test. The exact gap width is irrelevant (regex needs ≥1 space).
const ts = s => s + "                 06/06 16:11";

describe("parseComment", () => {
  test("推/噓/→ with id (and trailing timestamp)", () => {
    expect(parseComment(ts("推 abc: hi"))).toEqual({ type: "推", userid: "abc" });
    expect(parseComment(ts("噓 Foo: x"))).toEqual({ type: "噓", userid: "foo" });
    expect(parseComment(ts("→ wowBenny: y"))).toEqual({
      type: "→",
      userid: "wowbenny"
    });
  });
  test("id may be space-padded before ':' (Stock style)", () => {
    expect(parseComment(ts("推 diefishfish : x"))).toEqual({
      type: "推",
      userid: "diefishfish"
    });
  });
  test("comment shape but NO timestamp → null (body text)", () => {
    expect(parseComment("→ tony32135 : 明天開盤幾乎跌停你下得去手嗎")).toBeNull();
    expect(parseComment("推 bbignose : 你從哪來的錯覺能賣掉")).toBeNull();
  });
  test("※ 編輯 line → null (different format, leading ※)", () => {
    expect(
      parseComment("※ 編輯: wowbenny (49.215.21.245 臺灣), 06/06/2026 16:13:24")
    ).toBeNull();
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
    expect(parseArticleAuthor(ts("推 wowbenny: hi"))).toBeNull();
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

  test("body text in comment shape (no timestamp) → null, takes no floor", () => {
    const ctx = baseCtx();
    expect(annotateComment("→ tony32135 : 明天開盤幾乎跌停", ctx)).toBeNull();
    // counter untouched: the next real comment is still floor 1.
    expect(annotateComment(ts("推 kidla : x"), ctx).floor.seq).toBe(1);
  });

  test("原PO comment → author id range = exactly the user id columns", () => {
    const ann = annotateComment(ts("→ wowbenny: hi"), baseCtx());
    expect(ann.userid).toBe("wowbenny");
    expect(ann.authorIdStart).toBe(COMMENT_USERID_COL); // 3
    expect(ann.authorIdEnd).toBe(COMMENT_USERID_COL + "wowbenny".length); // 11
    expect(ann.pusher).toBe("wowbenny");
  });

  // REGRESSION: the easy-reading whole-column bleed. A different pusher must get
  // NO author range even when processed right after a 原PO row with a shared ctx.
  test("non-原PO row never inherits the author id range", () => {
    const ctx = baseCtx();
    annotateComment(ts("→ wowbenny: hi"), ctx); // 原PO first
    const other = annotateComment(ts("推 hsiung9: yo"), ctx); // then someone else
    expect(other.userid).toBe("hsiung9");
    expect(other.authorIdStart).toBeUndefined();
    expect(other.authorIdEnd).toBeUndefined();
  });

  test("highlightAuthor off → no author range", () => {
    const ctx = baseCtx();
    ctx.highlightAuthor = false;
    expect(
      annotateComment(ts("→ wowbenny: hi"), ctx).authorIdStart
    ).toBeUndefined();
  });

  test("floors advance for every comment including blacklisted", () => {
    const ctx = baseCtx();
    ctx.blacklist = new Set(["spammer"]);
    const a = annotateComment(ts("推 alice: 1"), ctx);
    const bl = annotateComment(ts("推 spammer: 2"), ctx);
    const b = annotateComment(ts("推 bob: 3"), ctx);
    expect(a.floor.seq).toBe(1);
    expect(bl.hidden).toBe(true);
    expect(bl.floor.seq).toBe(2); // blacklisted still occupies a floor
    expect(b.floor.seq).toBe(3); // numbering stays absolute
  });

  test("showFloorNumbers off → no floor, counter untouched", () => {
    const ctx = baseCtx();
    ctx.showFloorNumbers = false;
    expect(annotateComment(ts("推 alice: 1"), ctx).floor).toBeUndefined();
  });

  test("selectedPusher → whole-row highlight only for the matching id", () => {
    const ctx = baseCtx();
    ctx.selectedPusher = "alice";
    expect(annotateComment(ts("推 alice: 1"), ctx).pusherHighlight).toBe(true);
    expect(annotateComment(ts("推 bob: 2"), ctx).pusherHighlight).toBeUndefined();
  });
});

// Saved articles (tests/unit/fixtures/) that exposed the floor bugs. Each labelled
// row: C = real comment (one floor), N = must not be a comment / take a floor.
const FIX_DIR = path.join(__dirname, "fixtures");
const FIXTURES = [
  "Stock_M.1780738427.txt", // 內文推文格式被當真推文
  "C_Chat_M.1780733372.txt", // ※ 編輯被當樓層
  "C_Chat_M.1780732757.txt", // 少量推文，空白被標樓層
  "Stock_M.1780733590.txt", // 內文/推文混雜
  "Stock_M.1780735101.txt" // → BlueBird5566 不見 (偵測層面須為合法推文)
];

function loadFixture(name) {
  return fs
    .readFileSync(path.join(FIX_DIR, name), "utf8")
    .split(/\r?\n/)
    .filter(l => l.length && !l.startsWith("#"))
    .map(l => {
      const t = l.indexOf("\t");
      return {
        label: t < 0 ? l : l.slice(0, t),
        text: t < 0 ? "" : l.slice(t + 1)
      };
    });
}

describe("floor fixtures (saved articles)", () => {
  FIXTURES.forEach(name => {
    describe(name, () => {
      const rows = loadFixture(name);

      test("C rows are comments; N rows are not", () => {
        rows.forEach(({ label, text }) => {
          if (label === "C") expect(parseComment(text)).not.toBeNull();
          else expect(parseComment(text)).toBeNull();
        });
      });

      test("only C rows take a floor, sequential from 1", () => {
        const ctx = { showFloorNumbers: true, floorCounter: new FloorCounter() };
        let seq = 0;
        rows.forEach(({ label, text }) => {
          const ann = annotateComment(text, ctx);
          if (label === "C") {
            expect(ann.floor.seq).toBe(++seq);
          } else {
            expect(ann).toBeNull();
          }
        });
        expect(seq).toBe(rows.filter(r => r.label === "C").length);
      });
    });
  });
});

describe("parsePushInitText (easy-reading input-prompt detection)", () => {
  // A finished arrow comment must NOT be mistaken for the comment input prompt —
  // that bug dropped a leading "→ user:" comment from the easy-reading scroll.
  test("real arrow comment (has timestamp) → false", () => {
    expect(parsePushInitText(ts("→ BlueBird5566: 才生2個也在增產成功"))).toBe(false);
  });
  test("bare input prompt (no timestamp) → true", () => {
    expect(parsePushInitText("→ wowbenny: ")).toBe(true);
  });
  test("rating prompt still detected", () => {
    expect(parsePushInitText("您覺得這篇文章 是好文嗎？")).toBe(true);
  });
});
