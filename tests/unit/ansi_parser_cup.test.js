// @unit-env browser
// CUP／HVP（`ESC[<row>;<col>H`、`ESC[<row>;<col>f`）只帶一個參數的形式。
//
// ECMA-48 §8.3.21：CUP 的兩個參數都可省略，省略＝1 ⇒ `ESC[5H` ＝第 5 列第 1 欄
// （xterm 同）。PTT 自己畫畫面一律送兩個參數（mbbsd/term.c#do_move），但文章／看板
// 內容裡使用者寫的 ANSI 也會經過這裡：pttbbs common/sys/string.c 的 ANSI 掃描把
// CUP（H／f）列為 safe_mask 內的「安全指令」，動畫文、ANSI 圖可能只寫列號。
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
