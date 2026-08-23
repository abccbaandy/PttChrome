// 「畫面正在等使用者輸入」的偵測（`buf.isCursorOnInputField`）。
//
// 依據 mbbsd/vtuikit.c#vgetstring（1211-1240）：每次重畫輸入欄都是
//   outs(VCLR_INPUT_FIELD)  // include/vtuikit.h:37 → ANSI_COLOR(0;7) = ESC[0;7m
//   vfill(len, 0, buf)      // 填滿 len 格
//   outs(ANSI_RESET)
//   move(line_ansi, col_ansi + rt.icurr)   // 游標**一定**落在那條反白欄內
// ⇒「游標所在格 invert」是所有 PTT 輸入框（推文／搜尋／跳頁／y-N）共通的指紋。
//
// 壞過的行為：在看板列表按 s 叫出「搜尋全站看板」時，pageState 黏著在 2（列表），
// 游標底色因此畫到 prompt 那一列上（使用者回報：底色＋文字破碼＋游標錯位）。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { loadBig5Tables } from "./helpers/load_big5_tables";

loadBig5Tables();

// 一個只有 TermBuf 的最小 app：view stub 只吸掉 notify 的呼叫。
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

const feed = (buf, bytes) => new AnsiParser(buf).feed(bytes);

// vgetstring 的輸入欄：ESC[0;7m + len 格空白 + ESC[0m，游標移進欄內第 off 格。
function promptScreen(row, col, len, off) {
  return (
    "\x1b[" + (row + 1) + ";" + (col + 1) + "H" +
    "\x1b[0;7m" + " ".repeat(len) + "\x1b[0m" +
    "\x1b[" + (row + 1) + ";" + (col + off + 1) + "H"
  );
}

describe("isCursorOnInputField", () => {
  test("游標停在 vgetstring 的反白輸入欄內 ⇒ true", () => {
    const buf = makeBuf();
    feed(buf, promptScreen(1, 33, 13, 0));
    expect(buf.isCursorOnInputField()).toBe(true);
  });

  test("欄位用 ESC[0;7m（invert 旗標）編碼時同樣認得", () => {
    const buf = makeBuf();
    feed(buf, promptScreen(1, 33, 13, 0, "0;7"));
    expect(buf.isCursorOnInputField()).toBe(true);
  });

  test("整列反白的狀態列／表頭不算輸入欄（游標偶爾會 park 在上面）", () => {
    const buf = makeBuf();
    // 列表表頭「   編號    日 期  作 者 …」：從 col 0 反白到行尾（實測 79 格）
    feed(buf, "[3;1H[30;47m" + " ".repeat(80) + "[0m[3;40H");
    expect(buf.isCursorOnInputField()).toBe(false);
  });

  test("已經打了幾個字（游標往右移，仍在欄內）⇒ 仍是 true", () => {
    const buf = makeBuf();
    feed(buf, promptScreen(1, 33, 13, 5));
    expect(buf.isCursorOnInputField()).toBe(true);
  });

  test("一般畫面（游標停在普通字元上）⇒ false", () => {
    const buf = makeBuf();
    feed(buf, "\x1b[6;1Hhello world\x1b[6;1H");
    expect(buf.isCursorOnInputField()).toBe(false);
  });

  test("游標在輸入欄**外**（欄還在畫面上，但游標已離開）⇒ false", () => {
    const buf = makeBuf();
    feed(buf, promptScreen(1, 33, 13, 0) + "\x1b[6;1H");
    expect(buf.isCursorOnInputField()).toBe(false);
  });

  test("剛開機的空畫面不會炸，回 false", () => {
    expect(makeBuf().isCursorOnInputField()).toBe(false);
  });

  test("游標座標越界時不會炸，回 false", () => {
    const buf = makeBuf();
    buf.cur_x = 999;
    buf.cur_y = 999;
    expect(buf.isCursorOnInputField()).toBe(false);
  });
});
