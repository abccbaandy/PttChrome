// SGR 66（一字雙色）—— PTTBBS 自訂碼，**本專案永遠收不到，忽略即完全正確**。
//
// PTT 2026-09-20 公告「新指令: SGR 66 一字雙色」，PTT1 9/20、PTT2 9/19 上線：
//   「預期行為: 把後面的屬性作為一字雙色的後半段著色，或是忽略。
//     對「使用Big5連線」的Client 無影響，只對 UTF-8 連線生效 …
//     好處是略過也就是直接用後半部的顏色呈現，所以效果不會差太多」
//   「1. 如果你目前是用 Big5 與 PTT 連線，基本上不會收到, 但請寫好收到不要當掉。」
//
// server 端實作（3rd_script/pttbbs @ 3f031354）：
//   mbbsd/pfterm.c
//     #define FTCONF_USE_DBCS_SGR66    (1)   // 入站：把 SGR 66 收成 latched 屬性
//     #define FTCONF_UTF8_OUTPUT_SGR66 (1)   // 出站：UTF-8 模式才送
//     #define FTCONF_DBCS_OUTPUT_SGR66 (0)   // 出站：Big5 模式**不送**
//   fterm_param()  case 66: ft.half_attr = ft.attr; ft.has_half_attr = 1;
//     ⇒ 66 把**當下累積到的屬性**快照成下一個字元的「前半格」，序列剩下的參數
//       繼續改一般屬性、成為「後半格」。快照只被下一個字元消費一次。
//   fterm_rawattr_half()  fterm_raws(ESC "[66;"); fterm_raws(cmd + 2);
//     ⇒ 線路格式是 `ESC[<前半>m ESC[66;<後半>m <字>`。
//
// 本專案 term_view.js 寫死 `charset = 'big5'` ⇒ 走的是 FTCONF_DBCS_OUTPUT_SGR66
// 這條，**永遠收不到 SGR 66**。所以 term_buf.js 的 `case 66:` 是有意的 no-op，
// 不是「剛好落在 default 的 30-37/40-47 範圍外」的巧合 —— 這支測試鎖住那個意圖。
// 真要實作分色渲染的觸發條件與代價見 docs/handoff/sgr66-render.md。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { u2b } from "../../src/js/string_util";
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

// 一個 cell 的全部可見屬性，用來做「兩條序列等價」的比對。
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

describe("SGR 66（一字雙色）是有意的 no-op", () => {
  beforeAll(() => {
    loadBig5Tables();
  });

  // 公告原文的範例：`*[1;37;66;33m中*[m`，說明「中的前半個字元顯示成高亮白色，
  // 後面黃色」。忽略 66 的降級結果＝**整個字**用後半色（bright + fg 3），也就是
  // 前半格那個「高亮白」不會出現。
  //
  // 餵的是 `u2b()` 轉出來的 **Big5 位元組**（線路上就是這個）：一個中文字＝相鄰
  // 兩格各存一個 byte，兩格都要驗，否則「66 有沒有污染前半格」根本量不到。
  test("ESC[1;37;66;33m中 → 兩格都是後半色，且等價於沒有 66 的版本", () => {
    const withSgr66 = makeBuf();
    new AnsiParser(withSgr66).feed(u2b(ESC + "[1;37;66;33m中"));
    const plain = makeBuf();
    new AnsiParser(plain).feed(u2b(ESC + "[1;37;33m中"));

    // 先確認這個字真的佔了兩格（不然下面兩條會是空話）。
    expect(withSgr66.lines[0][0].ch.charCodeAt(0)).toBeGreaterThan(0x7f);
    expect(withSgr66.lines[0][1].ch.charCodeAt(0)).toBeGreaterThan(0x7f);

    // 前半格（lead byte）：66 若被實作成 latch，這一格會是 fg 7；忽略則是 fg 3。
    expect(attrOf(withSgr66, 0, 0)).toEqual(attrOf(plain, 0, 0));
    expect(attrOf(withSgr66, 0, 0)).toMatchObject({ fg: 3, bright: true });
    // 後半格（trail byte）
    expect(attrOf(withSgr66, 0, 1)).toEqual(attrOf(plain, 0, 1));
    expect(attrOf(withSgr66, 0, 1)).toMatchObject({ fg: 3, bright: true });

    // 字本身沒有被 66 吃掉。直接比 cell 裡的原始 Big5 位元組：
    // getRowText 要等 notify() 跑過 updateCharAttr() 重算 isLeadByte 才會把
    // 兩格折回一個字，這裡不想拉進 timer。
    expect(withSgr66.lines[0][0].ch + withSgr66.lines[0][1].ch).toBe(u2b("中"));
    expect(plain.lines[0][0].ch + plain.lines[0][1].ch).toBe(u2b("中"));
  });

  // 線路上真正的形狀（pfterm#fterm_rawattr_half）：`ESC[<前半>m ESC[66;<後半>m <字>`。
  test("線路形狀 ESC[1;37m ESC[66;33m 中：兩格都是後半色", () => {
    const buf = makeBuf();
    new AnsiParser(buf).feed(u2b(ESC + "[1;37m" + ESC + "[66;33m中"));
    expect(attrOf(buf, 0, 0)).toMatchObject({ fg: 3, bright: true });
    expect(attrOf(buf, 0, 1)).toMatchObject({ fg: 3, bright: true });
    expect(buf.lines[0][0].ch + buf.lines[0][1].ch).toBe(u2b("中"));
  });

  // 線路上真正會出現的形狀（pfterm#fterm_rawattr_half 產生的）：兩條獨立的 SGR。
  test("ESC[1;37m ESC[66;33m 的組合只留下後半色，且不污染其他屬性", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(ESC + "[0;1;5;37;44m");
    parser.feed(ESC + "[66;33m");
    parser.feed("A");
    expect(attrOf(buf, 0, 0)).toEqual({
      fg: 3, // 33 生效
      bg: 4, // 44 沒有被 66 洗掉
      bright: true, // 1 沒有被 66 洗掉
      blink: true, // 5 沒有被 66 洗掉
      invert: false,
      underLine: false,
    });
  });

  // 66 單獨出現時必須完全沒有效果 —— 特別是不可以被 default 分支當成顏色。
  test("ESC[66m 不改變任何屬性", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(ESC + "[1;31;42m");
    const before = (() => {
      parser.feed("A");
      return attrOf(buf, 0, 0);
    })();
    parser.feed(ESC + "[66m");
    parser.feed("B");
    expect(attrOf(buf, 0, 1)).toEqual(before);
  });

  // 66 出現在參數列最前面／最後面都一樣是 no-op。
  test.each([
    [ESC + "[66;1;33m", ESC + "[1;33m"],
    [ESC + "[1;33;66m", ESC + "[1;33m"],
    [ESC + "[0;66;30;47m", ESC + "[0;30;47m"],
  ])("%s 等價於 %s", (withSixtySix, without) => {
    const a = makeBuf();
    new AnsiParser(a).feed(withSixtySix + "A");
    const b = makeBuf();
    new AnsiParser(b).feed(without + "A");
    expect(attrOf(a, 0, 0)).toEqual(attrOf(b, 0, 0));
  });
});
