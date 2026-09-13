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
