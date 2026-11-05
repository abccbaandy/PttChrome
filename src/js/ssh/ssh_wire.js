// SSH 線路上的基本型別（RFC 4251 §5）：byte／boolean／uint32／string／mpint／name-list。
// 純函式，無 DOM、無網路。守護 tests/unit/ssh_wire.test.js。

const enc = new TextEncoder();
const dec = new TextDecoder();

export function utf8(s) {
  return enc.encode(s);
}

export function fromUtf8(bytes) {
  return dec.decode(bytes);
}

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// latin1 字串（telnet 層的 byte 表示法）⇄ Uint8Array。
export function latin1ToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function bytesToLatin1(b) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < b.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, b.subarray(i, i + CHUNK));
  }
  return s;
}

// OpenSSH 指紋格式：base64(SHA256(blob)) 去掉結尾的 '='。
export function base64NoPad(bytes) {
  return btoa(bytesToLatin1(bytes)).replace(/=+$/, '');
}

export function base64Url(bytes) {
  return btoa(bytesToLatin1(bytes)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// 無號 big-endian bytes → mpint 編碼的內容（不含長度）：去前導 0，最高位元是 1 就補一個 0。
export function mpintBody(unsigned) {
  let i = 0;
  while (i < unsigned.length && unsigned[i] === 0) i++;
  const v = unsigned.subarray(i);
  if (v.length && v[0] & 0x80) return concat(new Uint8Array([0]), v);
  return v;
}

// mpint 內容 → 無號 bytes（去掉補的 0）。負數在 SSH 這幾個欄位不會出現，當成錯誤。
export function mpintToUnsigned(body) {
  if (body.length && body[0] & 0x80) throw new Error('negative mpint');
  let i = 0;
  while (i < body.length && body[i] === 0) i++;
  return body.subarray(i);
}

export function bigintToBytes(n) {
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToBigint(b) {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

// 左補 0 到固定長度（ECDSA 的 r／s 要各 32 bytes）。
export function leftPad(b, len) {
  if (b.length === len) return b;
  if (b.length > len) throw new Error('value too long');
  const out = new Uint8Array(len);
  out.set(b, len - b.length);
  return out;
}

export class Writer {
  constructor() {
    this._parts = [];
  }
  byte(v) {
    this._parts.push(new Uint8Array([v & 0xff]));
    return this;
  }
  bool(v) {
    return this.byte(v ? 1 : 0);
  }
  uint32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0);
    this._parts.push(b);
    return this;
  }
  raw(bytes) {
    this._parts.push(bytes);
    return this;
  }
  // string：Uint8Array 原樣、JS 字串以 UTF-8 編碼。
  string(v) {
    const b = typeof v === 'string' ? utf8(v) : v;
    this.uint32(b.length);
    this._parts.push(b);
    return this;
  }
  nameList(arr) {
    return this.string(arr.join(','));
  }
  // 參數是無號 big-endian bytes。
  mpint(unsigned) {
    return this.string(mpintBody(unsigned));
  }
  bytes() {
    return concat(...this._parts);
  }
}

export class Reader {
  constructor(bytes, offset = 0) {
    this._b = bytes;
    this._o = offset;
  }
  get remaining() {
    return this._b.length - this._o;
  }
  _need(n) {
    if (this._o + n > this._b.length) throw new Error('truncated SSH message');
  }
  byte() {
    this._need(1);
    return this._b[this._o++];
  }
  bool() {
    return this.byte() !== 0;
  }
  uint32() {
    this._need(4);
    const b = this._b;
    const o = this._o;
    this._o += 4;
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }
  raw(n) {
    this._need(n);
    const v = this._b.subarray(this._o, this._o + n);
    this._o += n;
    return v;
  }
  string() {
    return this.raw(this.uint32());
  }
  utf8() {
    return fromUtf8(this.string());
  }
  nameList() {
    const s = this.utf8();
    return s ? s.split(',') : [];
  }
  // 回無號 big-endian bytes。
  mpint() {
    return mpintToUnsigned(this.string());
  }
}
