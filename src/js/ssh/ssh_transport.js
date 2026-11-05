// SSH 載體：WebSocket 連 relay（relay 只做「WebSocket ⇄ TCP ptt.cc:22」，看不到明文），
// SSH 在本頁解開。對 telnet 層提供跟 websocket.js 一樣的介面（open／data／close／send／close()），
// 多一個 resize(cols, rows)（pty 的 window-change）。
//
// SSH 函式庫（ssh_client.js 與密碼學）用 dynamic import 拆成 lazy chunk：選 websocket 的人不下載。
// 本檔只留在主 bundle 的部分（介面＋relay 合約），所以刻意很薄。
//
// 'open' 要等 KEX、host key 驗證、pty、shell 都完成才發；'close' 的 detail.reason：
//   'relay'       relay 連不上／拒絕（Origin、token、限流…）
//   'tcp'         relay 連上了，但 relay → ptt.cc:22 的 TCP 失敗
//   'hostkey'     host key 不在指紋表（可能被中間人攔截）⇒ 不要自動重連
//   'auth'｜'protocol'｜'unsupported'  SSH 層失敗（見 ssh_client.js）
//   'closed'      open 過之後的正常斷線
// relay 合約（close code）見 docs/ssh.md「relay 合約」與 tools/ssh-relay/ptt-ssh-relay.mjs。
import { Event } from '../event';
import { bytesToLatin1, latin1ToBytes } from './ssh_wire';

// relay 用的 WebSocket close code（三種 relay 一致）。
export const RELAY_CLOSE = Object.freeze({
  ORIGIN_REJECTED: 4003,
  BAD_PATH: 4004,
  RATE_LIMITED: 4029,
  UPSTREAM_FAILED: 4502,
});

// 這個頁面跑得動 SSH 載體嗎：WebCrypto（crypto.subtle）只在 secure context 存在。
// 從區網 http 位址開 dev 時是 false ⇒ 設定頁與失敗提示都不出現 SSH。
export function sshSupported() {
  return !!(typeof globalThis !== 'undefined' && globalThis.isSecureContext !== false &&
    globalThis.crypto && globalThis.crypto.subtle);
}

let clientModule = null;
function loadClient() {
  if (!clientModule) {
    clientModule = Promise.all([import('./ssh_client'), import('./ssh_host_keys')]).then(
      ([client, keys]) => ({ SshClient: client.SshClient, PTT_HOST_KEYS: keys.PTT_HOST_KEYS, PTT_SSH_USER: keys.PTT_SSH_USER })
    );
  }
  return clientModule;
}

// relay 的 close code（WebSocket 收攤時）→ 斷線原因。gotBytes＝relay 有沒有轉過任何 server bytes。
export function relayCloseReason(code, gotBytes) {
  if (code === RELAY_CLOSE.UPSTREAM_FAILED) return 'tcp';
  if (!gotBytes) return 'relay';
  return 'closed';
}

// opts.size()、opts.hostKeys（測試用；預設 PTT 指紋表）、opts.WebSocketImpl（測試用）。
export function SshTransport(wsUrl, opts = {}) {
  this._opts = opts;
  this._closed = false;
  this._opened = false;
  this._gotBytes = false;
  this._client = null;
  this._pendingFeed = [];
  const WS = opts.WebSocketImpl || globalThis.WebSocket;
  if (!sshSupported()) {
    // 不在 secure context：連 relay 都不必，直接告訴上層原因（非同步，跟 WebSocket 失敗一樣）。
    setTimeout(() => this._finish('unsupported', 'WebCrypto unavailable'), 0);
    return;
  }
  // 先開始下載 SSH chunk，跟 relay 的 WebSocket 握手並行。
  const ready = loadClient();
  try {
    this._ws = new WS(wsUrl);
  } catch (e) {
    setTimeout(() => this._finish('relay', String(e)), 0);
    return;
  }
  this._ws.binaryType = 'arraybuffer';
  this._ws.addEventListener('open', () => {
    ready.then(
      (mod) => this._startClient(mod),
      (e) => this._fail('unsupported', 'failed to load SSH module: ' + e)
    );
  });
  this._ws.addEventListener('message', (e) => {
    const bytes = new Uint8Array(e.data);
    if (bytes.length) this._gotBytes = true;
    if (this._client) this._client.feed(bytes);
    else this._pendingFeed.push(bytes);
  });
  this._ws.addEventListener('close', (e) => {
    const reason = this._opened ? 'closed' : relayCloseReason(e.code, this._gotBytes);
    this._finish(reason, 'relay closed (' + e.code + (e.reason ? ' ' + e.reason : '') + ')');
  });
}

Event.mixin(SshTransport.prototype);

SshTransport.prototype._startClient = function(mod) {
  if (this._closed) return;
  const client = new mod.SshClient({
    send: (bytes) => {
      if (this._ws && this._ws.readyState === 1) this._ws.send(bytes);
    },
    onReady: () => {
      this._opened = true;
      this.dispatchEvent(new CustomEvent('open'));
    },
    onData: (bytes) => {
      this.dispatchEvent(new CustomEvent('data', { detail: { data: bytesToLatin1(bytes) } }));
    },
    onClose: (reason, message) => this._fail(this._opened && reason !== 'hostkey' ? 'closed' : reason, message),
    size: this._opts.size,
    hostKeys: this._opts.hostKeys || mod.PTT_HOST_KEYS,
    user: mod.PTT_SSH_USER,
  });
  this._client = client;
  client.start();
  for (const b of this._pendingFeed) client.feed(b);
  this._pendingFeed = [];
};

// SSH 層先失敗：關掉 relay 連線，以 SSH 的原因收攤（relay 遲到的 close 由 _closed 吞掉）。
SshTransport.prototype._fail = function(reason, message) {
  this._finish(reason, message);
  try {
    if (this._ws) this._ws.close();
  } catch (e) {}
};

SshTransport.prototype._finish = function(reason, message) {
  if (this._closed) return;
  this._closed = true;
  if (typeof console !== 'undefined') console.info('ssh transport closed: ' + reason + ' — ' + message);
  this.dispatchEvent(new CustomEvent('close', { detail: { reason, message } }));
};

SshTransport.prototype.send = function(str) {
  if (this._client && !this._closed) this._client.write(latin1ToBytes(str));
};

SshTransport.prototype.resize = function(cols, rows) {
  if (this._client && !this._closed) this._client.resize(cols, rows);
};

SshTransport.prototype.close = function() {
  if (this._closed) return;
  if (this._client) this._client.disconnect();
  this._fail('closed', 'closed by client');
};
