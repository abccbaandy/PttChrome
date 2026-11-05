// 最小 SSH-2 client（RFC 4253／4252／4254），只做 PTT 用得到的那條路：
//   版本交換 → KEXINIT → ECDH／DH → 驗 host key（指紋表＋簽章）→ NEWKEYS
//   → ssh-userauth（none）→ session 通道 → pty-req → shell → 雙向資料
// server 中途發起的 rekey 照樣接（session_id 不變）。不做：port forwarding、agent、
// 公鑰／密碼認證、壓縮、client 主動 rekey（PTT 的連線量遠低於 RFC 建議的 1GB）。
//
// 為什麼自寫而不是用現成函式庫：評估見 docs/build-modernization.md「SSH client」。
//
// 介面（與線路無關，bytes 從哪來由呼叫端決定，見 ssh_transport.js）：
//   new SshClient({ send, onReady, onData, onClose, size, hostKeys, user, term, algorithms })
//   client.start()          送出版本字串與 KEXINIT
//   client.feed(Uint8Array) 收到的 bytes
//   client.write(Uint8Array) 通道資料（ready 之前呼叫會排隊）
//   client.resize(cols, rows) window-change
//   client.disconnect()     送 DISCONNECT
// onClose(reason, message) 只呼叫一次。reason：'hostkey'｜'auth'｜'protocol'｜'unsupported'｜'closed'。
// 守護：tests/unit/ssh_client.test.js（對 ssh2 起的本機 server）。
import { Reader, Writer, concat, fromUtf8, utf8 } from './ssh_wire';
import {
  CIPHERS,
  GcmCipher,
  createKex,
  cryptoCaps,
  deriveKey,
  digest,
  encodeMpint,
  hasWebCrypto,
  hostKeyBlobType,
  hostKeyFingerprint,
  randomBytes,
  verifyHostSignature,
} from './ssh_crypto';

export const CLIENT_VERSION = 'SSH-2.0-PttChrome_SSH_1.0';

const MSG = {
  DISCONNECT: 1,
  IGNORE: 2,
  UNIMPLEMENTED: 3,
  DEBUG: 4,
  SERVICE_REQUEST: 5,
  SERVICE_ACCEPT: 6,
  EXT_INFO: 7,
  KEXINIT: 20,
  NEWKEYS: 21,
  KEX_INIT: 30,
  KEX_REPLY: 31,
  USERAUTH_REQUEST: 50,
  USERAUTH_FAILURE: 51,
  USERAUTH_SUCCESS: 52,
  USERAUTH_BANNER: 53,
  GLOBAL_REQUEST: 80,
  REQUEST_SUCCESS: 81,
  REQUEST_FAILURE: 82,
  CHANNEL_OPEN: 90,
  CHANNEL_OPEN_CONFIRMATION: 91,
  CHANNEL_OPEN_FAILURE: 92,
  CHANNEL_WINDOW_ADJUST: 93,
  CHANNEL_DATA: 94,
  CHANNEL_EXTENDED_DATA: 95,
  CHANNEL_EOF: 96,
  CHANNEL_CLOSE: 97,
  CHANNEL_REQUEST: 98,
  CHANNEL_SUCCESS: 99,
  CHANNEL_FAILURE: 100,
};

const DISCONNECT_BY_APPLICATION = 11;
const STRICT_KEX_CLIENT = 'kex-strict-c-v00@openssh.com';
const STRICT_KEX_SERVER = 'kex-strict-s-v00@openssh.com';

const MAX_PACKET = 256 * 1024;
const LOCAL_WINDOW = 2 * 1024 * 1024;
const LOCAL_MAX_PACKET = 32768;
const MAX_VERSION_BYTES = 8192;

export class SshError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.reason = reason;
  }
}

// 依瀏覽器能力排出要提供的演算法（server 從中挑第一個雙方都有的）。
export async function defaultAlgorithms() {
  const caps = await cryptoCaps();
  const kex = [];
  if (caps.x25519) kex.push('curve25519-sha256', 'curve25519-sha256@libssh.org');
  kex.push('diffie-hellman-group14-sha256');
  const hostKey = [];
  if (caps.ed25519) hostKey.push('ssh-ed25519');
  hostKey.push('ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256');
  return {
    kex,
    hostKey,
    cipher: ['aes256-gcm@openssh.com', 'aes128-gcm@openssh.com'],
    // AEAD cipher 不用 MAC，但有些實作仍要求清單有交集。
    mac: ['hmac-sha2-256', 'hmac-sha2-512'],
  };
}

