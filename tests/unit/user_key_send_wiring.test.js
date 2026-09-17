// 送出到線路的入口分兩種，**界線是入口不是位元組內容**（推導見
// src/js/vtkbd_send_state.js 檔頭）：
//
//   conn.send / conn.convSend                 機器送出 → 懸空的 ESC 態一律化解
//   conn.sendUserKey / conn.convSendUserKey   真鍵盤／IME → 保留 ESC 組合鍵
//
// 後者**只有 term_view._send / _convSend 可以叫**。這條沒有 runtime 守得住
// （new App() 在 unit 起不來），而用錯的後果是靜默的：機器鍵誤用 userKey ⇒
// 使用者漏一個 Esc 之後那個鍵被吃成 esc_arg、**畫面不動零輸出**，看起來像 PTT
// 沒回應（2026-09-17 的「讀不到文章代碼（miss）」就是這樣來的）。
//
// 靜態掃描，風格比照 tests/unit/native_gesture_css.test.js。
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src/js");

function readAll() {
  return fs
    .readdirSync(SRC)
    .filter((f) => /\.jsx?$/.test(f))
    .map((f) => ({
      name: f,
      // 去掉行註解：這幾個名字在檔頭的說明文字裡大量出現。
      code: fs
        .readFileSync(path.join(SRC, f), "utf8")
        .replace(/^\s*\/\/.*$/gm, ""),
    }));
}

const FILES = readAll();
const fileNamed = (n) => FILES.find((f) => f.name === n);

describe("userKey 送出入口只有 term_view 一個", () => {
  test("沒有別的模組叫 conn.sendUserKey / convSendUserKey", () => {
    const offenders = FILES.filter(
      (f) =>
        f.name !== "term_view.js" &&
        f.name !== "telnet.js" &&
        /\.(send|convSend)UserKey\s*\(/.test(f.code),
    ).map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  test("term_view._send / _convSend 走的是 userKey 變體，沒有退回 conn.send", () => {
    const code = fileNamed("term_view.js").code;
    expect(code).toMatch(/_send:\s*function[\s\S]{0,120}?conn\.sendUserKey\(/);
    expect(code).toMatch(
      /_convSend:\s*function[\s\S]{0,120}?conn\.convSendUserKey\(/,
    );
    // term_view 是真鍵盤的出口，整份不該再有機器變體的呼叫。
    expect(code).not.toMatch(/\bconn\.send\s*\(/);
    expect(code).not.toMatch(/\bconn\.convSend\s*\(/);
  });
});

describe("機器送出的入口一個都不能漏掉守門", () => {
  // 四條機器路徑（CommandQueue／App.sendData／anti-idle／App.setBBSCmd）都在
  // pttchrome.jsx，而且刻意**維持 conn.send** —— 預設就是化解的那一邊，所以這裡
  // 守的是「別有人順手把它們改成 userKey」（上面第一條）與「別繞過 conn 直接打
  // socket」。
  // telnet.js（_sendRaw）與 websocket.js 是傳輸層自己，其餘都得走 conn。
  test("沒有任何模組繞過 TelnetConnection 直接 socket.send", () => {
    const offenders = FILES.filter(
      (f) =>
        f.name !== "websocket.js" &&
        f.name !== "telnet.js" &&
        /\bsocket\.send\s*\(/.test(f.code),
    ).map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  test("CommandQueue 的 send 綁的是 conn.send（機器，會化解）", () => {
    const code = fileNamed("pttchrome.jsx").code;
    expect(code).toMatch(
      /new CommandQueue\(\{[\s\S]{0,400}?this\.conn\.send\(/,
    );
  });
});
