// Unit tests for detectAids (src/js/aid_parse.js): finding PTT article-code
// (AID) candidates like "#1gIeu-3A" in a screen row, with an optional board
// suffix "(Android)" / "@Android". Fake TermChar cells only need `ch` and
// `isLeadByte` (the parser walks columns, never the DBCS tables).

import {
  detectAids,
  parsePostInfoAid,
  parseArticleUrlLine,
  parsePostInfoUrl
} from "../../src/js/aid_parse";

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

  // ---- 看板後綴跨推文（合併塊的 '\n' cell）----
  // 使用者 2026-08-27 回報的現場（ask 板 M.1787109393，錄製擋
  // tests/e2e/cassettes/ask-aid-wrap.json）：AID 打在一則推文的結尾、看板打在
  // 下一則的開頭。少了跨換行 board 會是 null ⇒ 退回目前看板 ⇒ 跳轉必失敗。
  describe("board suffix across a merged-comment newline", () => {
    test("#AID \\n (Board) → 認得看板，欄位範圍不變", () => {
      expect(detectAids(ascii("有興趣可到 #1gU3wwNZ\n(Browsers) 體驗"))).toEqual([
        { startCol: 6, endCol: 15, aid: "1gU3wwNZ", board: "Browsers" }
      ]);
    });

    test("#AID \\n @Board 也認得", () => {
      expect(detectAids(ascii("x #1gU3wwNZ\n@Browsers"))).toEqual([
        { startCol: 2, endCol: 11, aid: "1gU3wwNZ", board: "Browsers" }
      ]);
    });

    test("換行前後各允許一個空白", () => {
      expect(detectAids(ascii("x #1gU3wwNZ \n (Browsers)"))[0].board).toBe(
        "Browsers"
      );
    });

    test("最多跨一個換行：連兩個 '\\n' 不再往下找", () => {
      expect(detectAids(ascii("x #1gU3wwNZ\n\n(Browsers)"))[0].board).toBeNull();
    });

    test("換行後不是看板 token（中文）→ board 仍為 null", () => {
      const row = [
        ...ascii("#1gU3wwNZ\n("),
        ...dbcs("\xbb", "\xa1"), // 說
        ...ascii(")")
      ];
      expect(detectAids(row)[0].board).toBeNull();
    });

    test("換行後只有 1 字的 token 不算看板", () => {
      expect(detectAids(ascii("#1gU3wwNZ\n(a) x"))[0].board).toBeNull();
    });

    test("換行後括號沒閉合 → board 仍為 null", () => {
      expect(detectAids(ascii("#1gU3wwNZ\n(Browsers 體驗"))[0].board).toBeNull();
    });
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

  // -------------------------------------------------------------------------
  // 網址的 fragment 與 AIDc 同形（使用者 2026-08 回報）：
  //   https://abccbaandy.github.io/PttChrome/#Browsers/1gU3wwNZ
  // '#' 前一格是 '/'（非 AID 字元）、"Browsers" 恰好 8 個合法 AIDc 字元、第 9 格
  // 又是 '/' ⇒ 結構判準完全命中。被當成 AID 的後果是 LinkSegmentBuilder 在那裡切開
  // segment：URL 的 <a> 只到 '#'，中段變成 href="#" 的 aidLink，尾段連底線都沒有。
  // TermBuf.uriRegEx 早就把整段標成 URL 了，所以判準是「這幾格已經是 URL 的一部分」。
  // -------------------------------------------------------------------------
  describe("已被 uriRegEx 標記的 URL 內不產生候選", () => {
    // 真 TermChar 有 isPartOfURL()；假 cell 加上它才能重現這個情境。
    const urlAscii = str => str.split("").map(c => ({ ...cell(c), isPartOfURL: () => true }));

    test("網址 fragment #Browsers 不是 AID", () => {
      expect(
        detectAids(urlAscii("https://abccbaandy.github.io/PttChrome/#Browsers/1gU3wwNZ"))
      ).toEqual([]);
    });

    test("URL 內的 #AID 形狀（含 - _）一樣不算", () => {
      expect(detectAids(urlAscii("http://a.com/x#1gIeu-3A"))).toEqual([]);
    });

    test("同一列只有部分格在 URL 內：URL 外的 #AID 仍要偵測到", () => {
      // "see #1gIeu-3A " 為一般文字，其後才是被標記的網址。
      const row = [
        ...ascii("see #1gIeu-3A "),
        ...urlAscii("http://a.com/x#1gU3wwNZ")
      ];
      expect(detectAids(row)).toEqual([
        { startCol: 4, endCol: 13, aid: "1gIeu-3A", board: null }
      ]);
    });

    test("假 cell 沒有 isPartOfURL（既有測試的形狀）→ 行為不變", () => {
      expect(detectAids(ascii("see #1gIeu-3A ok"))).toEqual([
        { startCol: 4, endCol: 13, aid: "1gIeu-3A", board: null }
      ]);
    });
  });

  test("empty / null input", () => {
    expect(detectAids(null)).toEqual([]);
    expect(detectAids([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parsePostInfoAid：讀「Q 文章資訊框」那一列，拿到本篇文章自己的 AID。
// 定版來源 mbbsd/bbs.c#view_postinfo:3691-3705（AID_DISPLAYNAME 見
// include/common.h:154）。這是 AID 返回錨點的資料來源，不是畫面上的連結偵測，
// 所以吃的是解碼後的整列文字（同 parseCrossPostBoardPrefix）。
// ---------------------------------------------------------------------------
describe("parsePostInfoAid", () => {
  test("定版資訊框列：AID ＋ 括號板名", () => {
    expect(
      parsePostInfoAid(
        "│ 文章代碼(AID): #1gIeu-3A (movie) [ptt.cc] [好雷] 電影心得"
      )
    ).toEqual({ aid: "1gIeu-3A", board: "movie" });
  });

  test("currboard 為空時 pttbbs 印中文「不明」→ 板名解不到，AID 仍要拿到", () => {
    expect(parsePostInfoAid("│ 文章代碼(AID): #1gIeu-3A (不明) [ptt.cc]")).toEqual(
      { aid: "1gIeu-3A", board: null }
    );
  });

  test("本篇沒有合法 AID（bbs.c:3707 只印一根框線）→ null", () => {
    expect(parsePostInfoAid("│")).toBe(null);
  });

  test("文章內文出現的 #AID 不算資訊框（沒有「文章代碼(AID)」字面）", () => {
    expect(parsePostInfoAid("推 someuser: 參考 #1gIeu-3A (movie) 那篇")).toBe(
      null
    );
  });

  test("超過 8 碼的識別碼不是 AIDc", () => {
    expect(parsePostInfoAid("│ 文章代碼(AID): #1gIeu-3A9 (movie)")).toBe(null);
  });

  test("空 / null 輸入", () => {
    expect(parsePostInfoAid("")).toBe(null);
    expect(parsePostInfoAid(null)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 「本篇是哪一篇」的免費來源：畫面上的文章網址列。取得後可用 aid_codec 換算成
// AID，省掉按 Q（Q 會被 FULLUPDATE 抛回文章列表，得再花兩個指令回來）。
// ---------------------------------------------------------------------------
describe("parseArticleUrlLine", () => {
  test("文章本文末尾的 ※ 文章網址 → { board, aid }", () => {
    expect(
      parseArticleUrlLine(
        "※ 文章網址: https://www.ptt.cc/bbs/Browsers/M.1786265274.A.5E3.html"
      )
    ).toEqual({ board: "Browsers", aid: "1gU3wwNZ" });
  });

  test("前導空白可以有", () => {
    expect(
      parseArticleUrlLine(
        "  ※ 文章網址: https://www.ptt.cc/bbs/SYSOP/M.1786458180.A.4FE.html"
      )
    ).toEqual({ board: "SYSOP", aid: "1gUp14J-" });
  });

  // 回文的引言區塊會把原文那行原樣帶進來。不錨列首就會把「別人那篇」當成本篇，
  // 於是複製連結／返回錨點全部指向錯的文章。
  test("引言列 `: ※ 文章網址:` 不得命中", () => {
    expect(
      parseArticleUrlLine(
        ": ※ 文章網址: https://www.ptt.cc/bbs/Browsers/M.1786265274.A.5E3.html"
      )
    ).toBe(null);
    expect(
      parseArticleUrlLine(
        "> ※ 文章網址: https://www.ptt.cc/bbs/Browsers/M.1786265274.A.5E3.html"
      )
    ).toBe(null);
  });

  test("句子中間提到不算（必須整列就是那一行）", () => {
    expect(
      parseArticleUrlLine(
        "推 someuser: 我貼 ※ 文章網址: https://www.ptt.cc/bbs/A_Board/M.1.A.001.html"
      )
    ).toBe(null);
  });

  test("網址不是 ptt.cc 文章 → null", () => {
    expect(parseArticleUrlLine("※ 文章網址: https://example.com/x")).toBe(null);
  });

  test("空 / null 輸入", () => {
    expect(parseArticleUrlLine("")).toBe(null);
    expect(parseArticleUrlLine(null)).toBe(null);
  });
});

describe("parsePostInfoUrl", () => {
  test("Q 資訊框的網址列 → { board, aid }", () => {
    expect(
      parsePostInfoUrl(
        "│ 文章網址: https://www.ptt.cc/bbs/Browsers/M.1786265274.A.5E3.html"
      )
    ).toEqual({ board: "Browsers", aid: "1gU3wwNZ" });
  });

  // 資訊框在 currboard 為空時 AID 那列的板名會印「不明」，網址列卻仍是對的。
  test("補得回 parsePostInfoAid 拿不到的 board", () => {
    expect(parsePostInfoAid("│ 文章代碼(AID): #1gU3wwNZ (不明) [ptt.cc]")).toEqual(
      { aid: "1gU3wwNZ", board: null }
    );
    expect(
      parsePostInfoUrl(
        "│ 文章網址: https://www.ptt.cc/bbs/Browsers/M.1786265274.A.5E3.html"
      ).board
    ).toBe("Browsers");
  });

  test("pttbbs 的替代輸出（bbs.c:3709-3711）沒有網址 → null", () => {
    expect(parsePostInfoUrl("│ 本看板目前不提供文章網址 ")).toBe(null);
    expect(parsePostInfoUrl("│ 本文章不提供文章網址 ")).toBe(null);
  });

  test("本文的 ※ 那行不是資訊框的 │ 那行", () => {
    expect(
      parsePostInfoUrl(
        "※ 文章網址: https://www.ptt.cc/bbs/Browsers/M.1786265274.A.5E3.html"
      )
    ).toBe(null);
  });
});