// RFC 4253 §7.1：client 清單裡第一個 server 也有的。
export function negotiate(client, server) {
  for (const a of client) if (server.includes(a)) return a;
  return null;
}

export class SshClient {
  constructor(opts) {
    this._send = opts.send;
    this._onReady = opts.onReady || (() => {});
    this._onData = opts.onData || (() => {});
    this._onClose = opts.onClose || (() => {});
    this._size = opts.size || (() => ({ cols: 80, rows: 24 }));
    this._hostKeys = opts.hostKeys;
    this._user = opts.user;
    this._term = opts.term || 'vt100';
    this._algorithmsOverride = opts.algorithms || null;

    this._closed = false;
    this._ready = false;
    this._rx = new Uint8Array(0);
    this._versionDone = false;
    this._serverVersion = null;
    this._pumping = false;
    // start() 備好演算法清單之前不處理收到的 bytes（server 一連上就會送版本與 KEXINIT）。
    this._started = new Promise((res) => (this._markStarted = res));
    // 收送各自一條 promise 鏈：AES-GCM 是非同步的，封包順序（與 IV counter）靠鏈保證。
    this._txChain = Promise.resolve();
    this._seqOut = 0;
    this._seqIn = 0;
    this._cipherOut = null;
    this._cipherIn = null;

    this._sessionId = null;
    this._kex = null; // 進行中的金鑰交換
    this._kexHeld = []; // kex 期間暫存的非 kex 訊息
    this._firstKexDone = false;
    this._strict = false;
    this._ignoreNextKexPacket = false;

    this._channel = null; // { remoteId, remoteWindow, remoteMaxPacket, localWindow, consumed }
    this._pendingReplies = [];
    this._outQueue = [];
  }

  get ready() {
    return this._ready;
  }

  async start() {
    try {
      if (!hasWebCrypto()) throw new SshError('unsupported', 'WebCrypto unavailable (needs a secure context)');
      this._algorithms = this._algorithmsOverride || (await defaultAlgorithms());
      this._sendRawBytes(utf8(CLIENT_VERSION + '\r\n'));
      this._beginKex();
      this._markStarted();
    } catch (e) {
      this._fail(e);
    }
  }

  feed(bytes) {
    if (this._closed) return;
    this._rx = this._rx.length ? concat(this._rx, bytes) : bytes;
    this._pump();
  }

  write(bytes) {
    if (this._closed || !bytes.length) return;
    this._outQueue.push(bytes);
    if (this._ready) this._flushOut();
  }

  resize(cols, rows) {
    if (!this._ready || this._closed) return;
    this._sendMsg(
      new Writer()
        .byte(MSG.CHANNEL_REQUEST)
        .uint32(this._channel.remoteId)
        .string('window-change')
        .bool(false)
        .uint32(cols)
        .uint32(rows)
        .uint32(0)
        .uint32(0)
        .bytes()
    );
  }

  disconnect() {
    if (this._closed) return;
    if (this._firstKexDone) {
      this._sendMsg(
        new Writer().byte(MSG.DISCONNECT).uint32(DISCONNECT_BY_APPLICATION).string('bye').string('').bytes()
      );
    }
    this._finish('closed', 'client disconnect');
  }

  // ---- 收 ----

