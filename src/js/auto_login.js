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
// Migration is self-healing and never drops credentials: a legacy login that
// reaches the main menu triggers credentials.store() (browser save prompt), but
// the plaintext copy (username AND password) is only wiped once a later get()
// proves the browser really has it (store() resolving does not mean the user
// accepted the prompt).

import {
  readValuesWithDefault,
  clearLegacyAutoLoginCredential
} from './pref_storage';

const MAIN_MENU = ['主功能表', '【主功能表】'];
const POLL_MS = 500;
const ACTION_COOLDOWN_MS = 900;
const MAX_DURATION_MS = 90000;

// Page-lifetime cache: { user, pass, legacy }.
let sessionCred = null;

const credentialApiAvailable = () =>
  typeof window !== 'undefined' && !!window.PasswordCredential &&
  !!(navigator.credentials && navigator.credentials.get);

export function AutoLogin(app) {
  this._app = app;
}

// Called when PrefModal saves with credentials filled in, so they take effect
// this session even though the password is no longer persisted to localStorage.
AutoLogin.prototype.setSessionCredential = function(user, pass) {
  if (user && pass) sessionCred = { user, pass, legacy: false };
};

AutoLogin.prototype._resolveCredential = async function(v) {
  if (sessionCred) {
    console.info('auto_login: credential source = session cache');
    return sessionCred;
  }

  const legacy = () => {
    if (v.autoLoginUser && v.autoLoginPassword) {
      console.info('auto_login: credential source = legacy localStorage');
      sessionCred = { user: v.autoLoginUser, pass: v.autoLoginPassword, legacy: true };
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
      // The browser store is now the source of truth → drop any leftover
      // plaintext credentials (username included — useless without the
      // password) from prefs.
      if (v.autoLoginPassword || v.autoLoginUser) {
        console.info(
          'auto_login: clearing legacy plaintext credentials from prefs'
        );
        clearLegacyAutoLoginCredential();
      }
      sessionCred = { user: cred.id, pass: cred.password, legacy: false };
      return sessionCred;
    }
    console.info('auto_login: browser store returned no credential');
    return legacy();
  } catch (e) {
    return legacy();
  }
};

// Login succeeded with legacy plaintext creds → offer to save them into the
// browser's password manager. Plaintext is wiped later, on a successful get().
AutoLogin.prototype._maybeMigrate = function() {
  if (!this._usedLegacy || !credentialApiAvailable()) return;
  try {
    navigator.credentials
      .store(new PasswordCredential({
        id: this._user,
        password: this._pass,
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
  this._usedLegacy = !!cred.legacy;
  this._dupConn = v.autoLoginDupConn === 'Y' ? 'Y' : 'N';
  this._skipWelcome = !!v.autoLoginSkipWelcome;

  this._done = false;
  this._sentUser = false;
  this._sentPass = false;
  this._answeredDup = false;
  this._answeredErr = false;
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

  // 3. Duplicate login → answer per preference. One-shot: the prompt appears at
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

  // 4. Keep/clear error-attempt prompts → default no. One-shot, same as #3.
  if (this._sentPass && !this._answeredErr &&
      (screen.includes('您要刪除以上錯誤嘗試') || screen.includes('是否保留') ||
       screen.includes('保留上次') || screen.includes('清除錯誤嘗試'))) {
    this._answeredErr = true;
    this._send('n\r');
    return;
  }

  // 5. Welcome / "press any key" screens → advance (only if enabled).
  if (this._skipWelcome &&
      (screen.includes('請按任意鍵') || screen.includes('按任意鍵') ||
       screen.includes('任意鍵繼續') || screen.includes('Press any key') ||
       screen.includes('歡迎您再度拜訪'))) {
    this._send(' ');
    return;
  }

  // Wrong credentials → give up (avoid lockout loops).
  if (screen.includes('密碼不對') || screen.includes('密碼或代號錯誤') ||
      screen.includes('無法登入')) {
    this.stop();
  }
};

export default AutoLogin;
