// AnsiParser 的 DECSET/DECRST 分派：哪些模式會被轉發、哪些必須安靜忽略。
import { AnsiParser } from "../../src/js/ansi_parser";

const ESC = "\x1b";

// 精簡 stub：只記錄被呼叫到的模式。刻意不是真 TermBuf——這裡要測的是分派，
// 不是狀態機（狀態機在 mouse_report_modes.test.js）。
function makeStub() {
  const calls = [];
  return {
    calls,
    beginSyncUpdate() {
      calls.push(["BSU"]);
    },
    endSyncUpdate() {
      calls.push(["ESU"]);
    },
    handleDECSET(m) {
      calls.push(["SET", m]);
    },
    handleDECRST(m) {
      calls.push(["RST", m]);
    },
    // AnsiParser.feed 的其他路徑會用到的最小面
    puts() {},
    gotoPos() {}
  };
}

describe("AnsiParser DECSET/DECRST dispatch", () => {
  test("2026 只走 sync update，不得誤送進 handleDECSET", () => {
    const t = makeStub();
    const p = new AnsiParser(t);
    p.feed(ESC + "[?2026h" + ESC + "[?2026l");
    expect(t.calls).toEqual([["BSU"], ["ESU"]]);
  });

  test("四個滑鼠模式各自轉發", () => {
    const t = makeStub();
    const p = new AnsiParser(t);
    p.feed(ESC + "[?1000h" + ESC + "[?1002h" + ESC + "[?1003h" + ESC + "[?1006h");
    p.feed(ESC + "[?1000l" + ESC + "[?1006l");
    expect(t.calls).toEqual([
      ["SET", 1000],
      ["SET", 1002],
      ["SET", 1003],
      ["SET", 1006],
      ["RST", 1000],
      ["RST", 1006]
    ]);
  });

  test("多參數形式逐個轉發（ESC[?1000;1006h）", () => {
    const t = makeStub();
    const p = new AnsiParser(t);
    p.feed(ESC + "[?1000;1006h");
    expect(t.calls).toEqual([
      ["SET", 1000],
      ["SET", 1006]
    ]);
  });

  test("2026 與滑鼠模式混在同一條時各走各的", () => {
    const t = makeStub();
    const p = new AnsiParser(t);
    p.feed(ESC + "[?2026;1000h");
    expect(t.calls).toEqual([["BSU"], ["SET", 1000]]);
  });

  test.each([25, 47, 1001, 1005, 1015, 1047, 1049, 2004])(
    "未支援的 DEC 私有模式 %i 完全不轉發",
    (mode) => {
      const t = makeStub();
      const p = new AnsiParser(t);
      p.feed(ESC + "[?" + mode + "h" + ESC + "[?" + mode + "l");
      expect(t.calls).toEqual([]);
    }
  );

  test("跨 feed 切割仍正確分派", () => {
    const t = makeStub();
    const p = new AnsiParser(t);
    p.feed(ESC + "[?10");
    p.feed("00;10");
    p.feed("06h");
    expect(t.calls).toEqual([
      ["SET", 1000],
      ["SET", 1006]
    ]);
  });

  test("非私有前綴的 h/l（ESC[4h）不得轉發", () => {
    const t = makeStub();
    const p = new AnsiParser(t);
    p.feed(ESC + "[4h" + ESC + "[4l" + ESC + "[2026h");
    expect(t.calls).toEqual([]);
  });
});
