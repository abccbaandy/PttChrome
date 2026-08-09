// TOTP (RFC 6238) for PTT's two-factor authentication — pure logic, no DOM,
// unit-tested in tests/unit/totp.test.js.
//
// Parameters come straight from the official server implementation
// (3rd_script/pttbbs/common/sys/2fa.c): HMAC-SHA1, 6 digits, 30 second period,
// Base32 secret (PTT generates 10 random bytes → 16 chars of A-Z2-7). The
// server verifies with time_window=1, i.e. it accepts the neighbouring steps
// too (±30s of clock skew).
//
// Secrets reach us three ways — a bare Base32 string, one with spaces/dashes
// pasted from a screen, or the whole `otpauth://totp/<user>?secret=...&issuer=`
// URI PTT prints (3rd_script/pttbbs/mbbsd/user.c) — so normalizeOtpSecret
// accepts all of them.

export const TOTP_PERIOD_SEC = 30;
export const TOTP_DIGITS = 6;
// PTT's generate_2fa_secret() always emits 10 bytes; anything shorter is a
// truncated paste rather than a real secret.
export const MIN_SECRET_BYTES = 10;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// RFC 4648 Base32 → bytes. Returns null when the input contains a character
// that is not part of the alphabet.
//
// Invalid characters must NOT be skipped silently: 0/1/8/9 are the usual typo
// for O/I/B/g, and swallowing them yields a secret that looks fine but whose
// codes are always wrong — the hardest possible bug to diagnose. Whitespace
// and '-' are ignored and '=' ends the data, matching the server's decoder.
export const base32Decode = str => {
  if (typeof str !== 'string') return null;
  const bytes = [];
  let buffer = 0;
  let bitsLeft = 0;

  for (const rawCh of str) {
    if (rawCh === ' ' || rawCh === '\t' || rawCh === '\r' || rawCh === '\n' ||
        rawCh === '-') {
      continue;
    }
    if (rawCh === '=') break; // padding: nothing meaningful follows

    const val = BASE32_ALPHABET.indexOf(rawCh.toUpperCase());
    if (val < 0) return null;

    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bytes.push((buffer >> (bitsLeft - 8)) & 0xff);
      bitsLeft -= 8;
    }
  }
  // Trailing bits that don't complete a byte are padding — drop them (a
  // 16-char secret is exactly 80 bits, so this never happens for PTT).
  return new Uint8Array(bytes);
};

// User input → canonical Base32 (upper case, no separators). Returns "" when
// nothing usable can be extracted.
//
// Deliberately does NOT reject malformed secrets: the settings UI has to show
// the user what they actually typed, so validity is isValidOtpSecret's job.
export const normalizeOtpSecret = input => {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (!trimmed) return '';

  // A pasted otpauth:// URI (or just its query part). Parsed with a regex
  // rather than new URL(): otpauth is a non-special scheme whose host/path
  // handling differs between engines, and the regex also survives the stray
  // whitespace/newlines that come with copying a whole line off the screen.
  if (/^otpauth:/i.test(trimmed) || /[?&]secret=/i.test(trimmed)) {
    const m = /[?&]secret=([^&\s#]+)/i.exec(trimmed);
    if (!m) return '';
    let raw = m[1];
    try {
      raw = decodeURIComponent(raw);
    } catch (e) {
      // malformed percent-escape → use the raw match
    }
    return raw.replace(/[\s-]/g, '').toUpperCase();
  }

  return trimmed.replace(/[\s-]/g, '').toUpperCase();
};

export const isValidOtpSecret = input => {
  const bytes = base32Decode(normalizeOtpSecret(input));
  return !!bytes && bytes.length >= MIN_SECRET_BYTES;
};

// Which 30-second step `atMs` falls into.
export const totpCounter = (atMs = Date.now(), period = TOTP_PERIOD_SEC) =>
  Math.floor(atMs / 1000 / period);

// Milliseconds left in the current step (period*1000 at its very start, 1 at
// its last millisecond). Used to avoid sending a code that is about to expire.
export const totpRemainingMs = (atMs = Date.now(), period = TOTP_PERIOD_SEC) => {
  const span = period * 1000;
  return span - (atMs % span);
};

// Generate the current code. Throws on an unusable secret (returning "" would
// end up typed into the terminal) or when WebCrypto is missing (insecure
// context — auto-login needs HTTPS/localhost anyway).
//
// `digits` is configurable only so the 8-digit RFC 6238 test vectors can be
// checked directly; PTT always uses 6.
export const totpCode = async (secret, opts = {}) => {
  const {
    atMs = Date.now(),
    period = TOTP_PERIOD_SEC,
    digits = TOTP_DIGITS
  } = opts;

  const key = base32Decode(normalizeOtpSecret(secret));
  if (!key || key.length < MIN_SECRET_BYTES) {
    throw new Error('totp: invalid secret');
  }
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('totp: WebCrypto unavailable');

  const counter = totpCounter(atMs, period);
  const msg = new Uint8Array(8);
  const view = new DataView(msg.buffer);
  view.setUint32(0, Math.floor(counter / 4294967296));
  view.setUint32(4, counter % 4294967296);

  const cryptoKey = await subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const hmac = new Uint8Array(await subtle.sign('HMAC', cryptoKey, msg));

  // RFC 4226 dynamic truncation.
  const offset = hmac[19] & 0x0f;
  const truncated =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];

  return String(truncated % Math.pow(10, digits)).padStart(digits, '0');
};
