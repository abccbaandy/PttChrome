// CSI 終結字元（final byte）的範圍守護。
//
// 背景：fork 來的 `ansi_parser.js` 判定 CSI 結束用的是
//   (ch >= '`' && ch <= 'z') || (ch >= '@' && ch <= 'Z')
// ＝ 0x60-0x7A 與 0x40-0x5A，比 ECMA-48 規定的 0x40-0x7E **少了九個字元**：
//   0x5B-0x5F（[ \ ] ^ _）與 0x7B-0x7E（{ | } ~）。
//
// 症狀不是「那一條序列被忽略」而是**整條資料流被吃掉**：parser 續留 STATE_CSI，
// 把後續所有畫面位元組累積進 this.esc，直到某個落在舊範圍的字元出現才「假結束」
// ——而且那個字元會被當成該序列的指令執行（`H` ⇒ 游標跳原點、`J` ⇒ 清畫面）。
// ⇒ 一條沒實作的 CSI 會變成「畫面從此壞掉」，而不是安靜的 no-op。
//
// 為什麼現在要修：PTT 2026-09 公告開始送 DEC private control sequence
// （`ESC[?2026h/l`），並明說「本站未來還會增加 XTerm SGR，或其它內容，希望各 App
// 與連線軟體一次完成對 DEC private control sequence 的相容性（不用實作內容，
// 只要讀到 sequence 不會壞掉即可）」。「讀到不會壞掉」的前提就是終結字元判對。
//
// 實測佐證（掃 tests/e2e/cassettes/*.json 全部 recv）：PTT 目前用過的 CSI 終結
// 字元只有 H / m / K / J 四種，全部落在舊範圍內 ⇒ 放寬範圍不可能回歸任何被實際
// 走過的路徑。這條掃描指令值得保留給下一個人：
//   node -e "…讀 cassettes，逐 byte 走 CSI 狀態機，統計終結字元…"
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

// 整列文字（去掉右側空白），用來斷言「字有沒有印出來、印在哪一列」。
function row(buf, r) {
  return buf.getRowText(r, 0, buf.cols).replace(/\s+$/, "");
}

