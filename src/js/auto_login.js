// Enhanced Add-on: remember credentials + auto login.
//
// Self-driven polling loop (does NOT wait for keypresses). Each tick reads the
// current screen straight from the term buffer (getRowText — always up to date,
// unlike #mainContainer.innerText which lags one frame because the 'change' event
// fires before the React re-render) and responds to login prompts, mirroring the
// proven flow in tests/e2e/helpers/ptt.js#login. Account/password are sent via
// app.sendData (Big5-converted). Stops once the main menu is reached or after a
// max duration, so it never interferes with normal use.
//
// Credential sources, in order (see _resolveCredential):
//   1. session cache — set when PrefModal saves, or by an earlier resolution;
//      keeps reconnects from re-prompting the browser chooser.
//   2. browser credential store (Credential Management API / PasswordCredential,
//      e.g. Google Password Manager). mediation 'optional': silent once the user
//      enables auto sign-in, otherwise shows the account chooser on page load.
//   3. legacy plaintext prefs in localStorage (pre-migration data, unsupported
//      browsers like Firefox/Safari, and e2e injection).
// The stored password may carry the 2FA secret alongside it (credential_pack.js)
// because a PasswordCredential has nowhere else to put it.
// Migration is self-healing and never drops credentials: a legacy login that
// reaches the main menu triggers credentials.store() (browser save prompt), but
// the plaintext copy (username AND password) is only wiped once a later get()
// proves the browser really has it (store() resolving does not mean the user
// accepted the prompt). The same store() call re-packs the credential when the
// user has since added an OTP secret.

import {
  readValuesWithDefault,
  clearLegacyAutoLoginCredential
} from './pref_storage';
import { packCredential, unpackCredential } from './credential_pack';
import {
  isValidOtpSecret,
  totpCode,
  totpCounter,
  totpRemainingMs,
  TOTP_PERIOD_SEC
} from './totp';

const MAIN_MENU = ['主功能表', '【主功能表】'];
const POLL_MS = 500;
const ACTION_COOLDOWN_MS = 900;
const MAX_DURATION_MS = 90000;

// 2FA screens, from the official mbbsd/mbbsd.c#checkuser_2fa:
//   prompt  「請輸入兩階段(2FA)驗證碼(6位限時數字 或 8位救援碼):」
//   error   「驗證碼錯誤。請確定在時限前輸入完畢。」(5 attempts, then locked)
//   locked  「兩階段驗證失敗次數過多。」→ back to the account prompt
// The marker must NOT be '2FA': both the success line「2FA 兩階段驗證成功。」and
// the self-heal notice「[系統提示] 找不到 2FA 設定檔…」contain it, and matching
// those would type digits into screens that never asked for a code. The three
// anchors below sit at the head/middle/tail of the prompt, so the one place the
// line can wrap on an 80-column screen still leaves two of them intact
// (_readScreen joins rows with '\n', which breaks substring matches).
const OTP_PROMPT_MARKERS = ['請輸入兩階段', '位限時數字', '位救援碼'];
const OTP_BAD_CODE = '驗證碼錯誤';
const OTP_LOCKED = '兩階段驗證失敗次數過多';
// Clock-skew ladder, in 30s steps, applied in order as the server rejects each
// code. The server already verifies with time_window=1 (±30s, see totp.js), so
// step 0 covers a small skew on its own; a machine whose clock is off by more
// than that gets its codes rejected *every* time, and re-sending the same
// window's code (what we used to do) can never recover. Trying the neighbouring
// windows extends the tolerance to roughly ±90s.
//
// The server allows 5 tries; spending 3 still leaves the user room to type a
// code or a recovery code by hand.
const OTP_SKEW_STEPS = [0, -1, 1];
const MAX_OTP_ATTEMPTS = OTP_SKEW_STEPS.length;
// Don't send a code that is about to expire (guards against a fast local
// clock; the server itself tolerates ±30s). Only meaningful for step 0 — a
// neighbouring window's code was never "current" to begin with.
const OTP_MIN_REMAIN_MS = 2000;
// Minimum gap between two codes. The「驗證碼錯誤」line stays on screen after a
// rejection, so without this the next poll would fire the following code before
// the server has answered the previous one.
const OTP_RETRY_GAP_MS = 1200;
// Waiting for the next 30s window can outlast the normal budget, so extend it
// once a 2FA prompt is actually on screen.
const OTP_EXTRA_MS = 75000;

