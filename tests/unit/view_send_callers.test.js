// A2 步驟 d：`term_view._send`／`_convSend` 是「真鍵盤／IME」的出口（wire.sendUserKey／sendUserText，
// 先問 adoptUserBytes 要不要接手），不是所有 byte 的出口。機器自己決定送的 byte 該走
// `App.sendMachineBytes`（推導見 term_view.js `_send` 上方註解、docs/wire-send.md）。
//
// term_view 以外直接叫它的地方逐一列在下面，每一處標明是哪一類：
//   USER    ＝使用者這一下（點擊、滾輪、按鈕、方向鍵）的直接翻譯，送的 byte 等同使用者自己按鍵；
//   MACHINE ＝功能自己決定、在使用者動作之後的某個時機才送（序列中途、背景抓頁）；
//   AGENT   ＝外部 agent（window.pttAgent／WebMCP）代打。
// 新增一個呼叫點就要在這裡加一列並想清楚它是哪一類：MACHINE 改走 sendMachineBytes，例外見檔尾。
// 表上的列找不到對應程式碼也會紅（改名／刪掉要同步）。
//
// 靜態掃描，風格比照 tests/unit/user_key_send_wiring.test.js。
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");
const CALL = /\bview\._(?:conv)?[sS]end\(/;

const USER = "USER";
const MACHINE = "MACHINE";
const AGENT = "AGENT";

// match：該行（去掉前後空白）裡的一段字，在同檔要唯一。
const SITES = [
  // ── pttchrome.jsx ──
  { file: "js/pttchrome.jsx", match: "this.view._send(bytes);", kind: USER,
    why: "sendNavKeyAsUser：工具列／浮層按鈕替使用者按一個導覽鍵（先問 commandQueue 忙不忙並給提示）" },
  { file: "js/pttchrome.jsx", match: "self.view._send(key);", kind: MACHINE,
    why: "開燈軌 B：commandQueue 送 `\\` 開 pmore 快速設定、認出設定列後在 onDone 送 1/2/3",
    keep: "送進 vmsg 的可列印鍵：使用者懸空的 Esc 下，機器模式會補 ESC 收掉設定頁、數字落到 pager 跳頁；" +
      "真鍵盤模式數字被吃成 esc_arg，什麼都不發生（vtkbd_send_state.js 檔頭）" },
  { file: "js/pttchrome.jsx", match: "this.buf.isLiveScreenNow() ? 'q' : '\\x1b[D'", kind: USER,
    why: "點文章左側離開帶＝按 ←（實況是 q）" },
  { file: "js/pttchrome.jsx", match: "this.view._send(LEFT_ARROW);", kind: USER,
    why: "點列表／選單左側退出帶＝按 ←" },
  { file: "js/pttchrome.jsx", match: "step.repeat(Math.abs(delta))", kind: USER,
    why: "_sendRowEnter：點原生列表某一列＝方向鍵移過去再 Enter" },
  { file: "js/pttchrome.jsx", match: "this.view._send(dismiss.bytes);", kind: USER,
    why: "點掉 PTT 的「請按任意鍵繼續」框" },
  { file: "js/pttchrome.jsx", match: "this.view._send(encodeClick({", kind: USER,
    why: "SGR 滑鼠點擊回報（送出前過 _mouseSendBlocked）" },
  { file: "js/pttchrome.jsx", match: "this.view._send('\\x1b[D');", kind: USER,
    why: "中鍵＝←（prompt 開著不送）" },
  { file: "js/pttchrome.jsx", match: "this.view._send(encodeWheel({", kind: USER,
    why: "SGR 滾輪回報（送出前過 _mouseSendBlocked）" },
  // ── easy_reading.js ──
  { file: "js/easy_reading.js", match: "case 'ArrowLeft'", next: "this._core.view._send('q');", kind: USER,
    why: "實況裡按 ←：live_run 不認 ←，翻成 q" },
  { file: "js/easy_reading.js", match: "_onMouseClick", next: "this._core.view._send('q');", kind: USER,
    why: "實況裡點左側離開帶：同上翻成 q" },
  // ── live_helper.js ──
  { file: "js/live_helper.js", match: "core.view._send(key);", kind: USER,
    why: "實況小幫手的按鈕（v／q）＝使用者按那個鍵" },
  // ── help_menu.js ──
  { file: "js/help_menu.js", match: "core.view._send(bytes)", kind: USER,
    why: "說明選單彈窗：使用者點了某一項／離開／小天使送的鍵。自己抓下一頁的 PgDn、收拾補頁的 Home 走 _sendMachine" },
  // ── agent_tools.js ──
  { file: "js/agent_tools.js", match: "core.view._convSend(p.text);", kind: AGENT,
    why: "send_keys 工具：agent 指定的文字，刻意當成使用者打字（要經 adoptUserBytes）" },
  { file: "js/agent_tools.js", match: "else core.view._send(p.bytes);", kind: AGENT,
    why: "send_keys 工具：agent 指定的按鍵，刻意當成使用者按鍵" },
];

function callLines() {
  const out = [];
  for (const f of fs.readdirSync(SRC, { recursive: true })) {
    const name = f.split(path.sep).join("/");
    if (!/\.jsx?$/.test(name) || name === "js/term_view.js") continue;
    const lines = fs.readFileSync(path.join(SRC, f), "utf8").split("\n");
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*")) return;
      if (CALL.test(t)) out.push({ file: name, line: i, text: t, lines });
    });
  }
  return out;
}

