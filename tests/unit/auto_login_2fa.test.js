// Unit guard for the two-factor (TOTP) step of the auto-login state machine
// (AutoLogin.prototype._handleOtp, src/js/auto_login.js). Screens are scripted
// from the official prompts in 3rd_script/pttbbs/mbbsd/mbbsd.c#checkuser_2fa;
// the live e2e can't reach this path at all (it needs a 2FA-enabled account and
// a real clock), so everything is locked down here.
//
// Sending a code is async (WebCrypto), so the tests await al._otpPromise after
// each _tick().

import { AutoLogin } from "../../src/js/auto_login";
import { totpCode, TOTP_PERIOD_SEC } from "../../src/js/totp";

const SECRET = "ABCDEFGHIJKLMNOP";

// The real prompt, exactly as mbbsd prints it.
const OTP_PROMPT =
  "此帳號需要兩階段驗證。\n請輸入兩階段(2FA)驗證碼(6位限時數字 或 8位救援碼):";
const OTP_BAD = OTP_PROMPT + "\n驗證碼錯誤。請確定在時限前輸入完畢。";

// A step boundary, so remaining-time maths in the tests is obvious.
const STEP_START = 1_700_000_040_000;

function makeLogin(overrides = {}) {
  const al = new AutoLogin({ connectState: 1 });
  al.__sent = [];
  al.__stopped = false;
  al.__migrated = false;
  al._readScreen = () => al.__screen || "";
  al._send = function (str) {
    al.__sent.push(str);
    al._lastActionAt = Date.now();
  };
  al.stop = function () {
    al.__stopped = true;
    al._done = true;
  };
  al._maybeMigrate = function () {
    al.__migrated = true;
  };

  al._user = "testuser";
  al._pass = "secretpass";
  al._otpSecret = SECRET;
  al._dupConn = "N";
  al._skipWelcome = true;
  al._sentUser = true;
  al._sentPass = true;
  al._answeredDup = false;
  al._answeredErr = false;
  al._sawOtpPrompt = false;
  al._otpPending = false;
  al._otpAttempts = 0;
  al._otpLastCounter = -1;
  al._otpLastCode = "";
  al._otpSentAt = 0;
  al._otpPromise = null;
  al._seq = 1;
  al._deadline = Date.now() + 90000;
  al._lastActionAt = 0;

  Object.assign(al, overrides);
  al.__screen = overrides.__screen || "";
  return al;
}

