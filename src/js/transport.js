// 連線「載體」：站台 URL 的 scheme → 一條搬 bytes 的通道。telnet 層（telnet.js）以上
// 完全不知道底下是哪一種，介面只有：
//   事件 open／data（detail.data＝latin1 字串）／close（detail.reason＝斷線原因，可無）
//   方法 send(latin1 字串)／close()／resize(cols, rows)（可無）
//
// scheme 對照（docs/ssh.md）：
//   wstelnet://  wsstelnet://  WebSocket 直接就是 telnet 串流（ws.ptt.cc／proxy）
//   wssh://      wsssh://      WebSocket 連 relay（只搬 TCP ptt.cc:22 的 bytes），SSH 在本頁解開
// 前一半決定 ws:// 或 wss://（多一個 s 的是加密）。
//
// 測試注入點（只在 dev build）：window.__pttTestTransport(site, opts) 回傳一個載體 ⇒
// App.connect 直接用它，不經 WebSocket。offline e2e 用它在 SSH 協議下重放明文 cassette
//（WebSocket stub 只能餵 WS 線路上的 bytes，SSH 線路上是加密過的）。
// 守護：tests/unit/transport.test.js。
import { Websocket } from './websocket';
import { SshTransport, sshSupported } from './ssh/ssh_transport';

const SCHEMES = {
  wstelnet: { protocol: 'websocket', ws: 'ws://' },
  wsstelnet: { protocol: 'websocket', ws: 'wss://' },
  wssh: { protocol: 'ssh', ws: 'ws://' },
  wsssh: { protocol: 'ssh', ws: 'wss://' },
};

// 'websocket'｜'ssh'：使用者在設定頁選的「協議」值，也是 parseSite().protocol。
export const PROTOCOL_WEBSOCKET = 'websocket';
export const PROTOCOL_SSH = 'ssh';

// 站台 URL → { scheme, protocol, wsUrl }；不支援的 scheme 回 null。
export function parseSite(site) {
  const m = /^([a-z]+):\/\/([^/]+)(\/.*)?$/.exec(String(site || ''));
  if (!m || !Object.prototype.hasOwnProperty.call(SCHEMES, m[1])) return null;
  const s = SCHEMES[m[1]];
  return { scheme: m[1], protocol: s.protocol, wsUrl: s.ws + m[2] + (m[3] || '/') };
}

export function siteProtocol(site) {
  const p = parseSite(site);
  return p ? p.protocol : null;
}

function testTransportFactory() {
  if (!process.env.DEVELOPER_MODE) return null;
  const f = typeof window !== 'undefined' ? window.__pttTestTransport : null;
  return typeof f === 'function' ? f : null;
}

// opts.size()：回 { cols, rows }，SSH 載體開 pty 時用（WebSocket 載體用不到，尺寸走 NAWS）。
// 不支援的站台回 null（呼叫端照舊印 log 不連）。
export function createTransport(site, opts = {}) {
  const parsed = parseSite(site);
  if (!parsed) return null;
  const injected = testTransportFactory();
  if (injected) return injected(site, { ...opts, protocol: parsed.protocol });
  if (parsed.protocol === PROTOCOL_SSH) return new SshTransport(parsed.wsUrl, opts);
  return new Websocket(parsed.wsUrl);
}

// 這個環境能不能跑 SSH 載體（WebCrypto 只在 secure context）。設定頁與失敗提示據此決定
// 要不要出現 SSH 選項。
export { sshSupported };
