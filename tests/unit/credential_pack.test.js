import {
  packCredential,
  unpackCredential,
  CRED_PACK_PREFIX
} from "../../src/js/credential_pack";

const SECRET = "ABCDEFGHIJKLMNOP";

describe("packCredential", () => {
  it("returns the password untouched when there is no secret", () => {
    expect(packCredential("hunter2", "")).toBe("hunter2");
    expect(packCredential("hunter2", undefined)).toBe("hunter2");
    expect(packCredential("hunter2", "   ")).toBe("hunter2");
  });

  it("wraps password and secret with the password last", () => {
    expect(packCredential("hunter2", SECRET)).toBe(
      CRED_PACK_PREFIX + SECRET + ":hunter2"
    );
  });

  it("normalizes the secret before packing", () => {
    expect(packCredential("hunter2", " abcd efgh-ijkl mnop ")).toBe(
      CRED_PACK_PREFIX + SECRET + ":hunter2"
    );
    expect(
      packCredential("hunter2", `otpauth://totp/u?secret=${SECRET}&issuer=PTT`)
    ).toBe(CRED_PACK_PREFIX + SECRET + ":hunter2");
  });

  // A secret that cannot be a Base32 string would break the "first colon is
  // the separator" invariant, so it is dropped rather than packed.
  it("ignores a secret that is not valid base32", () => {
    expect(packCredential("hunter2", "not:base32!")).toBe("hunter2");
  });
});

describe("unpackCredential", () => {
  // The single most important case: everyone who saved a password before 2FA
  // support existed has a plain string in their password manager.
  it("returns a legacy plain password verbatim, with no secret", () => {
    for (const pw of ["hunter2", "a:b:c", "pttchrome", "  spaced  ", "重複:登入"]) {
      expect(unpackCredential(pw)).toEqual({ password: pw, otpSecret: "" });
    }
  });

  it("splits at the first colon only, so the password may contain colons", () => {
    expect(unpackCredential(CRED_PACK_PREFIX + SECRET + ":pa:ss:word")).toEqual({
      password: "pa:ss:word",
      otpSecret: SECRET
    });
  });

  it("never throws on junk input", () => {
    expect(unpackCredential(undefined)).toEqual({ password: "", otpSecret: "" });
    expect(unpackCredential(null)).toEqual({ password: "", otpSecret: "" });
    expect(unpackCredential("")).toEqual({ password: "", otpSecret: "" });
    expect(unpackCredential(42)).toEqual({ password: "", otpSecret: "" });
  });

  test.each([
    ["no separator", CRED_PACK_PREFIX + SECRET],
    ["lower-case secret segment", CRED_PACK_PREFIX + "abcdefgh:pw"],
    ["illegal character in secret", CRED_PACK_PREFIX + "ABCD0EFG:pw"],
    ["empty secret segment", CRED_PACK_PREFIX + ":pw"]
  ])("falls back to legacy semantics on a malformed envelope (%s)", (_n, s) => {
    expect(unpackCredential(s)).toEqual({ password: s, otpSecret: "" });
  });
});

describe("pack/unpack round trip", () => {
  test.each([
    ["plain", "hunter2"],
    ["with colons", "pa:ss:word"],
    ["leading colon", ":leading"],
    ["trailing colon", "trailing:"],
    ["with spaces", "  two words  "],
    ["CJK", "密碼測試"],
    ["emoji", "pw🔑🔒"],
    ["72 chars (PTT PW_PLAIN_LEN)", "x".repeat(72)],
    ["looks like our own prefix", CRED_PACK_PREFIX + "ZZZZ:nested"]
  ])("restores %s exactly", (_name, password) => {
    expect(unpackCredential(packCredential(password, SECRET))).toEqual({
      password,
      otpSecret: SECRET
    });
  });

  it("restores an empty password", () => {
    expect(unpackCredential(packCredential("", SECRET))).toEqual({
      password: "",
      otpSecret: SECRET
    });
  });
});
