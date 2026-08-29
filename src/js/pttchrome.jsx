// Main Program
import { AnsiParser } from './ansi_parser';
import { TermView } from './term_view';
import { TermBuf } from './term_buf';
import { TelnetConnection } from './telnet';
import { Websocket } from './websocket';
import { EasyReading, switchModePlan } from './easy_reading';
import { ListSession } from './list_session';
import { CommandQueue } from './command_queue';
import { AidNavigation } from './aid_navigation';
import { LongPushSession } from './long_push_session';
import { DeepLinkController } from './deep_link_controller';
import { AutoLogin } from './auto_login';
import { parseBlacklist, parseTitleBlacklist } from './comment_parse';
import { MouseButtonTracker } from './mouse_button_tracker';
import { LIST_HEADER_ROWS } from './list_window';
import { wheelDeltaToPx } from './wheel_scroll';
import {
  ACT_NONE,
  ACT_ENTER,
  ACT_EXIT,
  ACT_EXIT_ARTICLE,
  EXIT_COL_END,
  resolveMouseGates
} from './mouse_regions';
import { colFromClientX } from './mouse_geometry';
import { functionKeyClickPlan, LEFT_ARROW } from './function_key_plan';
import { isPreviewTarget } from './preview_targets';
import { ImageUploadController, isUploadLayerTarget } from './image_upload_controller';
import { i18n } from './i18n';
import { unescapeStr, b2u, parseWaterball, normalizeCopyText } from './string_util';
import { setTimer } from './util';
import { normalizeImgurProxyBase, setImgurProxyConfig } from './imgur_proxy';
import PasteShortcutAlert from '../components/PasteShortcutAlert';
import ConnectionAlert from '../components/ConnectionAlert';
import ContextMenu from '../components/ContextMenu';
import { renderInto, unmountFrom } from './react_root';
import { setBellEnabled } from './bell';
import { MantineRoot } from '../components/MantineRoot';
import logoIcon from '../icon/logo.png';
import logoConnectIcon from '../icon/logo_connect.png';
import logoDisconnectIcon from '../icon/logo_disconnect.png';

function noop() {}

// True when the click landed on a link, so link clicks bypass the terminal's own
// mouse handling.
//
// **必須是 closest('a')，不可以只看 parentElement**：連結內部的 DOM 最深可到
// a > span > span（LinkSegmentBuilder 的 TwoColorWord / ForceWidthWord，DBCS
// 雙色字與強制寬度字），只往上找一層的舊寫法在那種字上會漏判，於是「點連結」變成
// 「送出終端機動作」——在文章裡就是左側 7 欄點到連結卻退出文章。
function isAnchorTarget(el) {
  return !!(el && el.closest && el.closest('a'));
}

const ANTI_IDLE_STR = '\x1b\x1b';

export const App = function() {

  this.CmdHandler = document.getElementById('cmdHandler');
  this.CmdHandler.setAttribute('useMouseBrowsing', '1');
  this.CmdHandler.setAttribute('doDOMMouseScroll','0');
  this.CmdHandler.setAttribute('SkipMouseClick','0');

  this.view = new TermView();
  this.buf = new TermBuf(80, 24);
  this.buf.setView(this.view);
  //this.buf.severNotifyStr=this.getLM('messageNotify');
  //this.buf.PTTZSTR1=this.getLM('PTTZArea1');
  //this.buf.PTTZSTR2=this.getLM('PTTZArea2');
  this.view.setBuf(this.buf);
  this.view.setCore(this);
  this.parser = new AnsiParser(this.buf);
  // ORDER MATTERS (implicit coupling, do not reshuffle): easyReading registers its
  // termBuf 'screenSettled' listener HERE, before listSession does below — and
  // listSession's listener is what drives CommandQueue.onSettle (hence every
  // command's onDone). That ordering is what lets aid_navigation's landing onDone
  // run AFTER easyReading has already had its shot at the same settle, which is
  // why easy_reading.ensureEnabledOnArticle can rely on `_enabled` being final by
  // the time it is called (no double enterEasyReading → no duplicate PageDown/P4).
  this.easyReading = new EasyReading(this, this.view, this.buf);
  // List easy reading (v4): serialized machine keys + explicit state machine.
  // The queue only ever talks to the live connection; a dropped link makes the
  // send a no-op and the command dies by its own timeout (benign by design).
  this.commandQueue = new CommandQueue({
    send: (d) => {
      if (this.conn && this.conn.isConnected) this.conn.send(d);
    },
    // Per-command timeline into the debug recording (null recorder = zero
    // cost): a reproduced "畫面停住/處理中" hang shows exactly which kind sat
    // on the wire, for how long, and whether it ended done/miss/timeout.
    onEvent: (name, info) => this.debugRecorder?.log('queue.' + name, info),
    // Only a COMPLETE screen may end a probed command as 'miss' (see
    // command_queue's header). The probe is a bare \f = redrawwin, whose
    // response always opens with ESC[H ESC[2J, and term_buf's erase-display
    // case 2 does _touchRows(0, rows-1) ⇒ a full-screen clear is exactly
    // "changedRows covers every row". Anything narrower is a partial response
    // frame that raced the probe out, not an answer to it.
    isCompleteFrame: (facts) =>
      !!(facts && facts.changedRows && facts.rows && facts.changedRows.size >= facts.rows),
    // 線路空了就叫醒好讀：它的自動翻頁被 easy_reading._send 的閘門擋住時，是
    // **延後**不是丟棄，而文章落地那一幀好讀必定比 queue 早跑（見上面的 ORDER
    // MATTERS）⇒ 第一個 PageDown 一定被擋。少了這條線就只剩好讀自己的 620ms
    // watchdog 能救，等於每篇文章開頭固定卡一下。見 easy_reading.onWireIdle。
    onIdle: () => this.easyReading.onWireIdle()
  });
  this.listSession = new ListSession(this, this.view, this.buf, this.commandQueue);
  // AID (#文章代碼) link click → serialized native-key navigation to the target
  // article. A boardless link falls back to the current article's board
  // (tracked by term_view alongside articleAuthor).
  this.aidNavigation = new AidNavigation(this, this.view, this.buf, this.commandQueue);
  // 長推文一鍵發送（右鍵選單）：把一大段話切成 N 則，逐則跑完 PTT 的推文互動。
  // 與 aidNavigation 共用同一條 CommandQueue（一次只有一個鍵在線上），並同樣用
  // `active` 擋住使用者輸入。
  this.longPush = new LongPushSession(this, this.view, this.buf, this.commandQueue);
  this.view.onAidClick = (aid, board) => {
    this.aidNavigation.start(aid, board || this.view._articleBoard);
  };
  // 功能鍵按鈕（畫面上的 `[d]刪除` / `(y)回應`）→ 送出那個按鍵。
  // **只指派這一次，引用從此不變**：annotationsKey.refs 與 render/screen.js 的
  // outerHTML 節點重用都以它的參考身分為前提（每幀新建箭頭函式會讓整份標註快取
  // 每幀失效，長文直接回到 O(n²)）。
  this.view.onFunctionKey = (bytes, label) => this.onFunctionKey(bytes, label);
  // Deep link (外部連結 #<Board>/<AID>) → 同一套 AID 跳轉。目標可能比登入先到，
  // 所以排程權在 controller 手上，不在 URL 解析那邊。
  this.deepLinkController = new DeepLinkController(this, this.view, this.buf);
  this.autoLogin = new AutoLogin(this);
  // 圖片上傳（urusai）：拖放／貼上截圖／右鍵選單 → 上傳 → 網址送進推文列或編輯器。
  // 自己綁 window 的 drag* 事件；右鍵選單透過 this.imageUpload 呼叫它。
  this.imageUpload = new ImageUploadController(this);

  // Debug 錄製器（src/js/debug_recorder.js）：由 DebugRecordButton 掛上/卸下，
  // 純 runtime、不落地。關鍵路徑用 this.debugRecorder?.log(tag, info) 留痕。
  this.debugRecorder = null;

  //new pref - start
  this.antiIdleTime = 0;
  this.idleTime = 0;
  //new pref - end

  // for picPreview
  this.curX = 0;
  this.curY = 0;

  this.inputArea = document.getElementById('t');
  this.BBSWin = document.getElementById('BBSWindow');

  // horizontally center bbs window
  this.BBSWin.setAttribute("align", "center");
  this.view.mainDisplay.style.transformOrigin = 'center';

  this.mouseButtons = new MouseButtonTracker();

  this.inputAreaFocusTimer = null;
  // 目前開著的 modal 來源名稱集合；modalShown = size > 0（見 setModalOpen）。
  this._openModals = new Set();
  this.modalShown = false;

  this.lastSelection = null;

  this.waterball = { userId: '', message: '' };
  this.appFocused = true;

  this.endTurnsOnLiveUpdate = false;
  this.copyOnSelect = false;

  var self = this;

  window.addEventListener('click', function(e) {
    self.mouse_click(e);
  }, false);

  window.addEventListener('mousedown', function(e) {
    self.mouse_down(e);
  }, false);

  window.addEventListener('mousedown', function(e) {
    var ret = self.middleMouse_down(e);
    if (ret === false) {
      e.preventDefault();
    }
  }, false);

  window.addEventListener('mouseup', function(e) {
    self.mouse_up(e);
  }, false);

  document.addEventListener('mousemove', function(e) {
    self.mouse_move(e);
  }, false);

  document.addEventListener('mouseover', function(e) {
    self.mouse_over(e);
  }, false);

  if ('onwheel' in window) {
    window.addEventListener('wheel', function(e) {
      self.mouse_scroll(e);
    }, true);
  } else {
    window.addEventListener('mousewheel', function(e) {
      self.mouse_scroll(e);
    }, true);
  }

  window.addEventListener('focus', function(e) {
    self.appFocused = true;
    self.view.stopTitleFlash();
  }, false);

  // 分頁列切換不保證觸發 window 'focus'（各平台不一），而 deep link 交接的通知
  // 正是「使用者人在別的分頁」時發出的 —— visibilitychange 才是規範的訊號。
  // 只停閃爍，**不碰 appFocused**：那個旗標的語意是 window focus，且是水球解析的
  // 閘門（App.onData），混進 visibility 會改變水球行為。stopTitleFlash 冪等。
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) self.view.stopTitleFlash();
  }, false);

  window.addEventListener('blur', function(e) {
    self.appFocused = false;
    // A mouseup while unfocused never reaches us — clear held-button state
    // or the wheel stays stuck in page-scroll mode until reload.
    self.mouseButtons.reset();
    // 同理：滑鼠移出視窗不會再有 mousemove 把提示帶關掉。
    self.view.setExitAffordance(false);
  }, false);

  this.inputArea.addEventListener('paste', function(e) {
    self.onDOMPaste(e);
  });

  this.view.innerBounds = this.getWindowInnerBounds();
  this.view.firstGridOffset = this.getFirstGridOffsets();
  window.onresize = function() {
    self.onWindowResize();
  };

  window.addEventListener('beforeunload', (e) => {
    if (this.conn && this.conn.isConnected && this.buf.pageState != 0) {
      e.returnValue = 'You are currently connected. Are you sure?';
      return e.returnValue;
    }
  });

  this.dblclickTimer=null;
  this.mbTimer=null;
  this.timerEverySec=null;
  this.pushthreadAutoUpdateCount = 0;
  this.maxPushthreadAutoUpdateCount = -1;
  this.onWindowResize();
  this.setupContextMenus();
  this.contextMenuShown = false;
};

