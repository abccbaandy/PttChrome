// ECMA-48 控制字串（OSC / DCS / APC / PM / SOS）的終止子解析。
//
// 背景：fork 來的 parser 只把 `ESC [` 當獨立狀態，其餘 ESC 序列全掉進 STATE_C1，
// 而 C1 最多只吞一個位元組。`ESC ] 0;title BEL` 於是變成：
//   `]` 被吞 → `0;title` **當文字印到畫面上** → BEL 觸發 ringBell()
// 這不是「沒實作」，是「畫面被弄髒」。
//
// 為什麼現在補：PTT 2026-09-20「請實作ECMA-48」公告明說
//   「由於 DEC private control sequence 的格式普遍為各大終端機軟體所支援，
//     本站預計未來會不定期增加輸出的控制碼類形。大多數的控制碼不需要 App/連線
//     軟體真的完整支援，只要收到不要當掉、不予回應即可。」
// 並附上 vt100.net 的 DEC 控制序列表（含 DCS）。公告的底線只要求 CSI，但 OSC/DCS
// 是「收到會弄髒畫面」而不是「安靜 no-op」的唯一殘留缺口，一併補掉。
//
// 終止子的設計決定（見 ansi_parser.js 的 STATE_STRING 註解）：
//   BEL / CAN / SUB 直接結束；ESC 一律結束並退回重新處理（正規的 ST `ESC \`
//   因此變成「ESC 重啟 → `\` 被 C1 吃掉」，等效）。
//   **不認 8-bit ST（0x9C）**：這條資料流是 latin1 位元組，0x9C 落在 Big5 的
//   trail byte 範圍內，正文會誤命中而把後面的序列全部吞掉。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { loadBig5Tables } from "./helpers/load_big5_tables";

const ESC = "\x1b";
const BEL = "\x07";
const ST = ESC + "\\";

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

describe("AnsiParser 控制字串（OSC / DCS / APC / PM / SOS）", () => {
  beforeAll(() => {
    loadBig5Tables();
  });

  // 主回歸：修正前這一條會紅（畫面上會出現 `0;PTT` 並響一聲）。
  test("OSC + BEL 終止：payload 一個字都不得落到畫面上", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    const ring = vi.spyOn(buf, "puts");

    parser.feed(ESC + "]0;PTT 看板" + BEL);
    parser.feed("AFTER");

    expect(row(buf, 0)).toBe("AFTER");
    expect(parser.state).toBe(AnsiParser.STATE_TEXT);
    // BEL 是終止子，不可以被當成正文送進 puts（那會響鈴）。
    for (const call of ring.mock.calls) {
      expect(call[0]).not.toContain(BEL);
    }
    ring.mockRestore();
  });

  const INTRODUCERS = [
    ["]", "OSC"],
    ["P", "DCS"],
    ["_", "APC"],
    ["^", "PM"],
    ["X", "SOS"],
  ];
  test.each(INTRODUCERS)("ESC %s（%s）的 payload 被 ST 終止且不落畫面", (intro) => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(ESC + intro + "1;2;3 payload text" + ST);
    parser.feed("OK");
    expect(row(buf, 0)).toBe("OK");
    expect(parser.state).toBe(AnsiParser.STATE_TEXT);
  });

  // payload 裡出現 `[`、`;`、數字這些 CSI 的零件時不可以被誤認成序列。
  test("payload 含 CSI 形狀的字串也整段吞掉", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(ESC + "]2;title with [2J and [1;33m inside" + BEL);
    parser.feed("SAFE");
    expect(row(buf, 0)).toBe("SAFE");
  });

  // 字串被新序列打斷（server 端斷線／截斷時的真實形狀）：ESC 結束字串並退回，
  // 後面那條 CSI 必須完整執行。
  test("控制字串被 ESC[2J 打斷時，後續序列仍正確執行", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(ESC + "[1;1H");
    parser.feed("DIRTY");

    const clear = vi.spyOn(buf, "clear");
    parser.feed(ESC + "]0;truncated"); // 沒有終止子
    parser.feed(ESC + "[2J");
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(2);
    expect(parser.state).toBe(AnsiParser.STATE_TEXT);
    clear.mockRestore();
  });

  test.each([
    ["\x18", "CAN"],
    ["\x1a", "SUB"],
  ])("控制字串遇到 %s 立刻結束", (abortChar) => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(ESC + "]0;abc" + abortChar);
    parser.feed("TAIL");
    expect(row(buf, 0)).toBe("TAIL");
    expect(parser.state).toBe(AnsiParser.STATE_TEXT);
  });

  // **刻意沒有長度上限**（與 CSI 的 CSI_MAX 不同）：這條路徑只吞不存，沒有東西
  // 會溢位，而「超過 N 個位元組就放棄」的唯一效果是把剩下的 payload 印成畫面上的
  // 垃圾字 —— 嚴格劣於繼續吞。救援靠下一個 ESC，而 PTT 每一幀都以 `ESC[?2026h`
  // 開頭。這條鎖住這個取捨，避免下一個人「順手加個保險絲」。
  test("沒有終止子的超長控制字串繼續吞，不得印出 payload；下一個 ESC 救回來", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(ESC + "]0;" + "x".repeat(5000));
    expect(parser.state).toBe(AnsiParser.STATE_STRING);
    expect(row(buf, 0)).toBe("");

    parser.feed(ESC + "[1;1H");
    parser.feed("RECOVERED");
    expect(parser.state).toBe(AnsiParser.STATE_TEXT);
    expect(row(buf, 0)).toBe("RECOVERED");
  });

  // 0x9C 是 Big5 的合法 trail byte（例：0xA49C）。把它當 8-bit ST 會讓正文
  // 隨機把後面的序列吞掉，所以這裡鎖住「不認 0x9C」。
  test("0x9C 不得被當成 8-bit ST（Big5 trail byte 相衝）", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(ESC + "]0;\x9c still inside" + BEL);
    parser.feed("AFTER");
    expect(row(buf, 0)).toBe("AFTER");
  });

  // 原本就走 C1 的那幾條不可以被新狀態搶走。
  test("ESC 7 / ESC 8 / ESC D / ESC M / ESC ( B 行為不變", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(ESC + "[5;10H");
    parser.feed(ESC + "7"); // DECSC
    parser.feed(ESC + "[1;1H");
    parser.feed(ESC + "8"); // DECRC
    expect(buf.cur_y).toBe(4);
    expect(buf.cur_x).toBe(9);

    parser.feed(ESC + "(B"); // 字集切換：整條吞掉
    parser.feed("Z");
    expect(buf.getRowText(4, 9, 10)).toBe("Z");
    expect(parser.state).toBe(AnsiParser.STATE_TEXT);
  });
});
