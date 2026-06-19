// Unit guard for the auto-login prompt/response state machine
// (AutoLogin.prototype._tick, src/js/auto_login.js). The live e2e shared-login
// fixture only exercises this path incidentally; this drives _tick deterministically
// with scripted screens (no network/DOM) to lock down the regression-prone bits:
//   - the duplicate-login / error-attempt answers are ONE-SHOT (the prompt may
//     linger in later banners; re-sending would leak keys into the menu), and
//   - the loose 「重複登入」match additionally requires a [Y/n] / (Y/N) indicator.
// Mirrors enhanced-addon.md's former「auto_login 重複送鍵帶離主選單」note.

import { AutoLogin } from "../../src/js/auto_login";

// Build an AutoLogin already past credential resolution (start() reads localStorage
// / the credential store, which we don't exercise here). Screen + side effects are
// stubbed on the instance; flags default to "just connected, nothing sent yet".
function makeLogin(overrides = {}) {
  const al = new AutoLogin({ connectState: 1 });
  al.__sent = [];
  al.__stopped = false;
  al.__migrated = false;
  al._readScreen = () => al.__screen || "";
  al._send = function(str) {
    al.__sent.push(str);
    al._lastActionAt = Date.now();
  };
  al.stop = function() {
    al.__stopped = true;
    al._done = true;
  };
  al._maybeMigrate = function() {
    al.__migrated = true;
  };

  al._user = "testuser";
  al._pass = "secretpass";
  al._dupConn = "N";
  al._skipWelcome = true;
  al._sentUser = false;
  al._sentPass = false;
  al._answeredDup = false;
  al._answeredErr = false;
  al._lastActionAt = 0; // past the cooldown

  Object.assign(al, overrides);
  al.__screen = overrides.__screen || "";
  return al;
}

describe("AutoLogin._tick prompt → response", () => {
  test("account prompt → sends the username once", () => {
    const al = makeLogin({ __screen: "請輸入代號，或以 guest 參觀" });
    al._tick();
    expect(al.__sent).toEqual(["testuser\r"]);
    expect(al._sentUser).toBe(true);
  });

  test("password prompt (after username sent) → sends the password once", () => {
    const al = makeLogin({ _sentUser: true, __screen: "請輸入您的密碼:" });
    al._tick();
    expect(al.__sent).toEqual(["secretpass\r"]);
    expect(al._sentPass).toBe(true);
  });

  test("does not send the password before the username", () => {
    const al = makeLogin({ __screen: "請輸入您的密碼:" });
    al._tick();
    expect(al.__sent).toEqual([]);
  });

  test("explicit duplicate-login prompt → answers with the dup preference", () => {
    const al = makeLogin({
      _sentPass: true,
      _dupConn: "Y",
      __screen: "您想刪除其他重複登入的連線嗎?[Y/n]"
    });
    al._tick();
    expect(al.__sent).toEqual(["Y\r"]);
    expect(al._answeredDup).toBe(true);
  });

  test("loose 「重複登入」 only answers when a [Y/n] indicator is present", () => {
    const noIndicator = makeLogin({ _sentPass: true, __screen: "歡迎你 重複登入 的朋友" });
    noIndicator._tick();
    expect(noIndicator.__sent).toEqual([]);
    expect(noIndicator._answeredDup).toBe(false);

    const withIndicator = makeLogin({ _sentPass: true, __screen: "重複登入 (Y/N)" });
    withIndicator._tick();
    expect(withIndicator.__sent).toEqual(["N\r"]);
  });

  test("duplicate-login answer is one-shot (lingering banner is not re-answered)", () => {
    const al = makeLogin({
      _sentPass: true,
      _answeredDup: true,
      __screen: "您想刪除其他重複登入的連線嗎?[Y/n]"
    });
    al._tick();
    expect(al.__sent).toEqual([]);
  });

  test("error-attempt prompt → answers 'n' once", () => {
    const al = makeLogin({ _sentPass: true, __screen: "您要刪除以上錯誤嘗試的記錄嗎?[Y/n]" });
    al._tick();
    expect(al.__sent).toEqual(["n\r"]);
    expect(al._answeredErr).toBe(true);
  });

  test("error-attempt answer is one-shot", () => {
    const al = makeLogin({
      _sentPass: true,
      _answeredErr: true,
      __screen: "您要刪除以上錯誤嘗試的記錄嗎?[Y/n]"
    });
    al._tick();
    expect(al.__sent).toEqual([]);
  });

  test("welcome / press-any-key screen advances when skipWelcome is on", () => {
    const al = makeLogin({ _sentPass: true, __screen: "請按任意鍵繼續" });
    al._tick();
    expect(al.__sent).toEqual([" "]);
  });

  test("welcome screen is NOT advanced when skipWelcome is off", () => {
    const al = makeLogin({ _sentPass: true, _skipWelcome: false, __screen: "請按任意鍵繼續" });
    al._tick();
    expect(al.__sent).toEqual([]);
  });

  test("reaching the main menu migrates then stops", () => {
    const al = makeLogin({ _sentPass: true, __screen: "【主功能表】" });
    al._tick();
    expect(al.__migrated).toBe(true);
    expect(al.__stopped).toBe(true);
    expect(al.__sent).toEqual([]);
  });

  test("wrong credentials → stops without retrying (avoids lockout loops)", () => {
    const al = makeLogin({ _sentPass: true, __screen: "密碼或代號錯誤，請檢查" });
    al._tick();
    expect(al.__stopped).toBe(true);
    expect(al.__sent).toEqual([]);
  });

  test("throttles repeatable prompts within the action cooldown", () => {
    const al = makeLogin({ _lastActionAt: Date.now(), __screen: "請輸入代號" });
    al._tick();
    expect(al.__sent).toEqual([]);
  });

  test("does nothing while not connected", () => {
    const al = makeLogin({ __screen: "請輸入代號" });
    al._app.connectState = 0;
    al._tick();
    expect(al.__sent).toEqual([]);
  });
});