App.prototype.isConnected = function() {
  return this.connectState == 1 && !!this.conn;
};

App.prototype.connect = function(url) {
  this.connectState = 0;
  console.log('connect: ' + url);

  var parsed = this._parseURLSimple(url);
  if (parsed.protocol == 'wsstelnet') {
    this._setupWebsocketConn('wss://' + parsed.hostname + parsed.path);
  } else if (parsed.protocol == 'wstelnet') {
    this._setupWebsocketConn('ws://' + parsed.hostname + parsed.path);
  } else {
    console.log('unsupport connect url protocol: ' + parser.protocol);
    return;
  }

  this.connectedUrl = {
    url: url,
    site: parsed.hostname,
    port: parsed.port,
    easyReadingSupported: true
  };
};

App.prototype._parseURLSimple = function(url) {
  var protocol = url.split(/:\/\//, 2);
  if (protocol.length != 2)
    return null;
  var hostname = protocol[1].split(/\//, 2);
  var hostport = hostname[0].split(/:/);
  if (hostport > 2)
    return null;
  var port = hostport.length > 1 ? parseInt(hostport[1]) : {
    'wstelnet': 80,
    'wsstelnet': 443,
    'telnet': 23,
    'ssh': 22
  }[protocol[0]];
  return {
    protocol: protocol[0],
    hostname: hostname[0],
    host: hostport[0],
    port: port,
    path: '/' + (hostname.length > 1 ? hostname[1] : '')
  };
};

App.prototype._setupWebsocketConn = function(url) {
  var wsConn = new Websocket(url);
  this._attachConn(new TelnetConnection(wsConn));
};

App.prototype._attachConn = function(conn) {
  var self = this;
  this.conn = conn;
  this.conn.addEventListener('open', this.onConnect.bind(this));
  this.conn.addEventListener('close', this.onClose.bind(this));
  this.conn.addEventListener('data', function(e) {
    self.onData(e.detail.data);
  });
  this.conn.addEventListener('doNaws', function(e) {
    conn.sendWillNaws();
    conn.sendNaws(self.buf.cols, self.buf.rows);
  });
};

App.prototype.onConnect = function() {
  this.conn.isConnected = true;
  this.view.setConn(this.conn);
  console.info("pttchrome onConnect");
  this.debugRecorder?.log('app.onConnect');
  this.connectState = 1;
  this.updateTabIcon('connect');
  this.idleTime = 0;
  var self = this;
  this.timerEverySec = setTimer(true, function() {
    self.antiIdle();
    self.view.onBlink();
    self.incrementCountToUpdatePushthread();
  }, 1000);

  // Enhanced Add-on: kick off auto login (no-op unless enabled with credentials).
  this.autoLogin.start();
};

App.prototype.onData = function(data) {
  this.parser.feed(data);

  if (!this.appFocused && this.view.enableNotifications) {
    // parse received data for waterball
    var wb = parseWaterball(b2u(data));
    if (wb) {
      if ('userId' in wb) {
        this.waterball.userId = wb.userId;
      }
      if ('message' in wb) {
        this.waterball.message = wb.message;
      }
      this.view.showWaterballNotification();
    }
  }
};

App.prototype.onClose = function() {
  console.info("pttchrome onClose");
  this.debugRecorder?.log('app.onClose');
  if (this.timerEverySec) {
    this.timerEverySec.cancel();
  }
  this.conn.isConnected = false;

  // Connection gone: the list buffer is stale by definition — hard reset to
  // idle/native so the reconnect starts clean.
  this.listSession.disable();
  // Same for the AID back stack: its anchors are replayed as key sequences and
  // rely on this session's per-board cursors (pttbbs getkeep), which die with it.
  this.aidNavigation.reset();
  // A deep link waiting for login belongs to the session that is now gone: the
  // reconnect starts back at the login screen, and firing a jump into whatever
  // the user does next is worse than making them click the link again.
  this.deepLinkController.reset();

  this.cancelMbTimer();

  this.connectState = 2;
  this.idleTime = 0;

  const onDismiss = () => {
    unmountFrom(container);
    this.connect(this.connectedUrl.url);
  }
  const container = document.getElementById('reactAlert');
  renderInto(container, <MantineRoot><ConnectionAlert onDismiss={onDismiss} /></MantineRoot>);
  this.updateTabIcon('disconnect');
};

App.prototype.sendData = function(str) {
  if (this.connectState == 1)
    this.conn.convSend(str);
};

App.prototype.cancelMbTimer = function() {
  if (this.mbTimer) {
    this.mbTimer.cancel();
    this.mbTimer = null;
  }
};

App.prototype.setMbTimer = function() {
  this.cancelMbTimer();
  var _this = this;
  this.mbTimer = setTimer(false, function() {
    _this.mbTimer.cancel();
    _this.mbTimer = null;
    _this.CmdHandler.setAttribute('SkipMouseClick', '0');
  }, 100);
};

App.prototype.cancelDblclickTimer = function() {
  if (this.dblclickTimer) {
    this.dblclickTimer.cancel();
    this.dblclickTimer = null;
  }
};

App.prototype.setDblclickTimer = function() {
  this.cancelDblclickTimer();
  var _this = this;
  this.dblclickTimer = setTimer(false, function() {
    _this.dblclickTimer.cancel();
    _this.dblclickTimer = null;
  }, 350);
};

// `#t` 的**唯一** focus 漏斗。preventScroll 是防禦性的第二道鎖：#t 平時停在
// left:-10000px，只要哪天它變成某個捲動容器的子孫，focus() 的自動 scrollIntoView
// 就會把那個容器捲飛（見 index.html 的註解）。目前 #t 掛在 #BBSWindow 底下、
// 結構上不會發生，但這行成本是零。
App.prototype.setInputAreaFocus = function() {
  if (this.modalShown)
    return;
  //this.DocInputArea.disabled="";
  this.inputArea.focus({ preventScroll: true });
};

// modalShown 是終端機鍵盤／焦點的總閘門（讀取點散在 term_view.js 的 shouldAcceptInput
// ／onInput 與本檔的 setInputAreaFocus／mouse_click／mouse_down／mouse_up／mouse_over
// ／mouse_scroll）。歷史上它是「各處手動兩邊維護的裸布林」，只要任何一條關閉路徑漏掉
// 復位（early-return、或副作用中途 throw），就會變成「畫面上還有對話框、app 卻以為
// 沒有」→ keyup/mouseover/mouseup 永久把焦點搶回隱藏 input #t，整頁只能重整才能打字。
//
// 改為具名來源集合：
//   - 呼叫端只宣告「我這個來源開著／關了」，不直接寫 modalShown，兩個 modal 交錯開關
//     不會互相把對方的旗標關掉。
//   - React 側（components/ContextMenu/index.jsx）由 render state 推導後呼叫本函式，
//     結構上不可能失同步。
//   - 關掉最後一個 modal 時才把焦點還給終端機。
App.prototype.setModalOpen = function(source, open) {
  if (open)
    this._openModals.add(source);
  else
    this._openModals.delete(source);
  var shown = this._openModals.size > 0;
  if (shown === this.modalShown)
    return;
  this.modalShown = shown;
  // 對話框蓋上來時滑鼠已經離開終端機，提示帶留著會變成殘影（mousemove 被 modal
  // gate 擋掉，永遠等不到把它關掉的那一幀）。
  // 這個函式是終端機鍵盤／焦點的總閘門，**任何路徑都不可以 throw**（半途中斷 ⇒
  // 「畫面上有對話框、app 卻以為沒有」，整頁只能重整），故一律防禦性取用。
  if (shown && this.view && this.view.setExitAffordance)
    this.view.setExitAffordance(false);
  if (!shown)
    this.setInputAreaFocus();
};

// 即時看板小幫手的兩個入口：預設 noop，只有 pref 打開時才被注入真的實作
// （components/ContextMenu/index.jsx 的 useEffect 依 liveHelperEnabled 綁定／解綁）。
// 這是刻意的——消費端在 term_view.js（End 鍵的 onToggle…、任何非 Alt 鍵的
// onDisable…），不能為了「功能沒開」在熱路徑上到處加判斷。onToggle 回 true 代表
// 按鍵已被吃掉，noop 回 undefined ⇒ End 會落到原本的行為。
App.prototype.onToggleLiveHelperModalState = noop;
App.prototype.onDisableLiveHelperModalState = noop;

App.prototype.switchToEasyReadingMode = function(doSwitch) {
  this.debugRecorder?.log('app.switchToEasyReadingMode', { doSwitch: !!doSwitch });
  // 這裡做什麼是純決策（switchModePlan，見 easy_reading.js 的長註解 + unit
  // tests/unit/switch_mode_plan.test.js）。要點：**正在鏡像原生（functionMode，
  // 使用者停在 X 推文／r 回應／編輯器這類 prompt 上）時，只重繪，什麼都不准重置** —
  // 清掉 _functionMode 會讓 ^L 的整頁重繪落進好讀文章分支，而 prompt 幀的游標不在
  // (rows-1, cols-1) ⇒ accumulatePageLines 判 incomplete ⇒ pageLines 空 ⇒ 整頁全黑。
  //
  // NOTE: leavePost 這條路會經 leaveCurrentPost() 重設 per-post 狀態。呼叫端
  // （onPrefSaveImpl，以及 easyReading.exitEasyReading() 的傳遞呼叫）依賴它 —
  // an easy hop to miss when tracing the exit path.
  var plan = switchModePlan({
    doSwitch: !!doSwitch,
    functionMode: !!this.buf.easyReadingFunctionMode,
    pageState: this.buf.pageState
  });
  if (plan.leavePost)
    this.easyReading.leaveCurrentPost();
  if (doSwitch)
    this.onDisableLiveHelperModalState();
  if (plan.restoreNativeView) {
    this.view.mainContainer.style.paddingBottom = '';
    this.view.lastRowIndex = 22;
    this.view.lastRowDiv.style.display = '';
  }
  // clear the deep cloned copy of lines
  if (plan.clearPageLines)
    this.buf.pageLines = [];
  if (plan.cursorNudge) this.view._send('\x1b[D\x1b[C'); //this.view._send('qr');
  // request the full screen.
  // 一律走 view._send（內含 `if (this.conn)`），不可直接 this.view.conn.send：
  // TermView.setConn 只在 App.onConnect 被呼叫，**連線從未成功時 view.conn 是
  // undefined** → 直接 deref 會 TypeError，把呼叫端（關設定頁）整條路徑炸斷。
  // 回歸守護：tests/e2e/offline/connect_failure.offline.spec.js。
  this.view._send(unescapeStr('^L'));
};

// 剪貼簿寫入**一定要自己接住失敗**：document 沒有焦點、非 secure context、
// 權限被拒時 writeText 會 reject NotAllowedError，navigator.clipboard 本身在非
// secure context 更是根本不存在（裸 deref ＝同步 TypeError，會把呼叫端整條路徑
// 炸斷，長推文取消收尾 long_push_session#_finish 就走這條）。
// 沒接住的 rejection 除了讓真實使用者 console 冒紅字，還會被 Vite HMR client 轉發
// 回 dev server（vite:forward-console）→ 離線 e2e 的 stub WebSocket 把那段 JSON
// 記成「app 送出的 bytes」→ 讀 __sent 的 spec 偶發紅。
// 回歸守護：tests/unit/copy_clipboard_reject.test.js。
App.prototype.doCopy = function(str) {
  try {
    var clip = navigator.clipboard;
    if (!clip || !clip.writeText) return Promise.resolve(false);
    return Promise.resolve(clip.writeText(normalizeCopyText(str))).then(
      function() { return true; },
      function() { return false; }
    );
  } catch (e) {
    return Promise.resolve(false);
  }
};

App.prototype.doCopyAnsi = function() {
  if (!this.lastSelection)
    return;

  var selection = this.lastSelection;
  var pageLines = null;
  if (this.view.useEasyReadingMode && this.buf.pageState == 3) {
    pageLines = this.buf.pageLines;
  }

  var ansiText = '';
  if (selection.start.row == selection.end.row) {
    ansiText += this.buf.getText(selection.start.row, selection.start.col, selection.end.col, true, true, false, pageLines);
  } else {
    for (var i = selection.start.row; i <= selection.end.row; ++i) {
      var scol = 0;
      var ecol = this.buf.cols-1;
      if (i == selection.start.row) {
        scol = selection.start.col;
      } else if (i == selection.end.row) {
        ecol = selection.end.col;
      }
      ansiText += this.buf.getText(i, scol, ecol, true, true, false, pageLines);
      if (i != selection.end.row ) {
        ansiText += '\r';
      }
    }
  }

  this.doCopy(ansiText);
};

App.prototype.doPaste = function() {
  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(
      (text) => this.onPasteDone(text),
      () => this.showPasteUnimplemented());
  } else {
    this.showPasteUnimplemented();
  }
};

App.prototype.showPasteUnimplemented = function() {
  const container = document.getElementById('reactAlert')
  const onDismiss = () => {
    unmountFrom(container)
    this.setModalOpen('pasteAlert', false);
  }
  // PasteShortcutAlert 本身即 Mantine Modal（backdrop + ESC 由 Mantine 提供）；
  // × / 按鈕 / onClose 皆走 onDismiss → unmount 容器。
  renderInto(
    container,
    <MantineRoot>
      <PasteShortcutAlert opened onClose={onDismiss} />
    </MantineRoot>
  )
  this.setModalOpen('pasteAlert', true);
};

// Single funnel for every paste route (DOM paste on #t, Ctrl-Shift-V, context
// menu, middle click) — so both easy-reading modes only have to be taught here.
App.prototype.onPasteDone = function(content) {
  // List easy reading owns the wire while it renders the buffer: a raw convSend
  // would race its serialized commands AND land on a screen the user can't see.
  // onPaste returns false when it isn't engaged (native mirror / idle).
  if (this.listSession && this.listSession.onPaste(content))
    return;

  // Article easy reading: the same blind spot in miniature. _onKeyDown enters
  // functionMode for any single character it doesn't handle, precisely so the
  // prompt PTT opens (#, /, ;, :, s…) is mirrored live — but a paste isn't a
  // keypress, so it never tripped that rule and the prompt stayed hidden behind
  // the accumulated long page. Mirror natively before the text goes out.
  // (_enterFunctionMode is a no-op when already in it.)
  if (this.view.useEasyReadingMode && this.buf.startedEasyReading)
    this.easyReading._enterFunctionMode();

  this.view.onTextInput(content, true);
};

// 點畫面上功能鍵按鈕的**唯一**漏斗。形狀比照 onPasteDone —— 那是這個 app 已經
// 解過同一題（「一個非鍵盤的輸入要怎麼進到兩種好讀模式」）的地方。
//
// **必須自己守門**：<a> 上的 click listener 是元素層，永遠比掛在 window 的
// App.mouse_click 先跑 ⇒ 那邊的三道守門（modalShown / aidNavigation.active /
// 上傳浮層）攔不到它（aidLink 也是靠 aid_navigation 自己的 `if (this.active) return;`
// 自保，這裡比照）。見 docs/mouse.md 的點擊優先權表。
App.prototype.onFunctionKey = function(bytes, label) {
  if (!bytes) return;
  if (this.modalShown) return;
  if (this.aidNavigation && this.aidNavigation.active) {
    if (this.view.flashListHint)
      this.view.flashListHint('AID 跳文中，請稍候…');
    return;
  }
  // 長推文送出中：整條序列在程式化按 PTT 的鍵，插一個進去就會打亂 X → 型別 →
  // 內容 的配對（進度遮罩本身也會讓 modalShown 擋住，這裡是同一條件的自保）。
  if (this.longPush && this.longPush.active) {
    if (this.view.flashListHint)
      this.view.flashListHint('長推文送出中，請稍候…');
    return;
  }
  // 列表好讀：封閉互動（v5）。回 true ＝它接手了，不可以再送一次。
  if (this.listSession && this.listSession.onFunctionKey(bytes)) return;

  const plan = functionKeyClickPlan({
    bytes: bytes,
    mode:
      this.view.useEasyReadingMode && this.buf.startedEasyReading
        ? 'article-easy'
        : 'native'
  });
  // 送 byte **之前**先進原生鏡像：PTT 會開 prompt（(y)回應 / (X)推文 / (h)說明），
  // 但好讀的累積長頁原封不動 ⇒ 使用者看不到輸入框。docs/easy-reading.md 的
  // 「貼上驅動」「IME 驅動」補過同一個洞兩次，這是第三個入口。
  // （_enterFunctionMode 已在鏡像中時是 no-op。）
  if (plan.enterFunctionMode) this.easyReading._enterFunctionMode();
  // `←` 走與鍵盤 ArrowLeft 完全同一條路，離開文章時才不會閃一下原生 24 列。
  if (plan.stopEasyReading) this.easyReading.stopEasyReading();
  if (!plan.send) return;
  // **刻意不用 easyReading._send**：它 _wireBusy() 時直接**丟棄**（那是給狀態機
  // 自己送的鍵設計的，丟了只是少翻一頁）。使用者按下去的按鈕被靜默吞掉是 bug，
  // 所以在這裡自己判同一組條件並**給提示**。
  if (this.commandQueue && this.commandQueue.inFlightKind) {
    if (this.view.flashListHint)
      this.view.flashListHint('指令處理中，請稍候…');
    return;
  }
  // view._send 內含 `if (this.conn)`（view.conn 只在 onConnect 被設）。
  // **不用 _convSend**（會做 u2b 轉碼，對 [D 這種控制序列無意義），
  // **不用 setBBSCmd**（那是翻頁語意的分派器），**絕不用 this.view.conn.send**。
  this.view._send(bytes);
};

App.prototype.onDOMPaste = function(e) {
  // 剪貼簿裡是圖（截圖直接 Ctrl+V）→ 交給圖片上傳，吃掉這次貼上。沒有圖時
  // 回 false，文字貼上的行為與加這個功能之前完全一樣。
  if (this.imageUpload && this.imageUpload.tryClipboardImage(e))
    return;
  let str = e.clipboardData.getData('text');
  if (str) {
    e.preventDefault();
    this.onPasteDone(str);
  }
};

App.prototype.doSelectAll = function() {
  window.getSelection().selectAllChildren(this.view.mainDisplay);
};

App.prototype.doOpenUrlNewTab = function(a) {
  // ctrlKey opens the anchor in a new tab without stealing focus flow.
  a.dispatchEvent(new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    view: window,
    ctrlKey: true,
  }));
};

