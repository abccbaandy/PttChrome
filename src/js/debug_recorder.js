// Debug 錄製器：monkey-patch app.onData（recv）與 app.conn._sendRaw（send）
// —— 與 tests/e2e/tools/record-cassette.spec.js 同手法，零侵入，stop 時還原。
// 錄下雙向 bytes ＋ 每事件輕量狀態快照 ＋ 關鍵路徑 log（app.debugRecorder?.log(tag, info)）。
// 序列化 / redact / cassette 導出在 debug_recorder_logic.js（純邏輯，unit 測）。
import { serializeRecording } from './debug_recorder_logic';

// 輕量狀態快照：純讀取，不深拷貝 buf。欄位缺就缺（防呆）。
//
// **只准放「讀 JS 屬性」的欄位，不准放任何會觸發 layout 的量測**
// （scrollTop / offsetTop / getBoundingClientRect）：本函式掛在每一筆 recv/send 上，
// 而 onData → parse → notify → render 是同步的 ⇒ 每筆事件都會有待處理的 layout
// invalidation，量一次就強制 reflow 一次。要幾何請用 cursorGeomSample（節流、
// 只在游標真的移動時取樣）。
export function snapshotState(app) {
  try {
    const view = app.view;
    return {
      pageState: app.buf && app.buf.pageState,
      cur_x: app.buf && app.buf.cur_x,
      cur_y: app.buf && app.buf.cur_y,
      connectState: app.connectState,
      easyReading: !!(view && view.useEasyReadingMode),
      listState: app.listSession && app.listSession.state,
      // 好讀長頁 ↔ 原生鏡像：游標幾何類問題的第一個分岔（推文 prompt 走鏡像）。
      fnMode: !!(app.buf && app.buf.easyReadingFunctionMode),
      // 這一幀是不是格線畫面 —— 決定 #cursor 該不該可見（term_view._applyCursorVisibility）。
      gridRender: !!(view && view._gridRender),
      // 重現現場要能還原格線；chw/chh 是推導值（chh/2、視窗尺寸），不是量出來的。
      chw: view && view.chw,
      chh: view && view.chh,
      scaleX: view && view.scaleX,
      scaleY: view && view.scaleY,
      dpr: typeof window !== 'undefined' ? window.devicePixelRatio : undefined,
      // Mac 沒有 local MingLiu，整個等寬格線契約押在 bundled webfont SymMingLiu 上
      // ⇒ 字型還沒落地時 ASCII 走系統 monospace，advance 不是 0.5em。
      fontsReady:
        typeof document !== 'undefined' && document.fonts
          ? document.fonts.status === 'loaded'
          : undefined,
    };
  } catch (e) {
    return { error: String(e) };
  }
}

// 游標幾何取樣（tag `cursor.geom`）。**只錄數字座標，不錄任何文字** ⇒ 不觸及
// serializeRecording 的 redact 契約。呼叫端（term_view.updateCursorPos）自帶
// 「游標真的動了才取樣」的節流，且只在 isRecording 時才進來 —— 這裡會強制 reflow。
//
// 錄三個東西就足以判定「算術 vs layout 是否脫鉤」：
//   cursor  #cursor 的螢幕矩形（display:none 的閃爍暗相位會是全 0，照錄不修飾）
//   row     buf.cur_y 那一列**真正被畫出來**的節點矩形
//   main    捲動容器（含 scrollTop/scrollHeight/clientHeight ⇒ 「鏡像不可捲」不變量）
export function cursorGeomSample(view, doc) {
  try {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!view || !d) return null;
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        x: Math.round(b.left * 10) / 10,
        y: Math.round(b.top * 10) / 10,
        w: Math.round(b.width * 10) / 10,
        h: Math.round(b.height * 10) / 10,
      };
    };
    const cont = d.getElementById('mainContainer');
    const cy = view.buf && view.buf.cur_y;
    const rowEl = cont
      ? cont.querySelector('[type="bbsrow"][srow="' + cy + '"]')
      : null;
    const main = view.mainDisplay;
    return {
      cur_x: view.buf && view.buf.cur_x,
      cur_y: cy,
      cursor: r(d.getElementById('cursor')),
      row: r(rowEl),
      main: main
        ? Object.assign(r(main), {
            scrollTop: main.scrollTop,
            scrollHeight: main.scrollHeight,
            clientHeight: main.clientHeight,
          })
        : null,
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
