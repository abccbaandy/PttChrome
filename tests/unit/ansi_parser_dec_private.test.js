// DEC private mode 序列必須是**完全惰性**的（Phase A：相容性保證，零行為改變）。
//
// 背景：PTT 2026-09-08 公告，約 09-20 起 server 會送
//   - `ESC[?2026h` / `ESC[?2026l`（DEC 2026 Synchronized Output，BSU/ESU）
//   - 之後再加 `ESC[?1000h` ~ `ESC[?1006l`（XTerm SGR 滑鼠回報）
//
// server 端已驗證事實（vendored 3rd_script/pttbbs）：
//   - `DEC_SYNC_BEGIN/END` 包住**整個 doupdate()**（mbbsd/pfterm.c:53-54, 817-823, 1074-1075）
//   - **`!ft.dirty` 早退路徑也吐完整 BSU/ESU 對**（pfterm.c:824-829）⇒ 存在零內容 sync frame
//   - `term_init()` **無條件**呼叫 `term_enable_mouse(MOUSE_MODE_CLICK)`（mbbsd/term.c:136），
//     沒有 UF_MOUSE 的使用者（預設就是沒有）收到的是 **disable 四連**
//     ⇒ **每個 session 都會收到 DEC 序列**，不是只有開了滑鼠的人。
//   - 登入畫面不送（do_term_init 在 oklogin 之後，mbbsd/mbbsd.c:1548-1554）
//
// 這一組鎖的是：這些序列進來之後，畫面、游標、dirty row、settle 全部**不動**。
// 特別是 settle —— `term_buf` 的 settle timer 只由 `_touchRows()` 設的
// `_serverActivity`（內容）或 `posChanged`（游標）re-arm；DEC 序列兩者都不碰。
// 這件事是整個 easy-reading / list-session / command-queue 鏈的地基：如果 DEC
// 序列會 re-arm settle，PTT 每次回去等按鍵都吐一對空 BSU/ESU（io.c:451-452 的
// `while (vbuf_is_empty) refresh()`）就會把 settle 永遠往後推。
//
// 連帶記錄一個**文件層**的變化（不影響 code）：`docs/pttbbs-screen-protocol.md`
// 的不變量 P8「畫面沒變就零 bytes」自此不再成立（idle refresh 現在固定 16 bytes），
// 但依賴它的推論寫的都是「零 byte **零 settle** ⇒ 只能等 timeout」，而零 settle
// 仍然成立 ⇒ 既有 `fullRepaint: true`（附 \f）的解法依舊必要且正確。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { loadBig5Tables } from "./helpers/load_big5_tables";

const ESC = "\x1b";
const BSU = ESC + "[?2026h";
const ESU = ESC + "[?2026l";

// mbbsd/term.c:79-118 的四組實際字串，逐字抄過來。
const MOUSE_DISABLE_ALL =
  ESC + "[?1000l" + ESC + "[?1002l" + ESC + "[?1003l" + ESC + "[?1006l";
const MOUSE_CLICK = ESC + "[?1003l" + ESC + "[?1000h" + ESC + "[?1006h";
const MOUSE_DRAG = ESC + "[?1003l" + ESC + "[?1002h" + ESC + "[?1006h";
const MOUSE_TRACK = ESC + "[?1003h" + ESC + "[?1006h";

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

// 30ms queueUpdate -> notify -> _armSettleTimer(50ms) -> snapshot freeze.
function settle() {
  vi.advanceTimersByTime(300);
}

// 「這一串位元組完全沒有驚動 TermBuf」的完整斷言組。
function expectInert(buf, parser) {
  expect(buf.changed).toBe(false);
  expect(buf.posChanged).toBe(false);
  expect(buf._serverActivity).toBe(false);
  expect(buf.timerUpdate).toBe(null);
  expect(buf._settleTimer).toBe(null);
  expect(parser.state).toBe(AnsiParser.STATE_TEXT);
  expect(parser.esc).toBe("");
}

describe("AnsiParser DEC private modes are inert", () => {
  beforeAll(() => {
    loadBig5Tables();
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("純 BSU/ESU 對不改變任何 TermBuf 狀態", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    const x = buf.cur_x;
    const y = buf.cur_y;

    parser.feed(BSU + ESU);

    expectInert(buf, parser);
    expect(buf.cur_x).toBe(x);
    expect(buf.cur_y).toBe(y);
    expect(row(buf, 0)).toBe("");
  });

  test("BSU/ESU 不印出任何字元，前後文字仍相連", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed("ABC");
    parser.feed(BSU);
    parser.feed("DEF");
    parser.feed(ESU);
    settle();
    expect(row(buf, 0)).toBe("ABCDEF");
  });

  test("空 sync frame 不重新武裝 settle timer（settleSnapshot 維持同一物件）", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(ESC + "[2J" + ESC + "[1;1H" + "PAGE");
    settle();
    const snap1 = buf.settleSnapshot;
    expect(snap1).toBeTruthy();

    // PTT 每次回去等按鍵都會吐一對空的（!ft.dirty 早退路徑）。
    parser.feed(BSU + ESU);
    parser.feed(BSU + ESU);
    parser.feed(BSU + ESU);
    settle();

    expect(buf.settleSnapshot).toBe(snap1); // 同一物件＝完全沒有新的 settle
  });

  test.each([
    ["參數中間切開", [ESC + "[?20", "26h"]],
    ["終結字元前切開", [ESC + "[?2026", "h"]],
    ["ESC 之後切開", [ESC, "[?2026l"]],
  ])("跨 feed 切割仍正確（%s）", (_name, chunks) => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    for (const c of chunks) parser.feed(c);
    expectInert(buf, parser);
    expect(row(buf, 0)).toBe("");
  });

  test.each([
    ["disable 四連（無 UF_MOUSE 的使用者實際會收到的）", MOUSE_DISABLE_ALL],
    ["MOUSE_MODE_CLICK", MOUSE_CLICK],
    ["MOUSE_MODE_DRAG", MOUSE_DRAG],
    ["MOUSE_MODE_TRACK", MOUSE_TRACK],
  ])("PTT 滑鼠模式序列是惰性的：%s", (_name, seq) => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(seq);
    expectInert(buf, parser);
    expect(row(buf, 0)).toBe("");
  });

  test("多參數形式 ESC[?1000;1006h 零副作用", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(ESC + "[?1000;1006h");
    expectInert(buf, parser);
  });

  test("夾著真實內容的 sync frame：內容照畫，且恰好一次 settle", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    let settles = 0;
    buf.addEventListener("screenSettled", () => {
      settles += 1;
    });

    parser.feed(
      BSU + ESC + "[1;1H" + "HELLO" + ESC + "[24;1H" + ESU
    );
    settle();

    expect(row(buf, 0)).toBe("HELLO");
    expect(buf.cur_y).toBe(23); // 游標 park 在底列（pfterm 把它移進 sync block 內）
    expect(settles).toBe(1);
  });
});
