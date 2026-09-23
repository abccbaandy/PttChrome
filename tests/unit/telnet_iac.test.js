// TelnetConnection 的 IAC（0xFF）跳脫 —— RFC 854 §"IAC IAC"。
//
// 為什麼是真 bug 而不是理論問題：string_util.u2b 對「轉不出 Big5」的字元回
// '\xFF\xFD'（emoji 是最常見來源），而使用者貼上／輸入的文字一路走
// term_view.onTextInput → _convSend → TelnetConnection.convSend → socket。
// 0xFF 沒跳脫就是 telnet IAC ⇒ server 把它當命令起頭並吃掉後面的位元組
// （連線行為從此錯位）。長推文 UI 有 stripNonBig5 擋著，一般貼上沒有。
//
// 邊界：**協商回覆不可跳脫**（那裡的 0xFF 本來就是命令），所以跳脫只加在
// 資料路徑 send()/convSend()，_sendRaw 維持原樣。
import { TelnetConnection } from "../../src/js/telnet";
import { Event } from "../../src/js/event";
import { loadBig5Tables } from "./helpers/load_big5_tables";

const IAC = "\xff";
const SB = "\xfa";
const SE = "\xf0";
const WILL = "\xfb";
const DO = "\xfd";
const TERM_TYPE = "\x18";
const IS = "\x00";
const SEND = "\x01";

function makeConn() {
  const socket = { sent: [] };
  Event.mixin(socket);
  socket.send = (s) => socket.sent.push(s);
  const conn = new TelnetConnection(socket);
  return { conn, socket, wire: () => socket.sent.join("") };
}

function feed(socket, str) {
  socket.dispatchEvent(new CustomEvent("data", { detail: { data: str } }));
}

describe("送出端：資料路徑要把 IAC 加倍", () => {
  it("send() 的單一 0xFF 變成 0xFF 0xFF", () => {
    const { conn, wire } = makeConn();
    conn.send(IAC);
    expect(wire()).toBe(IAC + IAC);
  });

  it("send() 不動一般位元組（方向鍵這類控制序列原封不動）", () => {
    const { conn, wire } = makeConn();
    conn.send("\x1b[D");
    expect(wire()).toBe("\x1b[D");
  });

  it("convSend() 的 emoji：u2b 產生的 0xFF 也要跳脫", () => {
    loadBig5Tables();
    const { conn, wire } = makeConn();
    conn.convSend("\u{1F44D}"); // 👍：兩個 code unit 都轉不出 Big5 → '\xFF\xFD' ×2
    // 跳脫後每個 0xFF 成對；wire 上不存在「單獨一個 0xFF」。
    expect(wire()).toBe("\xff\xff\xfd\xff\xff\xfd");
  });

  it("convSend() 的純 ASCII 不受影響", () => {
    loadBig5Tables();
    const { conn, wire } = makeConn();
    conn.convSend("hello");
    expect(wire()).toBe("hello");
  });
});

describe("協商回覆維持原始 IAC（不可跳脫）", () => {
  it("IAC DO TERM_TYPE → IAC WILL TERM_TYPE", () => {
    const { socket, wire } = makeConn();
    feed(socket, IAC + DO + TERM_TYPE);
    expect(wire()).toBe(IAC + WILL + TERM_TYPE);
  });

  it("TERM_TYPE 子協商回覆的頭尾 IAC 不加倍", () => {
    const { socket, wire } = makeConn();
    feed(socket, IAC + SB + TERM_TYPE + SEND + IAC + SE);
    expect(wire()).toBe(IAC + SB + TERM_TYPE + IS + "VT100" + IAC + SE);
  });
});

describe("接收端：IAC IAC 還原成一個資料位元組", () => {
  it("不再被靜默丟掉", () => {
    const { conn, socket } = makeConn();
    const got = [];
    conn.addEventListener("data", (e) => got.push(e.detail.data));
    feed(socket, "a" + IAC + IAC + "b");
    expect(got.join("")).toBe("a\xffb");
  });
});

// 防閒置／連線保持：IAC DO TIMING-MARK（RFC 860）。PTT 站方公告（PttCurrent
// 2026-09-23）＋ pttbbs common/sys/telnet.c IAC_WAIT_OPT default 分支：未知 option
// 的 DO 回 WONT，位元組在 telnet 層就被吃掉、不進 vkey ⇒ 不影響畫面／輸入狀態。
describe("TIMING-MARK（防閒置 keep-alive）", () => {
  const WONT = "\xfc";
  const DONT = "\xfe";
  const TM = "\x06";

  it("sendTimingMark() 線上恰為 FF FD 06（不加倍 IAC、不動 vtkbd 推算狀態）", () => {
    const { conn, wire } = makeConn();
    conn.send("\x1b"); // 懸空 ESC：TM 不該化解或改變它
    const before = conn._vkState;
    const sentBefore = wire();
    conn.sendTimingMark();
    expect(wire().slice(sentBefore.length)).toBe(IAC + DO + TM);
    expect(conn._vkState).toBe(before);
  });

  it("收到 IAC WONT TM：不當資料、不回覆", () => {
    const { conn, socket, wire } = makeConn();
    const got = [];
    conn.addEventListener("data", (e) => got.push(e.detail.data));
    feed(socket, IAC + WONT + TM);
    expect(got).toEqual([]);
    expect(wire()).toBe("");
  });

  it("收到 IAC WILL TM：不當資料、也不回 IAC DONT TM", () => {
    const { conn, socket, wire } = makeConn();
    const got = [];
    conn.addEventListener("data", (e) => got.push(e.detail.data));
    feed(socket, IAC + WILL + TM);
    expect(got).toEqual([]);
    expect(wire()).not.toContain(IAC + DONT + TM);
    expect(wire()).toBe("");
  });

  it("只含協商 bytes 的封包也更新 lastRecvAt（WONT TM 就是這種封包）", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const { conn, socket } = makeConn();
      vi.setSystemTime(5000);
      feed(socket, IAC + WONT + TM);
      expect(conn.lastRecvAt).toBe(5000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("任何送出都更新 lastSendAt", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2000);
      const { conn } = makeConn();
      vi.setSystemTime(7000);
      conn.send("a");
      expect(conn.lastSendAt).toBe(7000);
      vi.setSystemTime(9000);
      conn.sendTimingMark();
      expect(conn.lastSendAt).toBe(9000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("abort()：半開斷線時立刻收攤", () => {
  it("關 socket 並立即 dispatch 一次 close；之後 socket 遲到的 close 不再觸發", () => {
    const { conn, socket } = makeConn();
    socket.close = vi.fn();
    let closes = 0;
    conn.addEventListener("close", () => closes++);
    conn.abort();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(closes).toBe(1);
    socket.dispatchEvent(new CustomEvent("close"));
    expect(closes).toBe(1);
  });

  it("abort 之後遲到的資料不再往上送", () => {
    const { conn, socket } = makeConn();
    socket.close = () => {};
    const got = [];
    conn.addEventListener("data", (e) => got.push(e.detail.data));
    conn.abort();
    feed(socket, "late");
    expect(got).toEqual([]);
  });

  it("正常 close 也只 dispatch 一次", () => {
    const { conn, socket } = makeConn();
    let closes = 0;
    conn.addEventListener("close", () => closes++);
    socket.dispatchEvent(new CustomEvent("close"));
    socket.dispatchEvent(new CustomEvent("close"));
    expect(closes).toBe(1);
  });
});
