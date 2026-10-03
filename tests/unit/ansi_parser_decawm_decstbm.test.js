// @unit-env browser
// DECAWM（`ESC[?7h/l`）與 DECSTBM（`ESC[t;br` / `ESC[r`）。
//
// PTT PttCurrent 2026-09-29 兩篇公告，server 端 CONFIRMED @ 3rd_script/pttbbs mbbsd/term.c：
//   - term_init() 一連線就送 `ESC[?7l`（關閉自動折行），term_uninit() 送 `ESC[?7h`。
//     pfterm 同時把 FTCONF_AUTO_WRAP 預設成 0（63f2cef4）：server 端的游標模型不再假設
//     client 會折行。
//   - term_set_size() 只在 client 列數 > MAX_TERM_ROWS(150) 時送 `ESC[1;150r`，
//     回到 ≤150 或離線時送 `ESC[r`；兩者之後都緊接一條 CUP 把游標放回原位。
//
// 相容性設計：
//   - DECAWM 預設 ON（VT100 預設，也是舊 client 的行為）⇒ 舊版 server 不送 `?7l`
//     時畫面行為一個 byte 都不變；新版 server 送 `?7l` 後改成「寫到行尾就停在最後
//     一格覆寫」。
//   - DECSTBM 超出畫面的 bottom 夾到最後一列（xterm 同樣做法）。本專案列數上限 100
//     （term_size.js#MAX_ROWS）⇒ 實務上收不到，但舊碼收到 `ESC[1;150r` 會讓 lineFeed
//     把游標推出 buffer ⇒ 下一個字 `lines[cur_y]` 是 undefined 直接炸。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { loadBig5Tables } from "./helpers/load_big5_tables";

const ESC = "\x1b";

