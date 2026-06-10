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
  findPageOverlap,
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

  // BePTT meta-latch rule (decompiled 7.0.9 login-mode telnet parser): fake
  // comments in the body DO take transient floors, but any non-comment row
  // before the "※ 發信站:"/"※ 文章網址:" latch zeroes the counters, so the
  // real comments (always after those meta lines) start at 1.
  describe("BePTT meta-latch rule (nonComment)", () => {
    test("non-comment row before the latch zeroes the counters", () => {
      const c = new FloorCounter();
      c.next("推"); // fake comment in the body
      c.next("推");
      c.nonComment("--"); // signature separator
      expect(c.next("→").seq).toBe(1);
    });

    test("blank rows reset too (pre-latch)", () => {
      const c = new FloorCounter();
      c.next("推");
      c.nonComment("");
      expect(c.next("推")).toEqual({ seq: 1, sub: 1, type: "推" });
    });

    test("the meta row itself resets first, then latches", () => {
      const c = new FloorCounter();
      c.next("推"); // fake comment immediately above ※ 發信站
      c.nonComment("※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4 (臺灣)");
      expect(c.metaSeen).toBe(true);
      expect(c.next("→").seq).toBe(1);
    });

    test("after the latch, non-comment rows (※ 編輯 / blank) never reset", () => {
      const c = new FloorCounter();
      c.nonComment("※ 文章網址: https://www.ptt.cc/bbs/C_Chat/M.1.A.1.html");
      c.next("→");
      c.next("→");
      c.nonComment("※ 編輯: someone (1.2.3.4 臺灣), 06/06/2026 16:13:24");
      c.nonComment("");
      expect(c.next("推").seq).toBe(3);
    });

    test("no-meta article: trailing consecutive comments still count from 1", () => {
      // Test #1g9GI-Zh case — no 發信站/文章網址 lines at all. The reset only
      // fires on non-comment rows, so the trailing comment block accumulates.
      const c = new FloorCounter();
      c.nonComment("內文最後一行");
      expect(c.next("推").seq).toBe(1);
      expect(c.next("→").seq).toBe(2);
    });

    test("reset() clears the latch (per-article lifecycle)", () => {
      const c = new FloorCounter();
      c.nonComment("※ 發信站: 批踢踢實業坊(ptt.cc)");
      expect(c.metaSeen).toBe(true);
      c.reset();
      expect(c.metaSeen).toBe(false);
      // next article: pre-latch reset behavior is back
      c.next("推");
      c.nonComment("body row");
      expect(c.next("推").seq).toBe(1);
    });
  });
});

