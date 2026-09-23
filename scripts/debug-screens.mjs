// 把 debug 錄製檔（設定頁「錄製 debug」匯出的 ptt-debug-*.json）解回**畫面**與
// **時間軸**，給分析使用者回報用。錄製檔裡 recv/send 只是 base64 的原始位元組，
// 光看 log 看不到「那一刻畫面上是什麼」——落點頁是哪幾篇、游標停在哪一列、
// prompt 有沒有出現，都得解回畫面才判得準。
//
// **用的是 app 自己的 TermBuf + AnsiParser**（經 Vite ssrLoadModule 載入，term_buf
// 的依賴鏈含圖檔 import，純 node 載不動），不是另寫一個迷你 VT：手寫的模擬器漏
// 處理序列時會解出**看起來像 PTT 送的**亂碼（2026-09-24 實例：`116;18Hj0o0h0n0`），
// 那比沒有工具更糟。
//
// 用法：
//   yarn debug:screens <錄製檔>                 時間軸（send 解成可讀字串＋log 事件）
//   yarn debug:screens <錄製檔> 13417 13891     印出這兩個時間點（ms）的畫面
//   yarn debug:screens <錄製檔> --from 13000 --to 14000   只看這段時間軸
//   --rows N   覆寫終端機列數（預設取錄製檔 cassette.rows，舊檔沒有就 24）
//
// 限制：錄製是**中途開始**的，第一個 recv 之前的畫面不在檔案裡 ⇒ 開頭幾幀可能
// 只有局部更新，要等 server 送整頁重繪（\x1b[2J 或 \f 回應）之後才完整。
// 畫面列文字走 buf.getRowText（Big5 → Unicode，與 app 讀畫面同一條路）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 純函式（tests/unit/debug_screens.test.js 守護）
// ---------------------------------------------------------------------------

// 錄製檔 JSON → { rows, cols, events }，events 的 data 解成 latin1（一字元一位元組，
// AnsiParser.feed 吃的就是這個形式）。
export function decodeRecording(json, opts) {
  const o = opts || {};
  const cas = json.cassette || {};
  const rows = o.rows || cas.rows || 24;
  const cols = cas.cols || 80;
  const events = (json.events || []).map((ev) => {
    if (ev.dir !== 'recv' && ev.dir !== 'send') return ev;
    return Object.assign({}, ev, {
      bytes: Buffer.from(ev.data || '', 'base64').toString('latin1')
    });
  });
  return { meta: json.meta || {}, rows, cols, events };
}

// 送出位元組 → 一眼看得懂的字串。控制字元一律具名／跳脫，Big5 等高位元組用 \xNN
// （send 多半是按鍵，極少是中文；要看中文內容請看畫面）。
const NAMED = { 0x1b: '\\e', 0x0d: '\\r', 0x0a: '\\n', 0x0c: '\\f', 0x09: '\\t', 0x08: '\\b', 0x7f: '\\x7f' };
export function escapeBytes(s) {
  let out = '';
  for (let i = 0; i < s.length; ++i) {
    const c = s.charCodeAt(i) & 0xff;
    if (NAMED[c]) out += NAMED[c];
    else if (c < 0x20) out += '^' + String.fromCharCode(c + 0x40);
    else if (c >= 0x80) out += '\\x' + c.toString(16).padStart(2, '0');
    else out += String.fromCharCode(c);
  }
  return out;
}

// 時間軸：send ＋ log（recv 只計數，內容請用畫面看）。
export function formatTimeline(rec, opts) {
  const o = opts || {};
  const from = o.from == null ? -Infinity : o.from;
  const to = o.to == null ? Infinity : o.to;
  const lines = [];
  let recvCount = 0;
  let recvBytes = 0;
  const flushRecv = () => {
    if (!recvCount) return;
    lines.push(`        recv ×${recvCount}（${recvBytes} bytes）`);
    recvCount = 0;
    recvBytes = 0;
  };
  for (const ev of rec.events) {
    if (ev.t < from || ev.t > to) continue;
    if (ev.dir === 'recv') {
      recvCount++;
      recvBytes += ev.bytes.length;
      continue;
    }
    flushRecv();
    const t = String(ev.t).padStart(7);
    if (ev.dir === 'send') lines.push(`${t} send ${escapeBytes(ev.bytes)}`);
    else lines.push(`${t} log  ${ev.tag}${ev.info ? ' ' + JSON.stringify(ev.info) : ''}`);
  }
  flushRecv();
  return lines.join('\n');
}

function makeBuf(TermBuf, cols, rows) {
  const buf = new TermBuf(cols, rows);
  buf.setView({
    update() {},
    updateCursorPos() {},
    refreshCursorVisibility() {},
    blinkOn: false,
    charset: 'big5'
  });
  buf.useMouseBrowsing = false;
  return buf;
}

