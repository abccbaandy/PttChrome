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
