// TelnetConnection 的裸 ESC 守門（送出端鏡像 pttbbs vtkbd 的狀態機）。
//
// 重現的真實症狀（錄製檔 ptt-debug-20260916-011413.json#t=5494,6922,6933）：
// 關掉長推文輸入框之後那一下 Esc 送出**裸 ESC**（t=5494），1.4 秒後使用者按 ←
// 想離開文章（t=6922），畫面卻變成同主題的上一篇（t=6933）。原因是 server 的
// vtkbd 停在 VKSTATE_ESC，← 的開頭 ESC 被當成 esc_arg 吃掉，`[` 與 `D` 以字面鍵
// 落到 pager，而 `[` ＝ RELATE_PREV。完整推導見 src/js/vtkbd_send_state.js 檔頭。
//
// 掛在 _sendEscaped（send/convSend 的共同收斂點），所以協商路徑（_sendRaw）不受影響
// ——那些位元組被 server 的 telnet 層吃掉，進不了 vtkbd。
import { TelnetConnection } from "../../src/js/telnet";
import { Event } from "../../src/js/event";
import { loadBig5Tables } from "./helpers/load_big5_tables";

const IAC = "\xff";
const SE = "\xf0";
const WILL = "\xfb";
const DO = "\xfd";
const TERM_TYPE = "\x18";
const SB = "\xfa";
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

describe("裸 ESC 之後的方向鍵不可以退化成字面鍵", () => {
  it("Esc 之後按 ← → 線上是 ESC + ESC ESC [ D", () => {
    const { conn, wire } = makeConn();
    conn.sendUserKey("\x1b"); // 使用者（或漏出來的）那一下 Esc
    conn.sendUserKey("\x1b[D"); // ←：想離開文章
    expect(wire()).toBe("\x1b" + "\x1b\x1b[D");
  });

  it("Esc 之後按 PageDown 同理", () => {
    const { conn, wire } = makeConn();
    conn.sendUserKey("\x1b");
    conn.sendUserKey("\x1b[6~");
    expect(wire()).toBe("\x1b" + "\x1b\x1b[6~");
  });

  it("化解之後恢復正常：再按一次 ← 不再補", () => {
    const { conn, wire } = makeConn();
    conn.sendUserKey("\x1b");
    conn.sendUserKey("\x1b[D");
    conn.sendUserKey("\x1b[D");
    expect(wire()).toBe("\x1b" + "\x1b\x1b[D" + "\x1b[D");
  });
});

describe("不可誤傷的路徑", () => {
  it("沒有懸空 ESC 時，方向鍵原封不動", () => {
    const { conn, wire } = makeConn();
    conn.sendUserKey("\x1b[D");
    expect(wire()).toBe("\x1b[D");
  });

  it("ESC 組合鍵（編輯器的 ESC-L）保持原樣", () => {
    const { conn, wire } = makeConn();
    conn.sendUserKey("\x1b");
    conn.sendUserKey("L");
    expect(wire()).toBe("\x1bL");
  });

  it("連按兩下 Esc 不會愈補愈多", () => {
    const { conn, wire } = makeConn();
    conn.sendUserKey("\x1b");
    conn.sendUserKey("\x1b");
    expect(wire()).toBe("\x1b\x1b");
  });

  it("協商回覆不受影響，也不會動到按鍵狀態", () => {
    const { conn, socket, wire } = makeConn();
    conn.sendUserKey("\x1b");
    feed(socket, IAC + DO + TERM_TYPE);
    feed(socket, IAC + SB + TERM_TYPE + SEND + IAC + SE);
    conn.sendUserKey("\x1b[D");
    expect(wire()).toBe(
      "\x1b" +
        IAC +
        WILL +
        TERM_TYPE +
        IAC +
        SB +
        TERM_TYPE +
        IS +
        "VT100" +
        IAC +
        SE +
        "\x1b\x1b[D",
    );
  });

  it("與 IAC 加倍併存：守門在加倍之前，兩者都要成立", () => {
    loadBig5Tables();
    const { conn, wire } = makeConn();
    conn.sendUserKey("\x1b");
    conn.convSendUserKey("\u{1F44D}"); // u2b 回 '\xFF\xFD' ×2
    // 開頭不是 ESC 且走真鍵盤路徑 ⇒ 不補；0xFF 照樣加倍。
    expect(wire()).toBe("\x1b" + "\xff\xff\xfd\xff\xff\xfd");
  });

  it("新連線各自從乾淨狀態開始", () => {
    const a = makeConn();
    a.conn.sendUserKey("\x1b");
    const b = makeConn();
    b.conn.sendUserKey("\x1b[D");
    expect(b.wire()).toBe("\x1b[D");
  });
});

// send／convSend（＝CommandQueue、setBBSCmd、anti-idle、App.sendData 走的那條）
// 一律化解懸空的 ESC 態。ESC 組合鍵的保護只留在 sendUserKey／convSendUserKey，
// 而那兩個只有 term_view._send／_convSend 會叫（守護
// tests/unit/user_key_send_wiring.test.js）。
describe("機器送出一律化解懸空的 ESC 態", () => {
  it("Esc 漏出去之後，探路的 Q 仍到得了 PTT（ptt-debug-20260917-012944.json#t=529）", () => {
    const { conn, wire } = makeConn();
    conn.sendUserKey("\x1b"); // 使用者關掉長推文輸入框後多按的那一下
    conn.send("Q"); // CommandQueue 的 longpush-aid
    expect(wire()).toBe("\x1b" + "\x1bQ");
  });

  it("化解之後不再補：接下來的 X 原封不動", () => {
    const { conn, wire } = makeConn();
    conn.sendUserKey("\x1b");
    conn.send("Q");
    conn.send("X");
    expect(wire()).toBe("\x1b" + "\x1bQ" + "X");
  });

  it("沒有懸空 ESC 時，機器鍵原封不動", () => {
    const { conn, wire } = makeConn();
    conn.send("Q");
    conn.send("\x1b[6~");
    expect(wire()).toBe("Q" + "\x1b[6~");
  });

  it("convSend 也化解，而且 IAC 照樣加倍", () => {
    loadBig5Tables();
    const { conn, wire } = makeConn();
    conn.sendUserKey("\x1b");
    conn.convSend("\u{1F44D}");
    expect(wire()).toBe("\x1b" + "\x1b" + "\xff\xff\xfd\xff\xff\xfd");
  });

  it("協商路徑（_sendRaw）不套守門，也不動按鍵狀態", () => {
    const { conn, socket, wire } = makeConn();
    conn.sendUserKey("\x1b");
    conn.sendNaws(80, 24);
    conn.send("Q");
    expect(wire()).toBe(
      "\x1b" + IAC + SB + "\x1f" + "\x00\x50\x00\x18" + IAC + SE + "\x1bQ",
    );
    expect(socket.sent.length).toBe(3);
  });
});
