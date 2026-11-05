// SSH client 用到的密碼學，全部走 WebCrypto（瀏覽器內建，零依賴）：
//   kex      curve25519-sha256（X25519）、diffie-hellman-group14-sha256（BigInt modpow）
//   host key ssh-ed25519、ecdsa-sha2-nistp256、rsa-sha2-512／256
//   cipher   aes256-gcm@openssh.com／aes128-gcm@openssh.com（RFC 5647 的 OpenSSH 變體）
// PTT 的 bbs-sshd 提供的組合見 docs/ssh.md「量測結果」。chacha20-poly1305 WebCrypto 沒有，
// 不實作。WebCrypto 只在 secure context（https、localhost）存在 ⇒ sshSupported() 先看它。
import {
  Reader,
  Writer,
  base64NoPad,
  base64Url,
  bigintToBytes,
  bytesToBigint,
  concat,
  leftPad,
} from './ssh_wire';

function stripLeadingZeros(b) {
  let i = 0;
  while (i < b.length && b[i] === 0) i++;
  return b.subarray(i);
}

function subtle() {
  const c = globalThis.crypto;
  return c && c.subtle ? c.subtle : null;
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function hasWebCrypto() {
  return !!subtle();
}

export async function digest(hash, data) {
  return new Uint8Array(await subtle().digest(hash, data));
}

// RFC 8032 §7.1 TEST 1 的公鑰：拿一把合法的點來探測 Ed25519 import 是否支援。
const ED25519_PROBE = new Uint8Array([
  0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64, 0x07, 0x3a,
  0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25, 0xaf, 0x02, 0x1a, 0x68, 0xf7, 0x07, 0x51, 0x1a,
]);

let capsPromise = null;

// 這個瀏覽器的 WebCrypto 支援哪些演算法。X25519／Ed25519 是近年才進 WebCrypto 的，
// 沒有就退回 dh-group14 與 ECDSA（PTT 都有提供）。結果整頁快取。
export function cryptoCaps() {
  if (!capsPromise) capsPromise = probeCaps();
  return capsPromise;
}

async function probeCaps() {
  const s = subtle();
  if (!s) return { x25519: false, ed25519: false };
  let x25519 = false;
  let ed25519 = false;
  try {
    await s.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    x25519 = true;
  } catch (e) {}
  try {
    await s.importKey('raw', ED25519_PROBE, { name: 'Ed25519' }, false, ['verify']);
    ed25519 = true;
  } catch (e) {}
  return { x25519, ed25519 };
}

// ---- 金鑰交換 ----

// RFC 3526 group 14（2048-bit MODP），g = 2。
const GROUP14_P = BigInt(
  '0x' +
    'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
    '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
    'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
    'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
    'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D' +
    'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
    '83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
    '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
    'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9' +
    'DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
    '15728E5A8AACAA68FFFFFFFFFFFFFFFF'
);

function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

// 一次金鑰交換的本機半邊。publicBlob()＝要放進 KEX init 的欄位（ECDH：string Q_C；
// DH：mpint e 的無號 bytes），finish(serverPublic)＝共享秘密 K 的無號 big-endian bytes。
export async function createKex(name) {
  if (name === 'curve25519-sha256' || name === 'curve25519-sha256@libssh.org') {
    const s = subtle();
    const kp = await s.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const pub = new Uint8Array(await s.exportKey('raw', kp.publicKey));
    return {
      hash: 'SHA-256',
      ecdh: true,
      clientPublic: pub,
      async finish(serverPublic) {
        if (serverPublic.length !== 32) throw new Error('bad curve25519 public key');
        const peer = await s.importKey('raw', serverPublic, { name: 'X25519' }, false, []);
        const bits = new Uint8Array(await s.deriveBits({ name: 'X25519', public: peer }, kp.privateKey, 256));
        // RFC 8731 §3：全零的共享秘密（對方給了小階點）必須中止。
        if (bits.every((b) => b === 0)) throw new Error('curve25519 all-zero shared secret');
        // X25519 的 32 bytes 直接當 big-endian 無號整數（RFC 8731 §3.1）：最高位元是 1
        // 很正常（約一半機率），不是負數 ⇒ 只去前導 0，不能走 mpintToUnsigned 的符號檢查。
        return stripLeadingZeros(bits);
      },
    };
  }
  if (name === 'diffie-hellman-group14-sha256') {
    const x = bytesToBigint(randomBytes(64)) % (GROUP14_P - 2n) + 1n;
    const e = modPow(2n, x, GROUP14_P);
    return {
      hash: 'SHA-256',
      ecdh: false,
      clientPublic: bigintToBytes(e),
      async finish(serverPublic) {
        const f = bytesToBigint(serverPublic);
        if (f <= 1n || f >= GROUP14_P - 1n) throw new Error('bad DH public value');
        return bigintToBytes(modPow(f, x, GROUP14_P));
      },
    };
  }
  throw new Error('unsupported kex: ' + name);
}

// ---- host key ----

// host key 演算法 → blob 裡寫的 key 型別（rsa-sha2-* 的 blob 仍是 ssh-rsa）。
export function hostKeyBlobType(alg) {
  return alg === 'rsa-sha2-256' || alg === 'rsa-sha2-512' ? 'ssh-rsa' : alg;
}

export async function hostKeyFingerprint(blob) {
  return 'SHA256:' + base64NoPad(await digest('SHA-256', blob));
}

// 用 host key blob 驗 exchange hash 的簽章。alg＝協商出的 host key 演算法。
// 失敗（含格式錯）回 false，不 throw。
export async function verifyHostSignature(alg, keyBlob, sigBlob, data) {
  try {
    const s = subtle();
    const kr = new Reader(keyBlob);
    const keyType = kr.utf8();
    const sr = new Reader(sigBlob);
    const sigAlg = sr.utf8();
    const sig = sr.string();
    if (keyType !== hostKeyBlobType(alg) || sigAlg !== alg) return false;
    if (alg === 'ssh-ed25519') {
      const pub = kr.string();
      const key = await s.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
      return await s.verify({ name: 'Ed25519' }, key, sig, data);
    }
    if (alg === 'ecdsa-sha2-nistp256') {
      if (kr.utf8() !== 'nistp256') return false;
      const q = kr.string();
      const key = await s.importKey('raw', q, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const rs = new Reader(sig);
      const r = leftPad(rs.mpint(), 32);
      const ss = leftPad(rs.mpint(), 32);
      return await s.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, concat(r, ss), data);
    }
    if (alg === 'rsa-sha2-256' || alg === 'rsa-sha2-512') {
      const e = kr.mpint();
      const n = kr.mpint();
      const hash = alg === 'rsa-sha2-512' ? 'SHA-512' : 'SHA-256';
      const key = await s.importKey(
        'jwk',
        { kty: 'RSA', e: base64Url(e), n: base64Url(n), ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash },
        false,
        ['verify']
      );
      return await s.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, sig, data);
    }
    return false;
  } catch (e) {
    return false;
  }
}

