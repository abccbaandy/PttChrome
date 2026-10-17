// 線路編碼轉接層（src/js/wire_charset.js）＋ telnet 層接線 ＋ CPR 編碼偵測。
//
// 鎖的行為：
//   1. UTF-8 收進來、Big5 收得下的字與 Big5 連線收到的位元組完全相同。
//   2. Big5 收不下的字存成 Unicode 格（src/js/unicode_cells.js），寬度照 server 的
//      ucs_width（server 依寬度算游標，錯一格整列錯位）；線路壞掉才是半形 ?。
//   3. logind 的編碼偵測（daemon/logind/logind.c#login_ctx_activate 送
//      `\r\xc4\xa1 ESC[6n`，login_conn_handle_terminal 只在回報欄 == 2 時切 UTF-8）：
//      UTF-8 線路下回報 col 2；Big5 線路下維持不回應（ansi_parser_cpr.test.js）。
//   4. 送出：app 產生的 Big5 位元組在線路上變成 UTF-8，且不含 0xFF（不需 IAC 加倍）。
import {
  createUtf8Inbound,
  big5ToUtf8Wire,
  cursorPositionReport,
  normalizeWireCharset,
} from "../../src/js/wire_charset";
import { u2b } from "../../src/js/string_util";
import { WIDE_TRAIL } from "../../src/js/unicode_cells";
import { TelnetConnection } from "../../src/js/telnet";
import { Event } from "../../src/js/event";
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { loadBig5Tables } from "./helpers/load_big5_tables";

const ESC = "\x1b";
// 逐位元組照抄 logind.c#login_ctx_activate。
const LOGIND_PROBE = "\r\xc4\xa1" + ESC + "[6n";

// UTF-8 文字 → 一字元一 byte 的線路字串（websocket.js 的格式）。
function wire(text) {
  return String.fromCharCode(...new TextEncoder().encode(text));
}

beforeAll(() => {
  loadBig5Tables();
});

describe("收：UTF-8 → 內部格子編碼", () => {
  test("中文與 Big5 連線收到的位元組相同", () => {
    const inb = createUtf8Inbound();
    expect(inb.decode(wire("推文　測試"))).toBe(u2b("推文　測試"));
  });

  test("ASCII 與 ESC 序列原樣通過", () => {
    const inb = createUtf8Inbound();
    const s = ESC + "[1;33mHello" + ESC + "[m\r\n";
    expect(inb.decode(s)).toBe(s);
  });

  test("一個字被切在兩包之間仍正確組回", () => {
    const inb = createUtf8Inbound();
    const bytes = wire("看板");
    const out = inb.decode(bytes.slice(0, 4)) + inb.decode(bytes.slice(4));
    expect(out).toBe(u2b("看板"));
  });

  test("切塊停在字中間後下一包是純 ASCII：懸著的半個字不得被吞掉後消失成別的字", () => {
    const inb = createUtf8Inbound();
    const bytes = wire("看");
    const out = inb.decode(bytes.slice(0, 2)) + inb.decode("A");
    // 壞掉的序列結算成一個半形佔位，後面的 A 照常
    expect(out).toBe("?A");
  });

  test("Big5 收不下的字存成 Unicode 格：全形補一格右半、半形一格", () => {
    const inb = createUtf8Inbound();
    expect(inb.decode(wire("한국"))).toBe("한" + WIDE_TRAIL + "국" + WIDE_TRAIL);
    expect(inb.decode(wire("ġ"))).toBe("ġ");
    // Big5 收得下的字照舊是兩個位元組，夾在中間也一樣
    expect(inb.decode(wire("中한文"))).toBe(u2b("中") + "한" + WIDE_TRAIL + u2b("文"));
  });

  test("server 真的送 U+FFFD ⇒ 全形（ucs_width 2）；BMP 以外的字照 pfterm 換成 U+FFFD", () => {
    const inb = createUtf8Inbound();
    expect(inb.decode(wire("\ufffd"))).toBe("\ufffd" + WIDE_TRAIL);
    expect(inb.decode(wire("😀"))).toBe("\ufffd" + WIDE_TRAIL);
  });

  test("寬 0 的字丟掉（pfterm#out_mbchar 不輸出 w <= 0 的字）", () => {
    const inb = createUtf8Inbound();
    expect(inb.decode(wire("e\u0301x\u200d\ufe0fy"))).toBe("exy");
  });

  test("壞掉的 UTF-8 是半形 ?：落單的 continuation、overlong、不可能的開頭 byte", () => {
    const inb = createUtf8Inbound();
    expect(inb.decode("\x80A")).toBe("?A");
    expect(inb.decode("\xc0\xafB")).toBe("??B");
    expect(inb.decode("\xe0\x80\xafC")).toBe("?C");
    expect(inb.decode("\xffD")).toBe("?D");
  });

  test("logind 探針在 UTF-8 下是半形一格（U+0121 不在 UAO）", () => {
    const inb = createUtf8Inbound();
    expect(inb.decode(LOGIND_PROBE)).toBe("\rġ" + ESC + "[6n");
  });
});

