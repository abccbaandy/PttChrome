// 一鍵登出（手機按鍵列的「登出」鈕）：從任何畫面走 PTT **正常的**離站流程，
// 由 server 自己關線。**絕不可以直接關 WebSocket**：那樣 server 端的 utmp 不會
// 在當下清掉，帳號會掛在線上（使用者再登入就撞「重複登入」）。
//
// ---- pttbbs 事實（3rd_script/pttbbs，Big5）----
// 1. 主功能表 menu.c:1354 `{Goodbye, 0, "Goodbye 離開，再見… "}`：level 0，guest 也有，
//    主選單唯一 G 開頭的項目。menu.c:726-741 按字母只移游標、要 `\r` 才執行。
//    menu.c:566-581 主選單上 ← **不會離開**，只把游標移到 Goodbye（default_exit）⇒
//    已在主選單就不可以再送 ←（沒害處，但會多一幀可比對的畫面變化）。
// 2. xyz.c:59-85 Goodbye()：getdata(b_lines-1, "您確定要離開【 批踢踢實業坊 】嗎(Y/N)？[N] ",
//    LCECHO) ⇒ 要送 `y\r`（只送 y 不會結束 getdata）；其他任何回答都回主選單。
//    確認後 show_80x24_screen("etc/Logout") ＋ vmsg("此次停留時間: …")（未註冊是
//    「尚未完成註冊程序。」）⇒ 一個 pressanykey。
// 3. 那個鍵之後 u_exit（mbbsd.c:187-209）→ term_uninit → close(0/1) ⇒ **連線由 server 關**，
//    之後不會再有任何畫面。所以最後一步沒有 expect 可以等，完成與否看 App.onClose。
// 4. 站方版本可能多出開源碼裡沒有的畫面 ⇒ 最後一段對「還是 pressanykey」照樣送空白
//    （有上限），其他認不出的畫面一律停手，**不盲送**。
//
// 逃回主選單的做法照 aid_navigation._enqueueEscape：一次一個鍵、每步以畫面內容確認
// （fullRepaint ⇒ 判斷的一定是整幀），畫面沒變＝這一鍵沒作用 ⇒ 失敗停手（例：編輯器裡
// ← 只移游標）。每一步先問 screen_dismiss.resolveDismiss：輸入欄送 ^C、按任意鍵送空白，
// 其餘才送 ←。
//
// 守護 tests/unit/logout_session.test.js。流程說明見 docs/mobile.md「一鍵登出」。

import { isMainMenuRow } from './aid_navigation';
import { resolveDismiss, DISMISS_ANY_KEY, KEY_DISMISS } from './screen_dismiss';

const KEY_LEFT = '\x1b[D';
export const KEY_GOODBYE = 'G\r';
export const KEY_CONFIRM = 'y\r';

// 站內信 3 層＋進板畫面等餘裕；上限是必要的（超額信箱的郵件選單 ← 會變成 R，
// 畫面一直變卻永遠到不了主選單，見 aid_navigation 的 MAX_ESCAPE_STEPS）。
export const MAX_ESCAPE_STEPS = 8;
// 確認之後最多再按幾次「任意鍵」等 server 關線（開源碼只有 1 個）。
export const MAX_FINAL_KEYS = 3;

const STEP_PROBE_AFTER_MS = 700;
const STEP_PROBE_WINDOW_MS = 700;
const STEP_HARD_MS = 3000;
// 最後一鍵送出後等多久還沒斷線就宣告失敗（server 端存檔在關 fd 之後，關線本身很快）。
const CLOSE_WAIT_MS = 5000;

// 確認列：getdata 畫在 b_lines-1，看最後兩列。
const CONFIRM_RE = /您確定要離開/;

export function isGoodbyeConfirm(rowTexts) {
  const rows = rowTexts || [];
  const n = rows.length;
  return CONFIRM_RE.test(rows[n - 1] || '') || CONFIRM_RE.test(rows[n - 2] || '');
}

