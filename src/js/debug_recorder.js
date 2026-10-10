// Debug 錄製器：monkey-patch app.onData（recv）與 app.conn._sendRaw（send）
// —— 與 tests/e2e/tools/record-cassette.spec.js 同手法，零侵入，stop 時還原。
// 錄下雙向 bytes ＋ 每事件輕量狀態快照 ＋ 關鍵路徑 log（app.debugRecorder?.log(tag, info)）。
// 序列化 / redact / cassette 導出在 debug_recorder_logic.js（純邏輯，unit 測）。
import { serializeRecording } from './debug_recorder_logic';
import { setDiagSink } from './diag';
import { OWNER_BOARD_LIST } from './list_render_owner';

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
      // 看板列表平滑捲動（另一個列表 session，共用 buf.listRenderMode）。
      brdListState: app.boardListSession && app.boardListSession.state,
      // 這一幀的列表畫面是誰在畫（null＝原生）——兩個 session 的分岔點。
      listOwner: (app.buf && app.buf.listRenderOwner) || null,
      // 好讀長頁 ↔ 原生鏡像：游標幾何類問題的第一個分岔（推文 prompt 走鏡像）。
      fnMode: !!(app.buf && app.buf.easyReadingFunctionMode),
      // 這一幀是不是格線畫面 —— 決定 #cursor 該不該可見（term_view._applyCursorVisibility）。
      gridRender: !!(view && view._gridRender),
      srowIsBufRow: !!(view && view._srowIsBufRow),
      // server 端 vtkbd 停在哪（0=NORMAL / 1=ESC / 2=CSI / 3=SS3），**送出之前**的值
      // ——懸空的 1 代表下一個位元組會被吃成 esc_arg、畫面零反應（那正是
      // 「讀不到文章代碼（miss）」的根因，見 vtkbd_send_state.js 檔頭）。
      // recv 那一列錄的是上一次送出後的狀態，兩種讀法都定得了案。
      vkState: app.conn && app.conn._vkStatePrev,
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
//   cursor  #cursor 的螢幕矩形（被 inline display:none 藏起來時是全 0，照錄不修飾；
//           閃爍暗相位只是 visibility:hidden，矩形照樣量得到）
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

// 列表好讀捲動視口（`.listBodyView`）的一筆狀態取樣（tag `list.scroll`／`touch`）。
// 只錄數字與狀態旗標，不錄文字。會量 scrollHeight（reflow），只在錄製期間、而且是
// scroll／touch 事件處理裡（不在 render 同步路徑上）才呼叫。
//   top/ctop  DOM scrollTop／內容座標（扣掉頂端保留區，screen.getListScrollTop）
//   res       頂端保留區 px（screen.absorbListShift）
//   ov        overflow-y（hidden＝交易 frozen 或 pref 關掉，使用者捲不動）
//   own       誰在畫列表（article-list／board-list／null＝原生）
//   st/rm     session 狀態／renderMode；topNum 視口錨；eu/ed 到頂／到底旗標
//   idle/fl   CommandQueue 是否閒置／在飛命令的 kind
export function listViewSample(app, v) {
  try {
    const buf = app.buf;
    const own = (buf && buf.listRenderOwner) || null;
    const ls = own === OWNER_BOARD_LIST ? app.boardListSession : app.listSession;
    const scr = app.view && app.view.componentScreen;
    const q = app.commandQueue;
    const out = {
      top: v ? Math.round(v.scrollTop) : null,
      ctop: scr && scr.getListScrollTop ? Math.round(scr.getListScrollTop()) : null,
      res: scr ? Math.round(scr._listReservePx || 0) : null,
      sh: v ? v.scrollHeight : null,
      ch: v ? v.clientHeight : null,
      ov: v ? v.style.overflowY : null,
      own,
      st: ls ? ls.state : null,
      rm: ls ? ls._renderMode : null,
      topNum: ls ? ls._topNum : null,
      eu: ls ? !!ls._edgeUp : null,
      ed: ls ? !!ls._edgeDown : null,
      idle: q ? !!q.idle : null,
      fl: q ? q.inFlightKind || null : null,
    };
    return out;
  } catch (e) {
    return { error: String(e) };
  }
}

const LIST_VIEW_SEL = '.listBodyView';
const TOUCH_TYPES = ['touchstart', 'touchend', 'touchcancel'];

