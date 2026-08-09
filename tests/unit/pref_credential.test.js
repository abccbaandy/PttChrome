// 設定頁憑證決策的純函式（src/components/ContextMenu/pref_credential.js）。
// UI 那層守在 pref_modal_autologin_tab.test.jsx；這裡鎖判斷規則本身。

import {
  normalizeAutoLoginValues,
  credentialToStore,
  localCredentialStatus,
} from "../../src/components/ContextMenu/pref_credential";
import { packCredential } from "../../src/js/credential_pack";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";

const SECRET = "ABCDEFGHIJKLMNOP";
const base = (over = {}) => ({
  ...DEFAULT_PREFS,
  autoLogin: true,
  autoLoginUser: "testuser",
  autoLoginPassword: "secretpass",
  ...over,
});

describe("normalizeAutoLoginValues", () => {
  test("把 otpauth:// 網址收斂成純 base32", () => {
    const out = normalizeAutoLoginValues(
      base({ autoLoginOtpSecret: `otpauth://totp/u?secret=${SECRET}&issuer=PTT` }),
    );
    expect(out.autoLoginOtpSecret).toBe(SECRET);
  });

  test("去掉空白與破折號並轉大寫", () => {
    expect(
      normalizeAutoLoginValues(base({ autoLoginOtpSecret: " abcd-efgh ijkl mnop " }))
        .autoLoginOtpSecret,
    ).toBe(SECRET);
  });

  test("已是正規形式時回傳同一個物件（不製造假的變更）", () => {
    const values = base({ autoLoginOtpSecret: SECRET });
    expect(normalizeAutoLoginValues(values)).toBe(values);
  });

  test("不動其他欄位", () => {
    const out = normalizeAutoLoginValues(base({ autoLoginOtpSecret: "abcdefghijklmnop" }));
    expect(out.autoLoginUser).toBe("testuser");
    expect(out.autoLoginPassword).toBe("secretpass");
  });
});

describe("credentialToStore", () => {
  const supported = { supported: true };

  test("帳密齊全時打包密鑰一起交出去", () => {
    expect(
      credentialToStore(base({ autoLoginOtpSecret: SECRET }), supported),
    ).toEqual({
      id: "testuser",
      password: packCredential("secretpass", SECRET),
    });
  });

  test("沒密鑰時交裸密碼", () => {
    expect(credentialToStore(base(), supported)).toEqual({
      id: "testuser",
      password: "secretpass",
    });
  });

  // PasswordCredential 需要 id+password 兩者；密碼可能已經只存在密碼管理員裡。
  // 這種情況交給 auto_login 的 needsStore 在下次登入成功後補存。
  test("只有密鑰沒有密碼 → 不存", () => {
    expect(
      credentialToStore(
        base({ autoLoginPassword: "", autoLoginOtpSecret: SECRET }),
        supported,
      ),
    ).toBeNull();
  });

  test.each([
    ["自動登入沒開", base({ autoLogin: false }), supported],
    ["沒帳號", base({ autoLoginUser: "" }), supported],
    ["瀏覽器不支援", base(), { supported: false }],
  ])("%s → 不存", (_name, values, opts) => {
    expect(credentialToStore(values, opts)).toBeNull();
  });
});

describe("localCredentialStatus", () => {
  test("不支援密碼管理員一律回 plaintext（明文不會被清）", () => {
    expect(localCredentialStatus(base(), { supported: false })).toBe("plaintext");
    expect(
      localCredentialStatus({ ...DEFAULT_PREFS }, { supported: false }),
    ).toBe("plaintext");
  });

  test.each(["autoLoginUser", "autoLoginPassword", "autoLoginOtpSecret"])(
    "本機只要 %s 還有值就是 pending",
    (key) => {
      expect(
        localCredentialStatus(
          { ...DEFAULT_PREFS, [key]: "x" },
          { supported: true },
        ),
      ).toBe("pending");
    },
  );

  test("三欄皆空 → none", () => {
    expect(localCredentialStatus({ ...DEFAULT_PREFS }, { supported: true })).toBe(
      "none",
    );
    expect(localCredentialStatus(null, { supported: true })).toBe("none");
  });
});
