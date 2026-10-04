// @unit-env browser
// 雲端同步 Google 登入的選路（src/js/google_sign_in.js）。
// 守的 bug：APK（WebView）裡走 signInWithPopup ⇒ Google 回 disallowed_useragent，登入永遠失敗。
// APK 內必須改走原生 bridge 取 ID token 再 signInWithCredential。
// Firebase 側用假的 SDK handle（只記錄呼叫）；真 SDK＋emulator 的同一條路徑在
// tests/integration/pref_sync.test.js「Android APK sign-in」。
import {
  authenticateGoogle,
  clearGoogleSignInState,
  isSignInCancelled
} from "../../src/js/google_sign_in";
import { GOOGLE_WEB_CLIENT_ID } from "../../src/js/firebase_config";

function fakeFirebase() {
  class GoogleAuthProvider {}
  GoogleAuthProvider.credential = vi.fn(idToken => ({ idToken }));
  return {
    auth: { name: "auth" },
    authM: {
      GoogleAuthProvider,
      signInWithPopup: vi.fn(async () => ({ user: { uid: "p" } })),
      signInWithCredential: vi.fn(async () => ({ user: { uid: "c" } }))
    }
  };
}

// 模擬原生 bridge：reply(request) 決定回覆內容。
function installAndroid(reply) {
  const listeners = [];
  const sent = [];
  window.__PTT_ANDROID__ = { site: "wstelnet://127.0.0.1:1/bbs/t" };
  window.PttAndroid = {
    postMessage: str => {
      const req = JSON.parse(str);
      sent.push(req);
      const out = reply(req);
      queueMicrotask(() =>
        listeners.forEach(fn => fn({ data: JSON.stringify({ id: req.id, ...out }) }))
      );
    },
    addEventListener: (type, fn) => {
      if (type === "message") listeners.push(fn);
    }
  };
  return sent;
}

afterEach(() => {
  delete window.__PTT_ANDROID__;
  delete window.PttAndroid;
});

describe("authenticateGoogle", () => {
  test("瀏覽器走 signInWithPopup", async () => {
    const f = fakeFirebase();
    await authenticateGoogle(f);
    expect(f.authM.signInWithPopup).toHaveBeenCalledTimes(1);
    expect(f.authM.signInWithCredential).not.toHaveBeenCalled();
  });

  test("APK 內不碰 popup：bridge 取 ID token → signInWithCredential", async () => {
    const sent = installAndroid(() => ({ ok: true, idToken: "id-token-xyz" }));
    const f = fakeFirebase();
    const cred = await authenticateGoogle(f);
    expect(f.authM.signInWithPopup).not.toHaveBeenCalled();
    expect(sent).toEqual([
      expect.objectContaining({ op: "googleSignIn", serverClientId: GOOGLE_WEB_CLIENT_ID })
    ]);
    expect(f.authM.GoogleAuthProvider.credential).toHaveBeenCalledWith("id-token-xyz");
    expect(f.authM.signInWithCredential).toHaveBeenCalledWith(f.auth, { idToken: "id-token-xyz" });
    expect(cred.user.uid).toBe("c");
  });

  test("serverClientId 是 Web OAuth client 形狀（原生端只收這個形狀）", () => {
    expect(GOOGLE_WEB_CLIENT_ID).toMatch(/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/);
  });

  test("使用者取消 ⇒ reject 且 isSignInCancelled 為真", async () => {
    installAndroid(() => ({ ok: false, error: "cancelled" }));
    const f = fakeFirebase();
    const e = await authenticateGoogle(f).catch(x => x);
    expect(isSignInCancelled(e)).toBe(true);
    expect(f.authM.signInWithCredential).not.toHaveBeenCalled();
  });

  test("原生失敗或回覆缺 idToken ⇒ reject 且不算取消", async () => {
    for (const out of [{ ok: false, error: "failed" }, { ok: false }, { ok: true }]) {
      installAndroid(() => out);
      const f = fakeFirebase();
      const e = await authenticateGoogle(f).catch(x => x);
      expect(e).toBeInstanceOf(Error);
      expect(isSignInCancelled(e)).toBe(false);
      expect(f.authM.signInWithCredential).not.toHaveBeenCalled();
    }
  });
});

describe("isSignInCancelled", () => {
  test("瀏覽器 popup 被關掉也算取消", () => {
    expect(isSignInCancelled({ code: "auth/popup-closed-by-user" })).toBe(true);
    expect(isSignInCancelled({ code: "auth/network-request-failed" })).toBe(false);
    expect(isSignInCancelled(undefined)).toBe(false);
  });
});

describe("clearGoogleSignInState", () => {
  test("APK 內送 googleSignOut", async () => {
    const sent = installAndroid(() => ({ ok: true }));
    await clearGoogleSignInState();
    expect(sent.map(m => m.op)).toEqual(["googleSignOut"]);
  });

  test("原生失敗不往外丟", async () => {
    installAndroid(() => ({ ok: false }));
    window.PttAndroid.postMessage = () => {
      throw new Error("boom");
    };
    await expect(clearGoogleSignInState()).resolves.toBeUndefined();
  });

  test("瀏覽器不做事", async () => {
    await expect(clearGoogleSignInState()).resolves.toBeUndefined();
  });
});