export class DebugRecorder {
  constructor(app) {
    this.app = app;
    this.events = [];
    this.isRecording = false;
    this._t0 = 0;
    this._origOnData = null;
    this._origSendRaw = null;
    this._scroller = null;
    this._onWheel = null;
    this._onScroll = null;
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

    // 渲染鏈的診斷 log（圖片尺寸模式、佔位盒掛載／卸載／高度）走 module 級出口，
    // 見 diag.js。
    setDiagSink((tag, info) => this.log(tag, info));
    this._watchScroller(app.view && app.view.mainDisplay);
    this._watchList();

    this.log('record.start', { url: app.connectedUrl && app.connectedUrl.url });
    // 錄製是中途開始的：之後只在「變了」才記 article.context／appBar（term_view
    // _setArticleContext、App._refreshScreenContext），起點的值要先補一筆。
    const view = app.view || {};
    this.log('article.context', {
      author: view._articleAuthor || null,
      board: view._articleBoard || null,
      title: view._articleTitle || null,
    });
    if (app._screenContext && app._screenContext.appBar) this.log('appBar', app._screenContext.appBar);
  }

  // 好讀長頁的捲動軌跡：使用者的滾輪輸入（main.wheel）對照實際捲動位置
  // （main.scroll）。「滾輪往上捲不動、畫面上下抖」這類問題只看 bytes 完全看不出來
  // （2026-09 的 ptt-debug-20260928-181323：開文後 23 秒一筆事件都沒有）。
  // 只在錄製期間掛 listener；scroll 事件本身一幀最多一次，量 scrollHeight 的 reflow
  // 成本只有錄製時才付。
  _watchScroller(scroller) {
    if (!scroller || typeof scroller.addEventListener !== 'function') return;
    this._scroller = scroller;
    this._onWheel = (e) =>
      this.log('main.wheel', {
        dy: Math.round(e.deltaY),
        mode: e.deltaMode,
        top: Math.round(scroller.scrollTop),
      });
    this._onScroll = () =>
      this.log('main.scroll', {
        top: Math.round(scroller.scrollTop),
        sh: scroller.scrollHeight,
        ch: scroller.clientHeight,
      });
    scroller.addEventListener('wheel', this._onWheel, { passive: true });
    scroller.addEventListener('scroll', this._onScroll, { passive: true });
  }

  // 列表好讀的捲動視口是 render 層的常駐節點，但錄製開始時可能還沒建立（或之後被重建），
  // 所以掛在 document 的 capture 階段（scroll 不冒泡，capture 收得到），用 target 篩。
  // 觸控一律記（含不在列表上的），才看得出「手指有放上去、卻沒有任何 scroll 事件」
  //（捲不動）這種卡住；在列表上的那幾筆附上 listViewSample。
  _watchList() {
    if (typeof document === 'undefined') return;
    const app = this.app;
    const listOf = (t) => (t && t.closest ? t.closest(LIST_VIEW_SEL) : null);
    this._onListScroll = (e) => {
      const t = e.target;
      if (!t || !t.matches || !t.matches(LIST_VIEW_SEL)) return;
      this.log('list.scroll', listViewSample(app, t));
    };
    this._onListWheel = (e) => {
      const v = listOf(e.target);
      if (!v) return;
      this.log('list.wheel', { dy: Math.round(e.deltaY), mode: e.deltaMode, top: Math.round(v.scrollTop) });
    };
    this._onTouch = (e) => {
      const p = (e.changedTouches && e.changedTouches[0]) || null;
      const v = listOf(e.target);
      const info = {
        type: e.type,
        n: e.touches ? e.touches.length : 0,
        x: p ? Math.round(p.clientX) : null,
        y: p ? Math.round(p.clientY) : null,
        inList: !!v,
      };
      if (v) Object.assign(info, listViewSample(app, v));
      this.log('touch', info);
    };
    const opt = { capture: true, passive: true };
    document.addEventListener('scroll', this._onListScroll, opt);
    document.addEventListener('wheel', this._onListWheel, opt);
    for (const type of TOUCH_TYPES) document.addEventListener(type, this._onTouch, opt);
  }

  _unwatchList() {
    if (typeof document === 'undefined' || !this._onListScroll) return;
    const opt = { capture: true, passive: true };
    document.removeEventListener('scroll', this._onListScroll, opt);
    document.removeEventListener('wheel', this._onListWheel, opt);
    for (const type of TOUCH_TYPES) document.removeEventListener(type, this._onTouch, opt);
    this._onListScroll = null;
    this._onListWheel = null;
    this._onTouch = null;
  }

  _unwatchScroller() {
    if (!this._scroller) return;
    this._scroller.removeEventListener('wheel', this._onWheel, { passive: true });
    this._scroller.removeEventListener('scroll', this._onScroll, { passive: true });
    this._scroller = null;
    this._onWheel = null;
    this._onScroll = null;
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
    setDiagSink(null);
    this._unwatchScroller();
    this._unwatchList();
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