// 逃生階段這一步該送什麼。screen ＝ { row0, lastRowText, cursorOnInputField }。
//   { menu: true }  已在主功能表 ⇒ 不送任何逃生鍵，直接進 Goodbye
//   { bytes }       要送的那一鍵
export function logoutEscapeKey(screen) {
  const s = screen || {};
  if (isMainMenuRow(s.row0 || '')) return { menu: true };
  const d = resolveDismiss({ lastRowText: s.lastRowText, cursorOnInputField: s.cursorOnInputField });
  if (d) return { bytes: d.bytes };
  return { bytes: KEY_LEFT };
}

// 這一幀是不是「按任意鍵」（登出後的停留時間橫幅就是這種）。
export function isAnyKeyPause(lastRowText) {
  const d = resolveDismiss({ lastRowText: lastRowText, cursorOnInputField: false });
  return !!d && d.kind === DISMISS_ANY_KEY;
}

function signature(rowTexts) {
  return (rowTexts || []).join('\n');
}

export function LogoutSession(core, view, termBuf, queue) {
  this._core = core;
  this._view = view;
  this._termBuf = termBuf;
  this._queue = queue;
  // 序列在線上：serialized_op_gate 據此吞掉使用者按鍵（與 aidNavigation.active 同義）。
  this.active = false;
  // 最後一鍵已送出、在等 server 關線 ⇒ App.onClose 看到它就知道這次斷線是登出。
  this.awaitingClose = false;
  this.opHint = '';
  this._closeTimer = null;
}

