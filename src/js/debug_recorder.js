// Debug 錄製器：monkey-patch app.onData（recv）與 app.conn._sendRaw（send）
// —— 與 tests/e2e/tools/record-cassette.spec.js 同手法，零侵入，stop 時還原。
// 錄下雙向 bytes ＋ 每事件輕量狀態快照 ＋ 關鍵路徑 log（app.debugRecorder?.log(tag, info)）。
// 序列化 / redact / cassette 導出在 debug_recorder_logic.js（純邏輯，unit 測）。
import { serializeRecording } from './debug_recorder_logic';

// 輕量狀態快照：純讀取，不深拷貝 buf。欄位缺就缺（防呆）。
export function snapshotState(app) {
  try {
    return {
      pageState: app.buf && app.buf.pageState,
      cur_x: app.buf && app.buf.cur_x,
      cur_y: app.buf && app.buf.cur_y,
      connectState: app.connectState,
      easyReading: !!(app.view && app.view.useEasyReadingMode),
      listState: app.listSession && app.listSession.state,
    };
  } catch (e) {
    return { error: String(e) };
  }
}

export class DebugRecorder {
  constructor(app) {
    this.app = app;
    this.events = [];
    this.isRecording = false;
    this._t0 = 0;
    this._origOnData = null;
    this._origSendRaw = null;
  }

  _push(ev) {
    ev.t = Math.round(performance.now() - this._t0);
    this.events.push(ev);
  }

  start() {
    if (this.isRecording) return;
    const app = this.app;
    const rec = this;
    this._t0 = performance.now();
    this.isRecording = true;

    // 保存原函式本體（非 bind 副本）→ stop 還原後 identity 不變。
    this._origOnData = app.onData;
    app.onData = function (data) {
      rec._push({ dir: 'recv', data, state: snapshotState(app) });
      return rec._origOnData.call(app, data);
    };

    if (app.conn) {
      const conn = app.conn;
      this._patchedConn = conn;
      this._origSendRaw = conn._sendRaw;
      conn._sendRaw = function (data) {
        if (data) rec._push({ dir: 'send', data, state: snapshotState(app) });
        return rec._origSendRaw.call(conn, data);
      };
    }

    this.log('record.start', { url: app.connectedUrl && app.connectedUrl.url });
  }

  log(tag, info) {
    if (!this.isRecording) return;
    this._push({ dir: 'log', tag, info });
  }

  // 停止並還原 patch；回傳序列化 JSON 字串（已 redact）。
  stop({ prefs } = {}) {
    if (!this.isRecording) return null;
    this.log('record.stop');
    this.isRecording = false;
    if (this._origOnData) this.app.onData = this._origOnData;
    if (this._origSendRaw && this._patchedConn) this._patchedConn._sendRaw = this._origSendRaw;
    this._origOnData = null;
    this._origSendRaw = null;

    const app = this.app;
    return serializeRecording({
      events: this.events,
      cols: (app.buf && app.buf.cols) || 80,
      rows: (app.buf && app.buf.rows) || 24,
      meta: {
        url: app.connectedUrl && app.connectedUrl.url,
        build: process.env.GIT_COMMIT,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      },
      redact: {
        ids: prefs && prefs.autoLoginUser ? [prefs.autoLoginUser] : [],
        // The 2FA secret is a long-lived credential — leaking it in a recording
        // means the account's second factor has to be reset to revoke it.
        secrets: prefs
          ? [prefs.autoLoginPassword, prefs.autoLoginOtpSecret].filter(Boolean)
          : [],
      },
    });
  }
}
