// Unit guard for auto-login credential resolution and migration
// (AutoLogin._resolveCredential / _maybeMigrate / setSessionCredential,
// src/js/auto_login.js) — previously untested, and now the place where the 2FA
// secret is packed into / unpacked out of the browser credential store
// (src/js/credential_pack.js).
//
// The module keeps a page-lifetime credential cache, so every test re-imports
// the module after vi.resetModules().

import { App } from "../../src/js/pttchrome";
import { packCredential } from "../../src/js/credential_pack";
import { DEFAULT_PREFS, readValuesWithDefault } from "../../src/js/pref_storage";

const PREF_KEY = "pttchrome.pref.v1";
const SECRET = "ABCDEFGHIJKLMNOP";

const writePrefs = prefs =>
  window.localStorage.setItem(
    PREF_KEY,
    JSON.stringify({ values: { ...DEFAULT_PREFS, autoLogin: true, ...prefs } })
  );

// Install a fake Credential Management API. `stored` is what get() resolves to
// (null = "the store has nothing"); pass supported:false to simulate
// Firefox/Safari.
function installCredentialApi({ stored = null, supported = true } = {}) {
  const calls = { stored: [] };
  if (!supported) {
    delete window.PasswordCredential;
    delete navigator.credentials;
    return calls;
  }
  window.PasswordCredential = class PasswordCredential {
    constructor({ id, password, name }) {
      Object.assign(this, { id, password, name });
    }
  };
  navigator.credentials = {
    get: vi.fn(async () => stored),
    store: vi.fn(async cred => {
      calls.stored.push(cred);
      return cred;
    })
  };
  return calls;
}

async function freshAutoLogin() {
  vi.resetModules();
  const { AutoLogin } = await import("../../src/js/auto_login");
  return new AutoLogin({ connectState: 1 });
}

beforeEach(() => {
  window.localStorage.clear();
  delete window.PasswordCredential;
  delete navigator.credentials;
});

describe("_resolveCredential: browser store", () => {
  test("unpacks a packed credential and clears every local copy", async () => {
    installCredentialApi({
      stored: { id: "testuser", password: packCredential("secretpass", SECRET) }
    });
    writePrefs({
      autoLoginUser: "olduser",
      autoLoginPassword: "oldpass",
      autoLoginOtpSecret: SECRET
    });

    const al = await freshAutoLogin();
    const cred = await al._resolveCredential(readValuesWithDefault());

    expect(cred).toMatchObject({
      user: "testuser",
      pass: "secretpass",
      otpSecret: SECRET,
      legacy: false,
      needsStore: false
    });
    const v = readValuesWithDefault();
    expect(v.autoLoginUser).toBe("");
    expect(v.autoLoginPassword).toBe("");
    expect(v.autoLoginOtpSecret).toBe("");
  });

  // The upgrade path: the password was saved before 2FA support existed, so the
  // secret lives on this machine only. Clearing it here would lose it for good.
  test("a bare password keeps the local secret and asks to re-store", async () => {
    installCredentialApi({ stored: { id: "testuser", password: "secretpass" } });
    writePrefs({ autoLoginOtpSecret: SECRET });

    const al = await freshAutoLogin();
    const cred = await al._resolveCredential(readValuesWithDefault());

    expect(cred).toMatchObject({
      user: "testuser",
      pass: "secretpass",
      otpSecret: SECRET,
      needsStore: true
    });
    expect(readValuesWithDefault().autoLoginOtpSecret).toBe(SECRET);
  });

  test("a bare password with no local secret leaves 2FA unconfigured", async () => {
    installCredentialApi({ stored: { id: "testuser", password: "secretpass" } });
    writePrefs({ autoLoginUser: "testuser", autoLoginPassword: "secretpass" });

    const al = await freshAutoLogin();
    const cred = await al._resolveCredential(readValuesWithDefault());

    expect(cred).toMatchObject({ otpSecret: "", needsStore: false });
    expect(readValuesWithDefault().autoLoginUser).toBe("");
  });
});

describe("_resolveCredential: fallbacks", () => {
  test("without the Credential API the local plaintext (incl. secret) is used and kept", async () => {
    installCredentialApi({ supported: false });
    writePrefs({
      autoLoginUser: "testuser",
      autoLoginPassword: "secretpass",
      autoLoginOtpSecret: SECRET
    });

    const al = await freshAutoLogin();
    const cred = await al._resolveCredential(readValuesWithDefault());

    expect(cred).toMatchObject({
      user: "testuser",
      pass: "secretpass",
      otpSecret: SECRET,
      legacy: true
    });
    expect(readValuesWithDefault().autoLoginPassword).toBe("secretpass");
    expect(readValuesWithDefault().autoLoginOtpSecret).toBe(SECRET);
  });

  test("an empty store falls back to the local plaintext", async () => {
    installCredentialApi({ stored: null });
    writePrefs({ autoLoginUser: "testuser", autoLoginPassword: "secretpass" });

    const al = await freshAutoLogin();
    const cred = await al._resolveCredential(readValuesWithDefault());

    expect(cred).toMatchObject({ user: "testuser", legacy: true });
    expect(readValuesWithDefault().autoLoginUser).toBe("testuser");
  });

  test("nothing anywhere → no credential", async () => {
    installCredentialApi({ stored: null });
    writePrefs({});

    const al = await freshAutoLogin();
    expect(await al._resolveCredential(readValuesWithDefault())).toBeNull();
  });
});