// 依序餵 recv，在每個要求的時間點（「t ≤ 該時間點的 recv 全部餵完」）拍一張畫面。
// 需要全域 window.lib 的 Big5 表（CLI 由 loadBig5Tables 載；unit 由測試 helper 載）。
// 回傳 [{ at, lastRecvT, curX, curY, pageState, rows: [text] }]。
export function replayScreens(rec, times, deps) {
  const { TermBuf, AnsiParser } = deps;
  const buf = makeBuf(TermBuf, rec.cols, rec.rows);
  const parser = new AnsiParser(buf);
  const want = times.slice().sort((a, b) => a - b);
  const shots = [];
  let lastRecvT = null;
  const shoot = (at) => {
    buf.notify(); // updateCharAttr：getRowText 依賴它設的 isLeadByte
    const rows = [];
    for (let r = 0; r < buf.rows; ++r) rows.push(buf.getRowText(r, 0, buf.cols));
    shots.push({
      at,
      lastRecvT,
      curX: buf.cur_x,
      curY: buf.cur_y,
      pageState: buf.pageState,
      rows
    });
  };
  let i = 0;
  for (const ev of rec.events) {
    while (i < want.length && ev.t > want[i]) shoot(want[i++]);
    if (i >= want.length) break;
    if (ev.dir !== 'recv') continue;
    parser.feed(ev.bytes);
    lastRecvT = ev.t;
  }
  while (i < want.length) shoot(want[i++]);
  // TermBuf 會掛 settle/blink 計時器；CLI 結束前要清掉，否則進程不會退出。
  clearTimeout(buf.timerUpdate);
  if (buf._settleTimer) clearTimeout(buf._settleTimer);
  return shots;
}

export function formatScreen(shot) {
  const head =
    `==== t=${shot.at}（最後一個 recv @${shot.lastRecvT == null ? '—' : shot.lastRecvT}）` +
    ` 游標 (row ${shot.curY}, col ${shot.curX}) pageState=${shot.pageState}`;
  const body = shot.rows.map((text, r) => {
    const mark = r === shot.curY ? '>' : ' ';
    return `${String(r).padStart(2)}${mark}|${text}`;
  });
  return [head].concat(body).join('\n');
}

export function parseArgs(argv) {
  const out = { file: null, times: [], rows: null, from: null, to: null };
  for (let i = 0; i < argv.length; ++i) {
    const a = argv[i];
    if (a === '--rows') out.rows = Number(argv[++i]);
    else if (a === '--from') out.from = Number(argv[++i]);
    else if (a === '--to') out.to = Number(argv[++i]);
    else if (out.file == null) out.file = a;
    else if (/^\d+$/.test(a)) out.times.push(Number(a));
    else throw new Error('看不懂的參數：' + a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// TermBuf 的建構式會碰 document（#BBSWindow 等），用 unit 測試同一套 jsdom 提供
// DOM 環境；Big5 表掛在 window.lib，與 main.jsx 的 bootstrap 同一個位置。
async function installDom() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.CustomEvent = globalThis.CustomEvent || dom.window.CustomEvent;
}

function loadBig5Tables() {
  const dir = path.join(ROOT, 'src', 'conv');
  window.lib = window.lib || {};
  window.lib.b2uArray = new Uint8Array(fs.readFileSync(path.join(dir, 'b2u_table.bin')));
  window.lib.u2bArray = new Uint8Array(fs.readFileSync(path.join(dir, 'u2b_table.bin')));
  // string_util.b2u 讀的是**裸全域** `lib`：瀏覽器與 vitest(jsdom) 裡 window 就是
  // global，node 不是 ⇒ 要另外掛一份到 globalThis。
  globalThis.lib = window.lib;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
    return;
  }
  if (!args.file) {
    console.error('用法：yarn debug:screens <錄製檔> [時間點 ms …] [--from ms --to ms] [--rows N]');
    process.exitCode = 2;
    return;
  }
  const rec = decodeRecording(JSON.parse(fs.readFileSync(args.file, 'utf8')), { rows: args.rows });
  const m = rec.meta;
  console.log(`# ${m.recordedAt || '?'} build=${m.build || '?'} ${rec.cols}x${rec.rows} events=${rec.events.length}`);
  if (!args.times.length) {
    console.log(formatTimeline(rec, { from: args.from, to: args.to }));
    return;
  }
  await installDom();
  loadBig5Tables();
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false,
    root: ROOT,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }
  });
  try {
    const { TermBuf } = await server.ssrLoadModule('/src/js/term_buf.js');
    const { AnsiParser } = await server.ssrLoadModule('/src/js/ansi_parser.js');
    for (const shot of replayScreens(rec, args.times, { TermBuf, AnsiParser }))
      console.log(formatScreen(shot));
  } finally {
    await server.close();
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