App.prototype.incrementCountToUpdatePushthread = function(interval) {
  if (this.maxPushthreadAutoUpdateCount == -1) {
    this.pushthreadAutoUpdateCount = 0;
    return;
  }

  if (++this.pushthreadAutoUpdateCount >= this.maxPushthreadAutoUpdateCount) {
    this.pushthreadAutoUpdateCount = 0;
    if (this.buf.pageState == 3 || this.buf.pageState == 2) {
      //this.view._send('qrG');
      this.view._send('\x1b[D\x1b[C\x1b[4~');
    }
  }
};
App.prototype.setAutoPushthreadUpdate = function(seconds) {
  this.maxPushthreadAutoUpdateCount = seconds;
};

App.prototype.onWindowResize = function() {
  this.view.innerBounds = this.getWindowInnerBounds();

  if (this.resizeTimeout) {
    clearTimeout(this.resizeTimeout);
  }
  if (this.resizer) {
    this.resizeTimeout = setTimeout(() => {
      this.resizeTimeout = null;
      if (this.resizer) {
        this.resizer();
      }
    }, 500);
  } else {
    this.view.fontResize();
  }
};

App.prototype.setTermSize = function(cols, rows) {
  if (this.buf.cols == cols && this.buf.rows == rows) {
    return;
  }

  this.buf.resize(cols, rows);
  if (this.conn) {
    this.conn.sendNaws(cols, rows);
  }
};

