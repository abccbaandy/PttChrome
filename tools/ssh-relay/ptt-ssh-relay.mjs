#!/usr/bin/env node
// PttChrome 的 SSH relay（自架版）：只做「WebSocket ⇄ TCP ptt.cc:22」，一個 byte 都不解讀。
// SSH 在瀏覽器裡解開（src/js/ssh/），所以這支程式看不到帳號密碼，也不需要任何金鑰。
//
// 用法（Windows／macOS／Linux 都一樣，需要已安裝 Node 18 以上；零依賴、單檔）：
//   node ptt-ssh-relay.mjs                 啟動，印出要貼進「設定 → 連線 → SSH relay 位址」的網址
//   node ptt-ssh-relay.mjs --port 8022     換 port
//   node ptt-ssh-relay.mjs --origin https://example.com   額外允許某個網頁來源（可重複）
//   node ptt-ssh-relay.mjs --new-token     換一組新的 token（舊網址失效）
//
// 安全邊界（docs/ssh.md「風險與對策」）：
//   - 目的地是常數 UPSTREAM_HOST:UPSTREAM_PORT，絕不從 URL／header／frame 解析 ⇒ 不會變成開放代理。
//   - 只綁 127.0.0.1；路徑要帶 token、Origin 要在白名單 ⇒ 別的網站借不到（CSWSH）。
// 第一次從 https 網頁連 ws://127.0.0.1 時，Chrome 會跳「存取本機網路」權限，允許一次即可；
// Safari 不支援從公開網頁連本機。要跨瀏覽器請自己架成 wss://（例如 Cloudflare Worker，見 proxy/ssh-relay-worker）。
//
// 這個檔案也被 dev server 拿來掛 /ssh（vite.config.mjs），兩邊共用同一份實作。
// relay 合約（close code）與三種 relay 一致：src/js/ssh/ssh_transport.js#RELAY_CLOSE。
// 守護：tests/unit/ssh_relay.test.js（含目的地寫死的靜態掃描）。
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠ 安全邊界：目的地只能是這兩個常數。
export const UPSTREAM_HOST = 'ptt.cc';
export const UPSTREAM_PORT = 22;

export const RELAY_CLOSE = Object.freeze({
  ORIGIN_REJECTED: 4003,
  BAD_PATH: 4004,
  RATE_LIMITED: 4029,
  UPSTREAM_FAILED: 4502,
});

// PttChrome 正式站與本機 dev server。
export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'https://abccbaandy.github.io',
  'http://localhost:8080',
]);

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 10000;

// ---- WebSocket（RFC 6455，只做 relay 需要的部分）----

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

// 送 close frame 後收攤：對方回的 close frame 要讀掉（不讀的話 socket 卡在半關），
// 對方不回就逾時直接切。
function endWithClose(socket, code, reason) {
  socket.on('data', () => {});
  socket.on('error', () => {});
  socket.end(closeFrame(code, reason));
  setTimeout(() => socket.destroy(), 2000).unref();
}

function closeFrame(code, reason = '') {
  const r = Buffer.from(reason, 'utf8').subarray(0, 120);
  const p = Buffer.alloc(2 + r.length);
  p.writeUInt16BE(code, 0);
  r.copy(p, 2);
  return encodeFrame(0x8, p);
}

// 從 buf 拆出完整的 frame；回 { frames, rest }。client → server 的 frame 一定有 mask。
export function parseFrames(buf) {
  const frames = [];
  let o = 0;
  for (;;) {
    if (buf.length - o < 2) break;
    const b0 = buf[o];
    const b1 = buf[o + 1];
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = o + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const big = buf.readBigUInt64BE(p);
      if (big > BigInt(MAX_FRAME)) throw new Error('frame too large');
      len = Number(big);
      p += 8;
    }
    if (len > MAX_FRAME) throw new Error('frame too large');
    if (!masked) throw new Error('unmasked client frame');
    if (buf.length - p < 4 + len) break;
    const mask = buf.subarray(p, p + 4);
    p += 4;
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = buf[p + i] ^ mask[i & 3];
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    o = p + len;
  }
  return { frames, rest: buf.subarray(o) };
}

// ---- relay ----