describe("setSessionCredential", () => {
  test("caches what PrefModal saved, secret included", async () => {
    installCredentialApi({ stored: { id: "other", password: "otherpass" } });
    const al = await freshAutoLogin();
    al.setSessionCredential("testuser", "secretpass", SECRET);

    // Session cache wins over the browser store (no chooser on reconnect).
    expect(await al._resolveCredential(readValuesWithDefault())).toMatchObject({
      user: "testuser",
      pass: "secretpass",
      otpSecret: SECRET
    });
  });

  // "I only filled in the OTP secret" — the password already lives in the
  // browser store, so it must not be wiped from the cache.
  test("a secret-only update keeps the cached password", async () => {
    const al = await freshAutoLogin();
    al.setSessionCredential("testuser", "secretpass", "");
    al.setSessionCredential("", "", SECRET);

    expect(await al._resolveCredential(readValuesWithDefault())).toMatchObject({
      user: "testuser",
      pass: "secretpass",
      otpSecret: SECRET
    });
  });

  test("an empty call changes nothing", async () => {
    installCredentialApi({ stored: null });
    writePrefs({ autoLoginUser: "testuser", autoLoginPassword: "secretpass" });
    const al = await freshAutoLogin();
    al.setSessionCredential("", "", "");

    expect(await al._resolveCredential(readValuesWithDefault())).toMatchObject({
      user: "testuser",
      legacy: true
    });
  });
});

// 迴歸守護：明文改成「留到 get() 證實才清」之後，啟動路徑（main.jsx 也呼叫
// onValuesPrefChange）若順手把 localStorage 的明文塞進 session cache，
// _resolveCredential 會直接回快取、永遠不呼叫 credentials.get() → 明文永遠清不掉。
// 症狀：設定完帳密、重整、自動登入成功，但設定頁欄位仍留著明文。
describe("App.onValuesPrefChange: 只有設定頁編輯能填 session cache", () => {
  const callWith = (opts) => {
    const setSessionCredential = vi.fn();
    App.prototype.onValuesPrefChange.call(
      { onPrefChange: vi.fn(), autoLogin: { setSessionCredential } },
      {
        autoLogin: true,
        autoLoginUser: "testuser",
        autoLoginPassword: "secretpass",
        autoLoginOtpSecret: SECRET
      },
      opts
    );
    return setSessionCredential;
  };

  test("啟動／雲端路徑（無 opts）不快取", () => {
    expect(callWith(undefined)).not.toHaveBeenCalled();
  });

  test("設定頁存檔路徑（fromPrefModal）才快取，且帶著密鑰", () => {
    expect(callWith({ fromPrefModal: true })).toHaveBeenCalledWith(
      "testuser",
      "secretpass",
      SECRET
    );
  });
});

describe("_maybeMigrate", () => {
  const migrateWith = async (props, api) => {
    const calls = installCredentialApi(api);
    const al = await freshAutoLogin();
    Object.assign(al, {
      _user: "testuser",
      _pass: "secretpass",
      _otpSecret: "",
      _usedLegacy: false,
      _needsStore: false,
      ...props
    });
    al._maybeMigrate();
    return calls;
  };

  test("legacy login with a secret stores the packed credential", async () => {
    const calls = await migrateWith({ _usedLegacy: true, _otpSecret: SECRET });
    expect(calls.stored).toHaveLength(1);
    expect(calls.stored[0].id).toBe("testuser");
    expect(calls.stored[0].password).toBe(packCredential("secretpass", SECRET));
  });

  test("legacy login without a secret stores the bare password", async () => {
    const calls = await migrateWith({ _usedLegacy: true });
    expect(calls.stored[0].password).toBe("secretpass");
  });

  // The store already had the password but not the secret → re-store so the
  // browser offers "update password".
  test("needsStore alone triggers the re-store", async () => {
    const calls = await migrateWith({ _needsStore: true, _otpSecret: SECRET });
    expect(calls.stored[0].password).toBe(packCredential("secretpass", SECRET));
  });

  test("nothing to do → no store() call", async () => {
    const calls = await migrateWith({});
    expect(calls.stored).toHaveLength(0);
  });

  test("no Credential API → no crash, no store", async () => {
    const calls = await migrateWith(
      { _usedLegacy: true, _otpSecret: SECRET },
      { supported: false }
    );
    expect(calls.stored).toHaveLength(0);
  });
});
