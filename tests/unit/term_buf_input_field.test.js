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
import { u2b } from "../../src/js/string_util";
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

// ─── 游標 park 在「已知狀態列」右下角 ⇒ 不是輸入框 ─────────────────────────────
// vs_footer 的右段配色是 VCLR_FOOTER = ANSI_COLOR(0;30;47)（vtuikit.h:41）＝ fg0/bg7，
// 正好是輸入欄的指紋；caption 是 VCLR_FOOTER_CAPTION = 34;46（vtuikit.h:40），不反白
// ⇒ 光看顏色，「游標停在 vs_footer 右段」會被誤判成輸入框。
// PTT 動態指令列改版讓這件事變常態（CONFIRMED 讀碼 @ piaip.newui 7e35b24e）：
//   psb.c#psb_main：空列表不畫 > 游標，最後 move(b_lines, t_columns-1)（＝vs_footer 右段，
//     vs_footer 以 VCLR_FOOTER outc(" ") 填到 col 79）
//   more.c#pager_on_footer：pmore 右半改由 vs_cmd_bar 產生，同樣走 vs_footer 的 30;47
// 誤判的後果：nav_key_gate 擋掉觸控板返回／上一頁、mouse_regions 整幀 NONE
// （文章左側退出帶失效）、點擊改送 Ctrl-C（列表上＝ClearTagList）。
// 輸入框不可能與這兩種狀態列同時存在：vgetstring 的 prompt 從 col 0 覆寫整列。
describe("isCursorOnInputField — 游標停在狀態列右下角", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // 走真的 notify → updateCharAttr（getRowText 需要 isLeadByte）。
  function paint(screen) {
    const buf = new TermBuf(80, 24);
    buf.setView({
      update() {},
      updateCursorPos() {},
      refreshCursorVisibility() {},
      charset: "big5",
      blinkOn: false,
    });
    buf.useMouseBrowsing = false;
    new AnsiParser(buf).feed(u2b(screen));
    vi.advanceTimersByTime(300);
    return buf;
  }

  const width = (s) => {
    let w = 0;
    for (const ch of s) w += ch.charCodeAt(0) > 0x7f ? 2 : 1;
    return w;
  };
  const padCols = (s, cols) => s + " ".repeat(Math.max(0, cols - width(s)));
  const PARK = "\x1b[24;80H";

  // caption（34;46）＋右段 VCLR_FOOTER（30;47）填到行尾。
  const footer = (left, right) =>
    "\x1b[24;1H\x1b[34;46m" +
    left +
    "\x1b[30;47m" +
    padCols(right, 80 - width(left)) +
    "\x1b[m";

  test("新版 pmore 狀態列（右半是 vs_footer 的 30;47）⇒ false", () => {
    const buf = paint(
      "\x1b[1;1H內文" +
        footer(
          "  瀏覽 第 1/2 頁 ( 50%)  目前顯示: 第 01~22 行",
          "  (y)回應 (X)推文       (←)離開 (h)說明 "
        ) +
        PARK
    );
    expect(buf.cur_y).toBe(23);
    expect(buf.cur_x).toBe(79);
    expect(buf.isCursorOnInputField()).toBe(false);
  });

  test("新版空文章列表（無 > 游標、游標停 23,79）⇒ false", () => {
    const buf = paint(
      "\x1b[1;1H\x1b[30;47m" +
        padCols("【板主:none】  看板《Test》", 80) +
        "\x1b[m\x1b[4;1H    沒有文章..." +
        footer(" 文章列表 ", " (^P)發表                                            (h)說明 ") +
        PARK
    );
    expect(buf.isCursorOnInputField()).toBe(false);
  });

  test("舊版 vs_footer（文章選讀）＋游標在右下角 ⇒ 同樣 false", () => {
    const buf = paint(
      footer(" 文章選讀 ", " (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題") + PARK
    );
    expect(buf.isCursorOnInputField()).toBe(false);
  });

  test("底列真的是 vgetstring prompt（反白欄、游標在欄內）⇒ 仍是 true", () => {
    const buf = paint(
      "\x1b[24;1H 搜尋標題: \x1b[0;7m" + " ".repeat(40) + "\x1b[0m\x1b[24;12H"
    );
    expect(buf.isCursorOnInputField()).toBe(true);
  });
});

// 推文輸入欄的反白寬度＝vgetstring 的 len＝maxlength（長推文單則上限的權威來源）。
// bytes 取自 ptt-debug-20260924-221056.json#t=4660（IP 板）／t=17273（非 IP 板），
// 帳號換成同長度（10 字）的佔位 id。
describe("inputFieldWidth", () => {
  const pushPrompt = (len) =>
    "\x1b[24;1H\x1b[1;33m" + u2b("推") + "\x1b[m tester1234: \x1b[30;47m" +
    " ".repeat(len) + "\x1b[m\x1b[K\x1b[24;16H";

  test("IP 板的推文輸入欄 36 格", () => {
    const buf = makeBuf();
    feed(buf, pushPrompt(36));
    expect(buf.inputFieldWidth()).toBe(36);
  });

  test("非 IP 板的推文輸入欄 51 格", () => {
    const buf = makeBuf();
    feed(buf, pushPrompt(51));
    expect(buf.inputFieldWidth()).toBe(51);
  });

  test("欄內已經打了字（echo 也是 30;47）⇒ 仍量到整欄", () => {
    const buf = makeBuf();
    feed(buf, pushPrompt(51) + "\x1b[30;47mjfkdl\x1b[m");
    expect(buf.inputFieldWidth()).toBe(51);
  });

  test("游標不在輸入欄上 ⇒ null", () => {
    const buf = makeBuf();
    feed(buf, pushPrompt(51) + "\x1b[6;1H");
    expect(buf.inputFieldWidth()).toBe(null);
  });

  test("整列反白的表頭 ⇒ null", () => {
    const buf = makeBuf();
    feed(buf, "\x1b[3;1H\x1b[30;47m" + " ".repeat(80) + "\x1b[0m\x1b[3;40H");
    expect(buf.inputFieldWidth()).toBe(null);
  });
});
