// Unit tests for detectAids (src/js/aid_parse.js): finding PTT article-code
// (AID) candidates like "#1gIeu-3A" in a screen row, with an optional board
// suffix "(Android)" / "@Android". Fake TermChar cells only need `ch` and
// `isLeadByte` (the parser walks columns, never the DBCS tables).

import { detectAids } from "../../src/js/aid_parse";

const cell = (ch, isLeadByte = false) => ({ ch, isLeadByte });
const ascii = str => str.split("").map(c => cell(c));
const dbcs = (lead, trail) => [cell(lead, true), cell(trail, false)];

describe("detectAids", () => {
  test("official AID line: 文章代碼(AID): #1gIeu-3A (Android)", () => {
    // The DBCS "文章代碼" part is 8 cols; build "(AID): #1gIeu-3A (Android)"
    const row = [
      ...dbcs("\xa4", "\xe5"), // 文
      ...dbcs("\xb3", "\xb9"), // 章
      ...dbcs("\xa5", "\x4e"), // 代
      ...dbcs("\xbd", "\x58"), // 碼
      ...ascii("(AID): #1gIeu-3A (Android) [ptt.cc]")
    ];
    // '#' is at col 8+7=15, aid spans [15,24)
    expect(detectAids(row)).toEqual([
      { startCol: 15, endCol: 24, aid: "1gIeu-3A", board: "Android" }
    ]);
  });

  test("bare #AID at line start, no board", () => {
    expect(detectAids(ascii("#1gIeu-3A ok"))).toEqual([
      { startCol: 0, endCol: 9, aid: "1gIeu-3A", board: null }
    ]);
  });

  test("@Board suffix (no space)", () => {
    expect(detectAids(ascii("see #1gIeu-3A@Gossiping !"))).toEqual([
      { startCol: 4, endCol: 13, aid: "1gIeu-3A", board: "Gossiping" }
    ]);
  });

  test("(Board) suffix separated by one space", () => {
    expect(detectAids(ascii("#1gIeu-3A (C_Chat)"))).toEqual([
      { startCol: 0, endCol: 9, aid: "1gIeu-3A", board: "C_Chat" }
    ]);
  });

  test("7-char and 9-char tokens rejected", () => {
    expect(detectAids(ascii("#1gIeu-3 end"))).toEqual([]);
    expect(detectAids(ascii("#1gIeu-3Ab end"))).toEqual([]);
  });

  test("prefix char before # rejects (a#..., ##...)", () => {
    expect(detectAids(ascii("a#1gIeu-3A"))).toEqual([]);
    expect(detectAids(ascii("##1gIeu-3A"))).toEqual([]);
  });

  test("# right after a DBCS char is a legal prefix", () => {
    const row = [...dbcs("\xa4", "\xa4"), ...ascii("#1gIeu-3A")];
    expect(detectAids(row)).toEqual([
      { startCol: 2, endCol: 11, aid: "1gIeu-3A", board: null }
    ]);
  });

  test("Big5 trail byte '#' (0x23 can't be trail, but lead pair skipped) — DBCS pair never yields AID", () => {
    // trail byte 0x40 pair immediately followed by 8 aid chars must not match
    const row = [...dbcs("\xa4", "\x23"), ...ascii("1gIeu-3A")];
    expect(detectAids(row)).toEqual([]);
  });

  test("aid ended by DBCS char right after 8 chars is accepted", () => {
    const row = [...ascii("#1gIeu-3A"), ...dbcs("\xaa", "\xba")];
    expect(detectAids(row)).toEqual([
      { startCol: 0, endCol: 9, aid: "1gIeu-3A", board: null }
    ]);
  });

  test("all-digit 8-char AID accepted (legal base64 value)", () => {
    expect(detectAids(ascii("#12345678 x"))).toEqual([
      { startCol: 0, endCol: 9, aid: "12345678", board: null }
    ]);
  });

  test("underscore and dash inside AID accepted", () => {
    expect(detectAids(ascii("#1a-B_c2Z"))).toEqual([
      { startCol: 0, endCol: 9, aid: "1a-B_c2Z", board: null }
    ]);
  });

  test("truncated at end of line (fewer than 8 chars) rejected", () => {
    expect(detectAids(ascii("#1gIeu"))).toEqual([]);
  });

  test("exactly 8 chars ending at end of line accepted", () => {
    expect(detectAids(ascii("#1gIeu-3A"))).toEqual([]
      .concat([{ startCol: 0, endCol: 9, aid: "1gIeu-3A", board: null }]));
  });

  test("board name shorter than 2 chars is not captured", () => {
    expect(detectAids(ascii("#1gIeu-3A (a)"))).toEqual([
      { startCol: 0, endCol: 9, aid: "1gIeu-3A", board: null }
    ]);
  });

  test("unclosed parenthesis board is not captured", () => {
    expect(detectAids(ascii("#1gIeu-3A (Android"))).toEqual([
      { startCol: 0, endCol: 9, aid: "1gIeu-3A", board: null }
    ]);
  });

  test("multiple AIDs on one row keep correct columns", () => {
    // #0..8 sp9 #10..18
    expect(detectAids(ascii("#1gIeu-3A #2AbCdEf0"))).toEqual([
      { startCol: 0, endCol: 9, aid: "1gIeu-3A", board: null },
      { startCol: 10, endCol: 19, aid: "2AbCdEf0", board: null }
    ]);
  });

  // 轉錄 header：看板在 AID 前面，靠 rowText（Unicode）比對前綴。
  describe("cross-post header board prefix (rowText)", () => {
    // ※ [本文轉錄自 C_Chat 看板 #1gIx63RL ] — DBCS 部分用假 lead/trail cells，
    // 欄位只要對得上 '#' 的位置即可（bytes 內容不影響 detectAids）。
    const crossPostRow = [
      ...dbcs("\xa1", "\xb0"), // ※
      ...ascii(" ["),
      ...dbcs("\xa5", "\xbb"), // 本
      ...dbcs("\xa4", "\xe5"), // 文
      ...dbcs("\xc2", "\xe0"), // 轉
      ...dbcs("\xbf", "\xfd"), // 錄
      ...dbcs("\xa6", "\xdb"), // 自
      ...ascii(" C_Chat "),
      ...dbcs("\xac", "\xdd"), // 看
      ...dbcs("\xaa", "\xa9"), // 板
      ...ascii(" #1gIx63RL ]")
    ];
    const crossPostText = "※ [本文轉錄自 C_Chat 看板 #1gIx63RL ]";

    test("board taken from 本文轉錄自 prefix", () => {
      // '#' col = 2+2+10+8+4+1 = 27
      expect(detectAids(crossPostRow, crossPostText)).toEqual([
        { startCol: 27, endCol: 36, aid: "1gIx63RL", board: "C_Chat" }
      ]);
    });

    test("without rowText behaviour unchanged (board null)", () => {
      expect(detectAids(crossPostRow)).toEqual([
        { startCol: 27, endCol: 36, aid: "1gIx63RL", board: null }
      ]);
    });

    test("suffix board wins over prefix", () => {
      expect(
        detectAids(
          ascii("#1gIeu-3A (Android)"),
          "本文轉錄自 C_Chat 看板 #1gIeu-3A (Android)"
        )
      ).toEqual([
        { startCol: 0, endCol: 9, aid: "1gIeu-3A", board: "Android" }
      ]);
    });

    test("rowText without the prefix leaves board null", () => {
      expect(detectAids(ascii("#1gIeu-3A ok"), "#1gIeu-3A ok")).toEqual([
        { startCol: 0, endCol: 9, aid: "1gIeu-3A", board: null }
      ]);
    });
  });

  test("empty / null input", () => {
    expect(detectAids(null)).toEqual([]);
    expect(detectAids([])).toEqual([]);
  });
});
