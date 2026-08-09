// Packing the PTT password and the 2FA (TOTP) secret into a single string —
// pure logic, unit-tested in tests/unit/credential_pack.test.js.
//
// Why pack at all: the Credential Management API only offers id + password on
// a PasswordCredential, and navigator.credentials.get() hands back exactly one
// credential, so a second entry holding the secret could never be read back.
// Storing both in one password field is the only way the browser's password
// manager (and its cross-device sync) can carry the secret.
//
// Format — the password always comes last:
//
//   "pttchrome:v1:" + <BASE32_SECRET> + ":" + <password>
//
//   password "pa:ss:word", secret "ABCDEFGHIJKLMNOP" pack to
//   "pttchrome:v1:ABCDEFGHIJKLMNOP:pa:ss:word", and unpacking splits at the
//   FIRST ':' after the prefix — everything past it is the password verbatim.
//
// Why that is unambiguous: the secret is normalized to Base32 ([A-Z2-7]+)
// before packing, so it can never contain ':'. The first ':' after the prefix
// is therefore always the separator, and the password may hold any number of
// ':' (or spaces, CJK, emoji) with no escaping at all. Keeping the marker and
// the secret in FRONT means there is only one boundary to find; a trailing
// marker would have to be guessed backwards through a user-chosen password of
// up to 72 characters, which could legitimately look like the marker itself.
//
// Without a secret nothing is wrapped, so non-2FA users keep a plain, human
// readable entry in their password manager and older builds still read it.

import { normalizeOtpSecret } from './totp';

export const CRED_PACK_PREFIX = 'pttchrome:v1:';

const BASE32_ONLY = /^[A-Z2-7]+$/;

export const packCredential = (password, otpSecret) => {
  const pass = typeof password === 'string' ? password : '';
  const secret = normalizeOtpSecret(otpSecret);
  if (!secret || !BASE32_ONLY.test(secret)) return pass;
  return CRED_PACK_PREFIX + secret + ':' + pass;
};

// Total function: anything unexpected falls back to "the whole string is the
// password" (the legacy shape), so a malformed envelope can never leak part of
// the secret into what gets typed at the PTT password prompt.
export const unpackCredential = stored => {
  if (typeof stored !== 'string' || !stored) {
    return { password: '', otpSecret: '' };
  }
  if (!stored.startsWith(CRED_PACK_PREFIX)) {
    return { password: stored, otpSecret: '' }; // legacy: plain password
  }

  const rest = stored.slice(CRED_PACK_PREFIX.length);
  const i = rest.indexOf(':');
  const secret = i < 0 ? '' : rest.slice(0, i);
  if (i < 0 || !BASE32_ONLY.test(secret)) {
    console.warn('credential_pack: malformed envelope, treating as password');
    return { password: stored, otpSecret: '' };
  }
  return { password: rest.slice(i + 1), otpSecret: secret };
};
