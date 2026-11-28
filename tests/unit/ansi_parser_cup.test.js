// @unit-env browser
// CUP／HVP（`ESC[<row>;<col>H`、`ESC[<row>;<col>f`）只帶一個參數的形式。
//
// ECMA-48 §8.3.21：CUP 的兩個參數都可省略，省略＝1 ⇒ `ESC[5H` ＝第 5 列第 1 欄
// （xterm 同；pttbbs mbbsd/pfterm.c#fterm_exec 解譯 CUP 也是同一語意）。PTT 線上
// 不送單參數形：使用者內容裡的 CSI 先被 server 端 pfterm 解譯，送出的是
// fterm_rawcmd2 重產的序列（FTCONF_ANSICMD2_OMIT=0 ⇒ 兩個參數或 `ESC[H`）。
// 這條守的是標準語意（其他站台、server 設定改變時不跑位）。
// 舊碼看到參數少於兩個就一律跳原點 (0,0)，後面的字全畫到第一列。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { loadBig5Tables } from "./helpers/load_big5_tables";

const ESC = "\x1b";

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

describe("AnsiParser CUP 參數省略", () => {
  beforeAll(() => {
    loadBig5Tables();
  });

  test.each(["H", "f"])("ESC[5%s 只帶列號 ⇒ 第 5 列第 1 欄", (fin) => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(`${ESC}[3;10H` + `${ESC}[5${fin}` + "ABC");
    expect(buf.cur_y).toBe(4);
    expect(row(buf, 4)).toBe("ABC");
    expect(row(buf, 0)).toBe("");
  });

  test("ESC[H／ESC[;H／ESC[0;0H 仍回原點", () => {
    for (const seq of ["[H", "[;H", "[0;0H", "[1;1H"]) {
      const buf = makeBuf();
      const parser = new AnsiParser(buf);
      parser.feed(`${ESC}[3;10H` + ESC + seq);
      expect([buf.cur_x, buf.cur_y]).toEqual([0, 0]);
    }
  });

  test("ESC[;7H 省略列號 ⇒ 第 1 列第 7 欄；ESC[4;H 省略欄號 ⇒ 第 4 列第 1 欄", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(`${ESC}[;7H`);
    expect([buf.cur_x, buf.cur_y]).toEqual([6, 0]);
    parser.feed(`${ESC}[3;10H${ESC}[4;H`);
    expect([buf.cur_x, buf.cur_y]).toEqual([0, 3]);
  });
});