// ---- 金鑰導出（RFC 4253 §7.2）----

// HASH(K || H || X || session_id)，不夠長就 HASH(K || H || K1 || ...) 往後接。
export async function deriveKey(hash, kMpint, h, letter, sessionId, len) {
  let out = await digest(hash, concat(kMpint, h, new Uint8Array([letter.charCodeAt(0)]), sessionId));
  while (out.length < len) {
    out = concat(out, await digest(hash, concat(kMpint, h, out)));
  }
  return out.subarray(0, len);
}

export function encodeMpint(unsigned) {
  return new Writer().mpint(unsigned).bytes();
}

// ---- aes-gcm@openssh.com ----

export const CIPHERS = {
  'aes256-gcm@openssh.com': { keyLen: 32 },
  'aes128-gcm@openssh.com': { keyLen: 16 },
};

// 一個方向的 AES-GCM 狀態。IV＝4 bytes 固定欄＋8 bytes invocation counter，每個封包 +1
//（RFC 5647 §7.1）。封包長度欄不加密，當 AAD。
export class GcmCipher {
  static async create(key, iv) {
    const c = new GcmCipher();
    c._key = await subtle().importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    c._iv = new Uint8Array(iv);
    return c;
  }
  _nextIv() {
    const iv = this._iv.slice();
    for (let i = 11; i >= 4; i--) {
      this._iv[i] = (this._iv[i] + 1) & 0xff;
      if (this._iv[i] !== 0) break;
    }
    return iv;
  }
  async seal(lenBytes, plain) {
    const iv = this._nextIv();
    return new Uint8Array(
      await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: lenBytes, tagLength: 128 }, this._key, plain)
    );
  }
  async open(lenBytes, sealed) {
    const iv = this._nextIv();
    return new Uint8Array(
      await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: lenBytes, tagLength: 128 }, this._key, sealed)
    );
  }
}