function makeBuf(rows = 24) {
  const buf = new TermBuf(80, rows);
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

function setup(rows) {
  const buf = makeBuf(rows);
  const parser = new AnsiParser(buf);
  return { buf, parser };
}

describe("DECAWM（?7）", () => {
  beforeAll(() => {
    loadBig5Tables();
  });

  test("預設（舊版 server 不送 ?7）：寫過第 80 欄照舊折到下一列", () => {
    const { buf, parser } = setup();
    parser.feed("x".repeat(80) + "YZ");
    expect(row(buf, 0)).toBe("x".repeat(80));
    expect(row(buf, 1)).toBe("YZ");
  });

  test("?7l 後：寫過第 80 欄不折行，停在最後一格覆寫", () => {
    const { buf, parser } = setup();
    parser.feed(ESC + "[?7l" + "x".repeat(80) + "YZ");
    expect(row(buf, 0)).toBe("x".repeat(79) + "Z");
    expect(row(buf, 1)).toBe("");
    expect(buf.cur_y).toBe(0);
  });

  test("?7l 在最後一列也不會捲動畫面", () => {
    const { buf, parser } = setup();
    parser.feed("top" + ESC + "[?7l" + ESC + "[24;1H" + "y".repeat(85));
    expect(row(buf, 0)).toBe("top");
    expect(row(buf, 23)).toBe("y".repeat(80));
  });

  test("?7l 之後游標定位再寫字一切正常", () => {
    const { buf, parser } = setup();
    parser.feed(ESC + "[?7l" + "x".repeat(80) + ESC + "[2;1H" + "next");
    expect(row(buf, 1)).toBe("next");
  });

  test("?7h 恢復折行（server 登出時送）", () => {
    const { buf, parser } = setup();
    parser.feed(ESC + "[?7l" + ESC + "[?7h" + "x".repeat(80) + "Y");
    expect(row(buf, 1)).toBe("Y");
  });

  test("一條序列設多個模式（`?7;2026l`）也認得", () => {
    const { buf, parser } = setup();
    parser.feed(ESC + "[?7;1000l" + "x".repeat(81));
    expect(row(buf, 1)).toBe("");
  });

  test("斷線重設後回到預設（折行）", () => {
    const { buf, parser } = setup();
    parser.feed(ESC + "[?7l");
    buf.resetTerminalModes();
    parser.feed("x".repeat(81));
    expect(row(buf, 1)).toBe("x");
  });

  test("序列本身不落到畫面上", () => {
    const { buf, parser } = setup();
    parser.feed("A" + ESC + "[?7l" + "B" + ESC + "[?7h" + "C");
    expect(row(buf, 0)).toBe("ABC");
  });
});

describe("DECSTBM（r）", () => {
  beforeAll(() => {
    loadBig5Tables();
  });

  // 主回歸：修正前 scrollEnd = 149 > rows - 1，lineFeed 把游標推出 buffer 後炸掉。
  test("`ESC[1;150r` 送到 24 列的 client：不炸、捲動照常（等同全螢幕）", () => {
    const { buf, parser } = setup(24);
    parser.feed(ESC + "[1;150r" + ESC + "[1;1H" + "first");
    let s = "";
    for (let i = 0; i < 30; ++i) s += "\r\nline" + i;
    expect(() => parser.feed(s)).not.toThrow();
    expect(buf.cur_y).toBe(23);
    expect(row(buf, 23)).toBe("line29");
    expect(row(buf, 0)).toBe("line6");
  });

  test("server 的完整送法：DECSTBM 後緊接 CUP 復位，游標落在 CUP 指定處", () => {
    const { buf, parser } = setup(24);
    parser.feed(ESC + "[5;10H" + ESC + "[1;150r" + ESC + "[5;10H" + "@");
    expect(row(buf, 4)).toBe("         @");
  });

  test("DECSTBM 依 VT100 規格把游標送回原點", () => {
    const { buf, parser } = setup(24);
    parser.feed(ESC + "[10;10H" + ESC + "[5;20r");
    expect([buf.cur_x, buf.cur_y]).toEqual([0, 0]);
  });

  test("捲動範圍內換行只捲範圍內的列", () => {
    const { buf, parser } = setup(24);
    let s = "";
    for (let r = 1; r <= 24; ++r) s += ESC + "[" + r + ";1H" + "r" + r;
    parser.feed(s + ESC + "[5;10r" + ESC + "[10;1H" + "\n");
    expect(row(buf, 3)).toBe("r4");
    expect(row(buf, 4)).toBe("r6"); // 範圍 5..10 往上捲一列
    expect(row(buf, 8)).toBe("r10");
    expect(row(buf, 9)).toBe("");
    expect(row(buf, 10)).toBe("r11"); // 範圍外不動
  });

  test("游標在捲動範圍下方時，換行只往下走、到底也不捲範圍", () => {
    const { buf, parser } = setup(24);
    parser.feed(ESC + "[6;6H" + "keep" + ESC + "[5;10r" + ESC + "[23;1H" + "\n\n\n" + "z");
    expect(buf.cur_y).toBe(23);
    expect(row(buf, 5)).toBe("     keep");
    expect(row(buf, 23)).toBe("z");
  });

  test("`ESC[r` 重設成全螢幕", () => {
    const { buf, parser } = setup(24);
    parser.feed(ESC + "[5;10r" + ESC + "[r");
    expect([buf.scrollStart, buf.scrollEnd]).toEqual([0, 23]);
  });

  test("top >= bottom 的無效範圍被忽略", () => {
    const { buf, parser } = setup(24);
    parser.feed(ESC + "[5;10r" + ESC + "[10;5r");
    expect([buf.scrollStart, buf.scrollEnd]).toEqual([4, 9]);
  });

  test("resize 與斷線重設都回到全螢幕範圍", () => {
    const { buf, parser } = setup(24);
    parser.feed(ESC + "[5;10r");
    buf.resize(80, 30);
    expect([buf.scrollStart, buf.scrollEnd]).toEqual([0, 29]);
    parser.feed(ESC + "[5;10r");
    buf.resetTerminalModes();
    expect([buf.scrollStart, buf.scrollEnd]).toEqual([0, 29]);
  });

  test("序列本身不落到畫面上", () => {
    const { buf, parser } = setup(24);
    parser.feed(ESC + "[1;150r" + ESC + "[1;1H" + "ok" + ESC + "[r");
    expect(row(buf, 0)).toBe("ok");
  });
});