App.prototype.antiIdle = function() {
  if (this.antiIdleTime && this.idleTime > this.antiIdleTime) {
    if (this.connectState == 1) {
      this.conn.send(ANTI_IDLE_STR);
      this.idleTime = 0;
    }
  } else {
    if (this.connectState == 1)
      this.idleTime += 1000;
  }
};

App.prototype.updateTabIcon = function(aStatus) {
  var icon = logoIcon;
  switch (aStatus) {
    case 'connect':
      icon = logoConnectIcon;
      this.setInputAreaFocus();
      break;
    case 'disconnect':
      icon = logoDisconnectIcon;
      break;
    default:
      break;
  }

  var link = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement("link");
    link.setAttribute("rel", "icon");
    link.setAttribute("href", icon);
    document.head.appendChild(link);
  } else {
    link.setAttribute("href", icon);
  }
};

// use this method to get better window size in case of page zoom != 100%
App.prototype.getWindowInnerBounds = function() {
  var width = document.documentElement.clientWidth - this.view.bbsViewMargin * 2;
  var height = document.documentElement.clientHeight - this.view.bbsViewMargin * 2;
  var bounds = {
    width: width,
    height: height
  };
  return bounds;
};

App.prototype.getFirstGridOffsets = function() {
  var container = document.querySelector(".main");
  return {
    top: container.offsetTop,
    left: container.offsetLeft
  };
};

// 畫面座標 → 格子座標。**欄的那一半刻意委給 mouse_geometry.colFromClientX**：
// 文章左側的退出提示帶（#exitHintBand）必須與這裡算出來的可點區逐格對齊，兩邊
// 共用同一份實作才不會漂移。（歷史上 term_view 另有一套 convertMN2XYEx 原點公式，
// 多了 +10 與 bbsViewMargin，用錯就差十幾個像素；已刪除，見 mouse_geometry.js 開頭。）
App.prototype.clientToPos = function(cX, cY) {
  var y;
  var h = this.view.innerBounds.height;
  if (this.view.scaleX != 1 || this.view.scaleY != 1) {
    y = cY - ((h - (this.view.chh * this.buf.rows) * this.view.scaleY) / 2);
  } else {
    y = cY - parseFloat(this.view.firstGridOffset.top);
  }
  var col = colFromClientX(cX, this.gridGeometry());
  var rowH = this.view.chh * this.view.scaleY;
  var row = Math.floor(y / rowH);

  // 列表好讀的平滑捲動：body 區整體上移了 frac ⇒ 那一段的列號要自己補回來，
  // 否則停在半列時點下去會開到上一篇（游標底色也會標錯列）。header／footer 不受
  // 影響（它們不在捲動視口裡）。視口底部露出的那一小條（overscan 列）給它
  // **渲染 index 24**，與 buildListWindowLines 放它的位置一致；不能用 3+20=23，
  // 那是 footer 的列號。
  var listFrac = this._listScrollFrac();
  if (listFrac > 0) {
    var bodyTop = LIST_HEADER_ROWS * rowH;
    var bodyRows = this.buf.rows - 4;
    if (y >= bodyTop && y < bodyTop + bodyRows * rowH) {
      var bodyIdx = Math.floor(
        (y - bodyTop + listFrac * this.view.scaleY) / rowH
      );
      if (bodyIdx > bodyRows) bodyIdx = bodyRows;
      if (bodyIdx < 0) bodyIdx = 0;
      return {
        col: col,
        row: bodyIdx === bodyRows ? this.buf.rows : LIST_HEADER_ROWS + bodyIdx
      };
    }
  }

  if (row < 0)
    row = 0;
  else if (row >= this.buf.rows-1)
    row = this.buf.rows-1;

  return {col: col, row: row};
};

