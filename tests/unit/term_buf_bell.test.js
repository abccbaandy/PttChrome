// term_buf 收到 BEL（^G）要真的去響 —— 上游是 `case '\x07': continue`，整個吞掉。
//
// 這條與 bell.test.js 互補：那邊測「響的規則」（gating／節流／不 throw），
// 這邊測「接線」——BEL 有沒有從畫面解析走到 ringBell，而且不會被當成一個字印出來。
import { TermBuf } from "../../src/js/term_buf";
import { ringBell } from "../../src/js/bell";

vi.mock("../../src/js/bell", () => ({
  ringBell: vi.fn(),
  setBellEnabled: vi.fn(),
}));

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

describe("term_buf 收到 BEL", () => {
  beforeEach(() => {
    ringBell.mockClear();
  });

  test("^G 會去響（是否真的出聲由 pref／節流決定，不在這裡判斷）", () => {
    const buf = makeBuf();
    buf.gotoPos(0, 0);
    buf.puts("\x07");
    expect(ringBell).toHaveBeenCalledTimes(1);
  });

  test("^G 不佔畫面格子，前後的字照常寫進去", () => {
    const buf = makeBuf();
    buf.gotoPos(0, 0);
    buf.puts("a\x07b");
    expect(buf.lines[0][0].ch).toBe("a");
    expect(buf.lines[0][1].ch).toBe("b");
    expect(buf.cur_x).toBe(2);
  });

  test("一串連發也是逐次呼叫（節流是 bell.js 的事，不在解析層做）", () => {
    const buf = makeBuf();
    buf.gotoPos(0, 0);
    buf.puts("\x07\x07\x07");
    expect(ringBell).toHaveBeenCalledTimes(3);
  });
});
