// Auto-login credential decisions for PrefModal — pure logic (no React, no
// browser API calls), unit-tested in tests/unit/pref_credential.test.js.
// The actual navigator.credentials.store() call stays in PrefModal.jsx.

import { normalizeOtpSecret } from "../../js/totp";
import { packCredential } from "../../js/credential_pack";

// Canonicalize the OTP secret before it is persisted, so a pasted
// `otpauth://…` URI (what PTT prints) becomes the bare Base32 string the rest
// of the code expects — and the user sees the result in the field.
export const normalizeAutoLoginValues = (values) => {
  const secret = normalizeOtpSecret(values.autoLoginOtpSecret);
  if (secret === values.autoLoginOtpSecret) return values;
  return { ...values, autoLoginOtpSecret: secret };
};

// What to hand to the browser's password manager, or null when there is
// nothing to save.
//
// A secret without a password can't be stored: a PasswordCredential needs
// both, and the password may well live in the store already. That case is
// picked up later by auto_login.js (needsStore), which re-stores the packed
// credential after the next successful login.
export const credentialToStore = (values, { supported } = {}) => {
  if (
    !supported ||
    !values.autoLogin ||
    !values.autoLoginUser ||
    !values.autoLoginPassword
  ) {
    return null;
  }
  return {
    id: values.autoLoginUser,
    password: packCredential(
      values.autoLoginPassword,
      values.autoLoginOtpSecret,
    ),
  };
};

// Which explanation the credentials fieldset shows, derived from what is
// actually sitting in localStorage right now (NOT from the form state, which
// changes as the user types).
//   plaintext — no Credential Management API: the copy never goes away
//   pending   — a local copy exists, auto_login will clear it once the browser
//               store is proven to hold it
//   none      — nothing local; the browser store is the only source
export const localCredentialStatus = (stored, { supported } = {}) => {
  if (!supported) return "plaintext";
  const has =
    !!stored &&
    (stored.autoLoginUser ||
      stored.autoLoginPassword ||
      stored.autoLoginOtpSecret);
  return has ? "pending" : "none";
};
