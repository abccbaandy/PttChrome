import {
  base32Decode,
  normalizeOtpSecret,
  isValidOtpSecret,
  totpCode,
  totpCounter,
  totpRemainingMs,
  TOTP_PERIOD_SEC
} from "../../src/js/totp";

const bytesToAscii = bytes => String.fromCharCode(...bytes);

describe("base32Decode", () => {
  // RFC 4648 §10 test vectors.
  test.each([
    ["MY======", "f"],
    ["MZXQ====", "fo"],
    ["MZXW6===", "foo"],
    ["MZXW6YQ=", "foob"],
    ["MZXW6YTB", "fooba"],
    ["MZXW6YTBOI======", "foobar"]
  ])("decodes %s", (encoded, expected) => {
    expect(bytesToAscii(base32Decode(encoded))).toBe(expected);
  });

  it("accepts lower case", () => {
    expect(bytesToAscii(base32Decode("mzxw6ytboi"))).toBe("foobar");
  });

  it("ignores spaces and dashes (as the PTT server decoder does)", () => {
    expect(bytesToAscii(base32Decode("MZXW 6YTB-OI"))).toBe("foobar");
  });

  it("stops at the padding character", () => {
    expect(bytesToAscii(base32Decode("MZXW6YTB=MZXW"))).toBe("fooba");
  });

  // Silently skipping these would produce a secret that looks valid but whose
  // codes never match — the whole reason this returns null.
  test.each(["ABCD0EFG", "ABCD1EFG", "ABCD8EFG", "ABCD9EFG", "ABCD!EFG"])(
    "rejects the illegal character in %s",
    input => {
      expect(base32Decode(input)).toBeNull();
    }
  );

  it("returns null for non-strings", () => {
    expect(base32Decode(undefined)).toBeNull();
    expect(base32Decode(null)).toBeNull();
  });
});

describe("normalizeOtpSecret", () => {
  it("keeps a bare base32 secret", () => {
    expect(normalizeOtpSecret("ABCDEFGHIJKLMNOP")).toBe("ABCDEFGHIJKLMNOP");
  });

  it("upper-cases and strips spaces/dashes", () => {
    expect(normalizeOtpSecret(" abcd efgh-ijkl mnop ")).toBe(
      "ABCDEFGHIJKLMNOP"
    );
  });

  it("extracts secret= from a full otpauth:// URI", () => {
    expect(
      normalizeOtpSecret(
        "otpauth://totp/someuser?secret=ABCDEFGHIJKLMNOP&issuer=PTT"
      )
    ).toBe("ABCDEFGHIJKLMNOP");
  });

  it("finds secret= even when it is not the first parameter", () => {
    expect(
      normalizeOtpSecret("otpauth://totp/u?issuer=PTT&secret=ABCDEFGHIJKLMNOP")
    ).toBe("ABCDEFGHIJKLMNOP");
  });

  it("survives a URI pasted with surrounding whitespace/newlines", () => {
    expect(
      normalizeOtpSecret("\n  otpauth://totp/u?secret=ABCDEFGHIJKLMNOP  \n")
    ).toBe("ABCDEFGHIJKLMNOP");
  });

  it("handles a URL-encoded label", () => {
    expect(
      normalizeOtpSecret(
        "otpauth://totp/PTT%3Asomeuser?secret=ABCDEFGHIJKLMNOP&issuer=PTT"
      )
    ).toBe("ABCDEFGHIJKLMNOP");
  });

  it("accepts a bare query fragment", () => {
    expect(normalizeOtpSecret("?secret=abcdefghijklmnop")).toBe(
      "ABCDEFGHIJKLMNOP"
    );
  });

  it("returns empty for a URI without secret=", () => {
    expect(normalizeOtpSecret("otpauth://totp/someuser?issuer=PTT")).toBe("");
  });

  it("returns empty for empty/non-string input", () => {
    expect(normalizeOtpSecret("")).toBe("");
    expect(normalizeOtpSecret("   ")).toBe("");
    expect(normalizeOtpSecret(undefined)).toBe("");
  });

  // Validity is isValidOtpSecret's job — the settings UI must be able to show
  // the user exactly what they typed.
  it("does not filter out illegal characters", () => {
    expect(normalizeOtpSecret("abcd0efg")).toBe("ABCD0EFG");
  });
});

