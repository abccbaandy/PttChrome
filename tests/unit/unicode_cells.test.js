// UTF-8 線路的內部格子編碼（src/js/unicode_cells.js）＋它在 string_util／TermBuf 上的接線。
//
// 鎖的行為（症狀層）：
//   1. Big5 收不下的字（韓文、簡體、ġ…）經 UTF-8 線路收進來，畫面文字是原字、
//      格數照 server 的 ucs_width ⇒ 後面的字、游標欄位不位移。
//   2. Big5 收得下的字與 Big5 線路逐位元組相同（25 個解析器不必分支）。
//   3. 打出去：Big5 收不下的字不再變 '?'，線路上是原字的 UTF-8；Big5 線路行為不變。
//   4. 「server 內部是 UTF-8」的閂：收到來回不一致的字才立；logind 探針、U+FFFD 不立。
//      立閂後 Big5 收得下但 ucs_width 1 的字（ｱ、✓）改成一格。
//   5. 欄號換算（textCellWidth／charCells）與格子一致。
import {
  WIDE_TRAIL,
  big5Of,
  cellPairs,
  codePointCells,
  serverIsUnicodeNative,
  setUnicodeCells,
} from "../../src/js/unicode_cells";
import {
  b2u,
  u2b,
  charCells,
  textCellWidth,
  isDBCSLead,
  isPttDrawable,
} from "../../src/js/string_util";
import { createUtf8Inbound } from "../../src/js/wire_charset";
import { rowToText } from "../../src/js/comment_parse";
import { nextSendState, VK_NORMAL, VK_ESC } from "../../src/js/vtkbd_send_state";
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { loadBig5Tables } from "./helpers/load_big5_tables";

const ESC = "\x1b";

function wire(text) {
  return String.fromCharCode(...new TextEncoder().encode(text));
}

function makeTerm() {
  const buf = new TermBuf(80, 24);
  buf.setView({
    update() {},
    updateCursorPos() {},
    refreshCursorVisibility() {},
    blinkOn: false,
    charset: "big5",
  });
  buf.useMouseBrowsing = false;
  const parser = new AnsiParser(buf);
  const inbound = createUtf8Inbound();
  const feed = (text) => {
    parser.feed(inbound.decode(wire(text)));
    buf.notify();
  };
  return { buf, feed };
}

beforeAll(() => {
  loadBig5Tables();
});

beforeEach(() => {
  setUnicodeCells(true);
});

afterAll(() => {
  setUnicodeCells(false);
});

describe("收進畫面：TermBuf 格子", () => {
  test("韓文全形：每字 2 格，後面的字落在 server 算的欄位", () => {
    const { buf, feed } = makeTerm();
    feed("한국A");
    expect(buf.getRowText(0, 0, 80).trimEnd()).toBe("한국A");
    expect(buf.lines[0][0].isLeadByte).toBe(true);
    expect(buf.lines[0][1].ch).toBe(WIDE_TRAIL);
    expect(buf.lines[0][4].ch).toBe("A");
    expect(buf.cur_x).toBe(5);
  });

  test("Big5 收不下的半形字：1 格、不是 lead", () => {
    const { buf, feed } = makeTerm();
    feed("ġx");
    expect(buf.lines[0][0].ch).toBe("ġ");
    expect(buf.lines[0][0].isLeadByte).toBe(false);
    expect(buf.lines[0][1].ch).toBe("x");
    expect(buf.cur_x).toBe(2);
  });

  test("與 Big5 字混排：Big5 收得下的照舊是 lead／trail 位元組", () => {
    const { buf, feed } = makeTerm();
    feed("推한文");
    const b5 = u2b("推");
    expect(buf.lines[0][0].ch + buf.lines[0][1].ch).toBe(b5);
    expect(buf.getRowText(0, 0, 80).trimEnd()).toBe("推한文");
  });

  test("CUP 定位到全形 Unicode 字後面：游標欄位與 server 一致", () => {
    const { buf, feed } = makeTerm();
    feed("简体" + ESC + "[1;5HZ");
    expect(buf.getRowText(0, 0, 80).trimEnd()).toBe("简体Z");
  });

  test("getRowText 的半格選取：從右半格開始也拿到整個字", () => {
    const { buf, feed } = makeTerm();
    feed("A한B");
    expect(buf.getRowText(0, 2, 4)).toBe("한B");
  });

  test("左半被蓋掉的孤兒右半格讀成 ?（U+FFFF 不漏進文字）", () => {
    const { buf, feed } = makeTerm();
    feed("한B" + ESC + "[1;1HY");
    expect(buf.getRowText(0, 0, 80).trimEnd()).toBe("Y?B");
    expect(rowToText(buf.lines[0]).trimEnd()).toBe("Y?B");
  });

  test("ANSI 複製（getText color）解回原字", () => {
    const { buf, feed } = makeTerm();
    feed(ESC + "[1;33m한" + ESC + "[m");
    expect(buf.getText(0, 0, 2, true, true, false)).toContain("한");
    expect(buf.getText(0, 0, 2, true, true, false)).not.toContain(WIDE_TRAIL);
  });

  test("URL 偵測：網址後面緊貼 Unicode 半形字不會吃掉網址的字", () => {
    const { buf, feed } = makeTerm();
    feed("ġhttps://example.com/abc 한");
    const line = buf.lines[0];
    expect(line[1].startOfURL).toBe(true);
    expect(line[1].fullurl).toBe("https://example.com/abc");
  });

  test("URL 的 CJK 延伸：Big5 收不下的全形字也算一格兩格", () => {
    const { buf, feed } = makeTerm();
    feed("https://ko.wikipedia.org/wiki/한국 x");
    const line = buf.lines[0];
    const end = line.findIndex((c) => c.endOfURL);
    // 30 個 ASCII ＋ 兩個全形字（4 格） ⇒ 結尾在 col 33
    expect(end).toBe(33);
    expect(line[0].fullurl).toBe(
      "https://ko.wikipedia.org/wiki/" + encodeURI("한국"),
    );
  });
});