// REGRESSION: easy-reading "first comment disappears". The cross-page de-dup used to
// rely on PTT status-line arithmetic (+ a 首頁 `i==4` hack) that over-skipped by 1 and
// ate the first comment. It is now pure content comparison — findPageOverlap returns
// how many top rows of the new screen are a re-display of the accumulated tail, so the
// caller appends newRows.slice(overlap). The dropped comment must NOT be in the skipped
// region.
describe("findPageOverlap", () => {
  test("typical 1-row overlap", () => {
    const acc = ["line A", "line B", "line C"];
    const neu = ["line C", "line D", "line E"];
    expect(findPageOverlap(acc, neu)).toBe(1); // only "line C" repeats
  });

  test("multi-row overlap returns the full k", () => {
    const acc = ["a", "b", "c", "d"];
    const neu = ["c", "d", "e", "f"];
    expect(findPageOverlap(acc, neu)).toBe(2);
  });

  test("regression: the first comment after the overlap is NOT skipped", () => {
    // Mirrors Stock #1g8znzQ3: body/url rows overlap, then the first arrow comment.
    const acc = ["body text", "※ 文章網址: ...M.1780735101..."];
    const neu = [
      "※ 文章網址: ...M.1780735101...", // the only re-displayed (overlap) row
      "→ BlueBird5566: 才生2個也在增產成功  06/06 16:38", // first comment — must survive
      "→ galleon2000 : 增產是利多嗎?  06/06 16:39"
    ];
    const k = findPageOverlap(acc, neu);
    expect(k).toBe(1);
    expect(neu.slice(k)).toContain(
      "→ BlueBird5566: 才生2個也在增產成功  06/06 16:38"
    );
  });

  test("purely-blank overlap → 0 (append all, never eat content)", () => {
    const acc = ["x", "   ", "   "];
    const neu = ["   ", "   ", "new line"];
    expect(findPageOverlap(acc, neu)).toBe(0);
  });

  test("no overlap → 0", () => {
    expect(findPageOverlap(["a", "b"], ["c", "d"])).toBe(0);
  });

  test("trailing whitespace differences still match", () => {
    expect(findPageOverlap(["row one  "], ["row one"])).toBe(1);
  });

  test("empty accumulated tail → 0", () => {
    expect(findPageOverlap([], ["a", "b"])).toBe(0);
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

  // REGRESSION (#1g8zcjhj): fake comments WITH fake timestamps match COMMENT_RE
  // (no per-row signal survives — even the colors were faked with ANSI). The
  // BePTT meta-latch rule must bring the real comments back to floor 1.
  test("fake comments with fake timestamps: real comments restart at 1", () => {
    const ctx = baseCtx();
    expect(annotateComment(ts("推 fakeghost: 假推文"), ctx).floor.seq).toBe(1);
    expect(annotateComment(ts("推 fakeghost: 假推文二"), ctx).floor.seq).toBe(2);
    annotateComment("--", ctx); // signature separator resets (pre-latch)
    annotateComment("※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4 (臺灣)", ctx);
    annotateComment("※ 文章網址: https://www.ptt.cc/...", ctx);
    expect(annotateComment(ts("→ joy82926: 真推文"), ctx).floor.seq).toBe(1);
    annotateComment("※ 編輯: somebody (1.2.3.4 臺灣), 06/06/2026 16:13:24", ctx);
    expect(annotateComment(ts("→ error405: 真推文二"), ctx).floor.seq).toBe(2);
  });

  test("showFloorNumbers off → non-comment rows don't touch the counter", () => {
    const ctx = baseCtx();
    ctx.showFloorNumbers = false;
    annotateComment("※ 發信站: 批踢踢實業坊(ptt.cc)", ctx);
    expect(ctx.floorCounter.metaSeen).toBe(false);
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
// row: C = real comment (one floor), N = must not be a comment / take a floor,
// F = fake comment in the body (full comment shape incl. fake timestamp — parses
// as a comment and takes a TRANSIENT floor, but the BePTT meta-latch rule must
// keep it out of the final numbering: the C rows still count 1..N).
const FIX_DIR = path.join(__dirname, "fixtures");
const FIXTURES = [
  "Stock_M.1780738427.txt", // 內文推文格式被當真推文
  "C_Chat_M.1780733372.txt", // ※ 編輯被當樓層
  "C_Chat_M.1780732757.txt", // 少量推文，空白被標樓層
  "Stock_M.1780733590.txt", // 內文/推文混雜
  "Stock_M.1780735101.txt", // → BlueBird5566 不見 (偵測層面須為合法推文)
  "C_Chat_M.1780734381.txt" // #1g8zcjhj 假推文帶假時間戳 (BePTT meta-latch 規則)
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

      test("C/F rows are comments; N rows are not", () => {
        rows.forEach(({ label, text }) => {
          if (label === "C" || label === "F")
            expect(parseComment(text)).not.toBeNull();
          else expect(parseComment(text)).toBeNull();
        });
      });

      test("C rows number 1..N despite F fakes (BePTT meta-latch rule)", () => {
        const ctx = { showFloorNumbers: true, floorCounter: new FloorCounter() };
        let seq = 0;
        rows.forEach(({ label, text }) => {
          const ann = annotateComment(text, ctx);
          if (label === "C") {
            expect(ann.floor.seq).toBe(++seq);
          } else if (label === "F") {
            // fake comment: parses and takes a transient floor — but a later
            // pre-latch reset keeps it out of the real numbering.
            expect(ann.floor.seq).toBeGreaterThan(0);
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