// 列表好讀的次列位移（未縮放的內容 px）。0＝沒有位移或不適用（其他畫面、frozen
// 快照）。座標換算與 render 都以它為準。
App.prototype._listScrollFrac = function() {
  if (!this.listSession || this.buf.listRenderMode !== 'buffer') return 0;
  return (this.listSession.scrollFrac && this.listSession.scrollFrac()) || 0;
};

// 各滑鼠入口的生效與否。總開關（buf.useMouseBrowsing）與四個子開關（view 上的
// mouseLeftClick / mouseMisclickGuard / mouseMiddleClick / mouseWheel）在純函式
// resolveMouseGates 匯總，所以「總開關關掉＝中鍵與滾輪也失效」只有一個真相源。
App.prototype.mouseGates = function() {
  return resolveMouseGates({
    useMouseBrowsing: this.buf.useMouseBrowsing,
    mouseLeftClick: this.view.mouseLeftClick,
    mouseMisclickGuard: this.view.mouseMisclickGuard,
    mouseMiddleClick: this.view.mouseMiddleClick,
    mouseWheel: this.view.mouseWheel,
    mouseWheelSmoothScroll: this.view.mouseWheelSmoothScroll
  });
};

// 餵給 mouse_geometry 的一組幾何（see clientToPos / TermView.setTermFontSize）。
App.prototype.gridGeometry = function() {
  return {
    innerWidth: this.view.innerBounds.width,
    chw: this.view.chw,
    cols: this.buf.cols,
    scaleX: this.view.scaleX,
    scaleY: this.view.scaleY,
    firstGridLeft: this.view.firstGridOffset && this.view.firstGridOffset.left
  };
};

// 左鍵在終端機區域點下去要送什麼。動作只有三種（見 mouse_regions.js）：
//   ACT_ENTER        列表／選單：把 server 的真游標移到目標列再 Enter
//   ACT_EXIT_ARTICLE 文章左側帶：左方向鍵離開
//   其餘             **真的什麼都不做**
// 最後一條是重點：改版前的 case 0 也會送左方向鍵，於是在文章裡隨手點一下空白處
// 就跳出文章。
App.prototype.onMouse_click = function (e) {
  if (!this.conn || !this.conn.isConnected)
    return;

  // AID navigation in flight: swallow clicks so a stray mouse-browsing action
  // can't inject keys into the serialized sequence (never silent — banner).
  if (this.aidNavigation.active) {
    e.preventDefault();
    this.view.flashListHint('AID 跳文中，請稍候…');
    return;
  }

  // disable auto update pushthread if any command is issued;
  this.onDisableLiveHelperModalState();

  // **先取值再交給好讀**：easyReading._onMouseClick 會 stopEasyReading()，那條路徑
  // 一路走到 buf.notify() → clearHighlight() 把 mouseAction 清成 none。改版前這個
  // 順序沒事只是因為舊的 case 0（＝被清掉的狀態）也送左方向鍵，剛好跟離開同義。
  var action = this.buf.mouseAction;
  var targetRow = this.buf.mouseActionRow;

  // 分派順序＝好讀先收狀態機，再由下面的 switch 送真正的按鍵。點擊優先權表在
  // docs/mouse.md，動作本身由純函式決策層 mouse_regions.js 決定（四種動作）。
  this.easyReading._onMouseClick(e);
  if (e.defaultPrevented)
    return;

  switch (action) {
    case ACT_EXIT_ARTICLE:
      this.view._send('\x1b[D'); //Arrow Left
      break;
    // 列表／選單的左側退出帶。送的 byte 與鍵盤左方向鍵**完全相同**，行為等價，
    // 不需要新語意（list_session._enqueueLeaveKey 用的也是它）。
    // **不可以掉進 default** —— 舊的 mouseCursor 改名 mouseAction 就是為了讓漏改
    // 變成 undefined 而不是靜默走錯 case（見 mouse_regions.js 檔頭）。
    // 註：列表好讀模式**走不到這裡**，它在 mouse_click 就被 buffer/frozen 分支
    // 攔下並交給 listSession.onMouseExitClick（封閉互動，見 docs/mouse.md）。
    case ACT_EXIT:
      this.view._send(LEFT_ARROW);
      break;
    case ACT_ENTER: {
      if (targetRow < 0)
        break;
      var delta = targetRow - this.buf.cur_y;
      var step = delta > 0 ? '\x1b[B' : '\x1b[A'; //Arrow Down / Up
      this.view._send(step.repeat(Math.abs(delta)) + '\r');
      break;
    }
    default:
      //do nothing
      break;
  }
};

App.prototype.onMouse_move = function(cX, cY) {
  var pos = this.clientToPos(cX, cY);
  // 列表好讀模式的畫面是我們自己組的虛擬視窗，term_buf.onMouse_move 那套（可點列
  // 判斷、欄位、該列是否為空）全部依 server 的真實 24 列判斷，套上去只會得到錯的
  // 游標形狀與錯的光棒。改由 view 依視窗內容判斷（見 onListMouseMove）。
  if (this.buf.listRenderMode === 'buffer' || this.buf.listRenderMode === 'frozen') {
    this.view.onListMouseMove(pos.row, pos.col);
    return;
  }
  this.buf.onMouse_move(pos.col, pos.row);
};

App.prototype.resetMouseCursor = function() {
  this.buf.BBSWin.style.cursor = 'auto';
  this.buf.mouseAction = ACT_NONE;
  this.buf.mouseActionRow = -1;
  if (this.view.setExitAffordance) this.view.setExitAffordance(false);
};

App.prototype.onValuesPrefChange = function(values, opts) {
  for (var name in values) {
    this.onPrefChange(name, values[name]);
  }

  // Enhanced Add-on: cache the credentials for this session's reconnects, but
  // ONLY when they come from the user editing the settings dialog
  // (setSessionCredential merges, so "only the OTP secret was filled in" is a
  // valid update too).
  //
  // Never on the startup/cloud path: prefs read from localStorage still hold
  // the plaintext until the migration completes, and seeding the cache with
  // them short-circuits _resolveCredential before it ever calls
  // credentials.get() — so the browser store would never be proven and the
  // plaintext would never be cleared.
  if (values.autoLogin && opts && opts.fromPrefModal) {
    this.autoLogin.setSessionCredential(
      values.autoLoginUser,
      values.autoLoginPassword,
      values.autoLoginOtpSecret
    );
  }

  // These prefs have to be processed as a whole.
  try {
    this.resizer = null;

    switch (values.termSizeMode) {
      case 'fixed-term-size':
        this.view.fontFitWindowWidth = values.fontFitWindowWidth;

        let size = values.termSize;
        this.setTermSize(size.cols, size.rows);
        this.view.fontResize();
        this.view.redraw(true);
        break;

      case 'fixed-font-size':
        this.view.fontFitWindowWidth = false;

        let fontSize = values.fontSize;
        this.resizer = () => {
          let size = this.view.calcTermSizeFromFont(fontSize);
          this.setTermSize(size.cols, size.rows);
          this.view.fixedResize(fontSize);
          this.view.redraw(true);
        };
        // Immediately recalc once.
        this.resizer();
        break;
    }

    var mainEls = document.querySelectorAll('.main');
    if (this.view.fontFitWindowWidth) {
      mainEls.forEach(function(el) { el.classList.add('trans-fix'); });
    } else {
      mainEls.forEach(function(el) { el.classList.remove('trans-fix'); });
    }
  } catch (e) {}
};