// Page-lifetime cache: { user, pass, otpSecret, legacy, needsStore }.
let sessionCred = null;

const credentialApiAvailable = () =>
  typeof window !== 'undefined' && !!window.PasswordCredential &&
  !!(navigator.credentials && navigator.credentials.get);

export function AutoLogin(app) {
  this._app = app;
}

// Called when PrefModal saves with credentials filled in, so they take effect
// this session even though the password is no longer persisted to localStorage.
// Merging rather than replacing: "I only changed the OTP secret" is a normal
// edit now that the password may already live in the browser store alone.
AutoLogin.prototype.setSessionCredential = function(user, pass, otpSecret) {
  if (!user && !pass && !otpSecret) return;
  const base = sessionCred || { user: '', pass: '', otpSecret: '', legacy: false };
  if (user && pass) {
    sessionCred = { ...base, user, pass, legacy: false };
  } else {
    sessionCred = { ...base };
  }
  if (otpSecret) sessionCred.otpSecret = otpSecret;
};

AutoLogin.prototype._resolveCredential = async function(v) {
  if (sessionCred) {
    console.info('auto_login: credential source = session cache');
    return sessionCred;
  }

  const legacy = () => {
    if (v.autoLoginUser && v.autoLoginPassword) {
      console.info('auto_login: credential source = legacy localStorage');
      sessionCred = {
        user: v.autoLoginUser,
        pass: v.autoLoginPassword,
        otpSecret: v.autoLoginOtpSecret || '',
        legacy: true
      };
      return sessionCred;
    }
    console.info('auto_login: no credential available');
    return null;
  };

  if (!credentialApiAvailable()) {
    console.info('auto_login: Credential Management API unavailable');
    return legacy();
  }

  try {
    const cred = await navigator.credentials.get({
      password: true,
      mediation: 'optional'
    });
    if (cred && cred.password) {
      console.info('auto_login: credential source = browser store');
      const unpacked = unpackCredential(cred.password);
      // A credential saved before 2FA support carries no secret; fall back to
      // the one in prefs and re-pack it on the next successful login.
      const otpSecret = unpacked.otpSecret || v.autoLoginOtpSecret || '';
      const needsStore = !unpacked.otpSecret && !!otpSecret;
      // The browser store is now the source of truth → drop any leftover
      // plaintext credentials (username included — useless without the
      // password) from prefs. The secret only goes once the store is proven to
      // hold it as well, otherwise this machine holds the only copy.
      if (v.autoLoginPassword || v.autoLoginUser || (!needsStore && v.autoLoginOtpSecret)) {
        console.info(
          'auto_login: clearing legacy plaintext credentials from prefs'
        );
        clearLegacyAutoLoginCredential({ clearSecret: !needsStore });
      }
      sessionCred = {
        user: cred.id,
        pass: unpacked.password,
        otpSecret,
        legacy: false,
        needsStore
      };
      return sessionCred;
    }
    console.info('auto_login: browser store returned no credential');
    return legacy();
  } catch (e) {
    return legacy();
  }
};

// Login succeeded and the browser store either doesn't have these credentials
// yet (legacy plaintext) or holds a copy without the OTP secret → offer to
// save/update them. Plaintext is wiped later, on a successful get().
AutoLogin.prototype._maybeMigrate = function() {
  if (!(this._usedLegacy || this._needsStore) || !credentialApiAvailable()) return;
  try {
    navigator.credentials
      .store(new PasswordCredential({
        id: this._user,
        password: packCredential(this._pass, this._otpSecret),
        name: 'PTT'
      }))
      .catch(() => {});
  } catch (e) {}
};

AutoLogin.prototype.start = async function() {
  this.stop(); // clear any previous run (reconnect)
  const seq = (this._seq = (this._seq || 0) + 1);

  const v = readValuesWithDefault();
  if (!v.autoLogin) return;
  this._app.debugRecorder?.log('autoLogin.start');
  const cred = await this._resolveCredential(v);
  // A newer start() may have begun while the credential chooser was open.
  if (!cred || seq !== this._seq) return;
  this._user = cred.user;
  this._pass = cred.pass;
  this._otpSecret = cred.otpSecret || '';
  this._usedLegacy = !!cred.legacy;
  this._needsStore = !!cred.needsStore;
  this._dupConn = v.autoLoginDupConn === 'Y' ? 'Y' : 'N';
  this._skipWelcome = !!v.autoLoginSkipWelcome;

  this._done = false;
  this._sentUser = false;
  this._sentPass = false;
  this._answeredDup = false;
  this._answeredErr = false;
  this._sawOtpPrompt = false;
  this._otpPending = false;
  this._otpAttempts = 0;
  this._otpLastCounter = -1;
  this._otpLastCode = '';
  this._otpSentAt = 0;
  this._otpPromise = null;
  this._lastActionAt = 0;
  this._deadline = Date.now() + MAX_DURATION_MS;
  this._poll();
};