// _tick + settle the async code generation.
async function tick(al) {
  al._tick();
  if (al._otpPromise) await al._otpPromise;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(STEP_START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("2FA prompt → sends the current TOTP", () => {
  test("sends the code the same secret+clock produces", async () => {
    const al = makeLogin({ __screen: OTP_PROMPT });
    await tick(al);
    expect(al.__sent).toEqual([
      (await totpCode(SECRET, { atMs: STEP_START })) + "\r"
    ]);
    expect(al._otpAttempts).toBe(1);
    expect(al.__stopped).toBe(false);
  });

  test("extends the deadline once the prompt is on screen", async () => {
    const al = makeLogin({ __screen: OTP_PROMPT, _deadline: STEP_START + 1000 });
    await tick(al);
    expect(al._deadline).toBeGreaterThan(STEP_START + 60000);
  });

  // The prompt is ~50 columns wide, so on an 80-column screen it can wrap in
  // at most one place; _readScreen joins rows with '\n'.
  test("still detects the prompt when the line wraps", async () => {
    const al = makeLogin({
      __screen: "請輸入兩階段(2FA)驗證碼(6位限時數\n字 或 8位救援碼):"
    });
    await tick(al);
    expect(al.__sent).toHaveLength(1);
  });
});

describe("no usable secret → hands over to the user", () => {
  // This is the documented opt-out ("leave the secret empty and type the six
  // digits yourself"), not just error handling: a stray key would count as a
  // wrong code and burn one of the server's five attempts.
  test("empty secret → stops without sending anything", async () => {
    const al = makeLogin({ _otpSecret: "", __screen: OTP_PROMPT });
    await tick(al);
    expect(al.__sent).toEqual([]);
    expect(al.__stopped).toBe(true);
  });

  test("malformed secret → stops without sending anything", async () => {
    const al = makeLogin({ _otpSecret: "ABCD0EFG", __screen: OTP_PROMPT });
    await tick(al);
    expect(al.__sent).toEqual([]);
    expect(al.__stopped).toBe(true);
  });
});

describe("retries", () => {
  // The rejection line stays on screen, so without the gap the next poll would
  // fire the following code before the server has answered the previous one.
  test("does not fire the next code before the server has answered", async () => {
    const al = makeLogin({ __screen: OTP_PROMPT });
    await tick(al);
    al.__screen = OTP_BAD;
    al._lastActionAt = 0; // past the action cooldown
    await tick(al);
    expect(al.__sent).toHaveLength(1);
  });

  // A clock that is off by more than the server's own ±30s tolerance gets every
  // code rejected, so re-sending the same window's code can never recover —
  // walk the neighbouring windows instead.
  test("a rejection moves on to the neighbouring window's code", async () => {
    const al = makeLogin({ __screen: OTP_PROMPT });
    await tick(al);
    vi.setSystemTime(STEP_START + 2000); // past OTP_RETRY_GAP_MS
    al.__screen = OTP_BAD;
    al._lastActionAt = 0;
    await tick(al);
    expect(al.__sent).toHaveLength(2);
    expect(al.__sent[1]).not.toBe(al.__sent[0]);
    expect(al.__sent[1]).toBe(
      (await totpCode(SECRET, {
        atMs: STEP_START + 2000 - TOTP_PERIOD_SEC * 1000
      })) + "\r"
    );
  });

  test("and then the window on the other side", async () => {
    const al = makeLogin({ __screen: OTP_PROMPT });
    await tick(al);
    al.__screen = OTP_BAD;
    vi.setSystemTime(STEP_START + 2000);
    al._lastActionAt = 0;
    await tick(al);
    vi.setSystemTime(STEP_START + 4000);
    al._lastActionAt = 0;
    await tick(al);
    expect(al.__sent).toHaveLength(3);
    expect(al.__sent[2]).toBe(
      (await totpCode(SECRET, {
        atMs: STEP_START + 4000 + TOTP_PERIOD_SEC * 1000
      })) + "\r"
    );
  });

  // The server allows five tries; we spend three and leave the rest for a
  // hand-typed code or a recovery code.
  test("gives up once every skew step has been rejected", async () => {
    const al = makeLogin({ __screen: OTP_PROMPT });
    await tick(al);
    al.__screen = OTP_BAD;
    for (let i = 1; i <= 3; ++i) {
      vi.setSystemTime(STEP_START + 2000 * i);
      al._lastActionAt = 0;
      await tick(al);
    }
    expect(al.__sent).toHaveLength(3);
    expect(al.__stopped).toBe(true);
  });

  // Crossing a window boundary can make the next step land on the code we just
  // sent; burn the step rather than one of the server's five attempts.
  test("never sends the same code twice in a row", async () => {
    const al = makeLogin({ __screen: OTP_PROMPT });
    await tick(al);
    al.__screen = OTP_BAD;
    // Step -1 from here is exactly the window we just sent for.
    vi.setSystemTime(STEP_START + TOTP_PERIOD_SEC * 1000 + 2000);
    al._lastActionAt = 0;
    await tick(al);
    expect(al.__sent).toHaveLength(1);
    expect(al._otpAttempts).toBe(2); // the step was spent, the attempt was not
  });

  test("stops on the lockout message without sending", async () => {
    const al = makeLogin({ __screen: "兩階段驗證失敗次數過多。" });
    await tick(al);
    expect(al.__sent).toEqual([]);
    expect(al.__stopped).toBe(true);
  });
});

describe("timing window", () => {
  test("waits when the current code is about to expire", async () => {
    vi.setSystemTime(STEP_START + 29_500); // 500ms left
    const al = makeLogin({ __screen: OTP_PROMPT });
    await tick(al);
    expect(al.__sent).toEqual([]);
    expect(al.__stopped).toBe(false);

    vi.setSystemTime(STEP_START + 30_000); // next window
    await tick(al);
    expect(al.__sent).toHaveLength(1);
  });
});

describe("async guards", () => {
  test("a pending computation blocks a second send", async () => {
    const al = makeLogin({ __screen: OTP_PROMPT });
    al._tick();
    al._tick(); // still pending
    await al._otpPromise;
    expect(al.__sent).toHaveLength(1);
  });

  test("does not send when the prompt is gone by the time the code is ready", async () => {
    const al = makeLogin({ __screen: OTP_PROMPT });
    al._tick();
    al.__screen = "【主功能表】"; // server moved on
    await al._otpPromise;
    expect(al.__sent).toEqual([]);
  });

  test("does not send after stop() (e.g. a reconnect restarted the run)", async () => {
    const al = makeLogin({ __screen: OTP_PROMPT });
    al._tick();
    al.stop();
    await al._otpPromise;
    expect(al.__sent).toEqual([]);
  });

  test("does not send when the connection dropped meanwhile", async () => {
    const al = makeLogin({ __screen: OTP_PROMPT });
    al._tick();
    al._app.connectState = 0;
    await al._otpPromise;
    expect(al.__sent).toEqual([]);
  });
});

describe("screens that merely mention 2FA must not trigger a code", () => {
  // 「2FA」appears in the success line and in the self-heal notice too, which is
  // why it can't be used as the prompt marker.
  test.each([
    ["success line", "2FA 兩階段驗證成功。"],
    [
      "self-heal notice",
      "[系統提示] 找不到 2FA 設定檔，已自動重設 2FA 狀態。"
    ]
  ])("%s", async (_name, screen) => {
    const al = makeLogin({ __screen: screen });
    await tick(al);
    expect(al.__sent).toEqual([]);
    expect(al.__stopped).toBe(false);
  });
});

describe("accounts that are never asked for a code (U_2FA_NEWIP)", () => {
  // The server skips 2FA when the source IP matches lasthost, so the rest of
  // the flow must not wait for an OTP that never comes.
  test("main menu straight after the password → migrate + stop, no OTP sent", async () => {
    const al = makeLogin({ __screen: "【主功能表】" });
    await tick(al);
    expect(al.__sent).toEqual([]);
    expect(al.__migrated).toBe(true);
    expect(al.__stopped).toBe(true);
  });

  test("later prompts are still answered when no OTP was ever sent", async () => {
    const al = makeLogin({ __screen: "您想刪除其他重複登入的連線嗎?[Y/n]" });
    await tick(al);
    expect(al.__sent).toEqual(["N\r"]);
  });
});

describe("after a successful 2FA the flow continues", () => {
  test("duplicate-login prompt is answered as usual", async () => {
    const al = makeLogin({ __screen: OTP_PROMPT });
    await tick(al);
    expect(al.__sent).toHaveLength(1);

    al.__screen = "您想刪除其他重複登入的連線嗎?[Y/n]";
    al._lastActionAt = 0;
    await tick(al);
    expect(al.__sent[1]).toBe("N\r");
    expect(al._answeredDup).toBe(true);
  });
});
