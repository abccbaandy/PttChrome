// OSC 8 超連結的整條接線：AnsiParser → TermBuf.setHyperlink → 逐格 hyperlink →
// updateCharAttr 的 URL 旗標（partOfURL / startOfURL / fullurl）→ 渲染鏈。
//
// 為什麼一定要做（PTT PttCurrent 2026-09-30「新指令: OSC 8 超連結」＋
// pttbbs c4ab8773「feat(pmore): Support markdown hyperlinks」）：新版 pmore 把文章裡
// 的 `[文字](網址)` **只顯示「文字」**，網址改用 OSC 8 送。舊 parser 只會把 OSC 吞掉
// ⇒ 使用者看到的是一段完全沒有網址、也點不動的字。這一組測試守的就是這個退化。
//
// 舊版 server 不送 OSC 8 ⇒ 下面「沒有 OSC 8 時 regex 自動連結照舊」那條同時守相容。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import { mountRow, unmountAll } from "./helpers/mount_screen";

const ESC = "\x1b";
const ST = ESC + "\\";
const open = (url) => ESC + "]8;;" + url + ST;
const close = ESC + "]8;;" + ST;

function makeBuf() {
  const buf = new TermBuf(80, 24);
  buf.setView({
    update() {},
    updateCursorPos() {},
    refreshCursorVisibility() {},
    blinkOn: false,
  });
  buf.useMouseBrowsing = false;
  return buf;
}

function row(buf, r) {
  return buf.getRowText(r, 0, buf.cols).replace(/\s+$/, "");
}

// 一列上所有連結：[{ start, end, href }]，由 TermChar 的旗標反推（渲染鏈讀的就是這些）。
function links(buf, r) {
  buf.updateCharAttr();
  const line = buf.lines[r];
  const out = [];
  let cur = null;
  for (let c = 0; c < line.length; ++c) {
    const ch = line[c];
    if (ch.isStartOfURL()) cur = { start: c, href: ch.getFullURL() };
    if (cur && !ch.isPartOfURL()) throw new Error("URL 範圍中斷於 col " + c);
    if (cur && ch.isEndOfURL()) {
      cur.end = c + 1;
      out.push(cur);
      cur = null;
    }
  }
  return out;
}

function feed(s) {
  const buf = makeBuf();
  const parser = new AnsiParser(buf);
  parser.feed(s);
  return { buf, parser };
}