// 有 next 的列：match 是往上找得到的脈絡（同一行字在檔內重複時用），往上 15 行內要有它。
function siteMatches(site, call) {
  if (site.file !== call.file) return false;
  if (!site.next) return call.text.includes(site.match);
  if (!call.text.includes(site.next)) return false;
  const above = call.lines.slice(Math.max(0, call.line - 15), call.line).join("\n");
  return above.includes(site.match);
}

test("term_view 以外每個 view._send／_convSend 呼叫點都在表上，且只對到一列", () => {
  const unlisted = [];
  for (const call of callLines()) {
    const hits = SITES.filter((s) => siteMatches(s, call));
    if (hits.length !== 1) unlisted.push(`${call.file}:${call.line + 1}（對到 ${hits.length} 列）${call.text}`);
  }
  expect(unlisted).toEqual([]);
});

test("表上每一列都還對得到程式碼（改名／刪掉要同步）", () => {
  const calls = callLines();
  const stale = SITES.filter((s) => !calls.some((c) => siteMatches(s, c))).map((s) => `${s.file}: ${s.match}`);
  expect(stale).toEqual([]);
});

// MACHINE 原則上不准留在真鍵盤出口：機器 byte 走它的後果是靜默的（使用者懸空的 ESC 會把機器鍵吃成
// 組合鍵、列表好讀的 adoptUserBytes 會把它當使用者輸入接手）。說明選單抓頁的 PgDn／收尾 Home、
// agent collectNative 的 PgDn 曾經在這裡，已改走 sendMachineBytes。
// 例外要寫 keep：送進 vmsg（任何鍵都收掉橫幅）的可列印鍵，機器模式補的 ESC 會先收掉畫面、讓原鍵
// 落到底下 ⇒ 那種情況留在真鍵盤出口反而安全。目前只准開燈軌 B 這一列，加新的例外要先想清楚。
test("每一列都有分類與理由；MACHINE 只准有 keep 理由的例外", () => {
  for (const s of SITES) {
    expect([USER, MACHINE, AGENT]).toContain(s.kind);
    expect(s.why.length).toBeGreaterThan(5);
  }
  const kept = SITES.filter((s) => s.kind === MACHINE);
  for (const s of kept) expect(s.keep || "").toMatch(/vmsg/);
  expect(kept.map((s) => s.match)).toEqual(["self.view._send(key);"]);
});