App.prototype.onPrefChange = function(name, value) {
  try {
    switch (name) {
    case 'enableWorkMode':
      // CSS-only disguise: color.css maps the 16 ANSI colors (fg/bg/glow/blink)
      // to muted grays under this class. body-level so the whole screen
      // (including easy-reading overlay) is covered.
      document.body.classList.toggle('work-mode-active', !!value);
      // The typing cursor's color is an inline style (not reachable by that
      // class) and is derived from the NATIVE bg palette — it has to be told,
      // or it goes invisible on the grayed-out reverse-video input rows.
      if (this.view) this.view.setWorkMode(!!value);
      break;
    case 'autoHideBlinkCursor':
      // 純顯示切換：只影響 #cursor 的 display，不需 redraw。
      if (this.view) this.view.setAutoHideBlinkCursor(!!value);
      break;
    // 總開關。關掉＝底色、左鍵、中鍵、滾輪、指標圖示、左側提示帶全部停用
    // （改版前中鍵與滾輪根本不看它）。連結與圖片不受影響。
    case 'useMouseBrowsing':
      var useMouseBrowsing = !!value;
      this.CmdHandler.setAttribute('useMouseBrowsing', useMouseBrowsing?'1':'0');
      this.buf.useMouseBrowsing = useMouseBrowsing;

      if (!useMouseBrowsing) {
        this.buf.BBSWin.style.cursor = 'auto';
        this.buf.clearHighlight();
        this.buf.tempMouseCol = 0;
        this.buf.tempMouseRow = 0;
      }
      this.buf.resetMousePos();
      this.view.redraw(true);
      this.view.updateCursorPos();
      break;
    // 游標所在列標示（見 pref_storage.js）：來源層三兄弟 + 樣式層兩兄弟，
    // 都只影響「哪一列畫什麼」，套用入口統一是 view.applyCursorHighlight，
    // 不需要重畫整個畫面（col > 0 的部分寬度會由 Screen 自己退回 _render）。
    case 'mouseBrowsingHighlight':
      this.buf.highlightCursor = value;
      this.view.applyCursorHighlight();
      break;
    case 'keyboardCursorHighlight':
      this.view.keyboardCursorHighlight = !!value;
      this.view.applyCursorHighlight();
      break;
    case 'mouseBrowsingHighlightColor':
      this.view.highlightBG = value;
      this.view.applyCursorHighlight();
      break;
    case 'cursorRowBrighten':
      this.view.cursorRowBrighten = !!value;
      this.view.applyCursorHighlight();
      break;
    case 'cursorRowBackground':
      this.view.cursorRowBackground = !!value;
      this.view.applyCursorHighlight();
      break;
    // 左鍵開關同時管指標圖示與左側提示帶 ⇒ 要立刻重新評估滑鼠目前停的那一格，
    // 否則要等使用者再動一次滑鼠才會看到變化。
    case 'mouseLeftClick':
      this.view.mouseLeftClick = !!value;
      if (!this.view.mouseLeftClick && this.view.setExitAffordance)
        this.view.setExitAffordance(false);
      this.buf.resetMousePos();
      break;
    // 防誤觸同時管「可點區」與「底色區」⇒ 兩邊都要立刻重算：resetMousePos 重跑
    // 目前這一格的區域決策（指標／提示帶／nowHighlight），applyCursorHighlight
    // 補上「滑鼠沒動、只有鍵盤游標列上色」的那種畫面。
    case 'mouseMisclickGuard':
      this.view.mouseMisclickGuard = !!value;
      this.buf.resetMousePos();
      this.view.applyCursorHighlight();
      break;
    // 功能鍵可點：改的是 annotation 的**內容**（哪幾格要包成 <a class="fnKey">），
    // 不是滑鼠當下停在哪一格 ⇒ 必須 redraw，而且要 **force**：dirty-row 逐列 patch
    // 只重畫 server 這一幀寫過的列，切 pref 時那批列通常是空的，不 force 的話按鈕
    // 該出現不出現、該消失不消失，直到 PTT 下次重畫該列為止。
    case 'mouseFunctionKeys':
      this.view.mouseFunctionKeys = !!value;
      this.view.redraw(true);
      break;
    case 'mouseMiddleClick':
      this.view.mouseMiddleClick = Number(value) || 0;
      break;
    case 'mouseWheel':
      this.view.mouseWheel = Number(value) || 0;
      break;
    // 純事件層行為（下一個 wheel event 就生效），不影響已畫出來的畫面 ⇒ 免 redraw。
    case 'mouseWheelSmoothScroll':
      this.view.mouseWheelSmoothScroll = !!value;
      break;
    case 'copyOnSelect':
      this.copyOnSelect = value;
      break;
    case 'endTurnsOnLiveUpdate':
      this.endTurnsOnLiveUpdate = value;
      break;
    case 'enablePicPreview':
      // 刻意存成 view 欄位：它在 redraw 時才被讀（term_view 傳成 hoverPreview 給
      // src/render/），所以真相源必須活在渲染鏈能同步讀到的地方，不是預覽元件裡。
      this.view.enablePicPreview = value;
      break;
    // imgur 快取代理：只更新 imgur_proxy.js 的模組 config，**不 redraw**。已解析過的
    // 預覽有 module cache（requestPreview 以 href 為鍵、probeCache 以 id 為鍵），切換
    // 只對之後新解析的連結生效 ⇒ 設定 UI 的文案標「重新整理後生效」。
    case 'useImgurProxy':
      setImgurProxyConfig({ enabled: value });
      break;
    case 'imgurProxyUrl':
      setImgurProxyConfig({ base: normalizeImgurProxyBase(value) });
      break;
    case 'enableNotifications':
      this.view.enableNotifications = value;
      break;
    case 'deepLinkHandoffNotify':
      this.view.deepLinkHandoffNotify = value;
      break;
    case 'showFloorNumbers':
      this.view.showFloorNumbers = value;
      this.view.redraw(true);
      break;
    case 'mergeSameAuthorComments':
      this.view.mergeSameAuthorComments = value;
      this.view.redraw(true);
      break;
    case 'enableAi':
      this.view.enableAi = value;
      this.view.redraw(true);
      break;
    case 'enableCaptionAi':
      this.view.enableCaptionAi = value;
      this.view.redraw(true);
      break;
    case 'highlightAuthorComments':
      this.view.highlightAuthorComments = value;
      this.view.redraw(true);
      break;
    case 'enableAutoFixUrl':
      this.view.enableAutoFixUrl = value;
      this.view.redraw(true);
      break;
    case 'enableBareDomainLink':
      this.view.enableBareDomainLink = value;
      this.view.redraw(true);
      break;
    case 'enableUrlAi':
      this.view.enableUrlAi = value;
      this.view.redraw(true);
      break;
    case 'enableXMentionLink':
      this.view.enableXMention = value;
      this.view.redraw(true);
      break;
    case 'blacklist':
      this.view.blacklist = parseBlacklist(value);
      this.view.redraw(true);
      break;
    case 'titleBlacklist':
      this.view.titleBlacklist = parseTitleBlacklist(value);
      this.view.redraw(true);
      break;
    case 'enableEasyReading':
      /*if (this.connectedUrl.site == 'ptt.cc') {
        this.view.useEasyReadingMode = value;
      } else {
        this.view.useEasyReadingMode = false;
      }*/
      break;
    case 'enableEasyReadingList':
      // ON while already sitting on a settled board list: no settle will come,
      // so evaluate the current screen immediately (e2e applyPrefs relies on
      // this). OFF: single-exit cleanup back to native.
      if (value) {
        this.listSession.evaluateNow();
      } else {
        this.listSession.disable();
      }
      break;
    case 'antiIdleTime':
      this.antiIdleTime = value * 1000;
      break;
    case 'dbcsDetect':
      this.view.dbcsDetect = value;
      break;
    case 'enableBell':
      setBellEnabled(!!value);
      break;
    case 'lineWrap':
      // 消費端是 term_view.onTextInput 的 this.lineWrap 與 list_session.onPaste 的
      // this._view.lineWrap ——「貼上時每滿 N 欄插一個 \r」的欄寬，不是畫面寬度
      // （那是 termSize.cols）。曾經寫進 this.conn.lineWrap，但那個欄位沒有任何
      // 讀取點，且 conn 每次重連都會被換掉 ⇒ 這個 pref 整個是死的（本函式把所有
      // 錯誤都吃掉，接錯線連一聲都不會響）。守護 tests/unit/pref_line_wrap.test.js。
      this.view.lineWrap = value;
      break;
    case 'fontFace':
      var fontFace = value;
      if (!fontFace) 
        fontFace='monospace';
      this.view.setFontFace(fontFace);
      break;
    case 'bbsMargin':
      var margin = value;
      this.view.bbsViewMargin = margin;
      this.onWindowResize();
      break;
    default:
      break;
    }
  } catch(e) {
    // eats all errors
    return;
  }
};

App.prototype.checkClass = function(cn) {
  // SVG 元素（Mantine 圖示如關閉鈕的 ✕、chevron 等）的 className 是
  // SVGAnimatedString（物件、truthy，故會通過呼叫端的 `if (e.target.className)`
  // 守門）而非字串 → 直接 .indexOf 會丟 TypeError。取其 baseVal 字串。
  if (cn && typeof cn !== "string") cn = cn.baseVal || "";
  if (!cn) return false;
  return (  cn.indexOf("closeSI") >= 0  || cn.indexOf("EPbtn") >= 0 ||
      cn.indexOf("closePP") >= 0 || cn.indexOf("picturePreview") >= 0 || 
      cn.indexOf("drag") >= 0    || cn.indexOf("floatWindowClientArea") >= 0 || 
      cn.indexOf("WinBtn") >= 0  || cn.indexOf("sBtn") >= 0 || 
      cn.indexOf("nonspan") >= 0 || cn.indexOf("nomouse_command") >= 0);
};

