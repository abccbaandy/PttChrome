// 「開燈」的隱藏文字偵測（src/js/hidden_text.js）——軌 A／軌 B 的逐列判定。
//
// 用真 TermBuf + AnsiParser + 真 Big5 表跑真的 escape 序列，不自己造假 TermChar：
// 判準吃的是 `getColor()`（內部＝ getFg()/getBg()，已把 bright / invert 攤平），手捏物件很容易寫出
// 一組現實中不存在的屬性組合。
//
// **每一條都對應一個實測樣本**（使用者提供的 debug 錄製檔，兩篇文章、兩種顯示模式
// 逐格對照過，詳見 docs/pttbbs-screen-protocol.md 的 PFTERM_DISABLE_HIDDEN_MESSAGE
// 一節）：
//   - Test 板自建測試文，預設模式下 `abc test2`（9 個半形）整段被 server 擦成空白；
//   - 同一篇的 `中文測試2` → 四個中文原樣送達（軌 A）、末尾的半形 `2` 被擦掉 1 格；
//   - Hunter 板那篇的隱藏網址 → 60 格全被擦成空白（軌 B 的大樣本）；
//   - 兩篇的文章狀態列都有 2 格 fg=7/bg=7 的空白 → **誤報來源**，必須不命中。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import { u2b } from "../../src/js/string_util";
import {
  detectHiddenRow,
  ERASED_RUN_MIN_DARK,
  ERASED_RUN_MIN_COLOR,
} from "../../src/js/hidden_text";

loadBig5Tables();

// 餵一段 ANSI 進 row 0，回傳那一列的 TermChar[]。
function row(ansi) {
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
  parser.feed("\x1b[H\x1b[2J" + ansi);
  buf.notify(); // updateCharAttr：DBCS lead byte 的旗標在這裡才寫上
  return buf.lines[0];
}

const detect = (ansi) => detectHiddenRow(row(ansi));
const big5 = (s) => u2b(s);

describe("軌 A：fg===bg 且有字（server 沒擦掉，本地提亮救得回來）", () => {
  test("ESC[30m + 中文（DBCS 例外，實測 `中文測試2` 的中文那半）", () => {
    expect(detect("\x1b[30m" + big5("中文測試"))).toEqual({
      lit: true,
      erased: false,
    });
  });

  test("同一列上「保留的中文」與「被擦掉的 1 格」並存 → 只有軌 A 命中", () => {
    // 錄製檔實錄：`中文測試2` 在預設模式送的是 中文測試 的 Big5 位元組 ＋ 1 個 0x20。
    // 那 1 格低於黑底門檻（2），刻意不算軌 B —— 這一列靠中文命中就夠了。
    expect(detect("\x1b[30m" + big5("中文測試") + " ")).toEqual({
      lit: true,
      erased: false,
    });
  });

  test("ESC[34;44m 藍字藍底 + 有字 → 軌 A（判準是 fg===bg，不是「黑」）", () => {
    expect(detect("\x1b[34;44mhidden").lit).toBe(true);
  });

  test("ESC[7;30;40m（reverse 同色）+ 有字 → 軌 A（getFg/getBg 已攤平 invert）", () => {
    expect(detect("\x1b[7;30;40mhidden").lit).toBe(true);
  });
});

describe("軌 B：fg===bg 且是空白（server 已擦掉，只能切 rawmode 重取）", () => {
  test("ESC[30m + 9 個空白（實測 `abc test2`）", () => {
    expect(detect("\x1b[30m" + " ".repeat(9))).toEqual({
      lit: false,
      erased: true,
    });
  });

  test("ESC[30m + 60 個空白（實測那條隱藏網址）", () => {
    expect(detect("\x1b[30m" + " ".repeat(60)).erased).toBe(true);
  });

  test("黑底門檻是 2：1 格不算、2 格算", () => {
    expect(ERASED_RUN_MIN_DARK).toBe(2);
    expect(detect("\x1b[30m x").erased).toBe(false);
    expect(detect("\x1b[30m  x").erased).toBe(true);
  });
});

describe("誤報防線", () => {
  test("狀態列的 fg=7/bg=7 兩格空白 → 不命中（彩底門檻 8）", () => {
    expect(ERASED_RUN_MIN_COLOR).toBe(8);
    // 實錄：文章狀態列開頭是 ESC[0;47m 後兩個空白，接著才換色寫字。
    expect(
      detect("\x1b[0;47m  \x1b[0;44;37m" + big5("瀏覽 第 1/1 頁")),
    ).toEqual({ lit: false, erased: false });
  });

  test("彩底連續 8 格才算（選單／狀態列的大片彩底空白）", () => {
    expect(detect("\x1b[0;47m" + " ".repeat(7)).erased).toBe(false);
    expect(detect("\x1b[0;47m" + " ".repeat(8)).erased).toBe(true);
  });

  test("ESC[1;30m（fg=8 深灰，pmore grayout 用的）→ 兩軌都不命中", () => {
    // 判準若寫成 fg===0，每次按 `\` 進設定頁時整片上半畫面都會誤判。
    expect(detect("\x1b[1;30m" + big5("推 someone: 內容"))).toEqual({
      lit: false,
      erased: false,
    });
    expect(detect("\x1b[1;30m" + " ".repeat(60))).toEqual({
      lit: false,
      erased: false,
    });
  });

  test("ESC[0;30;47m 白底黑字（肉眼看得見）→ 不命中", () => {
    expect(detect("\x1b[0;30;47m" + big5("白底黑字"))).toEqual({
      lit: false,
      erased: false,
    });
  });

  test("ESC[K 擦出來的格是 fg=7/bg=0 → 不命中（不繼承當前 SGR）", () => {
    expect(detect("\x1b[30mx\x1b[K").erased).toBe(false);
  });

  test("一般文章列（預設 fg=7/bg=0）→ 兩軌都不命中", () => {
    expect(detect(big5("中文測試3"))).toEqual({ lit: false, erased: false });
    expect(detect("")).toEqual({ lit: false, erased: false });
  });
});