describe("isValidOtpSecret", () => {
  it("accepts a real 16-char PTT secret", () => {
    expect(isValidOtpSecret("ABCDEFGHIJKLMNOP")).toBe(true);
  });

  it("accepts it via an otpauth:// URI", () => {
    expect(
      isValidOtpSecret("otpauth://totp/u?secret=ABCDEFGHIJKLMNOP&issuer=PTT")
    ).toBe(true);
  });

  it("rejects a truncated paste (fewer than 10 bytes)", () => {
    expect(isValidOtpSecret("ABCDEFGH")).toBe(false);
  });

  it("rejects an illegal character", () => {
    expect(isValidOtpSecret("ABCDEFGHIJKLMN0P")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(isValidOtpSecret("")).toBe(false);
  });
});

describe("totpCounter / totpRemainingMs", () => {
  it("counts 30-second steps", () => {
    expect(totpCounter(0)).toBe(0);
    expect(totpCounter(29999)).toBe(0);
    expect(totpCounter(30000)).toBe(1);
    expect(totpCounter(59999)).toBe(1);
    expect(totpCounter(60000)).toBe(2);
  });

  it("reports the whole period at a step boundary and 1ms at its end", () => {
    expect(totpRemainingMs(0)).toBe(TOTP_PERIOD_SEC * 1000);
    expect(totpRemainingMs(30000)).toBe(TOTP_PERIOD_SEC * 1000);
    expect(totpRemainingMs(29999)).toBe(1);
    expect(totpRemainingMs(28000)).toBe(2000);
  });
});

describe("totpCode", () => {
  // RFC 6238 Appendix B, SHA-1 rows. The shared secret is the ASCII string
  // "12345678901234567890", i.e. base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
  const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const VECTORS = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"]
  ];

  test.each(VECTORS)("RFC 6238 vector at T=%s (8 digits)", async (t, code) => {
    expect(await totpCode(RFC_SECRET, { atMs: t * 1000, digits: 8 })).toBe(code);
  });

  // Locks in that `digits` is only a truncation length, not a different
  // algorithm — PTT reads 6 digits off the same computation.
  test.each(VECTORS)("6-digit code at T=%s is the 8-digit tail", async (t, code) => {
    expect(await totpCode(RFC_SECRET, { atMs: t * 1000 })).toBe(code.slice(2));
  });

  it("always returns 6 digits, zero-padded", async () => {
    const out = await totpCode("ABCDEFGHIJKLMNOP", { atMs: 1_700_000_000_000 });
    expect(out).toMatch(/^\d{6}$/);
  });

  it("gives the same code anywhere inside one 30s step", async () => {
    const base = 1_700_000_040_000; // exact step boundary
    const a = await totpCode("ABCDEFGHIJKLMNOP", { atMs: base });
    const b = await totpCode("ABCDEFGHIJKLMNOP", { atMs: base + 29_999 });
    expect(a).toBe(b);
  });

  it("changes at the next step", async () => {
    const base = 1_700_000_040_000;
    const a = await totpCode("ABCDEFGHIJKLMNOP", { atMs: base });
    const b = await totpCode("ABCDEFGHIJKLMNOP", { atMs: base + 30_000 });
    expect(a).not.toBe(b);
  });

  it("accepts a secret pasted as an otpauth:// URI", async () => {
    const atMs = 1_700_000_000_000;
    expect(
      await totpCode("otpauth://totp/u?secret=ABCDEFGHIJKLMNOP&issuer=PTT", {
        atMs
      })
    ).toBe(await totpCode("ABCDEFGHIJKLMNOP", { atMs }));
  });

  // Returning "" here would get typed into the terminal.
  it("rejects an invalid secret", async () => {
    await expect(totpCode("ABCDEFGHIJKLMN0P")).rejects.toThrow();
    await expect(totpCode("ABCDEFGH")).rejects.toThrow();
    await expect(totpCode("")).rejects.toThrow();
  });
});