AutoLogin.prototype.stop = function() {
  this._done = true;
  if (this._timer) {
    clearTimeout(this._timer);
    this._timer = null;
  }
};

AutoLogin.prototype._poll = function() {
  if (this._done) return;
  if (Date.now() > this._deadline) {
    this.stop();
    return;
  }
  try {
    this._tick();
  } catch (e) {
    // ignore transient read/send errors and keep polling
  }
  if (!this._done) {
    this._timer = setTimeout(this._poll.bind(this), POLL_MS);
  }
};

// Read the whole screen straight from the term buffer (current frame).
AutoLogin.prototype._readScreen = function() {
  const buf = this._app.buf;
  const lines = [];
  for (let r = 0; r < buf.rows; r++) {
    lines.push(buf.getRowText(r, 0, buf.cols));
  }
  return lines.join('\n');
};

// Account/password + text answers go through sendData (converts to Big5).
AutoLogin.prototype._send = function(str) {
  this._app.sendData(str);
  this._lastActionAt = Date.now();
};

// Two-factor step. Returns true when it owns this tick (the caller must not
// fall through to the later prompts).
//
// Computing a TOTP needs WebCrypto, which is async while _tick is not, so the
// send happens in a promise guarded by _otpPending; _otpPromise is also the
// seam the unit tests await.
AutoLogin.prototype._handleOtp = function(screen) {
  // Out of tries: the server has dropped us back to the account prompt, so any
  // further key would be typed into the account field.
  if (screen.includes(OTP_LOCKED)) {
    console.warn('auto_login: 2FA locked out (too many failed codes)');
    this.stop();
    return true;
  }

  if (!OTP_PROMPT_MARKERS.some(m => screen.includes(m))) return false;

  if (!this._sawOtpPrompt) {
    this._sawOtpPrompt = true;
    // Waiting out a 30s window can exceed the normal budget.
    this._deadline = Math.max(this._deadline, Date.now() + OTP_EXTRA_MS);
  }

  if (this._otpPending) return true;

  // No usable secret → hand the keyboard back with the prompt still on screen.
  // This is the documented opt-out for people who don't want the secret stored
  // in a password manager, so it must not type anything: a stray key counts as
  // a wrong code and burns one of the server's five attempts.
  if (!isValidOtpSecret(this._otpSecret)) {
    console.warn(
      'auto_login: 2FA prompt but no usable OTP secret — handing over to the user'
    );
    this.stop();
    return true;
  }

  const failed = screen.includes(OTP_BAD_CODE);
  if (failed && this._otpAttempts >= MAX_OTP_ATTEMPTS) {
    console.warn(
      'auto_login: 2FA code rejected on every clock-skew step — handing over to the user'
    );
    this.stop();
    return true;
  }
  // Requiring the explicit「驗證碼錯誤」line (rather than "the prompt is still
  // there") avoids re-sending while the server is still checking the previous
  // code; the gap guards against the rejection line lingering on screen.
  const shouldSend =
    this._otpAttempts === 0 ||
    (failed && Date.now() - this._otpSentAt >= OTP_RETRY_GAP_MS);
  if (!shouldSend) return true;

  const skew = OTP_SKEW_STEPS[this._otpAttempts] || 0;
  // Don't send a code that expires in flight (step 0 only — see OTP_MIN_REMAIN_MS).
  if (skew === 0 && totpRemainingMs() < OTP_MIN_REMAIN_MS) return true;

  this._otpPending = true;
  const seq = this._seq;
  const atMs = Date.now() + skew * TOTP_PERIOD_SEC * 1000;
  this._otpPromise = totpCode(this._otpSecret, { atMs })
    .then(code => {
      if (this._done || seq !== this._seq) return;
      if (this._app.connectState !== 1) return;
      // The screen may have moved on while we were hashing.
      if (!OTP_PROMPT_MARKERS.some(m => this._readScreen().includes(m))) return;
      this._otpLastCounter = totpCounter(atMs);
      this._otpAttempts++;
      // Crossing a window boundary between two steps can make the next step
      // land on the code we just sent. Burn the step rather than the server's
      // attempt budget: the next poll moves on to the following step.
      if (code === this._otpLastCode) return;
      this._otpLastCode = code;
      this._otpSentAt = Date.now();
      this._send(code + '\r');
    })
    .catch(e => {
      console.warn('auto_login: TOTP generation failed', e);
      this.stop();
    })
    .finally(() => {
      this._otpPending = false;
    });
  return true;
};