// 圖片上傳浮層（拖曳遮罩／進度／紀錄面板）上的滑鼠事件，終端機一律不碰：它不是
// modal（終端機要能繼續打字），所以擋不住 modalShown；而滾輪是註冊在 window 的
// **capture** listener，浮層自己 stopPropagation 也攔不到 —— 少了這道，點面板的
// 「插入」會順便在 PTT 上送出一次滑鼠動作、面板裡滾動會變成 PTT 翻頁。
App.prototype._onUploadLayer = function(e) {
  return isUploadLayerTarget(e && e.target);
};

App.prototype.mouse_click = function(e) {
  if (this.modalShown)
    return;
  if (this._onUploadLayer(e))
    return;
  // AID navigation in flight: mouse-browsing must not inject keys. (The
  // initiating link click never reaches here — anchors early-return below.)
  if (this.aidNavigation.active) {
    e.preventDefault();
    return;
  }
  var skipMouseClick = (this.CmdHandler.getAttribute('SkipMouseClick') == '1');
  this.CmdHandler.setAttribute('SkipMouseClick','0');

  if (e.button == 2) { //right button
  } else if (e.button === 0) { //left button
    // 文章裡的可點擊物件一律優先，且**不受任何滑鼠 pref 影響**。順序不可調換：
    // 文章模式的第 0-6 欄現在是「點了就離開文章」，而連結與內嵌預覽圖都可能落在
    // 那幾欄裡（預覽圖甚至是整寬區塊、起點就在第 0 欄）。
    if (isAnchorTarget(e.target)) {
      return;
    }
    // 內嵌預覽（圖／影片／讀取中／載入失敗）走的是 Screen 的事件委派 onClick，
    // 不是 <a> 的子孫 ⇒ 上面那條攔不到，必須另外擋一次。
    if (isPreviewTarget(e.target)) {
      return;
    }
    if (window.getSelection().isCollapsed) { //no anything be select
      // Pusher highlight: clicking a comment row toggles a whole-row highlight of
      // all comments by that pusher. Runs regardless of mouse browsing; return
      // early to suppress browsing nav / left-button command.
      // 防誤觸開啟時**只有內容文字**算數（data-pusher-col＝該列的內容起始欄，見
      // comment_parse.annotateComment）：左邊「型別符＋id＋冒號」那一塊要留給文章的
      // 左側退出帶——它佔 cols 0-6，整列都吃掉的話那個手勢在推文區永遠點不到。
      // 欄位不合時**不 return**，讓下面的滑鼠瀏覽分支接手（＝退出文章）。
      // 屬性缺失（理論上不會，parseComment 命中就一定算得出來）⇒ 0＝整列可點，
      // 方向安全（退回改版前的行為）。
      var pusherEl = e.target && e.target.closest && e.target.closest('[data-pusher]');
      if (pusherEl) {
        var pusherColStart = this.mouseGates().misclickGuard
          ? Number(pusherEl.getAttribute('data-pusher-col')) || 0
          : 0;
        // row 在好讀長頁會被 clamp，但 col 是純幾何（mouse_geometry.colFromClientX），
        // 兩種 render 分支都可信。
        if (this.clientToPos(e.clientX, e.clientY).col >= pusherColStart) {
          this.view.togglePusherHighlight(pusherEl.getAttribute('data-pusher'));
          e.preventDefault();
          return;
        }
      }
      // List easy reading buffer/frozen render: the click is OURS — 單擊＝把選取
      // 移到那一列並開文（與原生滑鼠瀏覽同語意）。座標換算後交給 ListSession 走
      // 既有的開文交易。**永遠不要**落到下面的 useMouseBrowsing 分支：那條會依
      // server 的真實 24 列幾何直送方向鍵，虛擬視窗的座標與它並不對應（會開錯文），
      // 而且繞過 CommandQueue（違反 v5 封閉互動）。
      // preventDefault 是**無條件**的（即使滑鼠功能整組關掉）：這個模式的畫面是
      // 我們自己組的，不能讓瀏覽器預設行為或下游 handler 對它動作。pref gate 只
      // 包住「要不要真的開文」。
      if (this.buf.listRenderMode === 'buffer' || this.buf.listRenderMode === 'frozen') {
        e.preventDefault();
        if (this.mouseGates().leftClick && this.listSession) {
          var lpos = this.clientToPos(e.clientX, e.clientY);
          // 左側退出帶（cols 0..EXIT_COL_END）：與原生列表同一個手勢。**絕不直送
          // byte** —— onMouseExitClick 走 reducer 的 _beginLeave，它會先 getkeep
          // 同步 server 的真游標再送鍵（v5 封閉互動）。
          if (lpos.col >= 0 && lpos.col < EXIT_COL_END)
            this.listSession.onMouseExitClick();
          else
            this.listSession.onMouseClick(lpos.row, lpos.col);
        }
        return;
      }
      if (this.mouseGates().leftClick) {
        var doMouseCommand = true;
        if (e.target.className)
          if (this.checkClass(e.target.className))
            doMouseCommand = false;
        if (e.target.tagName)
          if(e.target.tagName.indexOf("menuitem") >= 0 )
            doMouseCommand = false;
        if (skipMouseClick) {
          doMouseCommand = false;
          var pos = this.clientToPos(e.clientX, e.clientY);
          this.buf.onMouse_move(pos.col, pos.row);
        }
        if (doMouseCommand) {
          this.onMouse_click(e);
          this.setDblclickTimer();
          e.preventDefault();
          this.setInputAreaFocus();
        }
      }
    }
  } else if (e.button == 1) { //middle button
  } else {
  }
};

// 中鍵：0=關閉 1=貼上 2=左方向鍵（值域與設定頁的 Select index 對齊）。
// 送字一律走 view._send —— 它內含 `if (this.conn)`，而 view.conn 只在 onConnect
// 被設，連線成功前直接用 this.conn.send 會炸。
App.prototype.middleMouse_down = function(e) {
  if (e.button == 1) {
    if (isAnchorTarget(e.target)) {
      return;
    }
    if (this._onUploadLayer(e)) {
      return;
    }
    var middle = this.mouseGates().middleClick;
    if (middle === 1) {
      this.doPaste();
      return false;
    } else if (middle === 2) {
      this.view._send('\x1b[D');
      return false;
    }
  }
};

App.prototype.mouse_down = function(e) {
  if (this.modalShown)
    return;
  if (this._onUploadLayer(e))
    return;
  //0=left button, 1=middle button, 2=right button
  if (e.button === 0) {
    if (this.buf.useMouseBrowsing) {
      // 350ms 內的第二下＝雙擊（或三擊）。要壓掉的只有「再送一次 PTT 指令」，
      // **不可以 preventDefault** —— mousedown 的預設行為就是瀏覽器的選取，
      // 取消它等於把原生雙擊選詞／三擊選行整組掐死（滑鼠瀏覽預設開 ⇒ 預設就壞）。
      // 同一類坑見 docs/enhanced-addon.md 踩坑 A（user-select:none）。
      // 改用既有的一次性旗標：mouse_click 開頭無條件讀取＋清空，命中時
      // doMouseCommand=false，「第二下不重複翻頁」的原意完整保住。
      // stopPropagation 也一併移除：mousedown 的兩個 listener 都掛在 window、
      // 同 target 本來就不受它影響，留著只是誤導。
      if (this.dblclickTimer) { //skip
        this.CmdHandler.setAttribute('SkipMouseClick','1');
      }
      this.setDblclickTimer();
    }
    this.mouseButtons.onMouseDown(e.button);
    //this.setInputAreaFocus();
    if (!(window.getSelection().isCollapsed))
      this.CmdHandler.setAttribute('SkipMouseClick','1');

    var onbbsarea = true;
    if (e.target.className)
      if (this.checkClass(e.target.className))
        onbbsarea = false;
    if (e.target.tagName)
      if (e.target.tagName.indexOf("menuitem") >= 0 )
        onbbsarea = false;
  } else if(e.button == 2) {
    this.mouseButtons.onMouseDown(e.button);
  }
};