LogoutSession.prototype = {
  _hint: function(msg, ms) {
    if (this._view && this._view.flashListHint) this._view.flashListHint(msg, ms || 4000);
  },

  _screen: function() {
    const buf = this._termBuf;
    return {
      row0: buf.getRowText(0, 0, buf.cols),
      lastRowText: buf.getRowText(buf.rows - 1, 0, buf.cols),
      cursorOnInputField: !!(buf.isCursorOnInputField && buf.isCursorOnInputField())
    };
  },

  _signature: function() {
    const buf = this._termBuf;
    const rows = [];
    for (let r = 0; r < buf.rows; ++r) rows.push(buf.getRowText(r, 0, buf.cols));
    return signature(rows);
  },

  _cursorOnInputField: function() {
    const buf = this._termBuf;
    return !!(buf.isCursorOnInputField && buf.isCursorOnInputField());
  },

  _fail: function(msg) {
    // 斷線後佇列被清（onFlushed）也會走到這裡；那時 onConnectionClosed 已經收過攤。
    if (!this.active) return;
    this.active = false;
    this.awaitingClose = false;
    this._clearCloseTimer();
    this.opHint = '';
    this._hint('登出失敗：' + msg + '（已停在原生畫面，可手動操作）', 6000);
  },

  _clearCloseTimer: function() {
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
  },

  // 回 true ＝開始了。沒連線／已在跑 ⇒ false。
  start: function() {
    if (this.active) return false;
    const core = this._core;
    if (!core || (core.isConnected && !core.isConnected())) return false;
    this.active = true;
    this.awaitingClose = false;
    this.opHint = '登出中，請稍候…';
    this._hint(this.opHint, 8000);
    // 登出途中自動登入不可以插手（它會在主選單以外的畫面送帳密）。
    if (core.autoLogin && core.autoLogin.stop) core.autoLogin.stop();
    // 讓原生畫面上場，並把列表 session 停到 functionMode（佇列清空、它的 reducer 吸收
    // 我們的中間畫面）—— 與 aid_navigation._begin 同一組前置，順序同理：先於 enqueue。
    if (core.easyReading && core.easyReading._enterFunctionMode) core.easyReading._enterFunctionMode();
    if (core.listSession && core.listSession.beginExternalNavigation)
      core.listSession.beginExternalNavigation();
    if (core.boardListSession && core.boardListSession.beginExternalNavigation)
      core.boardListSession.beginExternalNavigation();
    this._escapeStep(0);
    return true;
  },

  _escapeStep: function(step) {
    const self = this;
    const k = logoutEscapeKey(this._screen());
    if (k.menu) {
      this._enqueueGoodbye();
      return;
    }
    if (step >= MAX_ESCAPE_STEPS) {
      this._fail('退不回主功能表（層數過多）');
      return;
    }
    const prevSig = this._signature();
    this._queue.enqueue({
      keys: k.bytes,
      kind: 'logout-escape',
      fullRepaint: true,
      onFlushed: function() { self._fail('畫面已變更'); },
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      expect: function(snapshot, facts) {
        if (isMainMenuRow(facts.rowTexts[0] || '')) return { menu: true };
        // 畫面沒變 ＝這一鍵沒作用（編輯器裡的 ← 只移游標）：不重試，停手。
        return signature(facts.rowTexts) === prevSig ? false : { moved: true };
      },
      onDone: function(result) {
        if (result.menu) self._enqueueGoodbye();
        else self._escapeStep(step + 1);
      },
      onFail: function(reason) {
        self._fail('退不回主功能表（' + reason + '）');
      }
    });
  },

  _enqueueGoodbye: function() {
    const self = this;
    this._queue.enqueue({
      keys: KEY_GOODBYE,
      kind: 'logout-goodbye',
      fullRepaint: true,
      onFlushed: function() { self._fail('畫面已變更'); },
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      expect: function(snapshot, facts) {
        return isGoodbyeConfirm(facts.rowTexts) && self._cursorOnInputField();
      },
      onDone: function() { self._enqueueConfirm(); },
      onFail: function(reason) {
        self._fail('沒有出現離站確認（' + reason + '）');
      }
    });
  },

  _enqueueConfirm: function() {
    const self = this;
    this._queue.enqueue({
      keys: KEY_CONFIRM,
      kind: 'logout-confirm',
      fullRepaint: true,
      onFlushed: function() { self._fail('畫面已變更'); },
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      expect: function(snapshot, facts) {
        return isAnyKeyPause(facts.rowTexts[facts.rowTexts.length - 1] || '');
      },
      onDone: function() { self._enqueueFinalKey(0); },
      onFail: function(reason) {
        self._fail('確認後畫面不符預期（' + reason + '）');
      }
    });
  },

  // 最後一鍵：server 收到就 u_exit 關線，不會有回應畫面 ⇒ probe 關掉（\f 送到已關的
  // 線上沒有意義），完成由 App.onClose → onConnectionClosed 判定。若回來的是另一個
  // pressanykey（站方私有畫面），照樣再送一次空白。
  _enqueueFinalKey: function(n) {
    const self = this;
    if (n >= MAX_FINAL_KEYS) {
      this._fail('送出後 PTT 沒有斷線');
      return;
    }
    this.awaitingClose = true;
    this._armCloseTimer();
    this._queue.enqueue({
      keys: KEY_DISMISS,
      kind: 'logout-final',
      probe: false,
      timeoutMs: CLOSE_WAIT_MS,
      hardTimeoutMs: CLOSE_WAIT_MS,
      onFlushed: function() {
        // onClose 的 listSession.disable() 會把佇列清掉 ⇒ 這是正常結局，不是失敗。
      },
      expect: function(snapshot, facts) {
        const last = facts.rowTexts[facts.rowTexts.length - 1] || '';
        if (isAnyKeyPause(last)) return { again: true };
        if (isMainMenuRow(facts.rowTexts[0] || '')) return { menu: true };
        return false;
      },
      onDone: function(result) {
        if (!self.active) return;
        self._clearCloseTimer();
        if (result.again) self._enqueueFinalKey(n + 1);
        else self._fail('PTT 回到了主功能表');
      },
      onFail: function() {
        // 逾時：_closeTimer 會給結論（兩者同長，交給 timer 以免重複提示）。
      }
    });
  },

  _armCloseTimer: function() {
    const self = this;
    this._clearCloseTimer();
    this._closeTimer = setTimeout(function() {
      self._closeTimer = null;
      if (self.active && self.awaitingClose) self._fail('送出後 PTT 沒有斷線');
    }, CLOSE_WAIT_MS + 500);
  },

  // App.onClose 呼叫。回 true ＝這次斷線是我們登出造成的（App 改顯示「已登出」）。
  onConnectionClosed: function() {
    const wasLogout = this.active && this.awaitingClose;
    this.reset();
    return wasLogout;
  },

  reset: function() {
    this.active = false;
    this.awaitingClose = false;
    this.opHint = '';
    this._clearCloseTimer();
  }
};
