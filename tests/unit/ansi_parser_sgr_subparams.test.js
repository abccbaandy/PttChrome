// SGR 擴充色（38/48/58）的子參數必須整組吃掉。
//
// 背景：`TermChar.assignParams` 原本用 `params.forEach`，把每個數字都當成獨立的
// SGR 參數。於是
//   ESC[38;5;123m      → 38 無效果、**`5` 被當成 blink**、123 無效果 ⇒ 文字開始閃爍
//   ESC[38;2;200;30;40m → 38/2/200 無效果、**`30` 被當成前景黑、`40` 被當成背景黑**
//                         ⇒ 黑底黑字（整段文字消失）
// 這不是「不支援 256 色」而是「被誤解成別的指令」。
//
// 為什麼現在補：PTT 2026-09-20「請實作ECMA-48」公告明說「本站預計未來會不定期增加
// 輸出的控制碼類形」。目前 pfterm.c#fterm_chattr 只產生
// `ESC [ [0;] [1;] [5;] [3<fg>;] [4<bg>] m`（見 docs/pttbbs-screen-protocol.md §0），
// 所以這條路今天走不到 —— 但它是「哪天走到就整片文字消失」的那種。
//
// 範圍：**只把子參數吃掉，不實作 256/truecolor 上色**。我們的色票是 16 色
// （term_buf.js#termColors），真要上色是另一件事。
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

function attrOf(buf, y, x) {
  const c = buf.lines[y][x];
  return {
    fg: c.fg,
    bg: c.bg,
    bright: c.bright,
    blink: c.blink,
    invert: c.invert,
    underLine: c.underLine,
  };
}

const DEFAULT_ATTR = {
  fg: 7,
  bg: 0,
  bright: false,
  blink: false,
  invert: false,
  underLine: false,
};

describe("SGR 38/48/58 的子參數不得被當成獨立參數", () => {
  beforeAll(() => {
    loadBig5Tables();
  });

  // 主回歸：修正前這一條會紅（blink 變 true）。
  test("ESC[38;5;123m 不得讓文字閃爍", () => {
    const buf = makeBuf();
    new AnsiParser(buf).feed(ESC + "[38;5;123m" + "A");
    expect(attrOf(buf, 0, 0)).toEqual(DEFAULT_ATTR);
  });

  // 主回歸之二：修正前 fg/bg 都會變成 0（黑底黑字）。
  test("ESC[38;2;200;30;40m 不得把前景與背景都改成黑色", () => {
    const buf = makeBuf();
    new AnsiParser(buf).feed(ESC + "[38;2;200;30;40m" + "A");
    expect(attrOf(buf, 0, 0)).toEqual(DEFAULT_ATTR);
  });

  test.each([
    [ESC + "[48;5;9m", "48;5;n（背景 256 色）"],
    [ESC + "[48;2;10;20;30m", "48;2;r;g;b（背景 truecolor）"],
    [ESC + "[58;5;4m", "58;5;n（底線色）"],
  ])("%s（%s）零副作用", (seq) => {
    const buf = makeBuf();
    new AnsiParser(buf).feed(seq + "A");
    expect(attrOf(buf, 0, 0)).toEqual(DEFAULT_ATTR);
  });

  // 子參數吃完之後，**後面的參數要繼續正常生效**（跳過的格數不能多也不能少）。
  test("擴充色後面接的一般 SGR 仍然生效", () => {
    const buf = makeBuf();
    new AnsiParser(buf).feed(ESC + "[38;5;123;1;33;44m" + "A");
    expect(attrOf(buf, 0, 0)).toMatchObject({ fg: 3, bg: 4, bright: true });

    const buf2 = makeBuf();
    new AnsiParser(buf2).feed(ESC + "[48;2;1;2;3;7m" + "A");
    expect(attrOf(buf2, 0, 0)).toMatchObject({ invert: true });
  });

  // 裸的 38（沒有子參數）在某些終端機上會出現；不可以把後面的參數吃掉。
  test("裸的 ESC[38;33m 不得吃掉 33", () => {
    const buf = makeBuf();
    new AnsiParser(buf).feed(ESC + "[38;33m" + "A");
    expect(attrOf(buf, 0, 0)).toMatchObject({ fg: 3 });
  });

  // 零退化守護：PTT 實際會送的形狀（pfterm#fterm_chattr 的最短序列）。
  test.each([
    [ESC + "[m", DEFAULT_ATTR],
    [ESC + "[0;1;37;44m", { fg: 7, bg: 4, bright: true, blink: false }],
    [ESC + "[30;47m", { fg: 0, bg: 7, bright: false }],
    [ESC + "[1;33;45m", { fg: 3, bg: 5, bright: true }],
    [ESC + "[34;46m", { fg: 4, bg: 6, bright: false }],
    [ESC + "[0;1;5;31;40m", { fg: 1, bg: 0, bright: true, blink: true }],
  ])("PTT 實際會送的 %s 行為不變", (seq, expected) => {
    const buf = makeBuf();
    new AnsiParser(buf).feed(seq + "A");
    expect(attrOf(buf, 0, 0)).toMatchObject(expected);
  });
});
