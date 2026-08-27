// Pure-logic unit tests for the Enhanced Add-on. These run without DOM/network
// (vitest, pure logic) so they are stable — unlike the live-PTT e2e specs.
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
  parseArticleBoard,
  parseArticleHeader,
  parseListAuthor,
  parseListTitle,
  parseListTitleRaw,
  listColRegion,
  appendBlacklistEntry,
  parseListArticleNum,
  parseListArticleNumLoose,
  isPinnedListRow,
  isDeletedListRow,
  blacklistNoticeText,
  recoverCursorArticleNum,
  pageArticleNums,
  parseBlacklist,
  parseTitleBlacklist,
  matchTitleBlacklist,
  FloorCounter,
  annotateComment,
  isPusherHighlighted,
  findPageOverlap,
  resolvePageOverlap,
  decideAccumulateBranch,
  classifyPageTransition,
  COMMENT_USERID_COL
} from "../../src/js/comment_parse";

// Append a realistic right-aligned timestamp so a row passes the new "must end with
// MM/DD HH:MM" comment test. The exact gap width is irrelevant (regex needs ≥1 space).
const ts = s => s + "                 06/06 16:11";

describe("parseComment", () => {
  test("推/噓/→ with id (and trailing timestamp)", () => {
    // contentCol＝內容文字的起始欄（cell 空間）：推(0-1) 空格(2) id(3-) ':' ' ' 內容。
    expect(parseComment(ts("推 abc: hi"))).toEqual({
      type: "推",
      userid: "abc",
      contentCol: 8
    });
    expect(parseComment(ts("噓 Foo: x"))).toEqual({
      type: "噓",
      userid: "foo",
      contentCol: 8
    });
    expect(parseComment(ts("→ wowBenny: y"))).toEqual({
      type: "→",
      userid: "wowbenny",
      contentCol: 13
    });
  });
  test("id may be space-padded before ':' (Stock style)", () => {
    expect(parseComment(ts("推 diefishfish : x"))).toEqual({
      type: "推",
      userid: "diefishfish",
      contentCol: 17
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

  // PTT 帳號規則 common/bbs/names.c#is_validuserid：長度 2..IDLEN(12)、
  // 首字 isalpha、其餘 isalnum。fileheader_t.owner 也只有 IDLEN+1 bytes
  // （include/pttstruct.h），所以推文列的 id 不可能超過 12 字。
  test("userid 邊界（is_validuserid：長度 2..12）", () => {
    expect(parseComment(ts("推 ab: x"))).toEqual({
      type: "推",
      userid: "ab",
      contentCol: 7
    });
    expect(parseComment(ts("推 abcdefghijkl: x"))).toEqual({
      type: "推",
      userid: "abcdefghijkl",
      contentCol: 17
    }); // 12 字，合法上限
    // 13 字＝不可能是真 id，這種行是內文假冒推文格式（本文照樣不佔樓層）。
    expect(parseComment(ts("推 abcdefghijklm: x"))).toBeNull();
    // 單字元 id 不存在（len < 2）。
    expect(parseComment(ts("推 a: x"))).toBeNull();
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

describe("parseArticleBoard", () => {
  test("header line → board name (case preserved)", () => {
    expect(parseArticleBoard("作者  wowBenny (nick) 看板 C_Chat")).toBe(
      "C_Chat"
    );
  });
  test("non-header lines → null", () => {
    expect(parseArticleBoard(ts("推 wowbenny: hi"))).toBeNull();
    expect(parseArticleBoard("標題  [問題] ...")).toBeNull();
    expect(parseArticleBoard("")).toBeNull();
    expect(parseArticleBoard(null)).toBeNull();
  });
});

// term_view 用它把「作者」與「看板」綁成同一次 header 事件。分開判斷時，站內信
// header（沒有「看板」欄位，該欄只存在於看板文章檔）會讓 _articleBoard 沿用**上一篇
// 看板文章**的板名 → 信裡沒帶後綴的 #AID 跳到毫不相干的看板。
describe("parseArticleHeader（作者＋看板同一次事件）", () => {
  test("看板文章 header → 兩個欄位都有", () => {
    expect(parseArticleHeader("作者  wowBenny (nick) 看板 C_Chat")).toEqual({
      author: "wowbenny",
      board: "C_Chat"
    });
  });

  test("站內信 header（無「看板」欄）→ board 必須是 null，不可沿用舊值", () => {
    expect(parseArticleHeader("作者  someuser (暱稱)")).toEqual({
      author: "someuser",
      board: null
    });
  });

  test("非 header 列 → null（呼叫端據此保留翻頁前的值）", () => {
    expect(parseArticleHeader(ts("推 wowbenny: hi"))).toBeNull();
    expect(parseArticleHeader("標題  [問題] ...")).toBeNull();
    expect(parseArticleHeader("")).toBeNull();
    expect(parseArticleHeader(null)).toBeNull();
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
  test("cursor row (leading full-width ●) realigns → full author kept", () => {
    // The keyboard-cursor row starts with a full-width bullet that rowToText
    // collapses 2 cells → 1 char, shifting columns left. Without realignment the
    // author was truncated (jhengkunlin → hengkunlin) and the blacklist missed.
    const cursorRow = "●50039 + 1 6/14 JHENGKUNLIN  □ [母雞] foo";
    const normalRow = " 350039 + 1 6/14 JHENGKUNLIN  □ [母雞] foo";
    expect(parseListAuthor(cursorRow)).toBe("jhengkunlin");
    expect(parseListAuthor(cursorRow)).toBe(parseListAuthor(normalRow));
  });
});

describe("parseListTitle", () => {
  test("title region after the author column, lower-cased", () => {
    // Same row layout as parseListAuthor: author at col 17-28, title follows.
    const row = " 350024 + 2 6/14 a0930307148  R: [閒聊] 烙印勇士384";
    expect(parseListTitle(row)).toBe("r: [閒聊] 烙印勇士384".toLowerCase());
  });
  test("short author keeps title aligned", () => {
    const row = " 350029 +17 6/14 GTES         □ [討論] 醫師：把猛健樂當減肥藥賣";
    expect(parseListTitle(row)).toContain("[討論]".toLowerCase());
  });
  test("fail-safe → '' when row too short", () => {
    expect(parseListTitle("       ")).toBe("");
    expect(parseListTitle(null)).toBe("");
  });
});

describe("parseListTitleRaw（黑名單快速新增：Modal 預填用，保留大小寫）", () => {
  test("title region kept in original case", () => {
    const row = " 350024 + 2 6/14 a0930307148  R: [閒聊] 烙印勇士384";
    expect(parseListTitleRaw(row)).toBe("R: [閒聊] 烙印勇士384");
  });
  test("cursor row (leading ●) realigns like parseListTitle", () => {
    const cursorRow = "●50039 + 1 6/14 JHENGKUNLIN  □ [母雞] Foo";
    const normalRow = " 350039 + 1 6/14 JHENGKUNLIN  □ [母雞] Foo";
    expect(parseListTitleRaw(cursorRow)).toBe(parseListTitleRaw(normalRow));
    expect(parseListTitleRaw(cursorRow)).toBe("□ [母雞] Foo");
  });
  test("fail-safe → '' when row too short / null", () => {
    expect(parseListTitleRaw("       ")).toBe("");
    expect(parseListTitleRaw(null)).toBe("");
  });
});

// 欄位邊界依 mbbsd/bbs.c#readdoent 的 printf 序列（見 comment_parse.js 頂部欄位表）：
// 作者欄 prints("%-13.12s", ent->owner) 佔 cols [17,30)（內容 ≤12 字 + 至少 1 格
// padding），標題區（mark "□"/"R:" 起）從 col 30。col 29 是作者欄的 padding，
// 屬 author 不屬 title。
describe("listColRegion（右鍵欄位判定）", () => {
  test("boundaries: author field [17,30), title 30+", () => {
    expect(listColRegion(16)).toBeNull();
    expect(listColRegion(17)).toBe("author");
    expect(listColRegion(28)).toBe("author");
    expect(listColRegion(29)).toBe("author"); // %-13.12s 的 padding 格
    expect(listColRegion(30)).toBe("title"); // mark（□/R:/轉/鎖/ˇ）起點
    expect(listColRegion(79)).toBe("title");
    expect(listColRegion(0)).toBeNull();
  });
});

describe("appendBlacklistEntry（快速新增去重 append）", () => {
  test("append to empty / existing list", () => {
    expect(appendBlacklistEntry("", "foo")).toBe("foo");
    expect(appendBlacklistEntry("foo", "bar")).toBe("foo\nbar");
  });
  test("already present (case-insensitive, trimmed) → null", () => {
    expect(appendBlacklistEntry("foo\nbar", "FOO")).toBeNull();
    expect(appendBlacklistEntry("  foo  \nbar", "foo")).toBeNull();
    expect(appendBlacklistEntry("foo", "  foo ")).toBeNull();
  });
  test("empty / whitespace-only entry → null", () => {
    expect(appendBlacklistEntry("foo", "")).toBeNull();
    expect(appendBlacklistEntry("foo", "   ")).toBeNull();
    expect(appendBlacklistEntry("foo", null)).toBeNull();
  });
  test("entry is trimmed and existing order/lines preserved", () => {
    expect(appendBlacklistEntry("a\nb", "  c  ")).toBe("a\nb\nc");
  });
  test("trailing newlines in the stored pref don't create blank lines", () => {
    expect(appendBlacklistEntry("a\nb\n", "c")).toBe("a\nb\nc");
    expect(appendBlacklistEntry("\n", "c")).toBe("c");
  });
});

describe("parseListArticleNum", () => {
  test("leading article number", () => {
    expect(parseListArticleNum(" 352960 + 4 6/05 HarunoYukino R: foo")).toBe(
      352960
    );
  });
  test("cursor row (leading ● covers the top digit) → null (not recoverable)", () => {
    // The full-width ● overwrites the leading space + first digit, so the number is
    // obscured. We return null rather than the wrong partial number (50039) — the
    // accumulator recovers it from the same article on a cursor-free page.
    const cursorRow = "●50039 + 1 6/14 JHENGKUNLIN  □ [母雞] foo";
    expect(parseListArticleNum(cursorRow)).toBeNull();
    // A normal (non-cursor) row of the same article reads the full number.
    expect(parseListArticleNum(" 350039 + 1 6/14 JHENGKUNLIN  □ [母雞] foo")).toBe(
      350039
    );
  });
  test("新版游標列（半形 > 只蓋前導空格）→ 讀得到完整序號", () => {
    // pttbbs b9a5029f「cleanup(cursor): Always do CURSOR_ASCII」廢除 UF_CURSOR_ASCII，
    // 全站改用 STR_CURSOR ">"（單格 ASCII，只蓋 %7d 的前導空格）。序號完整可見，
    // 欄位也不再位移 —— 舊碼的 /^\s*(\d+)\s/ 認不到行首 '>' → 游標列序號恆 null →
    // facts.cursorRowNum 恆 null → 所有 jump 交易的 expect 永不滿足 →「列表好讀卡住」。
    const cursorRow = ">350039 + 1 6/14 JHENGKUNLIN  □ [母雞] foo";
    const normalRow = " 350039 + 1 6/14 JHENGKUNLIN  □ [母雞] foo";
    expect(parseListArticleNum(cursorRow)).toBe(350039);
    expect(parseListArticleNum(cursorRow)).toBe(parseListArticleNum(normalRow));
    // 欄位天然對齊（'>' 是半形，rowToText 不折疊）→ 作者/標題與乾淨列等值
    expect(parseListAuthor(cursorRow)).toBe(parseListAuthor(normalRow));
    expect(parseListTitleRaw(cursorRow)).toBe(parseListTitleRaw(normalRow));
  });
  test("★pinned / separator / status / empty rows → null", () => {
    expect(parseListArticleNum("★      6/14 SYSOP        ◇ [公告] 板規")).toBeNull();
    expect(parseListArticleNum("       ")).toBeNull();
    expect(parseListArticleNum("")).toBeNull();
    expect(parseListArticleNum(null)).toBeNull();
    expect(
      parseListArticleNum("【板主】abc 看板《C_Chat》線上1234人, 我是guest")
    ).toBeNull();
  });
});

describe("isPinnedListRow", () => {
  test("★pinned/置底 row (no number but a valid author) → true", () => {
    // Real captured C_Chat ★pinned rows (fixtures/replay/cchat-list.page.json).
    expect(isPinnedListRow("    ★  m 1 6/01 arrenwu      轉 [公告] 不當連結相關申訴")).toBe(true);
    expect(isPinnedListRow("    ★  M 3 6/13 SaberTheBest □ [26夏] 夏番各作品首播時間")).toBe(true);
  });
  test("normal numbered article row → false (has a number)", () => {
    expect(isPinnedListRow(" 352960 + 4 6/05 HarunoYukino R: foo")).toBe(false);
  });
  test("新版游標壓在編號列（> 蓋頭）→ false（序號讀得到，不得誤判成置底）", () => {
    // 舊碼會因為「無序號＋作者欄合法」把它當置底列 → accumulateListLines 的
    // (i !== cur_y || 有★) 守門再把它擋掉 ⇒ 游標所在那篇文章永遠進不了 buffer。
    expect(isPinnedListRow(">352960 + 4 6/05 HarunoYukino R: foo")).toBe(false);
  });
  test("新版游標壓在置底列（>…★）→ true（★ 仍在，序號仍不可讀）", () => {
    // server 畫法 outs("  " ANSI "  ★ ")：cells 0-3 空白、4-5 ★、6 空白；
    // '>' 只蓋 cell 0 ⇒ text 為 '>' + 3 空白 + '★'（乾淨列是 4 空白 + '★'）。
    expect(isPinnedListRow(">   ★  m 1 6/01 arrenwu      轉 [公告] 板規")).toBe(true);
  });
  test("status / separator / blank rows → false (no valid author)", () => {
    expect(isPinnedListRow("【板主】abc 看板《C_Chat》線上1234人, 我是guest")).toBe(false);
    expect(isPinnedListRow("       ")).toBe(false);
    expect(isPinnedListRow("")).toBe(false);
    expect(isPinnedListRow(null)).toBe(false);
  });
});

describe("parseListArticleNumLoose（pinned-map guard）", () => {
  test("● 盖头的编号列 → 可见数字（判为编号列，不进 pinned map）", () => {
    expect(parseListArticleNumLoose("●52880 +17 7/03 RoaringWolf  □ [星原] 藍色星原")).toBe(52880);
    expect(parseListArticleNumLoose("●50039 + 1 6/14 JHENGKUNLIN  □ [母雞] foo")).toBe(50039);
  });
  test("> 盖头的编号列（新版 ASCII 游标）→ 可见数字（判为编号列，不进 pinned map）", () => {
    // 新版 '>' 不盖数字，loose 与 strict 同值；关键是行首 '>' 必须被 strip，
    // 否则 classifyListScreen 的板尾短页放宽规则（依赖 loose 非 null）会失效
    // → 板尾任何无主 settle 都降级 functionMode。
    expect(parseListArticleNumLoose(">352880 +17 7/03 RoaringWolf  □ [星原] 藍色星原")).toBe(352880);
    expect(parseListArticleNumLoose(">350039 + 1 6/14 JHENGKUNLIN  □ [母雞] foo")).toBe(350039);
  });
  test("真置底列（★ / 游标压★变体，两代游标）→ null", () => {
    expect(parseListArticleNumLoose("    ★  m 1 6/01 arrenwu      轉 [公告] 板規")).toBeNull();
    expect(parseListArticleNumLoose("●  ★  m 1 6/01 arrenwu      轉 [公告] 板規")).toBeNull();
    // '>' 加进 strip 集合后，置底列仍由 ★ 屏蔽推文数 → 依旧 null（不得回归）
    expect(parseListArticleNumLoose(">   ★  m 1 6/01 arrenwu      轉 [公告] 板規")).toBeNull();
    expect(parseListArticleNumLoose(">   ★    4 9/21 alicekey     □ [公告] 小軟體板的精神")).toBeNull();
  });
  test("置底列推文数为纯数字（无 m/+/= 前缀）→ null（★ 屏蔽推文数，不得误判为编号）", () => {
    // 使用者实测部分置底文固定消失的主因：★ 后紧接推文数栏，纯数字推文数
    // （EZsoft「4」、PC_Shopping「35」）被旧 strip ★ 逻辑露出、误判为编号列 →
    // 被 accumulateListLines 的 pinned guard 排除 → 该公告永远收不进 buffer。
    expect(parseListArticleNumLoose("★    4 9/21 alicekey     □ [公告] 小軟體板的精神")).toBeNull();
    expect(parseListArticleNumLoose("★   35 3/07 AreLies      □ [公告] 電蝦板板規 V4.1a")).toBeNull();
    expect(parseListArticleNumLoose("★  +12 6/05 AreLies      □ [公告] 本板菜單文")).toBeNull();
  });
  test("header / 空列 → null", () => {
    expect(parseListArticleNumLoose("   編號    日 期 作  者")).toBeNull();
    expect(parseListArticleNumLoose("")).toBeNull();
    expect(parseListArticleNumLoose(null)).toBeNull();
  });
});

describe("isDeletedListRow", () => {
  test("自刪/被刪列（作者欄 -）→ true（實錄 Stock/測試板樣本）", () => {
    expect(
      isDeletedListRow(" 203599     7/04 -            □ (本文已被刪除) <wh40917>")
    ).toBe(true);
    expect(
      isDeletedListRow("    343     7/04 -            □ (本文已被刪除) [sogou]")
    ).toBe(true);
  });
  test("游標壓在刪除列（● 蓋頭）仍 → true", () => {
    expect(
      isDeletedListRow("●03599     7/04 -            □ (本文已被刪除) <wh40917>")
    ).toBe(true);
  });
  test("游標壓在刪除列（新版 > 蓋頭）仍 → true", () => {
    expect(
      isDeletedListRow(">203599     7/04 -            □ (本文已被刪除) <wh40917>")
    ).toBe(true);
  });
  test("一般文章列 / 置底列 / 狀態列 → false", () => {
    expect(isDeletedListRow(" 352960 + 4 6/05 HarunoYukino R: foo")).toBe(false);
    expect(
      isDeletedListRow("    ★  m 1 6/01 arrenwu      轉 [公告] 不當連結相關申訴")
    ).toBe(false);
    expect(isDeletedListRow(" 文章選讀  (y)回應(X)推文")).toBe(false);
    expect(isDeletedListRow("")).toBe(false);
    expect(isDeletedListRow(null)).toBe(false);
  });
});

describe("blacklistNoticeText（原生模式黑名單列 → 被刪除樣式通知）", () => {
  test("保留序號/日期欄，作者欄改 '-'，標題放全形括號「（本文已被黑名單） <原作者>」", () => {
    const out = blacklistNoticeText(
      " 352960 + 4 6/05 HarunoYukino R: [閒聊] 廣告貼文"
    );
    // 序號/日期欄（col 0-16）原樣保留
    expect(out.startsWith(" 352960 + 4 6/05 ")).toBe(true);
    // 作者欄變 '-'
    expect(out.substring(17, 18)).toBe("-");
    // 全形括號（避免半形破壞 2 格節奏）+ 原作者（原始大小寫）
    expect(out).toContain("（本文已被黑名單） HarunoYukino");
    expect(out).not.toContain("(本文已被黑名單)"); // 不得是半形括號
  });
  test("游標列（● 蓋頭）：raw 前綴保留 ●、作者仍由 realign 正確取出", () => {
    const out = blacklistNoticeText(
      "●52960 + 4 6/05 HarunoYukino R: [閒聊] 廣告貼文"
    );
    // raw 前綴保留 ●（不 realign 墊空白 → 游標列不位移）
    expect(out.startsWith("●52960 + 4 6/05 -")).toBe(true);
    expect(out).toContain("（本文已被黑名單） HarunoYukino");
  });
  test("游標列（新版 > 蓋頭）：前綴保留 >、序號完整、不位移", () => {
    const out = blacklistNoticeText(
      ">352960 + 4 6/05 HarunoYukino R: [閒聊] 廣告貼文"
    );
    expect(out.startsWith(">352960 + 4 6/05 -")).toBe(true);
    expect(out).toContain("（本文已被黑名單） HarunoYukino");
    // 半形游標不折疊 ⇒ 通知列與乾淨列等長（原生模式游標上下移動不得跳版）
    expect(out.length).toBe(
      blacklistNoticeText(" 352960 + 4 6/05 HarunoYukino R: [閒聊] 廣告貼文").length
    );
  });
  test("帶 label（標題關鍵字命中）→ 尾端顯示關鍵字而非作者", () => {
    const out = blacklistNoticeText(
      " 352960 + 4 6/05 HarunoYukino R: [閒聊] 廣告貼文",
      "廣告"
    );
    expect(out.startsWith(" 352960 + 4 6/05 -")).toBe(true);
    expect(out).toContain("（本文已被黑名單） 廣告");
    expect(out).not.toContain("HarunoYukino");
  });
  test("label 為 null/undefined → 維持顯示作者（作者黑名單路徑不變）", () => {
    const out = blacklistNoticeText(
      " 352960 + 4 6/05 HarunoYukino R: [閒聊] 廣告貼文",
      null
    );
    expect(out).toContain("（本文已被黑名單） HarunoYukino");
  });
});

describe("recoverCursorArticleNum", () => {
  test("restores the digit the cursor ● covered, from a neighbour", () => {
    // Live C_Chat: cursor row "●49886", neighbour row 349887 → 349886.
    expect(recoverCursorArticleNum(49886, 349887)).toBe(349886);
    expect(recoverCursorArticleNum(49866, 349867)).toBe(349866);
  });
  test("correct across a high-digit boundary", () => {
    expect(recoverCursorArticleNum(49999, 350000)).toBe(349999);
    expect(recoverCursorArticleNum(50000, 349999)).toBe(350000);
  });
  test("null inputs → null", () => {
    expect(recoverCursorArticleNum(null, 1)).toBeNull();
    expect(recoverCursorArticleNum(1, null)).toBeNull();
  });
});

describe("pageArticleNums", () => {
  // Captured live C_Chat page after a PgUp: header rows 0-2, articles 3-22, cursor on
  // row 3 (the ● covers its leading digit). Numbers ascend top→bottom, consecutive.
  const page = [
    "",
    "",
    "   編號    日 期 作  者       文  章  標  題                        人氣:2571",
    "●49886 + 5 6/21 AoyamaNagisa □ [蔚藍] 哇幹 乳牛比基尼莉央",
    " 349887 + 1 6/21 someoneA     □ [閒聊] 標題二",
    " 349888 +10 6/21 someoneB     □ [問題] 標題三"
  ];
  test("recovers the cursor row's number; nulls for header rows", () => {
    const nums = pageArticleNums(page, 3);
    expect(nums.slice(0, 3)).toEqual([null, null, null]);
    expect(nums[3]).toBe(349886); // ●49886 recovered from neighbour 349887
    expect(nums[4]).toBe(349887);
    expect(nums[5]).toBe(349888);
  });
  test("新版 > 游標列不需回推鄰居（序號本來就完整可讀）", () => {
    const p = [
      "   編號    日 期 作  者       文  章  標  題                        人氣:2571",
      ">349886 + 5 6/21 AoyamaNagisa □ [蔚藍] 哇幹 乳牛比基尼莉央",
      " 349887 + 1 6/21 someoneA     □ [閒聊] 標題二"
    ];
    expect(pageArticleNums(p, 1)).toEqual([null, 349886, 349887]);
    // 即使整頁只有游標列一列（板尾短頁），也讀得到
    expect(pageArticleNums([">349886 + 5 6/21 AoyamaNagisa □ [蔚藍] foo"], 0)).toEqual([
      349886
    ]);
  });
  test("no cursor / cursor on a numberless row → that row stays null", () => {
    expect(pageArticleNums(page, 0)).toEqual([
      null, null, null, null, 349887, 349888
    ]);
  });
  test("monotonicity repair: a row whose leading digit cell was left blank (partial redraw → \"  51903\") is recovered from the previous number", () => {
    // Real artifact: the newest article 351903 painted as "  51903" after the cursor moved
    // off it; not the cursor row, so the cursor-recovery above misses it. The ascending
    // monotonic repair fixes it from the prior confirmed number.
    const p = [
      "   編號    日 期 作  者       文  章  標  題                        人氣:3160",
      " 351901 + 2 6/24 qk123        □ [閒聊] 標題一",
      " 351902 +   6/24 sakurammsrx  R: 標題二",
      "  51903 +   6/24 chopper594   □ [PTCGP] 標題三", // leading "3" blanked
    ];
    expect(pageArticleNums(p, 0)).toEqual([null, 351901, 351902, 351903]);
  });
  test("monotonicity repair does NOT touch genuine ascending numbers", () => {
    const p = [
      " 351901 + 2 6/24 a            □ t1",
      " 351902 +   6/24 b            □ t2",
      " 351903 +   6/24 c            □ t3",
    ];
    expect(pageArticleNums(p, 0)).toEqual([351901, 351902, 351903]);
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

// REGRESSION: easy-reading "duplicate block" bug. On a half-painted intermediate frame a
// row inside the true overlap hasn't settled, so findPageOverlap (largest text match)
// returns a SMALLER k than the real overlap → the caller re-appends already-accumulated
// rows → a duplicate block. PTT's status-line row numbers ("目前顯示: 第 S~E 行") give the
// exact overlap regardless of paint state, so resolvePageOverlap prefers them.
describe("resolvePageOverlap", () => {
  test("status and content agree → that value", () => {
    expect(
      resolvePageOverlap({ accEndRow: 90, statusStart: 89, kContent: 2, maxK: 23 })
    ).toBe(2); // 90 - 89 + 1 = 2
  });

  test("race: content under-counts, status recovers the true overlap", () => {
    // Prev screen ended at article line 113; new screen shows 111~133 → true overlap 3
    // rows (111,112,113). But a half-painted frame left row 112 mismatching, so content
    // only matched the top run and returned 1. The duplicate must be prevented → use 3.
    const accTail = ["line 111", "line 112", "line 113"];
    const newTexts = ["line 111", "line 112 (half-painted)", "line 113"];
    expect(
      resolvePageOverlap({
        accEndRow: 113,
        statusStart: 111,
        kContent: 1,
        maxK: 3,
        accTail,
        newTexts
      })
    ).toBe(3);
  });

  test("status under-counts (wrapped line) → never go below content's proven overlap", () => {
    // A long article 行 can wrap across 2 display rows, so the arithmetic kStatus can be
    // SMALLER than the true display-row overlap. content already matched more rows (they
    // genuinely re-appear) — trusting the smaller kStatus would re-append real duplicates.
    // Regression for the Stock 5-page replay fixture "相鄰非空白列不重複" failure.
    expect(
      resolvePageOverlap({ accEndRow: 100, statusStart: 99, kContent: 3, maxK: 23 })
    ).toBe(3); // kStatus = 2 < kContent 3 → keep 3
  });

  test("no status numbers → fall back to content", () => {
    expect(
      resolvePageOverlap({ accEndRow: null, statusStart: null, kContent: 2, maxK: 23 })
    ).toBe(2);
  });

  test("drift guard: status region shares ~nothing with tail → fall back to content", () => {
    // accEndRow drifted way ahead so kStatus is large, but the implied overlap rows do
    // not match the accumulated tail at all → distrust status, keep content's k.
    const accTail = ["aaa", "bbb", "ccc", "ddd"];
    const newTexts = ["zzz", "yyy", "xxx", "www"];
    expect(
      resolvePageOverlap({
        accEndRow: 200,
        statusStart: 197,
        kContent: 0,
        maxK: 4,
        accTail,
        newTexts
      })
    ).toBe(0);
  });

  test("forced redraw of the same screen → skip whole screen (no double-append)", () => {
    // pref/pusher toggle re-enters with the identical screen: accEndRow still equals this
    // screen's rowIndexEnd, so kStatus = accEndRow - statusStart + 1 = maxK → append none.
    expect(
      resolvePageOverlap({ accEndRow: 113, statusStart: 91, kContent: 23, maxK: 23 })
    ).toBe(23); // 113 - 91 + 1 = 23
  });

  test("kStatus is clamped to [0, maxK]", () => {
    expect(
      resolvePageOverlap({ accEndRow: 500, statusStart: 91, kContent: 5, maxK: 23 })
    ).toBe(23); // would be 410, clamped to maxK
    expect(
      resolvePageOverlap({ accEndRow: 10, statusStart: 91, kContent: 0, maxK: 23 })
    ).toBe(0); // negative → clamped to 0
  });
});

describe("parseBlacklist", () => {
  test("newline-separated, lower-cased, trimmed", () => {
    const set = parseBlacklist("Foo\n  bar \n\nBAZ");
    expect([...set].sort()).toEqual(["bar", "baz", "foo"]);
  });
});

describe("parseTitleBlacklist", () => {
  test("newline-separated keyword array, lower-cased, trimmed, empties dropped", () => {
    expect(parseTitleBlacklist("代Po\n  廣告 \n\n閒聊")).toEqual([
      "代po",
      "廣告",
      "閒聊"
    ]);
  });
  test("empty input → []", () => {
    expect(parseTitleBlacklist("")).toEqual([]);
    expect(parseTitleBlacklist(null)).toEqual([]);
  });
});

describe("matchTitleBlacklist", () => {
  test("substring contains → 回傳命中的關鍵字（truthy）；未命中 → null", () => {
    const kws = parseTitleBlacklist("代po\n廣告");
    expect(matchTitleBlacklist("r: [閒聊] 代po 一篇文章", kws)).toBe("代po");
    expect(matchTitleBlacklist("q: 廣告 代po 都有", kws)).toBe("代po"); // 第一個命中者
    expect(matchTitleBlacklist("□ [情報] 純情報", kws)).toBeNull();
  });
  test("empty keyword list / empty title → null", () => {
    expect(matchTitleBlacklist("任何標題", [])).toBeNull();
    expect(matchTitleBlacklist("", ["代po"])).toBeNull();
  });
});

describe("annotateComment", () => {
  const baseCtx = () => ({
    blacklist: new Set(),
    showFloorNumbers: true,
    floorCounter: new FloorCounter(),
    highlightAuthor: true,
    articleAuthor: "wowbenny"
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

  // 高亮已經不在 annotation 裡（見下一個 describe 與 render/screen.js）。
  test("annotateComment 不再產出 pusherHighlight", () => {
    const ctx = baseCtx();
    expect(annotateComment(ts("推 alice: 1"), ctx)).not.toHaveProperty(
      "pusherHighlight",
    );
  });
});

// 推文者高亮的**唯一述詞**。2026-08 從 annotateComment 搬出來：寫進 annotation
// 等於讓一個純互動狀態進 annotationsKey，點一下推文列就會炸掉整份增量快取並重建
// 每一列節點（症狀：合併推文空白區閃爍、雙擊選字時好時壞）。現在由
// ScreenController 在 build 時現算、切換時逐列搬 class。
// 規則與改版前的 annotateComment 逐字等價：黑名單列不 tint。
describe("isPusherHighlighted", () => {
  const ann = (o) => ({ pusher: "alice", hidden: false, ...o });

  test("選中的人 true；別人／沒選 false", () => {
    expect(isPusherHighlighted(ann(), "alice")).toBe(true);
    expect(isPusherHighlighted(ann(), "bob")).toBe(false);
    expect(isPusherHighlighted(ann(), null)).toBe(false);
  });

  test("黑名單列即使同 id 也不 tint", () => {
    expect(isPusherHighlighted(ann({ hidden: true }), "alice")).toBe(false);
  });

  test("非推文列（null／無 pusher）→ false", () => {
    expect(isPusherHighlighted(null, "alice")).toBe(false);
    expect(isPusherHighlighted({ floor: 1 }, "alice")).toBe(false);
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
  "C_Chat_M.1780734381.txt", // #1g8zcjhj 假推文帶假時間戳 (BePTT meta-latch 規則)
  "IpComment_M.1621089154.txt", // 官方 fixture：BRD_IPLOGRECMD 看板 IP 行
  "Forward_M.1644506392.txt" // 官方 fixture：FORWARD 轉錄行不計樓
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

// REGRESSION: official cross-validation against Ptt-official-app's real-PTT testcases
// (go-pttbbs comment format + go-bbs parse rules). The fixtures IpComment_M.1621089154 /
// Forward_M.1644506392 carry the two row shapes our own saved articles never had: an
// IP-logging board (BRD_IPLOGRECMD) and 轉錄 (FORWARD) lines. See comment_parse.js's
// "Official cross-validation" note for the byte/format spec these guard.
describe("official cross-validation (Ptt-official-app fixtures)", () => {
  test("IP-bearing comment (BRD_IPLOGRECMD): IP not eaten into userid", () => {
    expect(
      parseComment("推 ericf129: 辛苦了 ><                 1.200.29.12 05/16 22:57")
    ).toEqual({ type: "推", userid: "ericf129", contentCol: 13 });
    expect(
      parseComment("推 Japan2001: 謝謝活動部             180.214.183.155 05/18 18:57")
    ).toEqual({ type: "推", userid: "japan2001", contentCol: 14 });
  });

  test("FORWARD (轉錄) line → null, takes no floor (mirrors BePTT terminal numbering)", () => {
    expect(
      parseComment("※ PttACT:轉錄至看板 OriginalSong                01/26 17:19")
    ).toBeNull();
    expect(
      parseComment("※ jasome:轉錄至某隱形看板                       01/29 02:39")
    ).toBeNull();
  });

  test("轉錄 after the meta-latch does NOT reset numbering between real comments", () => {
    // The raw fixture has no 發信站/文章網址 lines; this covers the real-article case
    // where a 轉錄 row sits between two real comments past the latch (post-latch
    // non-comment rows must be no-ops, so bob stays floor 2).
    const ctx = { showFloorNumbers: true, floorCounter: new FloorCounter() };
    annotateComment("※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4 (臺灣)", ctx);
    annotateComment("※ 文章網址: https://www.ptt.cc/...", ctx);
    expect(annotateComment(ts("推 alice: 1"), ctx).floor.seq).toBe(1);
    annotateComment("※ PttACT:轉錄至看板 OriginalSong                01/26 17:19", ctx);
    expect(annotateComment(ts("推 bob: 2"), ctx).floor.seq).toBe(2);
  });

  // BORROWED from go-bbs/user_comment_record.go regex `[a-zA-Z][a-zA-Z0-9]+`: a userid
  // must start with a letter and be ≥2 chars (the PTT account rule). A leading-digit or
  // single-char "id" is body text, not a comment — even with a real-looking timestamp.
  test("userid must start with a letter, ≥2 chars (official id pattern)", () => {
    expect(parseComment(ts("推 1: x"))).toBeNull();
    expect(parseComment(ts("推 a: x"))).toBeNull();
    expect(parseComment(ts("推 a1: x"))).toEqual({
      type: "推",
      userid: "a1",
      contentCol: 7
    });
  });
});

// 滑鼠防誤觸模式用它把「型別符＋id＋冒號」排除在可點區之外，好把 cols 0-6 還給
// 文章左側的退出提示帶（docs/mouse.md）。算錯就是「點內容沒反應」或「左側點不到」。
describe("contentCol（推文內容起始欄）", () => {
  test("與 comment_merge.commentContentCells 的 start 同語意", () => {
    // "推 aaa: " ＝ 2(型別符) + 1(空格) + 3(id) + 1(':') + 1(空格) = 8
    expect(parseComment(ts("推 aaa: xxx")).contentCol).toBe(8);
  });

  test("冒號後沒有空白時只跳冒號那一格", () => {
    expect(parseComment(ts("推 abc:hi")).contentCol).toBe(7);
  });

  test("BRD_ALIGNEDCMT 的補空格算在左側（不可點）那一邊", () => {
    expect(parseComment(ts("推 abc   : hi")).contentCol).toBe(11);
  });

  test("annotateComment 把它帶出去給 Row 的 data-pusher-col", () => {
    const ctx = { showFloorNumbers: false, floorCounter: null };
    expect(annotateComment(ts("推 abc: hi"), ctx).contentCol).toBe(8);
    // 黑名單列也照樣有——它只是 visibility:hidden，仍在 DOM 裡。
    const bl = { ...ctx, blacklist: new Set(["abc"]) };
    const r = annotateComment(ts("推 abc: hi"), bl);
    expect(r.hidden).toBe(true);
    expect(r.contentCol).toBe(8);
  });

  test("非推文列沒有 annotation，自然也沒有 contentCol", () => {
    const ctx = { showFloorNumbers: false, floorCounter: null };
    expect(annotateComment("這是內文，不是推文", ctx)).toBeNull();
  });
});

// [ ]（跳同標題上/下一篇）疊加回歸：leaveCurrentPost 的一次性 prevPageState=0 旗標
// 被舊文章殘幀消費後，新文章第一頁走「續接」分支 → 兩篇串在同一長頁。
// decideAccumulateBranch 是 accumulatePageLines 的分支決策純函式：
// sticky pendingReset 只在「確認文章第一頁」時消費，另有身分自癒。
describe("decideAccumulateBranch", () => {
  const d = decideAccumulateBranch;
  test("race 自癒：旗標已被舊幀吃掉，新文章第一頁（statusStart=1、零重疊、header 變了）→ rebuild", () => {
    expect(
      d({ prevPageState: 3, pendingReset: false, statusStart: 1, kContent: 0, hasAcc: true, headerChanged: true })
    ).toBe("rebuild");
  });
  test("同篇第一頁半畫幀（零重疊但 header 未變）→ append（不得誤重建——stock-end 離線回歸）", () => {
    expect(
      d({ prevPageState: 3, pendingReset: false, statusStart: 1, kContent: 0, hasAcc: true, headerChanged: false })
    ).toBe("append");
  });
  test("sticky 正常路徑：pendingReset 在舊文章中段幀不消費（append），到第一頁才 rebuild", () => {
    expect(
      d({ prevPageState: 3, pendingReset: true, statusStart: 57, kContent: 5, hasAcc: true })
    ).toBe("append");
    expect(
      d({ prevPageState: 3, pendingReset: true, statusStart: 1, kContent: 0, hasAcc: true, headerChanged: true })
    ).toBe("rebuild");
  });
  test("同篇強制重繪（第一頁、內容全重疊）→ append（no-op dedup 不變）", () => {
    expect(
      d({ prevPageState: 3, pendingReset: false, statusStart: 1, kContent: 22, hasAcc: true })
    ).toBe("append");
  });
  test("functionMode resume（中段頁、有重疊）→ append", () => {
    expect(
      d({ prevPageState: 3, pendingReset: false, statusStart: 34, kContent: 8, hasAcc: true })
    ).toBe("append");
  });
  test("transient 無狀態列：prevPageState=3 → skip；否則 rebuild", () => {
    expect(
      d({ prevPageState: 3, pendingReset: false, statusStart: null, kContent: 0, hasAcc: true })
    ).toBe("skip");
    expect(
      d({ prevPageState: 0, pendingReset: true, statusStart: null, kContent: 0, hasAcc: false })
    ).toBe("rebuild");
  });
  test("list→article 既有路徑（prevPageState!=3）→ rebuild", () => {
    expect(
      d({ prevPageState: 0, pendingReset: false, statusStart: 1, kContent: 0, hasAcc: false })
    ).toBe("rebuild");
  });
  test("正常翻頁（statusStart>1、零重疊也一樣）→ append", () => {
    expect(
      d({ prevPageState: 3, pendingReset: false, statusStart: 24, kContent: 0, hasAcc: true })
    ).toBe("append");
  });
  test("acc 空時第一頁零重疊（headerChanged 恆 false——無舊 header 可比）→ append（concat 到空陣列等價重建）", () => {
    expect(
      d({ prevPageState: 3, pendingReset: false, statusStart: 1, kContent: 0, hasAcc: false, headerChanged: false })
    ).toBe("append");
  });

  // P6（pttbbs-screen-protocol §13）：pfterm 每次回應結尾才把游標 park 到
  // (rows-1, cols-1)，且 footer 是 per-cell patch ⇒ 半畫幀的狀態列還是**上一頁的舊值**。
  // 拿舊 footer 去算重疊 → _accEndRow 漂移 → 之後整條去重都建在錯的基準上。
  // 所以「本幀不是完整回應」必須 skip，不管其他輸入長什麼樣。
  test("半畫幀（complete=false）→ skip，即使其他輸入看起來像正常翻頁", () => {
    expect(
      d({ complete: false, prevPageState: 3, pendingReset: false, statusStart: 24, kContent: 1, hasAcc: true })
    ).toBe("skip");
  });
  test("半畫幀（complete=false）＋看似新文章第一頁 → 仍 skip（不得誤重建）", () => {
    expect(
      d({ complete: false, prevPageState: 3, pendingReset: true, statusStart: 1, kContent: 0, hasAcc: true, headerChanged: true })
    ).toBe("skip");
  });
  test("complete=true 時行為與舊版一致", () => {
    expect(
      d({ complete: true, prevPageState: 3, pendingReset: false, statusStart: 24, kContent: 1, hasAcc: true })
    ).toBe("append");
  });

  // P1：掉頁（新頁 S' > 上一頁 E + 1）不得默默 append 出一個破洞。
  test("掉頁（transition='gap'）→ 'gap' 分支，不 append", () => {
    expect(
      d({ complete: true, prevPageState: 3, pendingReset: false, statusStart: 66, kContent: 0, hasAcc: true, transition: "gap" })
    ).toBe("gap");
  });
  test("掉頁但同時是文章第一頁（restart 優先，重新累積本來就對）", () => {
    expect(
      d({ complete: true, prevPageState: 3, pendingReset: true, statusStart: 1, kContent: 0, hasAcc: true, headerChanged: true, transition: "restart" })
    ).toBe("rebuild");
  });

  // healInFlight：好讀正在用 pmore 的 goto-line（送 `:N\r`）補讀被吞掉的那一頁。
  // 期間底部是「跳至第幾行:」prompt，狀態列失配 ⇒ 那一幀的 pageState 可能不是 3，而
  // term_view.redraw **每個渲染幀結尾都寫 buf.prevPageState = buf.pageState** ⇒ 落地幀
  // 會命中 `prevPageState !== 3 → rebuild`，**從文章中段重建 pageLines、把上面累積的
  // 全部靜默刪掉**——比它要修的掉頁還糟。所以 heal 在途時兩條 rebuild 路徑都要封住。
  test("heal 在途：prevPageState 被 prompt 幀污染成 0 → 仍 append（不得從中段重建）", () => {
    expect(
      d({ complete: true, healInFlight: true, prevPageState: 0, pendingReset: false, statusStart: 44, kContent: 1, hasAcc: true, transition: "continuation" })
    ).toBe("append");
  });
  test("heal 在途：落在第一頁 + pendingReset 也不 rebuild", () => {
    expect(
      d({ complete: true, healInFlight: true, prevPageState: 3, pendingReset: true, statusStart: 1, kContent: 0, hasAcc: true, headerChanged: true, transition: "restart" })
    ).toBe("append");
  });
  test("heal 在途：仍偵測得到掉頁（升級路徑不得被封死）", () => {
    expect(
      d({ complete: true, healInFlight: true, prevPageState: 3, pendingReset: false, statusStart: 66, kContent: 0, hasAcc: true, transition: "gap" })
    ).toBe("gap");
  });
  test("heal 在途：半畫幀照樣 skip（P6 優先於一切）", () => {
    expect(
      d({ complete: false, healInFlight: true, prevPageState: 0, pendingReset: false, statusStart: 44, kContent: 1, hasAcc: true })
    ).toBe("skip");
  });
});

// P1（docs/pttbbs-screen-protocol.md §13）：pmore 的 PageDown 是
// mf_forward(mf.dispedlines - 1)（pmore.c#PMORE_UINAV_FORWARDPAGE），所以下一頁的
// 起始行號恰等於上一頁的結束行號；末頁被 mf_determinemaxdisps 的 maxdisps 夾住時
// 只會更小。**S' > E 在單次 PageDown 下不可能發生** —— 觀察到就代表中間整頁被
// typeahead 跳繪吞掉（P4），內容永久掉了。
describe("classifyPageTransition（pmore 分頁不變量 P1）", () => {
  const c = classifyPageTransition;
  test("正常翻頁：S' == E → continuation", () => {
    expect(c({ accEndRow: 44, statusStart: 44, statusEnd: 66 })).toBe("continuation");
  });
  test("末頁被 maxdisps 夾住：S' < E → continuation（重疊變大而已）", () => {
    expect(c({ accEndRow: 88, statusStart: 78, statusEnd: 100 })).toBe("continuation");
  });
  test("零重疊邊界 S' == E+1（dispedlines==1）→ 仍算 continuation", () => {
    expect(c({ accEndRow: 44, statusStart: 45, statusEnd: 67 })).toBe("continuation");
  });
  test("掉頁：S' > E+1 → gap", () => {
    expect(c({ accEndRow: 44, statusStart: 66, statusEnd: 88 })).toBe("gap");
  });
  test("往回（PgUp / 指定行）：E' < accEndRow → backward", () => {
    expect(c({ accEndRow: 88, statusStart: 22, statusEnd: 44 })).toBe("backward");
  });
  test("文章第一頁 / 尚無追蹤基準 → restart", () => {
    expect(c({ accEndRow: 88, statusStart: 1, statusEnd: 23 })).toBe("restart");
    expect(c({ accEndRow: null, statusStart: 44, statusEnd: 66 })).toBe("restart");
  });
  test("statusStart 為 null（transient 幀）→ null（呼叫端另行處理）", () => {
    expect(c({ accEndRow: 44, statusStart: null, statusEnd: null })).toBeNull();
  });
});