App.prototype.mouse_up = function(e) {
  // Held-button state must clear even under a modal, or a right-click
  // released over a dialog leaves the wheel stuck in page-scroll mode.
  this.mouseButtons.onMouseUp(e.button);
  if (this.modalShown)
    return;
  // 讓開上傳浮層（放開按鍵的狀態自癒已在上面做完，不可以更早 return）。
  if (this._onUploadLayer(e))
    return;
  //0=left button, 1=middle button, 2=right button
  if (e.button === 0) {
    this.setMbTimer();
  }

  if (e.button === 0 || e.button == 2) { //left or right button
    if (window.getSelection().isCollapsed) { //no anything be select
      if (this.buf.useMouseBrowsing)
        this.onMouse_move(e.clientX, e.clientY);

      this.setInputAreaFocus();
      if (e.button === 0) {
        var preventDefault = true;
        if (e.target.className)
          if (this.checkClass(e.target.className))
            preventDefault = false;
        if (e.target.tagName)
          if (e.target.tagName.indexOf("menuitem") >= 0 )
            preventDefault = false;
        if (preventDefault)
          e.preventDefault();
      }
    } else { //something has be select
      if (this.copyOnSelect) {
        this.doCopy(window.getSelection().toString().replace(/\u00a0/g, " "));
      }
    }
  } else {
    this.setInputAreaFocus();
    e.preventDefault();
  }
  var _this = this;
  this.inputAreaFocusTimer = setTimer(false, function() {
    clearTimeout(_this.inputAreaFocusTimer);
    _this.inputAreaFocusTimer = null;
    if (window.getSelection().isCollapsed)
      _this.setInputAreaFocus();
  }, 10);
};

App.prototype.mouse_move = function(e) {
  if (this._onUploadLayer(e))
    return;
  if (this.buf.useMouseBrowsing) {
    if (window.getSelection().isCollapsed) {
      if(!this.mouseButtons.left)
        this.onMouse_move(e.clientX, e.clientY);
    } else
      this.resetMouseCursor();
  }

};

App.prototype.mouse_over = function(e) {
  if (this.modalShown)
    return;
  // 浮層上不可以把焦點搶回隱藏的 #t：面板裡的按鈕會失焦、面板也沒得操作。
  if (this._onUploadLayer(e))
    return;

  this.curX = e.clientX;
  this.curY = e.clientY;

  if(window.getSelection().isCollapsed && !this.mouseButtons.left)
    this.setInputAreaFocus();
};

// 滾輪。改版前有三組設定（素滾／按住右鍵／按住左鍵）× 四種動作，全部收斂成單一
// pref `mouseWheel`（0=關閉 1=上下頁）。三種畫面三種歸屬：
//   原生 24 列   → 送 PageUp/PageDown 給 server（server 端翻頁，沒有逐行的可能）
//   文章好讀     → 早退，完全交給瀏覽器原生捲動（不受 mouseWheel 影響）
//   列表好讀     → 本地視窗操作：預設**平滑捲動**（pref mouseWheelSmoothScroll），
//                 關掉才回到一次一頁
//
// 關閉時**直接 return，不 preventDefault** —— 語意是「我們完全不碰滾輪」。原生
// 24 列模式下畫面沒有可捲距離（#BBSWindow 是 fixed + overflow:hidden，.main 的
// 高度就是內容高），所以放行不會造成怪異捲動。
App.prototype.mouse_scroll = function(e) {
  // Self-heal: e.buttons is the browser's authoritative held-button state,
  // recovering any flag stuck by a mouseup we never saw.
  this.mouseButtons.syncFromButtons(e.buttons);
  if (this.modalShown)
    return;
  // 上傳紀錄面板要能自己捲動（它的清單比視窗短，但仍會超出面板高度）。
  if (this._onUploadLayer(e))
    return;
  // AID navigation in flight: no wheel-driven keys may hit the wire.
  if (this.aidNavigation.active) {
    e.preventDefault();
    return;
  }
  var gates = this.mouseGates();
  if (!gates.wheel)
    return;
  // if in easyreading, use it like webpage
  if (this.view.useEasyReadingMode && this.buf.pageState == 3) {
    return;
  }

  var up = e.deltaY < 0 || e.wheelDelta > 0;

  // List easy reading buffer/frozen render (native-parity window): 同樣是翻頁，
  // 但**在本機的視窗上執行** —— 隱藏的真游標不可以動，也不送任何 byte 給 server。
  // Frozen（開文交易進行中）整個吞掉，比照鍵盤的開文行為。
  if (this.buf.listRenderMode === 'buffer' || this.buf.listRenderMode === 'frozen') {
    if (this.buf.listRenderMode === 'buffer' && this.listSession) {
      if (gates.wheelSmoothScroll) {
        // 平滑捲動：換算成距離交給 ListSession 的緩動器（分幀吃掉＋次列位移）。
        // 座標系換算是關鍵：wheel 的像素是**螢幕上的**，而視窗較矮時整個終端機
        // 被 scaleY 縮放過（term_view.setTermFontSize）⇒ 除回去才是內容座標，
        // 那才是 ListSession/scrollTop 用的單位。漏掉就會捲太多。
        var scaleY = this.view.scaleY || 1;
        var px = wheelDeltaToPx(e, {
          lineHeight: this.view.chh * scaleY,
          pageLines: this.buf.rows - 4
        });
        if (px) this.listSession.onWheelScrollPx(px / scaleY);
      } else {
        this.listSession.onWheel(up ? 'pgup' : 'pgdn');
      }
    }
    e.stopPropagation();
    e.preventDefault();
    return;
  }

  this.setBBSCmd(up ? 'doPageUp' : 'doPageDown');

  e.stopPropagation();
  e.preventDefault();

  // 按住右鍵滾輪不再是被設定的手勢，但瀏覽器仍會在放開右鍵時發 contextmenu ⇒
  // 翻完頁還跳出選單。這個旗標是 ContextMenu/index.jsx 唯一的消費者，留著。
  if (this.mouseButtons.right) //prevent context menu popup
    this.CmdHandler.setAttribute('doDOMMouseScroll','1');
  if (this.mouseButtons.left) {
    this.CmdHandler.setAttribute('SkipMouseClick','1');
  }
};

App.prototype.setBBSCmd = function setBBSCmd(cmd) {
  switch (cmd) {
    case "doArrowUp":
      if (this.view.useEasyReadingMode && this.buf.startedEasyReading) {
        if (this.view.mainDisplay.scrollTop === 0) {
          this.easyReading.leaveCurrentPost();
          this.conn.send('\x1b[D\x1b[A\x1b[C');
        } else {
          this.view.mainDisplay.scrollTop -= this.view.chh;
        }
      } else {
        this.conn.send('\x1b[A');
      }
      break;
    case "doArrowDown":
      if (this.view.useEasyReadingMode && this.buf.startedEasyReading) {
        if (this.view.mainDisplay.scrollTop >= this.view.mainContainer.clientHeight - this.view.chh * this.buf.rows) {
          this.easyReading.leaveCurrentPost();
          this.conn.send('\x1b[B');
        } else {
          this.view.mainDisplay.scrollTop += this.view.chh;
        }
      } else {
        this.conn.send('\x1b[B');
      }
      break;
    case "doPageUp":
      if (this.view.useEasyReadingMode && this.buf.startedEasyReading) {
        this.view.mainDisplay.scrollTop -= this.view.chh * this.easyReading._turnPageLines;
      } else {
        this.conn.send('\x1b[5~');
      }
      break;
    case "doPageDown":
      if (this.view.useEasyReadingMode && this.buf.startedEasyReading) {
        this.view.mainDisplay.scrollTop += this.view.chh * this.easyReading._turnPageLines;
      } else {
        this.conn.send('\x1b[6~');
      }
      break;
    case "previousThread":
      if (this.view.useEasyReadingMode && this.buf.startedEasyReading) {
        this.easyReading.leaveCurrentPost();
        this.conn.send('[');
      } else if (this.buf.pageState==2 || this.buf.pageState==3 || this.buf.pageState==4) {
        this.conn.send('[');
      }
      break;
    case "nextThread":
      if (this.view.useEasyReadingMode && this.buf.startedEasyReading) {
        this.easyReading.leaveCurrentPost();
        this.conn.send(']');
      } else if (this.buf.pageState==2 || this.buf.pageState==3 || this.buf.pageState==4) {
        this.conn.send(']');
      }
      break;
    case "doEnter":
      if (this.view.useEasyReadingMode && this.buf.startedEasyReading) {
        if (this.view.mainDisplay.scrollTop >= this.view.mainContainer.clientHeight - this.view.chh * this.buf.rows) {
          this.easyReading.leaveCurrentPost();
          this.conn.send('\r');
        } else {
          this.view.mainDisplay.scrollTop += this.view.chh;
        }
      } else {
        this.conn.send('\r');
      }
      break;
    case "doRight":
      if (this.view.useEasyReadingMode && this.buf.startedEasyReading) {
        if (this.view.mainDisplay.scrollTop >= this.view.mainContainer.clientHeight - this.view.chh * this.buf.rows) {
          this.easyReading.leaveCurrentPost();
          this.conn.send('\x1b[C');
        } else {
          this.view.mainDisplay.scrollTop += this.view.chh * this.easyReading._turnPageLines;
        }
      } else {
        this.conn.send('\x1b[C');
      }
      break;
    default:
      break;
  }
}

App.prototype.setupContextMenus = function() {
  renderInto(
    document.getElementById('cmenuReact'),
    <MantineRoot><ContextMenu pttchrome={this} /></MantineRoot>
  );
};
