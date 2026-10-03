// TermBuf／AnsiParser 的解析路徑不需要 DOM（node project，沒有 document）。
//
// 為什麼要守：`yarn debug:screens`（scripts/debug-screens.mjs）在 node 裡用 app 自己的
// TermBuf/AnsiParser 把使用者的錄製檔解回畫面。以前 TermBuf 建構式無條件
// document.getElementById ⇒ CLI 只好用 jsdom 假造一份 DOM，而 jsdom 跟使用者的瀏覽器
// 行為不一致時，工具解出的畫面就可能跟實際不同。解析本身是純邏輯，DOM 只是建構式順手
// 拿 #BBSWindow（設滑鼠游標樣式用，用到的地方本來就判斷存在）。
import cassette from "../e2e/cassettes/cchat-list.json";
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { loadBig5Tables, decodeRecv } from "./helpers/load_big5_tables";

beforeAll(loadBig5Tables);

test("node 環境（沒有 document）可以建 TermBuf", () => {
  expect(typeof document).toBe("undefined");
  expect(() => new TermBuf(80, 24)).not.toThrow();
});

test("真錄製素材在沒有 DOM 的環境解得出畫面", () => {
  vi.useFakeTimers();
  try {
    const buf = new TermBuf(cassette.cols, cassette.rows);
    buf.setView({
      update() {},
      updateCursorPos() {},
      refreshCursorVisibility() {},
      blinkOn: false,
    });
    buf.useMouseBrowsing = false;
    const parser = new AnsiParser(buf);
    for (const step of cassette.steps) if (step.recv) parser.feed(decodeRecv(step.recv));
    buf.notify();
    const text = Array.from({ length: buf.rows }, (_, r) => buf.getRowText(r, 0, buf.cols)).join("\n");
    expect(text).toContain("C_Chat");
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