describe("AnsiParser CSI final byte range", () => {
  beforeAll(() => {
    loadBig5Tables();
  });

  // 主回歸：修正前這一條會紅。
  //
  // 修正前的實際走法：`{`(0x7B) 不被當終結字元 ⇒ 續留 STATE_CSI ⇒ 'H'(0x48) 落在
  // 舊範圍 ⇒ 被當成這條 CSI 的終結字元 ⇒ 執行 case 'H'（CUP）⇒ 游標跳 (0,0)，
  // 而 'H' 這個字元本身被吃掉 ⇒ 畫面上只剩 "ELLO" 且印在原點。
  test("以 { 結尾的未知 CSI 不得吃掉後續輸出（wedge 回歸）", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);

    // 先把游標移到第 5 列，好證明「游標有沒有被誤跳回原點」。
    parser.feed(ESC + "[5;1H");
    expect(buf.cur_y).toBe(4);

    parser.feed(ESC + "[999{");
    parser.feed("HELLO");

    // 症狀鎖：整串印得出來，而且印在原本那一列。
    expect(row(buf, 4)).toBe("HELLO");
    expect(buf.cur_y).toBe(4); // 沒有被誤判的 CUP 拉回原點
    expect(row(buf, 0)).toBe(""); // 沒有跑到第 0 列去
    // parser 必須已經回到 TEXT 狀態、accumulator 清空。
    expect(parser.state).toBe(AnsiParser.STATE_TEXT);
    expect(parser.esc).toBe("");
  });

  // 九個缺口字元逐一參數化。
  const GAP_FINALS = ["[", "\\", "]", "^", "_", "{", "|", "}", "~"];
  test.each(GAP_FINALS)(
    "以 %s 結尾的未知 CSI 被安靜丟棄，後續文字照常印出",
    (final) => {
      const buf = makeBuf();
      const parser = new AnsiParser(buf);
      parser.feed(ESC + "[1" + final);
      parser.feed("X");
      expect(row(buf, 0)).toBe("X");
      expect(parser.state).toBe(AnsiParser.STATE_TEXT);
      expect(parser.esc).toBe("");
    }
  );

  // 舊範圍零退化：這四種就是 cassette 實測到 PTT 真正會送的全集。
  test("PTT 實際會送的四種 CSI 仍正常運作", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);

    parser.feed(ESC + "[2J"); // ED：清畫面
    parser.feed(ESC + "[5;10H"); // CUP
    expect(buf.cur_y).toBe(4);
    expect(buf.cur_x).toBe(9);

    parser.feed(ESC + "[1;33m"); // SGR
    parser.feed("ABC");
    expect(row(buf, 4)).toBe("         ABC".replace(/\s+$/, ""));
    expect(buf.getRowText(4, 9, 12)).toBe("ABC");

    parser.feed(ESC + "[K"); // EL：清到列尾
    expect(parser.state).toBe(AnsiParser.STATE_TEXT);
  });

  // `firstChar` 早退（ansi_parser.js:48）在放寬之後仍必須守住：帶私有前綴、
  // 終結字元不是 h/l 的序列一律丟棄，**不可以**掉進 case 'M'(deleteLine) 之類。
  test("私有前綴且非 h/l 結尾仍被丟棄（不得誤觸 deleteLine）", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(ESC + "[1;1H");
    parser.feed("ROW0");
    parser.feed(ESC + "[2;1H");
    parser.feed("ROW1");

    const spy = vi.spyOn(buf, "deleteLine");
    // XTerm SGR 滑鼠回報的形狀（我方不會收到，但它是最典型的 `<` 前綴 + 'M' 結尾）。
    parser.feed(ESC + "[<0;5;5M");
    expect(spy).not.toHaveBeenCalled();
    expect(row(buf, 0)).toBe("ROW0");
    expect(row(buf, 1)).toBe("ROW1");
    spy.mockRestore();
  });

  // DECRQM 查詢（`ESC[?2026$p`）：`$` 是 intermediate byte、`p` 是終結字元。
  // 我們不回覆，但**絕不可以 wedge**。
  test("DECRQM 查詢 ESC[?2026$p 零副作用且不 wedge", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(ESC + "[?2026$p");
    parser.feed("OK");
    expect(row(buf, 0)).toBe("OK");
    expect(parser.state).toBe(AnsiParser.STATE_TEXT);
    expect(parser.esc).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 中間位元組（0x20-0x2F）與 CSI 中止規則（2026-09-20 公告「請實作 ECMA-48」）
//
// 公告給的形狀是 `\x1B\[[0-?]*[ -/]*[@-~]`：參數位元組、中間位元組、終結字元
// 三段。舊碼把前兩段塞進同一個 accumulator，靠「終結字元剛好沒命中任何 case」
// 才沒出事；中止規則則整個沒有，被截斷的 CSI 會併吞下一條。
//
// 中止規則照抄 server 端 common/sys/vtkbd.c:230-256，兩邊對「被切斷的序列」
// 要有同一套認知。
describe("AnsiParser CSI 中間位元組與中止規則", () => {
  beforeAll(() => {
    loadBig5Tables();
  });

  // 每一條的終結字元都是我們**有實作**的指令，所以「被丟棄」與「被執行」
  // 兩種結果在畫面上分得出來。
  const WITH_INTERMEDIATE = [
    [ESC + "[0 q", "DECSCUSR（游標形狀）"],
    [ESC + "[!p", "DECSTR（軟重置）"],
    [ESC + "[?2026$p", "DECRQM（模式查詢）"],
    [ESC + "[1 @", "帶中間位元組的 ICH 形狀"],
  ];
  test.each(WITH_INTERMEDIATE)(
    "含中間位元組的 %s 一律丟棄且不觸發同名指令",
    (seq) => {
      const buf = makeBuf();
      const parser = new AnsiParser(buf);
      const insert = vi.spyOn(buf, "insert");
      parser.feed(ESC + "[1;1H");
      parser.feed("KEEP");
      parser.feed(seq);
      parser.feed("!");
      expect(insert).not.toHaveBeenCalled();
      expect(row(buf, 0)).toBe("KEEP!");
      expect(parser.state).toBe(AnsiParser.STATE_TEXT);
      expect(parser.esc).toBe("");
      expect(parser.escInter).toBe("");
      insert.mockRestore();
    }
  );

  // 主回歸：被切斷的 CSI 併吞下一條。修正前 esc 會變成 "3\x1b[2"、終結字元 'J'
  // ⇒ parseInt("3\x1b[2") = 3 ⇒ term.clear(3)，而真正的 ESC[2J 從沒被執行。
  test("CSI 中途遇到 ESC 會重啟，不得併吞下一條序列", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(ESC + "[1;1H");
    parser.feed("DIRTY");

    const clear = vi.spyOn(buf, "clear");
    parser.feed(ESC + "[3"); // 被截斷的 CSI
    parser.feed(ESC + "[2J"); // 真正要執行的 ED
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(2);
    clear.mockRestore();
  });

  test.each([
    ["\x18", "CAN"],
    ["\x1a", "SUB"],
  ])("CSI 中途遇到 %s 整條丟棄，後續文字照常", (abortChar) => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    const clear = vi.spyOn(buf, "clear");
    parser.feed(ESC + "[2" + abortChar);
    parser.feed("J"); // 這個 J 必須是字面字元，不是 ED
    expect(clear).not.toHaveBeenCalled();
    expect(row(buf, 0)).toBe("J");
    expect(parser.state).toBe(AnsiParser.STATE_TEXT);
    clear.mockRestore();
  });

  // 其餘 C0 不只是「不被吃掉」，而是要**退回去照常處理**：PTT 的畫面靠 \r\n
  // 推進，被序列吞掉一個就整列錯位。
  test("CSI 中途遇到 CR/LF 會中止並讓它照常生效", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed("ROW0");
    parser.feed(ESC + "[12\r\n"); // 截斷的 CSI + 換行
    parser.feed("ROW1");
    expect(row(buf, 0)).toBe("ROW0");
    expect(row(buf, 1)).toBe("ROW1");
    expect(parser.state).toBe(AnsiParser.STATE_TEXT);
  });

  // 保險絲：終結字元永遠不來時不可以把整個畫面累積進 parser 狀態。
  //
  // 放棄的方式是「丟掉內容但**留在 CSI 態**」：中途跳回 TEXT 會把序列剩下的
  // 位元組當文字印出來，畫面上就是一串 `;1;1;1…` 的垃圾。
  test("超長 CSI 參數放棄內容但仍吃到終結字元，不得印出垃圾字", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    const sgr = vi.spyOn(buf, "assignParamsToAttrs");

    parser.feed(ESC + "[" + "1;".repeat(200));
    // 放棄內容，但還沒收到終結字元 ⇒ 必須留在 CSI 態繼續吞。
    expect(parser.state).toBe(AnsiParser.STATE_CSI);
    expect(parser.esc).toBe("");

    parser.feed("m"); // 終結字元：整條丟棄，不得套用任何屬性
    expect(sgr).not.toHaveBeenCalled();
    expect(parser.state).toBe(AnsiParser.STATE_TEXT);
    expect(parser.escDrop).toBe(false);

    parser.feed("BACK");
    expect(row(buf, 0)).toBe("BACK");
    sgr.mockRestore();
  });
});