// 處理一個 HTTP upgrade。opts：
//   authorize(req) → null（放行）｜RELAY_CLOSE 的某個 code（拒絕，握手完成後立刻以該 code 關掉，
//                    讓頁面分得出原因；瀏覽器看不到握手被拒的 HTTP 狀態）
//   connect       測試注入用；預設 net.connect。**呼叫參數永遠是兩個常數**。
//   log           (msg) => void
export function handleUpgrade(req, socket, head, opts = {}) {
  const log = opts.log || (() => {});
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  socket.setNoDelay(true);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
  );
  const denied = opts.authorize ? opts.authorize(req) : null;
  if (denied) {
    log('rejected ' + denied + ' origin=' + (req.headers.origin || '-'));
    endWithClose(socket, denied, 'rejected');
    return;
  }

  const connect = opts.connect || ((port, host) => net.connect(port, host));
  const upstream = connect(UPSTREAM_PORT, UPSTREAM_HOST);
  upstream.setNoDelay?.(true);
  let upstreamOpen = false;
  let done = false;
  const finish = (code, reason) => {
    if (done) return;
    done = true;
    try {
      endWithClose(socket, code, reason);
    } catch (e) {}
    upstream.destroy();
  };
  const timer = setTimeout(() => {
    if (!upstreamOpen) finish(RELAY_CLOSE.UPSTREAM_FAILED, 'upstream timeout');
  }, CONNECT_TIMEOUT_MS);
  upstream.on('connect', () => {
    upstreamOpen = true;
    clearTimeout(timer);
    log('upstream connected');
  });
  upstream.on('data', (d) => {
    if (!socket.write(encodeFrame(0x2, d))) {
      upstream.pause();
      socket.once('drain', () => upstream.resume());
    }
  });
  upstream.on('error', (e) => {
    clearTimeout(timer);
    finish(upstreamOpen ? 1011 : RELAY_CLOSE.UPSTREAM_FAILED, upstreamOpen ? 'upstream error' : 'upstream connect failed');
    log('upstream error: ' + e.message);
  });
  upstream.on('close', () => {
    clearTimeout(timer);
    finish(upstreamOpen ? 1000 : RELAY_CLOSE.UPSTREAM_FAILED, 'upstream closed');
  });

  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  const onData = (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    let parsed;
    try {
      parsed = parseFrames(buf);
    } catch (e) {
      finish(1002, 'bad frame');
      return;
    }
    buf = parsed.rest;
    for (const f of parsed.frames) {
      if (f.opcode === 0x2 || f.opcode === 0x0) {
        if (!upstream.write(f.payload)) {
          socket.pause();
          upstream.once('drain', () => socket.resume());
        }
      } else if (f.opcode === 0x8) {
        finish(1000, '');
        return;
      } else if (f.opcode === 0x9) {
        socket.write(encodeFrame(0xa, f.payload));
      } else if (f.opcode === 0x1) {
        finish(1003, 'binary only');
        return;
      }
    }
  };
  socket.on('data', onData);
  socket.on('error', () => finish(1011, ''));
  socket.on('close', () => {
    done = true;
    clearTimeout(timer);
    upstream.destroy();
  });
  if (buf.length) onData(Buffer.alloc(0));
}

// Origin 白名單＋（可選）token 路徑。pathPrefix 例：'/ssh'；token 有給就要求 '/ssh/<token>'。
export function makeAuthorizer({ allowedOrigins, pathPrefix = '/ssh', token = null, sameOriginOk = false }) {
  return (req) => {
    const origin = req.headers.origin || '';
    const host = req.headers.host || '';
    const sameOrigin = sameOriginOk && origin && /^https?:\/\//.test(origin) && origin.replace(/^https?:\/\//, '') === host;
    if (!sameOrigin && !allowedOrigins.includes(origin)) return RELAY_CLOSE.ORIGIN_REJECTED;
    const p = String(req.url || '').split('?')[0];
    const want = token ? pathPrefix + '/' + token : pathPrefix;
    if (token ? !timingSafeEqualStr(p, want) : p !== want) return RELAY_CLOSE.BAD_PATH;
    return null;
  };
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// dev server（vite.config.mjs）用：同源頁面的 /ssh 直接放行，不用 token（dev server 本來就只給本機開發）。
export function attachDevSshRelay(httpServer, opts = {}) {
  const authorize = makeAuthorizer({
    allowedOrigins: [...DEFAULT_ALLOWED_ORIGINS],
    pathPrefix: '/ssh',
    sameOriginOk: true,
  });
  httpServer.on('upgrade', (req, socket, head) => {
    if (String(req.url || '').split('?')[0] !== '/ssh') return;
    handleUpgrade(req, socket, head, { authorize, log: opts.log });
  });
}

// ---- CLI ----

function parseArgs(argv) {
  const out = { port: 8022, origins: [], newToken: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--origin') out.origins.push(String(argv[++i] || '').replace(/\/+$/, ''));
    else if (a === '--new-token') out.newToken = true;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

const TOKEN_FILE = path.join(os.homedir(), '.ptt-ssh-relay-token');

function loadToken(fresh) {
  if (!fresh) {
    try {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (/^[A-Za-z0-9_-]{16,}$/.test(t)) return t;
    } catch (e) {}
  }
  const t = crypto.randomBytes(18).toString('base64url');
  try {
    fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  } catch (e) {}
  return t;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
    console.log('用法：node ptt-ssh-relay.mjs [--port 8022] [--origin <網頁來源>] [--new-token]');
    return;
  }
  const token = loadToken(args.newToken);
  const authorize = makeAuthorizer({
    allowedOrigins: [...DEFAULT_ALLOWED_ORIGINS, ...args.origins],
    pathPrefix: '/ssh',
    token,
  });
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('PttChrome SSH relay：請在 PttChrome 的設定裡使用這個位址，不要用瀏覽器直接開。\n');
  });
  const stamp = () => new Date().toISOString().slice(11, 19);
  server.on('upgrade', (req, socket, head) =>
    handleUpgrade(req, socket, head, { authorize, log: (m) => console.log(stamp() + ' ' + m) })
  );
  server.on('error', (e) => {
    console.error('啟動失敗：' + e.message);
    process.exitCode = 1;
  });
  // ⚠ 只綁 loopback：別台機器連不到。
  server.listen(args.port, '127.0.0.1', () => {
    console.log('PttChrome SSH relay 已啟動（只轉送到 ' + UPSTREAM_HOST + ':' + UPSTREAM_PORT + '，看不到帳號密碼）');
    console.log('把下面這個位址貼到 PttChrome「設定 → 連線 → SSH relay 位址」：');
    console.log('');
    console.log('  wssh://127.0.0.1:' + args.port + '/ssh/' + token);
    console.log('');
    console.log('允許的網頁來源：' + [...DEFAULT_ALLOWED_ORIGINS, ...args.origins].join(', '));
    console.log('按 Ctrl+C 結束。');
  });
  return server;
}

const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch (e) {
    return false;
  }
})();
if (isMain) main();
