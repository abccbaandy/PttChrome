// Unit tests for detectBareDomains (src/js/bare_domain.js): auto-linking a bare
// domain written WITHOUT a scheme and WITHOUT a path — "indiegametw.com" — which
// both TermBuf.uriRegEx (needs a scheme) and detectFixableUrls (skips bare-domain
// mentions) deliberately ignore.
//
// Fake TermChar cells only need `ch`, `isLeadByte` and `isPartOfURL` (the parser
// walks columns, never the DBCS tables) — same convention as mention_parse.test.js.

import { detectBareDomains } from "../../src/js/bare_domain";

const cell = (ch, isLeadByte = false, url = false) => ({
  ch,
  isLeadByte,
  isPartOfURL: () => url
});
// ASCII string → one single-byte cell per char.
const ascii = (str, url = false) => str.split("").map(c => cell(c, false, url));
// A Big5 DBCS character → [lead, trail] pair (isLeadByte on the first).
const dbcs = (lead, trail) => [cell(lead, true), cell(trail, false)];
// n generic Chinese chars = 2n columns. 0xa4 0xa4 is 「中」.
const cjk = n => {
  const out = [];
  for (let i = 0; i < n; ++i) out.push(...dbcs("\xa4", "\xa4"));
  return out;
};
// Big5 full-width parens: （ = a1 5d, ） = a1 5e.
const fwOpen = () => dbcs("\xa1", "\x5d");
const fwClose = () => dbcs("\xa1", "\x5e");

const hosts = row => detectBareDomains(row, "").map(d => d.host);
const hrefs = row => detectBareDomains(row, "").map(d => d.href);

describe("detectBareDomains — 使用者回報的兩個案例", () => {
  test("中文句尾的裸網域 indiegametw.com → 可連結", () => {
    // 9 個中文字 = cols 0..17, 空白 col 18, host cols 19..33 (15 chars)
    const row = [...cjk(9), ...ascii(" indiegametw.com")];
    expect(detectBareDomains(row, "")).toEqual([
      {
        startCol: 19,
        endCol: 34,
        host: "indiegametw.com",
        href: "https://indiegametw.com",
        gray: true
      }
    ]);
  });

  test("獨立成行的三段裸網域 eaigc.filtergame.com → 可連結且非灰色地帶", () => {
    expect(detectBareDomains(ascii("eaigc.filtergame.com"), "")).toEqual([
      {
        startCol: 0,
        endCol: 20,
        host: "eaigc.filtergame.com",
        href: "https://eaigc.filtergame.com",
        gray: false // 3 段子網域 → 規則有信心，不必送 AI
      }
    ]);
  });
});

describe("detectBareDomains — mention 守則（不可誤連）", () => {
  test("※ 發信站 系統行整列跳過", () => {
    const text = "※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4";
    // 就算 cells 掃得到 ptt.cc，系統行判斷也要先擋下整列。
    const row = ascii("x ptt.cc x");
    expect(detectBareDomains(row, text)).toEqual([]);
  });

  test("※ 文章網址 / ※ 編輯 / ◆ From: 也是系統行", () => {
    const row = ascii("example.com");
    for (const t of [
      "※ 文章網址: https://www.ptt.cc/bbs/Stock/M.123.html",
      "※ 編輯: someone (1.2.3.4 臺灣)",
      "◆ From: 1.2.3.4"
    ]) {
      expect(detectBareDomains(row, t)).toEqual([]);
    }
  });

  test("半形括號包住的網域＝文中提及，不連", () => {
    expect(hosts(ascii("看這個(example.com)介紹"))).toEqual([]);
  });

  test("全形括號包住的網域＝文中提及，不連", () => {
    const row = [...cjk(2), ...fwOpen(), ...ascii("example.com"), ...fwClose()];
    expect(hosts(row)).toEqual([]);
  });

  test("只有單邊括號不算包覆（正常連結）", () => {
    expect(hosts(ascii("(example.com 這個"))).toEqual(["example.com"]);
  });

  test("PTT 系統網域黑名單", () => {
    expect(hosts(ascii("我常逛 ptt.cc 這站"))).toEqual([]);
    expect(hosts(ascii("ptt2.cc"))).toEqual([]);
    expect(hosts(ascii("www.ptt.cc"))).toEqual([]);
  });

  test("email 的網域部分不連（前一格是 @）", () => {
    expect(hosts(ascii("寄到 abc@example.com 給我"))).toEqual([]);
  });

  test("@ 結尾的 local part 也不連", () => {
    expect(hosts(ascii("example.com@host"))).toEqual([]);
  });
});

