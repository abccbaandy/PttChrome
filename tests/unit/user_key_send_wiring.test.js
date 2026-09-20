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
    expect(code).toMatch(/_send:\s*function[\s\S]{0,320}?conn\.sendUserKey\(/);
    expect(code).toMatch(
      /_convSend:\s*function[\s\S]{0,320}?conn\.convSendUserKey\(/,
    );
    // term_view 是真鍵盤的出口，整份不該再有機器變體的呼叫。
    expect(code).not.toMatch(/\bconn\.send\s*\(/);
    expect(code).not.toMatch(/\bconn\.convSend\s*\(/);
  });
});

// 列表好讀的 fail-closed 守門（2026-09-19「Ctrl+X 轉錄轉到別篇」）。
//
// 為什麼要靜態守：這道守門**今天幾乎攔不到東西**（按鍵分派點都已經自己走 sync 腿），
// 它的價值在下一次——新增一條送字路徑、或某顆鍵被放行到原生鍵盤路徑時自動接住。
// 正因為平常沒有可見效果，最容易被下一個人「順手簡化掉」，而拿掉之後的症狀是靜默的
// （server 對錯的那一列動作，好讀畫面完全不動）。形狀比照 native_gesture_css.test.js。
describe("使用者 byte 上線前必經列表好讀的 cursor-sync 守門", () => {
  test("term_view._send / _convSend 在 conn 之前先問 adoptUserBytes", () => {
    const code = fileNamed("term_view.js").code;
    // 順序是承重的：問在 conn.*UserKey **之前**才擋得住。
    expect(code).toMatch(
      /_send:\s*function[\s\S]{0,320}?adoptUserBytes\([\s\S]{0,200}?conn\.sendUserKey\(/,
    );
    expect(code).toMatch(
      /_convSend:\s*function[\s\S]{0,320}?adoptUserBytes\([\s\S]{0,200}?conn\.convSendUserKey\(/,
    );
    // _convSend 的 payload 是 Unicode 文字 ⇒ 必須標記 conv，接手方才知道要轉 Big5。
    expect(code).toMatch(/adoptUserBytes\(\s*data\s*,\s*\{\s*conv:\s*true\s*\}\s*\)/);
  });

  test("App.adoptUserBytes 走 activeListSession（唯一真相源），不自己判擁有者", () => {
    const code = fileNamed("pttchrome.jsx").code;
    expect(code).toMatch(
      /App\.prototype\.adoptUserBytes[\s\S]{0,300}?activeListSession\(\)/,
    );
  });

  test("兩個列表 session 都實作了 adoptUserBytes", () => {
    for (const n of ["list_session.js", "board_list_session.js"])
      expect(fileNamed(n).code).toMatch(/adoptUserBytes:\s*function/);
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

// 機器狀態機的 byte 不走使用者出口（2026-09-20，a3aaa6e 的症狀第 2 次復發）。
//
// 78c276a 把使用者按鍵的 cursor-sync 守門掛在 term_view._send，理由寫的是
// 「全專案唯一的使用者 byte 出口」—— 但 easy_reading 這條**機器狀態機**也走
// view._send ⇒ 好讀自己的自動翻頁被列表 session 當成使用者按鍵 SWALLOW 掉，
// 每篇文章固定卡 620ms（watchdog）＋閃一次假的「開啟文章中，請稍候…」。
// 實錄 ptt-debug-20260920-023652，完整推導見 docs/easy-reading.md「送鍵閘門」。
//
// 靜態守的理由與上面那組相同：用錯出口的後果是**靜默**的（byte 被吞掉、畫面不動），
// 而兩個出口的呼叫寫起來長得一模一樣。
describe("機器狀態機的 byte 不走使用者出口", () => {
  test("easy_reading 不得再叫 _view._send / _view._convSend", () => {
    const code = fileNamed("easy_reading.js").code;
    expect(code).not.toMatch(/_view\._send\s*\(/);
    expect(code).not.toMatch(/_view\._convSend\s*\(/);
    // 它的唯一出口是機器那一格
    expect(code).toMatch(/_core\.sendMachineBytes\s*\(/);
  });

  test("App.sendMachineBytes 綁 conn.send（機器，會化解懸空 ESC），不是 userKey", () => {
    const code = fileNamed("pttchrome.jsx").code;
    // 順序是承重的：先確認連線（websocket.send 對已關閉的 socket 會 throw
    // InvalidStateError），再送，最後回報「有沒有真的上線」。
    expect(code).toMatch(
      /App\.prototype\.sendMachineBytes[\s\S]{0,400}?conn\.isConnected[\s\S]{0,200}?conn\.send\(/,
    );
    expect(code).not.toMatch(
      /App\.prototype\.sendMachineBytes[\s\S]{0,400}?sendUserKey/,
    );
  });

  test("關設定頁的重繪／cursorNudge 走機器出口", () => {
    // ^L 與 cursorNudge 是程式要求的整頁重繪，不是使用者按的鍵。留在使用者出口的
    // 後果：列表好讀下關掉設定頁 → decideUserBytes 回 ADOPT →
    // _beginPassthroughBytes → _enterFunctionMode ⇒ 被踢到原生鏡像並丟掉 cache。
    const code = fileNamed("pttchrome.jsx").code;
    const m = code.match(
      /App\.prototype\.switchToEasyReadingMode[\s\S]*?\n\};/,
    );
    expect(m).not.toBe(null);
    expect(m[0]).toMatch(/sendMachineBytes\(/);
    expect(m[0]).not.toMatch(/view\._send\(/);
  });

  test("term_view 仍只有 userKey 變體（機器出口沒有長在它身上）", () => {
    // 上面「term_view._send / _convSend 走的是 userKey 變體」那條已經斷言過
    // `not.toMatch(/\bconn\.send\s*\(/)`。這裡把理由釘住：新的機器出口刻意放在
    // pttchrome.jsx（與既有四條機器路徑同處一檔），所以那條斷言在這次改動後仍成立。
    expect(fileNamed("term_view.js").code).not.toMatch(/sendMachineBytes/);
  });
});