AutoLogin.prototype._tick = function() {
  if (this._app.connectState !== 1) return;
  const screen = this._readScreen();
  if (!screen.trim()) return;

  // Reached the main menu → login finished, detach.
  if (MAIN_MENU.some(m => screen.includes(m))) {
    this._maybeMigrate();
    this.stop();
    return;
  }

  // Throttle repeatable prompts so a slow screen transition isn't double-answered.
  if (Date.now() - this._lastActionAt < ACTION_COOLDOWN_MS) return;

  // 1. Account prompt.
  if (!this._sentUser &&
      (screen.includes('請輸入代號') || screen.includes('請輸入帳號'))) {
    this._sentUser = true;
    this._send(this._user + '\r');
    return;
  }

  // 2. Password prompt.
  if (this._sentUser && !this._sentPass && screen.includes('密碼')) {
    this._sentPass = true;
    this._send(this._pass + '\r');
    return;
  }

  // 3. Two-factor (TOTP) prompt. Purely reactive: with PTT's U_2FA_NEWIP mode
  // the server skips this entirely when the source IP matches lasthost, so the
  // steps below must keep gating on _sentPass alone — adding an _sentOtp
  // condition would deadlock every login that never sees this prompt.
  if (this._sentPass && this._handleOtp(screen)) return;

  // 4. Duplicate login → answer per preference. One-shot: the prompt appears at
  // most once per login, and welcome banners may still contain「重複登入」after
  // it's answered — re-sending would leak keys into later screens. The loose
  // 「重複登入」match additionally requires a y/n indicator for the same reason.
  if (this._sentPass && !this._answeredDup &&
      (screen.includes('您想刪除其他重複登入') ||
       (screen.includes('重複登入') && /\[Y\/n\]|\(Y\/N\)/i.test(screen)))) {
    this._answeredDup = true;
    this._send(this._dupConn + '\r');
    return;
  }

  // 5. Keep/clear error-attempt prompts → default no. One-shot, same as #4.
  if (this._sentPass && !this._answeredErr &&
      (screen.includes('您要刪除以上錯誤嘗試') || screen.includes('是否保留') ||
       screen.includes('保留上次') || screen.includes('清除錯誤嘗試'))) {
    this._answeredErr = true;
    this._send('n\r');
    return;
  }

  // 6. Welcome / "press any key" screens → advance (only if enabled).
  if (this._skipWelcome &&
      (screen.includes('請按任意鍵') || screen.includes('按任意鍵') ||
       screen.includes('任意鍵繼續') || screen.includes('Press any key') ||
       screen.includes('歡迎您再度拜訪'))) {
    this._send(' ');
    return;
  }

  // 登入失敗 → 收手（避免重試觸發帳號鎖定，或一路空轉到 timeout）。
  // 官方 mbbsd/mbbsd.c 的登入迴圈只有這幾種「不會再往下走」的出口：
  //   include/common.h ERR_PASSWD "密碼不對喔！請檢查帳號及密碼大小寫有無輸入錯誤。"
  //     — 帳號格式合法（存在與否都一樣）但密碼錯，回頭重問代號。
  //   include/common.h ERR_UID    "這裡沒有這個人啦！"
  //     — is_validuserid(uid) 失敗（長度非 2..12 / 首字非字母 / 含非 alnum），
  //       **不會再問密碼** ⇒ 少了這條就永遠等不到密碼 prompt。
  //   passwd_require_secure_connection → "抱歉，此帳號已設定為只能使用安全連線(如ssh)登入。"
  //       同樣 continue 回帳號輸入。
  // 一律取前綴比對（畫面上這些訊息後面還會接著重印的代號 prompt）。
  if (screen.includes('密碼不對') ||
      screen.includes('這裡沒有這個人啦') ||
      screen.includes('只能使用安全連線')) {
    this.stop();
  }
};

export default AutoLogin;