describe("string_util 在 UTF-8 線路", () => {
  test("u2b：Big5 收得下 ⇒ 位元組；收不下 ⇒ Unicode 格；emoji 原樣", () => {
    expect(u2b("中")).toBe(big5Of(0x4e2d));
    expect(u2b("한")).toBe("한" + WIDE_TRAIL);
    expect(u2b("ġ")).toBe("ġ");
    expect(u2b("😀")).toBe("😀");
  });

  test("b2u 解回原字（含落在字串尾的右半格）", () => {
    expect(b2u(u2b("中한ġ"))).toBe("中한ġ");
    expect(b2u("한" + WIDE_TRAIL)).toBe("한");
  });

  test("isDBCSLead：全形 Unicode 格是 lead，半形與右半格不是", () => {
    expect(isDBCSLead("한")).toBe(true);
    expect(isDBCSLead("ġ")).toBe(false);
    expect(isDBCSLead(WIDE_TRAIL)).toBe(false);
  });

  test("textCellWidth／charCells 與格子一致", () => {
    expect(textCellWidth("中한ġA")).toBe(2 + 2 + 1 + 1);
    expect(charCells("ġ")).toBe(1);
    expect(textCellWidth("é")).toBe(1);
  });

  test("Big5 線路：寬度規則與既有的「非 ASCII 一律 2」相同", () => {
    setUnicodeCells(false);
    expect(textCellWidth("中한ġA")).toBe(7);
    expect(u2b("한")).toBe("\xff\xfd");
  });

  test("isPttDrawable：Big5 內部的 server 畫不出 Big5 以外的字", () => {
    expect(isPttDrawable("中")).toBe(true);
    expect(isPttDrawable("한")).toBe(false);
    expect(isPttDrawable("😀")).toBe(false);
  });

  test("cellPairs：Big5 lead 一律配對；全形 Unicode 格只配右半格", () => {
    expect(cellPairs("\xa4", "@")).toBe(true);
    expect(cellPairs("한", WIDE_TRAIL)).toBe(true);
    expect(cellPairs("한", "A")).toBe(false);
  });
});

describe("server 內部是 UTF-8 的閂", () => {
  test("logind 探針 U+0121、U+FFFD、Big5 收得下的字都不立閂", () => {
    const inb = createUtf8Inbound();
    inb.decode(wire("\rġ�中文★"));
    expect(serverIsUnicodeNative()).toBe(false);
    // Big5 內部的 server 上 ｱ 照 Big5 位元組佔 2 格
    expect(codePointCells(0xff71)).toBe(2);
  });

  test("收到 Big5 收不下的字 ⇒ 立閂；之後 ucs_width 1 的 Big5 字改成一格", () => {
    const { buf, feed } = makeTerm();
    feed("한");
    expect(serverIsUnicodeNative()).toBe(true);
    feed("\r\nｱ✓X");
    expect(buf.lines[1][0].ch).toBe("ｱ");
    expect(buf.lines[1][1].ch).toBe("✓");
    expect(buf.lines[1][2].ch).toBe("X");
    expect(buf.getRowText(1, 0, 80).trimEnd()).toBe("ｱ✓X");
    expect(textCellWidth("ｱ✓X")).toBe(3);
    // 立閂後 Big5 以外的 BMP 字畫得出來；emoji 仍不行（pfterm ftchar 16 bit）
    expect(isPttDrawable("한")).toBe(true);
    expect(isPttDrawable("😀")).toBe(false);
  });

  test("新連線重算閂", () => {
    createUtf8Inbound().decode(wire("한"));
    expect(serverIsUnicodeNative()).toBe(true);
    setUnicodeCells(true);
    expect(serverIsUnicodeNative()).toBe(false);
  });
});

describe("送出前的 vtkbd 狀態鏡像", () => {
  test("U+011B（ě）的低位元組是 0x1B，但它不是 ESC", () => {
    expect(nextSendState(VK_NORMAL, "ě")).toBe(VK_NORMAL);
    expect(nextSendState(VK_NORMAL, ESC)).toBe(VK_ESC);
  });
});