describe("detectBareDomains — Big5 DBCS 安全性", () => {
  test("中文字的 trail byte 不可與後方 .com 湊成假 label", () => {
    // trail byte 0x61 = 'a'：用字串掃描會得到假的 "a.com"。
    const row = [...dbcs("\xa4", "\x61"), ...ascii(".com")];
    expect(detectBareDomains(row, "")).toEqual([]);
  });

  test("中文字緊接真網域時 startCol 仍是 ASCII 起點", () => {
    // 3 個中文 = cols 0..5，host 自 col 6 起
    const row = [...cjk(3), ...ascii("example.com")];
    expect(detectBareDomains(row, "")).toEqual([
      {
        startCol: 6,
        endCol: 17,
        host: "example.com",
        href: "https://example.com",
        gray: true
      }
    ]);
  });
});

describe("detectBareDomains — 與既有偵測的重疊排除", () => {
  test("已被 uriRegEx 標記的 URL 內不再產生候選", () => {
    // 整列 cells 的 isPartOfURL() 為 true（term_buf 已標好）
    expect(hosts(ascii("https://foo.com/bar", true))).toEqual([]);
  });

  test("host 後面緊接 / 的深連結留給 url_fix 處理", () => {
    expect(hosts(ascii("參考 example.com/img.jpg 這個"))).toEqual([]);
  });
});

describe("detectBareDomains — false-positive 守則", () => {
  test("版本號不是網域", () => {
    expect(hosts(ascii("版本 3.5 比 2.1 好"))).toEqual([]);
  });

  test("非白名單 TLD 跳過", () => {
    expect(hosts(ascii("看看 foo.zzunderined 這個"))).toEqual([]);
  });

  test("TLD 必須是完整 label，不做前綴匹配", () => {
    expect(hosts(ascii("example.commit"))).toEqual([]);
    expect(hosts(ascii("main.jsx"))).toEqual([]);
  });

  test("IPv4 不是網域（最後一段非 TLD）", () => {
    expect(hosts(ascii("來自: 1.2.3.4"))).toEqual([]);
  });

  test("單一 label（無點）不是網域", () => {
    expect(hosts(ascii("他在 www 上面找不到"))).toEqual([]);
    expect(hosts(ascii("com"))).toEqual([]);
  });

  test("前導點 / 空 label 拒絕", () => {
    expect(hosts(ascii(".com"))).toEqual([]);
    expect(hosts(ascii("a..com"))).toEqual([]);
  });

  test("label 頭尾的連字號拒絕（DNS 規則）", () => {
    expect(hosts(ascii("-foo.com"))).toEqual([]);
    expect(hosts(ascii("foo-.com"))).toEqual([]);
  });

  test("句尾句號不併入 host", () => {
    expect(hosts(ascii("去 example.com."))).toEqual(["example.com"]);
  });

  test("大小寫不敏感，host 正規化為小寫", () => {
    expect(hrefs(ascii("Example.COM"))).toEqual(["https://example.com"]);
  });
});

describe("detectBareDomains — port 與多候選", () => {
  test("帶 port", () => {
    expect(detectBareDomains(ascii("example.com:8080"), "")).toEqual([
      {
        startCol: 0,
        endCol: 16,
        host: "example.com:8080",
        href: "https://example.com:8080",
        gray: true
      }
    ]);
  });

  test("冒號後不是數字則不併入", () => {
    expect(hosts(ascii("example.com: 說明"))).toEqual(["example.com"]);
  });

  test("同列多個候選的 col 各自正確", () => {
    // a.com 0..4, sp 5, b.tw 6..9
    expect(detectBareDomains(ascii("a.com b.tw"), "")).toEqual([
      {
        startCol: 0,
        endCol: 5,
        host: "a.com",
        href: "https://a.com",
        gray: true
      },
      {
        startCol: 6,
        endCol: 10,
        host: "b.tw",
        href: "https://b.tw",
        gray: true
      }
    ]);
  });

  test("www. 前綴視為強訊號（非灰色地帶）", () => {
    expect(detectBareDomains(ascii("www.example.com"), "")[0].gray).toBe(false);
  });
});

describe("detectBareDomains — 邊界輸入", () => {
  test("null / 空列", () => {
    expect(detectBareDomains(null, "")).toEqual([]);
    expect(detectBareDomains([], "")).toEqual([]);
  });

  test("cells 缺 isPartOfURL 方法時不炸（防禦）", () => {
    const row = "a.com".split("").map(ch => ({ ch, isLeadByte: false }));
    expect(detectBareDomains(row, "")).toEqual([
      {
        startCol: 0,
        endCol: 5,
        host: "a.com",
        href: "https://a.com",
        gray: true
      }
    ]);
  });

  test("列中有 null cell 不炸", () => {
    const row = [...ascii("a.com"), null, ...ascii("b.tw")];
    expect(hosts(row)).toEqual(["a.com", "b.tw"]);
  });
});
