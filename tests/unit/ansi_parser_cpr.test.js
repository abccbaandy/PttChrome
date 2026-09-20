// Cursor Position Report（`ESC[6n`）—— **本專案刻意不回應**，這支測試就是那個決定的閂鎖。
//
// PTT 2026-09-20 公告「新指令: Cursor Position Report」，PTT1 9/27、PTT2 9/20 上線：
//   「預期行為: App/Client 用 *[r;cR 格式回應目前游標位置, 或是忽略此指令。
//     PTT 的登入程式會利用這個命令來偵測 terminal 的狀態 (主要是 encoding)。
//     如果程式不想實作此命令可以忽略，但請注意測試不要當掉。」
//
// server 端實作（3rd_script/pttbbs，commit 3f031354 "logind: Auto-detect UTF-8 terminal"）：
//   daemon/logind/logind.c#login_ctx_activate
//       if (conn->ctx.encoding == CONV_NORMAL)
//           _buff_write(conn, "\r\xc3\xa2\033[6n", 7);
//     註解寫得很清楚：`\xc3\xa2 is valid for both Big5&UTF8 so can be used for detection.`
//       UTF-8 下是一個字 U+00E2（游標停在 col 2）
//       Big5  下是一個雙位元組字（游標停在 col 3）
//   daemon/logind/logind.c#login_conn_handle_terminal
//       if (raw_ch == 'R' && csi_prefix == 0 && csi_param_count == 2)
//           if (conn->vtkbd.csi_params[1] == 2) { ctx.encoding = CONV_UTF8; ... }
//     ⇒ **只有第二個參數 == 2** 會把 server 切成 UTF-8；其餘值與「完全不回應」
//       一樣留在 LOGIND_INITIAL_ENCODING（0 ＝ CONV_NORMAL ＝ Big5）。
//
// 本專案 term_view.js 寫死 `charset = 'big5'`（全 repo 無第二個寫入點），正確答案
// 永遠是「留在 Big5」。**不回應**零風險地達成它；而「順手把 CPR 實作起來」一旦把欄位
// 算成 2，代價是整站變亂碼。所以這裡鎖三件事：
//   1. 收到 `ESC[6n` 不當掉、不 wedge
//   2. **零回送**
//   3. 登入畫面那串 `\r \xc3\xa2 ESC[6n` 的畫面效果與不含 CPR 時完全相同
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { loadBig5Tables } from "./helpers/load_big5_tables";

const ESC = "\x1b";
// logind 送的偵測字串，逐位元組照抄 logind.c。
const DETECT = "\r\xc3\xa2" + ESC + "[6n";

// 任何「回送給 server」的呼叫都會經過 view.conn / bbscore。餵一個會記帳的 stub，
// 只要有人送東西出去就抓得到。
function makeBuf() {
  const sent = [];
  const buf = new TermBuf(80, 24);
  buf.setView({
    update() {},
    updateCursorPos() {},
    refreshCursorVisibility() {},
    blinkOn: false,
    charset: "big5",
    conn: {
      send: (b) => sent.push(b),
      sendUserKey: (b) => sent.push(b),
      convSend: (b) => sent.push(b),
      convSendUserKey: (b) => sent.push(b),
    },
    _send: (b) => sent.push(b),
    _convSend: (b) => sent.push(b),
  });
  buf.useMouseBrowsing = false;
  return { buf, sent };
}

function row(buf, r) {
  return buf.getRowText(r, 0, buf.cols).replace(/\s+$/, "");
}

describe("Cursor Position Report（ESC[6n）刻意不回應", () => {
  beforeAll(() => {
    loadBig5Tables();
  });

  test("logind 的偵測字串不觸發任何回送", () => {
    const { buf, sent } = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(DETECT);
    expect(sent).toEqual([]);
    expect(parser.state).toBe(AnsiParser.STATE_TEXT);
    expect(parser.esc).toBe("");
  });

  // 「不當掉」比「不回應」更基本：序列必須被完整讀完，後續畫面照常。
  test("ESC[6n 之後的畫面序列完全不受影響", () => {
    const { buf } = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(DETECT);
    parser.feed(ESC + "[2J" + ESC + "[1;1H");
    parser.feed("歡迎");
    expect(row(buf, 0)).toBe("歡迎");
  });

  // 位元組層級的等價性：拔掉 CPR 之後畫面應該一模一樣 —— 也就是 CPR 對我們是
  // 真正的 no-op，而不是「剛好看起來沒事」。
  test("含 CPR 與不含 CPR 的畫面完全相同", () => {
    const withCpr = makeBuf();
    new AnsiParser(withCpr.buf).feed(DETECT);
    const without = makeBuf();
    new AnsiParser(without.buf).feed("\r\xc3\xa2");

    for (let r = 0; r < withCpr.buf.rows; ++r) {
      expect(row(withCpr.buf, r)).toBe(row(without.buf, r));
    }
    expect(withCpr.buf.cur_x).toBe(without.buf.cur_x);
    expect(withCpr.buf.cur_y).toBe(without.buf.cur_y);
  });

  // DSR 的其他形式（5n 裝置狀態、?6n DECXCPR）同樣不得回送。
  test.each([ESC + "[5n", ESC + "[0n", ESC + "[?6n"])(
    "%s 同樣零回送且不 wedge",
    (seq) => {
      const { buf, sent } = makeBuf();
      const parser = new AnsiParser(buf);
      parser.feed(seq);
      parser.feed("X");
      expect(sent).toEqual([]);
      expect(row(buf, 0)).toBe("X");
    }
  );

  // 跨 feed() 切塊（WebSocket 會在任意位元組邊界切）也不可以變成回送或垃圾字。
  test("序列被切成兩個 feed 仍是 no-op", () => {
    const { buf, sent } = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(ESC + "[6");
    parser.feed("n");
    parser.feed("AFTER");
    expect(sent).toEqual([]);
    expect(row(buf, 0)).toBe("AFTER");
  });
});