describe("OSC 8 超連結", () => {
  beforeAll(() => {
    loadBig5Tables();
  });

  // 主回歸：修正前這條會紅（文字在，但沒有任何連結）。
  test("pfterm 的輸出形狀：連結文字可點，href 是 OSC 指定的網址", () => {
    // 取自 pttbbs mbbsd/test_pfterm_url.c 的斷言字串。
    const { buf } = feed(open("https://term.ptt.cc") + "PTT" + close + " BBS");
    expect(row(buf, 0)).toBe("PTT BBS");
    expect(links(buf, 0)).toEqual([
      { start: 0, end: 3, href: "https://term.ptt.cc" },
    ]);
  });

  test("跳脫序列與網址不得印到畫面上", () => {
    const { buf } = feed("A" + open("https://example.com/x") + "B" + close + "C");
    expect(row(buf, 0)).toBe("ABC");
  });

  test("相鄰兩條連結各自獨立（中間不關閉直接換 URL）", () => {
    const { buf } = feed(
      open("https://url1.com") + "AAA" + open("https://url2.com") + "BBB" + close,
    );
    expect(links(buf, 0)).toEqual([
      { start: 0, end: 3, href: "https://url1.com" },
      { start: 3, end: 6, href: "https://url2.com" },
    ]);
  });

  test("連結狀態跟著游標走：中途移游標、換列都不會自己關掉", () => {
    const { buf } = feed(
      open("https://move.test") + "ab" + ESC + "[3;5H" + "cd" + close + "ef",
    );
    expect(links(buf, 0)).toEqual([{ start: 0, end: 2, href: "https://move.test" }]);
    expect(links(buf, 2)).toEqual([{ start: 4, end: 6, href: "https://move.test" }]);
    expect(row(buf, 2)).toBe("    cdef");
  });

  test("連結文字本身就是網址時，以 OSC 指定的 URL 為準（不被 regex 二次辨識切開）", () => {
    const { buf } = feed(
      open("https://real.example/target") + "https://shown.example" + close + " tail",
    );
    expect(links(buf, 0)).toEqual([
      { start: 0, end: 21, href: "https://real.example/target" },
    ]);
  });

  test("同一列裡 OSC 連結以外的純文字網址照舊由 regex 辨識", () => {
    const { buf } = feed(
      // 「文字」的 Big5 位元組（線上資料是 latin1 位元組串，不是 Unicode）
      open("https://a.example") + "\xa4\xe5\xa6\x72" + close + " https://b.example/x",
    );
    expect(links(buf, 0)).toEqual([
      { start: 0, end: 4, href: "https://a.example" },
      { start: 5, end: 24, href: "https://b.example/x" },
    ]);
  });

  test("沒有 OSC 8（舊版 server）時 regex 自動連結行為不變", () => {
    const { buf } = feed("see https://www.ptt.cc/bbs/ ok");
    expect(links(buf, 0)).toEqual([
      { start: 4, end: 27, href: "https://www.ptt.cc/bbs/" },
    ]);
  });

  test.each(["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"])(
    "非 http/https 的 OSC 8 不產生連結，文字照常顯示：%s",
    (url) => {
      const { buf } = feed(open(url) + "click" + close);
      expect(row(buf, 0)).toBe("click");
      expect(links(buf, 0)).toEqual([]);
    },
  );

  test("Big5 中文網址：href 是百分比編碼的 Unicode", () => {
    // 「中」的 Big5 = A4 A4
    const { buf } = feed(open("https://zh.wikipedia.org/wiki/\xa4\xa4") + "wiki" + close);
    expect(links(buf, 0)).toEqual([
      { start: 0, end: 4, href: "https://zh.wikipedia.org/wiki/%E4%B8%AD" },
    ]);
  });

  test("序列被切在任意位置（WebSocket 分段）結果一樣", () => {
    const s = open("https://split.example/p") + "LINK" + close + "!";
    for (let cut = 1; cut < s.length; ++cut) {
      const buf = makeBuf();
      const parser = new AnsiParser(buf);
      parser.feed(s.slice(0, cut));
      parser.feed(s.slice(cut));
      expect(row(buf, 0)).toBe("LINK!");
      expect(links(buf, 0)).toEqual([
        { start: 0, end: 4, href: "https://split.example/p" },
      ]);
    }
  });

  test("BEL 終止子也認（xterm 慣例）", () => {
    const { buf } = feed(ESC + "]8;;https://bel.example\x07X" + ESC + "]8;;\x07Y");
    expect(row(buf, 0)).toBe("XY");
    expect(links(buf, 0)).toEqual([{ start: 0, end: 1, href: "https://bel.example" }]);
  });

  test("被 CAN 中止的 OSC 8 不生效", () => {
    const { buf } = feed(ESC + "]8;;https://x.example\x18" + "plain");
    expect(row(buf, 0)).toBe("plain");
    expect(links(buf, 0)).toEqual([]);
  });

  test("ESC 後面不是 `\\`（被新序列打斷）的 OSC 8 不生效，新序列照常執行", () => {
    const { buf } = feed(ESC + "]8;;https://x.example" + ESC + "[2;1H" + "plain");
    expect(row(buf, 1)).toBe("plain");
    expect(links(buf, 1)).toEqual([]);
  });

  test("超長 payload：不生效、不留殘渣，後面的字正常", () => {
    const { buf } = feed(open("https://x.example/" + "a".repeat(10000)) + "T" + close + "U");
    expect(row(buf, 0)).toBe("TU");
    expect(links(buf, 0)).toEqual([]);
  });

  test("其他 OSC（視窗標題）仍安靜忽略，也不影響連結狀態", () => {
    const { buf } = feed(
      open("https://keep.example") + ESC + "]0;title" + ST + "K" + close,
    );
    expect(row(buf, 0)).toBe("K");
    expect(links(buf, 0)).toEqual([{ start: 0, end: 1, href: "https://keep.example" }]);
  });

  test("擦除（清畫面／清行）後的格子不再帶著舊連結", () => {
    const { buf, parser } = feed(open("https://old.example") + "OLD" + close);
    parser.feed(ESC + "[H" + ESC + "[K" + "new");
    expect(row(buf, 0)).toBe("new");
    expect(links(buf, 0)).toEqual([]);
  });

  test("覆寫同一格：沒開連結時寫入的字會把舊連結蓋掉", () => {
    const { buf, parser } = feed(open("https://old.example") + "OLD" + close);
    buf.updateCharAttr();
    parser.feed(ESC + "[H" + "XY");
    expect(row(buf, 0)).toBe("XYD");
    expect(links(buf, 0)).toEqual([{ start: 2, end: 3, href: "https://old.example" }]);
  });

  test("斷線重設（resetTerminalModes）會關掉進行中的連結", () => {
    const { buf, parser } = feed(open("https://dangling.example") + "A");
    buf.resetTerminalModes();
    parser.feed("B");
    expect(links(buf, 0)).toEqual([{ start: 0, end: 1, href: "https://dangling.example" }]);
  });

  // 渲染鏈讀的是同一組 TermChar 旗標；這條實證最後真的畫成 <a>，而且畫的是
  // OSC 指定的 href、顯示的是連結文字。
  describe("渲染", () => {
    afterEach(() => unmountAll());

    test("OSC 8 連結畫成 <a href>，文字是連結文字", () => {
      const { buf } = feed("see " + open("https://term.ptt.cc/") + "PTT" + close + " now");
      buf.updateCharAttr();
      const { container } = mountRow({ chars: buf.lines[0] });
      const anchors = container.querySelectorAll("a");
      expect(anchors).toHaveLength(1);
      expect(anchors[0].getAttribute("href")).toBe("https://term.ptt.cc/");
      expect(anchors[0].textContent).toBe("PTT");
    });

    test("被白名單擋掉的 OSC 8 不產生任何 <a>", () => {
      const { buf } = feed(open("javascript:alert(1)") + "click" + close);
      buf.updateCharAttr();
      const { container } = mountRow({ chars: buf.lines[0] });
      expect(container.querySelectorAll("a")).toHaveLength(0);
      expect(container.textContent).toContain("click");
    });
  });

  test("容錯：精簡的 termbuf stub（沒有 setHyperlink）不會炸", () => {
    const stub = { puts() {} };
    const parser = new AnsiParser(stub);
    expect(() => parser.feed(open("https://x.example") + "a" + close)).not.toThrow();
  });
});