describe("送：內部格子編碼 → UTF-8", () => {
  test("中文轉成 UTF-8", () => {
    expect(big5ToUtf8Wire(u2b("推文"))).toBe(wire("推文"));
  });

  test("ASCII／控制鍵原樣", () => {
    const s = "\x15" + ESC + "[A\rq";
    expect(big5ToUtf8Wire(s)).toBe(s);
  });

  test("u2b 的轉不出標記變成一個 ?，後面的 ASCII 不被誤吃", () => {
    // U+0121 不在 UAO：u2b 回一組 \xFF\xFD
    expect(big5ToUtf8Wire(u2b("ġ") + "ab")).toBe("?ab");
  });

  test("ansiHalfColorConv 的 raw 注入：色碼保留、字在 trail 到時才送", () => {
    const b5 = u2b("中");
    const injected = "\x00" + b5[0] + "\x15[1;33m" + b5[1];
    expect(big5ToUtf8Wire(injected)).toBe("\x00\x15[1;33m" + wire("中"));
  });

  test("Unicode 格直接轉 UTF-8，右半格丟掉", () => {
    expect(big5ToUtf8Wire("한" + WIDE_TRAIL + "ġ")).toBe(wire("한ġ"));
  });

  test("u2b 放行的 emoji 與組合字元照送", () => {
    expect(big5ToUtf8Wire("😀e\u0301")).toBe(wire("😀e\u0301"));
  });

  test("落單的 surrogate ⇒ ?", () => {
    expect(big5ToUtf8Wire("\ud83dA")).toBe("?A");
  });

  test("全形 Unicode 格被 raw-mode 一字雙色夾住：色碼先送、字等右半格", () => {
    const injected = "\x00한\x15[1;33m" + WIDE_TRAIL;
    expect(big5ToUtf8Wire(injected)).toBe("\x00\x15[1;33m" + wire("한"));
  });

  test("轉完的線路資料不含 0xFF", () => {
    const out = big5ToUtf8Wire(u2b("測試😀") + "\xff\xfd");
    expect(out.indexOf("\xff")).toBe(-1);
  });
});

describe("telnet 層接線", () => {
  function makeConn(charset) {
    const socket = { sent: [] };
    Event.mixin(socket);
    socket.send = (s) => socket.sent.push(s);
    const conn = new TelnetConnection(socket);
    if (charset) conn.setWireCharset(charset);
    const recv = [];
    conn.addEventListener("data", (e) => recv.push(e.detail.data));
    const feed = (s) =>
      socket.dispatchEvent(new CustomEvent("data", { detail: { data: s } }));
    return { conn, socket, recv, feed };
  }

  test("預設 Big5：收送都不轉", () => {
    const { conn, socket, recv, feed } = makeConn();
    expect(conn.wireCharset).toBe("big5");
    feed(u2b("中"));
    expect(recv.join("")).toBe(u2b("中"));
    conn.convSend("中");
    expect(socket.sent.join("")).toBe(u2b("中"));
  });

  test("UTF-8：收到的轉成 Big5、送出的轉成 UTF-8", () => {
    const { conn, socket, recv, feed } = makeConn("utf8");
    feed(wire("中"));
    expect(recv.join("")).toBe(u2b("中"));
    conn.convSend("中");
    expect(socket.sent.join("")).toBe(wire("中"));
  });

  test("UTF-8：Big5 收不下的字收進來是 Unicode 格、打出去是原字的 UTF-8", () => {
    const { conn, socket, recv, feed } = makeConn("utf8");
    feed(wire("한글"));
    expect(recv.join("")).toBe("한" + WIDE_TRAIL + "글" + WIDE_TRAIL);
    conn.convSend("한글😀");
    expect(socket.sent.join("")).toBe(wire("한글😀"));
  });

  test("切回 Big5 線路：u2b 恢復 '\\xFF\\xFD' 標記（「畫不出來」的判斷靠它）", () => {
    makeConn("utf8");
    expect(u2b("한")).toBe("한" + WIDE_TRAIL);
    makeConn("big5");
    expect(u2b("한")).toBe("\xff\xfd");
  });

  test("UTF-8：IAC 協商不受轉碼影響", () => {
    const { socket, recv, feed } = makeConn("utf8");
    feed("\xff\xfd\x18" + wire("字"));
    expect(socket.sent[0]).toBe("\xff\xfb\x18");
    expect(recv.join("")).toBe(u2b("字"));
  });

  test("未知值一律退回 Big5", () => {
    expect(normalizeWireCharset(undefined)).toBe("big5");
    expect(normalizeWireCharset("UTF-8")).toBe("big5");
    expect(normalizeWireCharset("utf8")).toBe("utf8");
  });
});

describe("CPR 編碼偵測（UTF-8 線路）", () => {
  function makeTerm() {
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
    const reports = [];
    parser.onCursorPositionRequest = (r, c) =>
      reports.push(cursorPositionReport(r, c));
    return { parser, reports };
  }

  test("探針經 UTF-8 解碼後，回報第二個參數 == 2（server 才會切 UTF-8）", () => {
    const { parser, reports } = makeTerm();
    parser.feed(createUtf8Inbound().decode(LOGIND_PROBE));
    expect(reports).toEqual([ESC + "[1;2R"]);
  });

  test("同一串若當 Big5 解讀，游標會在 col 3（＝不切換）", () => {
    const { parser, reports } = makeTerm();
    parser.feed(LOGIND_PROBE);
    expect(reports).toEqual([ESC + "[1;3R"]);
  });

  test.each([ESC + "[5n", ESC + "[?6n", ESC + "[n"])("%s 不回報", (seq) => {
    const { parser, reports } = makeTerm();
    parser.feed(seq);
    expect(reports).toEqual([]);
  });
});
