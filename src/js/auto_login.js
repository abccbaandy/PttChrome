// Enhanced Add-on: remember credentials + auto login.
//
// Self-driven polling loop (does NOT wait for keypresses). Each tick reads the
// current screen straight from the term buffer (getRowText — always up to date,
// unlike #mainContainer.innerText which lags one frame because the 'change' event
// fires before the React re-render) and responds to login prompts, mirroring the
// proven flow in tests/e2e/helpers/ptt.js#login. Credentials come from prefs
// (localStorage only, never committed). Account/password are sent via
// app.sendData (Big5-converted). Stops once the main menu is reached or after a
// max duration, so it never interferes with normal use.

import { readValuesWithDefault } from '../components/ContextMenu/PrefModal';

const MAIN_MENU = ['主功能表', '【主功能表】'];
const POLL_MS = 500;
const ACTION_COOLDOWN_MS = 900;
const MAX_DURATION_MS = 90000;

export function AutoLogin(app) {
  this._app = app;
}

AutoLogin.prototype.start = function() {
  const v = readValuesWithDefault();
  if (!v.autoLogin || !v.autoLoginUser || !v.autoLoginPassword) return;
  this._user = v.autoLoginUser;
  this._pass = v.autoLoginPassword;
  this._dupConn = v.autoLoginDupConn === 'Y' ? 'Y' : 'N';
  this._skipWelcome = !!v.autoLoginSkipWelcome;

  this.stop(); // clear any previous run (reconnect)
  this._done = false;
  this._sentUser = false;
  this._sentPass = false;
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

  // 3. Duplicate login → answer per preference.
  if (screen.includes('您想刪除其他重複登入') || screen.includes('重複登入')) {
    this._send(this._dupConn + '\r');
    return;
  }

  // 4. Keep/clear error-attempt prompts → default no.
  if (screen.includes('您要刪除以上錯誤嘗試') || screen.includes('是否保留') ||
      screen.includes('保留上次') || screen.includes('清除錯誤嘗試')) {
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