  async _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      await this._started;
      while (!this._closed) {
        if (!this._versionDone) {
          if (!this._readVersion()) break;
          continue;
        }
        const payload = await this._readPacket();
        if (!payload) break;
        await this._dispatch(payload);
      }
    } catch (e) {
      this._fail(e);
    } finally {
      this._pumping = false;
    }
  }

  // RFC 4253 §4.2：server 可以在版本字串前送別的行；版本行以 SSH- 開頭。
  _readVersion() {
    for (;;) {
      const nl = this._rx.indexOf(0x0a);
      if (nl < 0) {
        if (this._rx.length > MAX_VERSION_BYTES) throw new SshError('protocol', 'no SSH version line');
        return false;
      }
      let line = fromUtf8(this._rx.subarray(0, nl));
      this._rx = this._rx.subarray(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.startsWith('SSH-')) {
        if (!/^SSH-(2\.0|1\.99)-/.test(line)) throw new SshError('protocol', 'unsupported SSH version: ' + line);
        this._serverVersion = line;
        this._versionDone = true;
        return true;
      }
    }
  }

  async _readPacket() {
    if (this._rx.length < 4) return null;
    const lenBytes = this._rx.subarray(0, 4);
    const len = new Reader(lenBytes).uint32();
    if (len > MAX_PACKET || len < 5) throw new SshError('protocol', 'bad packet length ' + len);
    const total = 4 + len + (this._cipherIn ? 16 : 0);
    if (this._rx.length < total) return null;
    const body = this._rx.slice(4, total);
    const lenCopy = lenBytes.slice();
    this._rx = this._rx.subarray(total);
    let plain;
    if (this._cipherIn) {
      if (len % 16) throw new SshError('protocol', 'bad GCM packet length');
      try {
        plain = await this._cipherIn.open(lenCopy, body);
      } catch (e) {
        throw new SshError('protocol', 'packet authentication failed');
      }
    } else {
      plain = body;
    }
    this._seqIn = (this._seqIn + 1) >>> 0;
    const padLen = plain[0];
    if (padLen < 4 || padLen + 1 > plain.length) throw new SshError('protocol', 'bad padding');
    return plain.subarray(1, plain.length - padLen);
  }

  async _dispatch(payload) {
    const type = payload[0];
    const r = new Reader(payload, 1);
    // 初次 kex 的 strict 模式（Terrapin 對策）：kex 期間只准 kex 訊息。
    if (this._strict && !this._firstKexDone && !(type >= 20 && type <= 49) && type !== MSG.DISCONNECT) {
      throw new SshError('protocol', 'unexpected message ' + type + ' during strict kex');
    }
    switch (type) {
      case MSG.DISCONNECT: {
        r.uint32();
        const msg = r.utf8();
        this._finish('closed', 'server disconnect: ' + msg);
        return;
      }
      case MSG.IGNORE:
      case MSG.DEBUG:
      case MSG.UNIMPLEMENTED:
      case MSG.EXT_INFO:
        return;
      case MSG.KEXINIT:
        return this._onKexInit(payload);
      case MSG.KEX_REPLY:
        if (this._ignoreNextKexPacket) {
          this._ignoreNextKexPacket = false;
          return;
        }
        return this._onKexReply(r);
      case MSG.NEWKEYS:
        return this._onNewKeys();
      case MSG.SERVICE_ACCEPT:
        return this._onServiceAccept(r);
      case MSG.USERAUTH_BANNER:
        return;
      case MSG.USERAUTH_SUCCESS:
        return this._openChannel();
      case MSG.USERAUTH_FAILURE: {
        const methods = r.nameList();
        throw new SshError('auth', 'authentication "none" rejected (server allows: ' + methods.join(',') + ')');
      }
      case MSG.GLOBAL_REQUEST: {
        r.utf8();
        if (r.bool()) this._sendMsg(new Uint8Array([MSG.REQUEST_FAILURE]));
        return;
      }
      case MSG.REQUEST_SUCCESS:
      case MSG.REQUEST_FAILURE:
        return;
      case MSG.CHANNEL_OPEN: {
        r.utf8();
        const sender = r.uint32();
        this._sendMsg(
          new Writer()
            .byte(MSG.CHANNEL_OPEN_FAILURE)
            .uint32(sender)
            .uint32(1) // SSH_OPEN_ADMINISTRATIVELY_PROHIBITED
            .string('')
            .string('')
            .bytes()
        );
        return;
      }
      case MSG.CHANNEL_OPEN_CONFIRMATION:
        return this._onChannelConfirm(r);
      case MSG.CHANNEL_OPEN_FAILURE: {
        r.uint32();
        r.uint32();
        throw new SshError('protocol', 'session channel refused: ' + r.utf8());
      }
      case MSG.CHANNEL_WINDOW_ADJUST: {
        r.uint32();
        if (this._channel) {
          this._channel.remoteWindow = Math.min(0xffffffff, this._channel.remoteWindow + r.uint32());
          this._flushOut();
        }
        return;
      }
      case MSG.CHANNEL_DATA: {
        r.uint32();
        return this._onChannelData(r.string());
      }
      case MSG.CHANNEL_EXTENDED_DATA: {
        r.uint32();
        r.uint32();
        return this._onChannelData(r.string());
      }
      case MSG.CHANNEL_EOF:
        return;
      case MSG.CHANNEL_CLOSE:
        if (this._channel) {
          this._sendMsg(new Writer().byte(MSG.CHANNEL_CLOSE).uint32(this._channel.remoteId).bytes());
        }
        this._finish('closed', 'channel closed by server');
        return;
      case MSG.CHANNEL_REQUEST: {
        r.uint32();
        r.utf8();
        if (r.bool() && this._channel) {
          this._sendMsg(new Writer().byte(MSG.CHANNEL_FAILURE).uint32(this._channel.remoteId).bytes());
        }
        return;
      }
      case MSG.CHANNEL_SUCCESS:
      case MSG.CHANNEL_FAILURE:
        return this._onChannelReply(type === MSG.CHANNEL_SUCCESS);
      default:
        this._sendMsg(new Writer().byte(MSG.UNIMPLEMENTED).uint32((this._seqIn - 1) >>> 0).bytes());
    }
  }

  // ---- 金鑰交換 ----

  _beginKex() {
    const a = this._algorithms;
    const kexList = this._firstKexDone ? a.kex : [...a.kex, STRICT_KEX_CLIENT];
    const payload = new Writer()
      .byte(MSG.KEXINIT)
      .raw(randomBytes(16))
      .nameList(kexList)
      .nameList(a.hostKey)
      .nameList(a.cipher)
      .nameList(a.cipher)
      .nameList(a.mac)
      .nameList(a.mac)
      .nameList(['none'])
      .nameList(['none'])
      .nameList([])
      .nameList([])
      .bool(false)
      .uint32(0)
      .bytes();
    this._kex = { clientInit: payload, serverInit: null, impl: null };
    this._sendMsg(payload);
  }

  async _onKexInit(payload) {
    if (!this._kex) this._beginKex(); // server 發起的 rekey
    const kex = this._kex;
    kex.serverInit = payload.slice();
    const r = new Reader(payload, 17);
    const s = {
      kex: r.nameList(),
      hostKey: r.nameList(),
      cipherC2S: r.nameList(),
      cipherS2C: r.nameList(),
      macC2S: r.nameList(),
      macS2C: r.nameList(),
      compC2S: r.nameList(),
      compS2C: r.nameList(),
    };
    r.nameList();
    r.nameList();
    const firstFollows = r.bool();
    const a = this._algorithms;
    const kexAlg = negotiate(a.kex, s.kex);
    const hostKeyAlg = negotiate(a.hostKey, s.hostKey);
    const cipherOut = negotiate(a.cipher, s.cipherC2S);
    const cipherIn = negotiate(a.cipher, s.cipherS2C);
    if (!kexAlg || !hostKeyAlg || !cipherOut || !cipherIn) {
      throw new SshError(
        'protocol',
        'no common algorithm (server kex=' + s.kex.join(',') + ' hostkey=' + s.hostKey.join(',') +
          ' cipher=' + s.cipherS2C.join(',') + ')'
      );
    }
    if (!s.compC2S.includes('none') || !s.compS2C.includes('none')) {
      throw new SshError('protocol', 'server requires compression');
    }
    if (!this._firstKexDone && s.kex.includes(STRICT_KEX_SERVER)) this._strict = true;
    // server 猜錯就會先送一個用不到的 kex 封包，要丟掉（RFC 4253 §7）。
    if (firstFollows && (s.kex[0] !== kexAlg || s.hostKey[0] !== hostKeyAlg)) this._ignoreNextKexPacket = true;
    kex.alg = { kex: kexAlg, hostKey: hostKeyAlg, cipherOut, cipherIn };
    kex.impl = await createKex(kexAlg);
    const w = new Writer().byte(MSG.KEX_INIT);
    if (kex.impl.ecdh) w.string(kex.impl.clientPublic);
    else w.mpint(kex.impl.clientPublic);
    this._sendMsg(w.bytes());
  }

  async _onKexReply(r) {
    const kex = this._kex;
    if (!kex || !kex.impl) throw new SshError('protocol', 'unexpected KEX reply');
    const hostKeyBlob = r.string();
    const serverPublic = kex.impl.ecdh ? r.string() : r.mpint();
    const sigBlob = r.string();

    await this._checkHostKey(kex.alg.hostKey, hostKeyBlob);

    const k = await kex.impl.finish(serverPublic);
    const kMpint = encodeMpint(k);
    const hw = new Writer()
      .string(CLIENT_VERSION)
      .string(this._serverVersion)
      .string(kex.clientInit)
      .string(kex.serverInit)
      .string(hostKeyBlob);
    if (kex.impl.ecdh) hw.string(kex.impl.clientPublic).string(serverPublic);
    else hw.mpint(kex.impl.clientPublic).mpint(serverPublic);
    hw.raw(kMpint);
    const h = await digest(kex.impl.hash, hw.bytes());

    if (!(await verifyHostSignature(kex.alg.hostKey, hostKeyBlob, sigBlob, h))) {
      throw new SshError('hostkey', 'host key signature verification failed');
    }
    if (!this._sessionId) this._sessionId = h;

    const outSpec = CIPHERS[kex.alg.cipherOut];
    const inSpec = CIPHERS[kex.alg.cipherIn];
    const hash = kex.impl.hash;
    const sid = this._sessionId;
    const ivOut = await deriveKey(hash, kMpint, h, 'A', sid, 12);
    const ivIn = await deriveKey(hash, kMpint, h, 'B', sid, 12);
    const keyOut = await deriveKey(hash, kMpint, h, 'C', sid, outSpec.keyLen);
    const keyIn = await deriveKey(hash, kMpint, h, 'D', sid, inSpec.keyLen);
    kex.nextOut = await GcmCipher.create(keyOut, ivOut);
    kex.nextIn = await GcmCipher.create(keyIn, ivIn);

    // NEWKEYS 之後的封包用新金鑰：切換點放進送出鏈，跟封包順序綁在一起。
    this._sendMsg(new Uint8Array([MSG.NEWKEYS]), () => {
      this._cipherOut = kex.nextOut;
      if (this._strict) this._seqOut = 0;
    });
    kex.sentNewKeys = true;
    // kex 期間暫存的訊息現在可以送了（用新金鑰）。
    const held = this._kexHeld;
    this._kexHeld = [];
    for (const m of held) this._sendMsg(m);
  }

  async _checkHostKey(alg, blob) {
    const type = hostKeyBlobType(alg);
    const blobType = new Reader(blob).utf8();
    if (blobType !== type) throw new SshError('hostkey', 'host key type mismatch');
    const fp = await hostKeyFingerprint(blob);
    const allowed = (this._hostKeys && this._hostKeys[type]) || [];
    if (!allowed.includes(fp)) {
      throw new SshError('hostkey', 'unknown host key ' + type + ' ' + fp);
    }
  }

  _onNewKeys() {
    const kex = this._kex;
    if (!kex || !kex.nextIn || !kex.sentNewKeys) throw new SshError('protocol', 'unexpected NEWKEYS');
    this._cipherIn = kex.nextIn;
    if (this._strict) this._seqIn = 0;
    this._kex = null;
    if (!this._firstKexDone) {
      this._firstKexDone = true;
      this._sendMsg(new Writer().byte(MSG.SERVICE_REQUEST).string('ssh-userauth').bytes());
    }
  }

  // ---- 認證與通道 ----

  _onServiceAccept(r) {
    const name = r.utf8();
    if (name !== 'ssh-userauth') throw new SshError('protocol', 'unexpected service ' + name);
    this._sendMsg(
      new Writer()
        .byte(MSG.USERAUTH_REQUEST)
        .string(this._user)
        .string('ssh-connection')
        .string('none')
        .bytes()
    );
  }

  _openChannel() {
    this._channel = {
      remoteId: null,
      remoteWindow: 0,
      remoteMaxPacket: 0,
      localWindow: LOCAL_WINDOW,
      consumed: 0,
    };
    this._sendMsg(
      new Writer()
        .byte(MSG.CHANNEL_OPEN)
        .string('session')
        .uint32(0)
        .uint32(LOCAL_WINDOW)
        .uint32(LOCAL_MAX_PACKET)
        .bytes()
    );
  }

  _onChannelConfirm(r) {
    if (!this._channel) throw new SshError('protocol', 'unexpected channel confirmation');
    r.uint32(); // 我們的 channel id（0）
    const ch = this._channel;
    ch.remoteId = r.uint32();
    ch.remoteWindow = r.uint32();
    ch.remoteMaxPacket = r.uint32();
    const { cols, rows } = this._size();
    this._channelRequest('pty-req', (w) =>
      w.string(this._term).uint32(cols).uint32(rows).uint32(0).uint32(0).string(new Uint8Array([0]))
    );
    this._channelRequest('shell', (w) => w);
  }

  _channelRequest(name, fill) {
    this._pendingReplies.push(name);
    const w = new Writer().byte(MSG.CHANNEL_REQUEST).uint32(this._channel.remoteId).string(name).bool(true);
    this._sendMsg(fill(w).bytes());
  }

  _onChannelReply(ok) {
    const name = this._pendingReplies.shift();
    if (!name) return;
    if (!ok) throw new SshError('protocol', 'server refused ' + name);
    if (name === 'shell') {
      this._ready = true;
      this._onReady();
      this._flushOut();
    }
  }

  _onChannelData(data) {
    const ch = this._channel;
    if (!ch) return;
    ch.consumed += data.length;
    if (ch.consumed >= LOCAL_WINDOW / 2) {
      this._sendMsg(
        new Writer().byte(MSG.CHANNEL_WINDOW_ADJUST).uint32(ch.remoteId).uint32(ch.consumed).bytes()
      );
      ch.consumed = 0;
    }
    if (data.length) this._onData(data.slice());
  }

  _flushOut() {
    const ch = this._channel;
    if (!this._ready || !ch) return;
    while (this._outQueue.length && ch.remoteWindow > 0) {
      let chunk = this._outQueue[0];
      const max = Math.min(ch.remoteWindow, ch.remoteMaxPacket || LOCAL_MAX_PACKET, LOCAL_MAX_PACKET);
      if (chunk.length > max) {
        this._outQueue[0] = chunk.subarray(max);
        chunk = chunk.subarray(0, max);
      } else {
        this._outQueue.shift();
      }
      ch.remoteWindow -= chunk.length;
      this._sendMsg(new Writer().byte(MSG.CHANNEL_DATA).uint32(ch.remoteId).string(chunk).bytes());
    }
  }

  // ---- 送 ----

  _sendRawBytes(bytes) {
    this._txChain = this._txChain.then(() => {
      if (!this._closed) this._send(bytes);
    });
  }

  // kex 進行中（已送 KEXINIT、還沒送 NEWKEYS）只准送傳輸層／kex 訊息，其餘暫存。
  _sendMsg(payload, afterSent) {
    const type = payload[0];
    if (this._kex && !this._kex.sentNewKeys && type >= 50) {
      this._kexHeld.push(payload);
      return;
    }
    this._txChain = this._txChain
      .then(async () => {
        if (this._closed && type !== MSG.DISCONNECT) return;
        const packet = await this._encode(payload);
        this._seqOut = (this._seqOut + 1) >>> 0;
        this._send(packet);
        if (afterSent) afterSent();
      })
      .catch((e) => this._fail(e));
  }

  async _encode(payload) {
    const cipher = this._cipherOut;
    const block = cipher ? 16 : 8;
    // 有 cipher 時長度欄不算進對齊（aes-gcm@openssh.com），沒有時算（RFC 4253 §6）。
    const lead = cipher ? 1 : 5;
    let padLen = block - ((lead + payload.length) % block);
    if (padLen < 4) padLen += block;
    const packetLen = 1 + payload.length + padLen;
    const lenBytes = new Writer().uint32(packetLen).bytes();
    const body = concat(new Uint8Array([padLen]), payload, randomBytes(padLen));
    if (!cipher) return concat(lenBytes, body);
    return concat(lenBytes, await cipher.seal(lenBytes, body));
  }

  // ---- 收尾 ----

  _fail(e) {
    if (this._closed) return;
    const reason = e instanceof SshError ? e.reason : 'protocol';
    if (this._firstKexDone && reason !== 'hostkey') {
      // 盡力告訴 server 為什麼走（失敗也無所謂）。
      try {
        this._sendMsg(
          new Writer().byte(MSG.DISCONNECT).uint32(2).string(String(e.message || e)).string('').bytes()
        );
      } catch (_) {}
    }
    this._finish(reason, String((e && e.message) || e));
  }

  _finish(reason, message) {
    if (this._closed) return;
    this._closed = true;
    this._ready = false;
    this._onClose(reason, message);
  }
}
