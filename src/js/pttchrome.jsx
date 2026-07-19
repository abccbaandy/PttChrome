// Main Program
import { AnsiParser } from './ansi_parser';
import { TermView } from './term_view';
import { TermBuf } from './term_buf';
import { TelnetConnection } from './telnet';
import { Websocket } from './websocket';
import { EasyReading } from './easy_reading';
import { ListSession } from './list_session';
import { CommandQueue } from './command_queue';
import { AidNavigation } from './aid_navigation';
import { AutoLogin } from './auto_login';
import { parseBlacklist, parseTitleBlacklist } from './comment_parse';
import { MouseButtonTracker } from './mouse_button_tracker';
import { i18n } from './i18n';
import { unescapeStr, b2u, parseWaterball, normalizeCopyText } from './string_util';
import { setTimer } from './util';
import PasteShortcutAlert from '../components/PasteShortcutAlert';
import ConnectionAlert from '../components/ConnectionAlert';
import ContextMenu from '../components/ContextMenu';
import { renderInto, unmountFrom } from './react_root';
import { MantineRoot } from '../components/MantineRoot';
import logoIcon from '../icon/logo.png';
import logoConnectIcon from '../icon/logo_connect.png';
import logoDisconnectIcon from '../icon/logo_disconnect.png';

function noop() {}

// True when the click landed on a link (the <a> itself or its immediate
// parent), so link clicks bypass the terminal's own mouse handling.
function isAnchorTarget(el) {
  return !!el && (el.tagName === 'A' ||
    (!!el.parentElement && el.parentElement.tagName === 'A'));
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
  this.easyReading = new EasyReading(this, this.view, this.buf);
  // List easy reading (v4): serialized machine keys + explicit state machine.
  // The queue only ever talks to the live connection; a dropped link makes the
  // send a no-op and the command dies by its own timeout (benign by design).
  this.commandQueue = new CommandQueue({
    send: (d) => {
      if (this.conn && this.conn.isConnected) this.conn.send(d);
    }
  });
  this.listSession = new ListSession(this, this.view, this.buf, this.commandQueue);
  // AID (#文章代碼) link click → serialized native-key navigation to the target
  // article. A boardless link falls back to the current article's board
  // (tracked by term_view alongside articleAuthor).
  this.aidNavigation = new AidNavigation(this, this.view, this.buf, this.commandQueue);
  this.view.onAidClick = (aid, board) => {
    this.aidNavigation.start(aid, board || this.view._articleBoard);
  };
  this.autoLogin = new AutoLogin(this);

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
    if (self.view.titleTimer) {
      self.view.titleTimer.cancel();
      self.view.titleTimer = null;
      document.title = self.connectedUrl.site;
      self.view.notif.close();
    }
  }, false);

  window.addEventListener('blur', function(e) {
    self.appFocused = false;
    // A mouseup while unfocused never reaches us — clear held-button state
    // or the wheel stays stuck in page-scroll mode until reload.
    self.mouseButtons.reset();
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

App.prototype.setInputAreaFocus = function() {
  if (this.modalShown)
    return;
  //this.DocInputArea.disabled="";
  this.inputArea.focus();
};

// FIXME: Injected when enabled. See: src/components/ContextMenu/index.js
App.prototype.onToggleLiveHelperModalState = noop;
// FIXME: Injected when enabled. See: src/components/ContextMenu/index.js
App.prototype.onDisableLiveHelperModalState = noop;

App.prototype.switchToEasyReadingMode = function(doSwitch) {
  this.debugRecorder?.log('app.switchToEasyReadingMode', { doSwitch: !!doSwitch });
  // NOTE: this resets per-post easy-reading state via leaveCurrentPost(). Callers
  // (onPrefSaveImpl, and transitively easyReading.exitEasyReading()) rely on it —
  // an easy hop to miss when tracing the exit path.
  this.easyReading.leaveCurrentPost();
  if (doSwitch) {
    this.onDisableLiveHelperModalState();
    // clear the deep cloned copy of lines
    this.buf.pageLines = [];
    if (this.buf.pageState == 3) this.view.conn.send('\x1b[D\x1b[C'); //this.view.conn.send('qr');
  } else {
    this.view.mainContainer.style.paddingBottom = '';
    this.view.lastRowIndex = 22;
    this.view.lastRowDiv.style.display = '';
    this.view.replyRowDiv.style.display = '';
    // clear the deep cloned copy of lines
    this.buf.pageLines = [];
  }
  // request the full screen
  this.view.conn.send(unescapeStr('^L'));
};

App.prototype.doCopy = function(str) {
  navigator.clipboard.writeText(normalizeCopyText(str));
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
    this.modalShown = false;
  }
  // PasteShortcutAlert 本身即 Mantine Modal（backdrop + ESC 由 Mantine 提供）；
  // × / 按鈕 / onClose 皆走 onDismiss → unmount 容器。
  renderInto(
    container,
    <MantineRoot>
      <PasteShortcutAlert opened onClose={onDismiss} />
    </MantineRoot>
  )
  this.modalShown = true;
};

App.prototype.onPasteDone = function(content) {
  //this.conn.convSend(content);
  this.view.onTextInput(content, true);
};

App.prototype.onDOMPaste = function(e) {
  let str = e.clipboardData.getData('text');
  if (str) {
    e.preventDefault();
    this.onPasteDone(str);
  }
};

App.prototype.onSymFont = function(content) {
  console.log("using " + (content ? "extension" : "system") + " font");
  var font_src = content ? 'src: url('+content.data+');' : '';
  var css = '@font-face { font-family: MingLiUNoGlyph; '+font_src+' }';
  var style = document.createElement('style');
  style.type = 'text/css';
  style.innerHTML = css;
  document.getElementsByTagName('head')[0].appendChild(style);
};

App.prototype.doSelectAll = function() {
  window.getSelection().selectAllChildren(this.view.mainDisplay);
};

App.prototype.doSearchGoogle = function(searchTerm) {
  window.open('http://google.com/search?q='+searchTerm);
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
      //this.view.conn.send('qrG');
      this.view.conn.send('\x1b[D\x1b[C\x1b[4~');
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

App.prototype.switchMouseBrowsing = function() {
  if (this.CmdHandler.getAttribute('useMouseBrowsing')=='1') {
    this.CmdHandler.setAttribute('useMouseBrowsing', '0');
    this.buf.useMouseBrowsing=false;
  } else {
    this.CmdHandler.setAttribute('useMouseBrowsing', '1');
    this.buf.useMouseBrowsing=true;
  }

  if (!this.buf.useMouseBrowsing) {
    this.buf.BBSWin.style.cursor = 'auto';
    this.buf.clearHighlight();
    this.buf.mouseCursor=0;
    this.buf.nowHighlight=-1;
    this.buf.tempMouseCol=0;
    this.buf.tempMouseRow=0;
  } else {
    this.buf.resetMousePos();
    this.view.redraw(true);
    this.view.updateCursorPos();
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

App.prototype.clientToPos = function(cX, cY) {
  var x;
  var y;
  var w = this.view.innerBounds.width;
  var h = this.view.innerBounds.height;
  if (this.view.scaleX != 1 || this.view.scaleY != 1) {
    x = cX - ((w - (this.view.chw * this.buf.cols) * this.view.scaleX) / 2);
    y = cY - ((h - (this.view.chh * this.buf.rows) * this.view.scaleY) / 2);
  } else {
    x = cX - parseFloat(this.view.firstGridOffset.left);
    y = cY - parseFloat(this.view.firstGridOffset.top);
  }
  var col = Math.floor(x / (this.view.chw * this.view.scaleX));
  var row = Math.floor(y / (this.view.chh * this.view.scaleY));

  if (row < 0)
    row = 0;
  else if (row >= this.buf.rows-1)
    row = this.buf.rows-1;

  if (col < 0)
    col = 0;
  else if (col >= this.buf.cols-1)
    col = this.buf.cols-1;

  return {col: col, row: row};
};

App.prototype.onMouse_click = function (e) {
  var cX = e.clientX, cY = e.clientY;
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

  // TODO make a responder stack.
  this.easyReading._onMouseClick(e);
  if (e.defaultPrevented)
    return;

  // TODO Move this to mouse browsing module.
  switch (this.buf.mouseCursor) {
    case 1:
      this.conn.send('\x1b[D');  //Arrow Left
      break;
    case 2:
      this.conn.send('\x1b[5~'); //Page Up
      break;
    case 3:
      this.conn.send('\x1b[6~'); //Page Down
      break;
    case 4:
      this.conn.send('\x1b[1~'); //Home
      break;
    case 5:
      this.conn.send('\x1b[4~'); //End
      break;
    case 6:
      if (this.buf.nowHighlight != -1) {
        var sendstr = '';
        if (this.buf.cur_y > this.buf.nowHighlight) {
          var count = this.buf.cur_y - this.buf.nowHighlight;
          for (var i = 0; i < count; ++i)
            sendstr += '\x1b[A'; //Arrow Up
        } else if (this.buf.cur_y < this.buf.nowHighlight) {
          var count = this.buf.nowHighlight - this.buf.cur_y;
          for (var i = 0; i < count; ++i)
            sendstr += '\x1b[B'; //Arrow Down
        }
        sendstr += '\r';
        this.conn.send(sendstr);
      }
      break;
    case 7:
      var pos = this.clientToPos(cX, cY);
      var sendstr = '';
      if (this.buf.cur_y > pos.row) {
        var count = this.buf.cur_y - pos.row;
        for (var i = 0; i < count; ++i)
          sendstr += '\x1b[A'; //Arrow Up
      } else if (this.buf.cur_y < pos.row) {
        var count = pos.row - this.buf.cur_y;
        for (var i = 0; i < count; ++i)
          sendstr += '\x1b[B'; //Arrow Down
      }
      sendstr += '\r';
      this.conn.send(sendstr);
      break;
    case 0:
      this.conn.send('\x1b[D'); //Arrow Left
      break;
    case 8:
      this.conn.send('['); //Previous post with the same title
      break;
    case 9:
      this.conn.send(']'); //Next post with the same title
      break;
    case 10:
      this.conn.send('='); //First post with the same title
      break;
    case 12:
      this.conn.send('\x1b[D\r\x1b[4~'); //Refresh post / pushed texts
      break;
    case 13:
      this.conn.send('\x1b[D\r\x1b[4~[]'); //Last post with the same title (LIST)
      break;
    case 14:
      this.conn.send('\x1b[D\x1b[4~[]\r'); //Last post with the same title (READING)
      break;
    default:
      //do nothing
      break;
  }
};

App.prototype.onMouse_move = function(cX, cY) {
  var pos = this.clientToPos(cX, cY);
  this.buf.onMouse_move(pos.col, pos.row, false);
};

App.prototype.resetMouseCursor = function(cX, cY) {
  this.buf.BBSWin.style.cursor = 'auto';
  this.buf.mouseCursor = 11;
};

App.prototype.onValuesPrefChange = function(values) {
  for (var name in values) {
    this.onPrefChange(name, values[name]);
  }

  // Enhanced Add-on: PrefModal hands us the un-stripped values (the persisted
  // copy has no password when the browser credential store is used), so cache
  // them for this session's reconnects.
  if (values.autoLogin && values.autoLoginUser && values.autoLoginPassword) {
    this.autoLogin.setSessionCredential(
      values.autoLoginUser,
      values.autoLoginPassword
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
      break;
    case 'useMouseBrowsing':
      var useMouseBrowsing = value;
      this.CmdHandler.setAttribute('useMouseBrowsing', useMouseBrowsing?'1':'0');
      this.buf.useMouseBrowsing = useMouseBrowsing;

      if (!this.buf.useMouseBrowsing) {
        this.buf.BBSWin.style.cursor = 'auto';
        this.buf.clearHighlight();
        this.buf.mouseCursor = 0;
        this.buf.nowHighlight = -1;
        this.buf.tempMouseCol = 0;
        this.buf.tempMouseRow = 0;
      }
      this.buf.resetMousePos();
      this.view.redraw(true);
      this.view.updateCursorPos();
      break;
    case 'mouseBrowsingHighlight':
      this.buf.highlightCursor = value;
      this.view.redraw(true);
      this.view.updateCursorPos();
      break;
    case 'mouseBrowsingHighlightColor':
      this.view.highlightBG = value;
      this.view.redraw(true);
      this.view.updateCursorPos();
      break;
    case 'mouseLeftFunction':
      this.view.leftButtonFunction = value;
      if (typeof(this.view.leftButtonFunction) == 'boolean') {
        this.view.leftButtonFunction = this.view.leftButtonFunction ? 1:0;
      }
      break;
    case 'mouseMiddleFunction':
      this.view.middleButtonFunction = value;
      break;
    case 'mouseWheelFunction1':
      this.view.mouseWheelFunction1 = value;
      break;
    case 'mouseWheelFunction2':
      this.view.mouseWheelFunction2 = value;
      break;
    case 'mouseWheelFunction3':
      this.view.mouseWheelFunction3 = value;
      break;
    case 'copyOnSelect':
      this.copyOnSelect = value;
      break;
    case 'endTurnsOnLiveUpdate':
      this.endTurnsOnLiveUpdate = value;
      break;
    case 'enablePicPreview':
      // TODO: move this to ImagePreview.
      this.view.enablePicPreview = value;
      break;
    case 'enableNotifications':
      this.view.enableNotifications = value;
      break;
    case 'showFloorNumbers':
      this.view.showFloorNumbers = value;
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
    case 'lineWrap':
      this.conn.lineWrap = value;
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

App.prototype.mouse_click = function(e) {
  if (this.modalShown)
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
    if (isAnchorTarget(e.target)) {
      return;
    }
    if (window.getSelection().isCollapsed) { //no anything be select
      // Pusher highlight: clicking anywhere on a comment row toggles a whole-row
      // highlight of all comments by that pusher. Runs regardless of mouse
      // browsing; return early to suppress browsing nav / left-button command.
      var pusherEl = e.target && e.target.closest && e.target.closest('[data-pusher]');
      if (pusherEl) {
        this.view.togglePusherHighlight(pusherEl.getAttribute('data-pusher'));
        e.preventDefault();
        return;
      }
      // List easy reading buffer/frozen render: swallow clicks entirely.
      // Click-selection was removed (2026-07-08, user-rejected: it moved the
      // selection without opening the article — useless). Never fall through
      // to useMouseBrowsing here: it would fire keys at the server from
      // virtual-window coordinates (violates the v5 closed-interaction rule).
      if (this.buf.listRenderMode === 'buffer' || this.buf.listRenderMode === 'frozen') {
        e.preventDefault();
        return;
      }
      if (this.buf.useMouseBrowsing) {
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
          this.buf.onMouse_move(pos.col, pos.row, true);
        }
        if (doMouseCommand) {
          this.onMouse_click(e);
          this.setDblclickTimer();
          e.preventDefault();
          this.setInputAreaFocus();
        }
      } else if (this.view.leftButtonFunction) {
        if (this.view.leftButtonFunction == 1) {
          this.setBBSCmd('doEnter', this.CmdHandler);
          e.preventDefault();
          this.setInputAreaFocus();
        } else if (this.view.leftButtonFunction == 2) {
          this.setBBSCmd('doRight', this.CmdHandler);
          e.preventDefault();
          this.setInputAreaFocus();
        }
      }
    }
  } else if (e.button == 1) { //middle button
  } else {
  }
};

App.prototype.middleMouse_down = function(e) {
  if (e.button == 1) {
    if (isAnchorTarget(e.target)) {
      return;
    }
    if (this.view.middleButtonFunction == 1) {
      this.conn.send('\r');
      return false;
    } else if (this.view.middleButtonFunction == 2) {
      this.conn.send('\x1b[D');
      return false;
    } else if (this.view.middleButtonFunction == 3) {
      this.doPaste();
      return false;
    }
  }
};

App.prototype.mouse_down = function(e) {
  if (this.modalShown)
    return;
  //0=left button, 1=middle button, 2=right button
  if (e.button === 0) {
    if (this.buf.useMouseBrowsing) {
      if (this.dblclickTimer) { //skip
        e.preventDefault();
        e.stopPropagation();
        e.cancelBubble = true;
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

  this.curX = e.clientX;
  this.curY = e.clientY;

  if(window.getSelection().isCollapsed && !this.mouseButtons.left)
    this.setInputAreaFocus();
};

App.prototype.mouse_scroll = function(e) {
  // Self-heal: e.buttons is the browser's authoritative held-button state,
  // recovering any flag stuck by a mouseup we never saw.
  this.mouseButtons.syncFromButtons(e.buttons);
  if (this.modalShown)
    return;
  // AID navigation in flight: no wheel-driven keys may hit the wire.
  if (this.aidNavigation.active) {
    e.preventDefault();
    return;
  }
  // if in easyreading, use it like webpage
  if (this.view.useEasyReadingMode && this.buf.pageState == 3) {
    return;
  }
  // List easy reading buffer/frozen render (native-parity window): the wheel
  // performs the SAME action mapping as native (plain scroll = arrow,
  // right-hold = page, left-hold = thread) but executes LOCALLY on the window
  // — the hidden real cursor must not move and no bytes go to the server.
  // Thread ops have no local meaning → ignored. Frozen (an open is in flight)
  // swallows the wheel entirely, mirroring the keyboard's opening behavior.
  if (this.buf.listRenderMode === 'buffer' || this.buf.listRenderMode === 'frozen') {
    if (this.buf.listRenderMode === 'buffer' && this.listSession) {
      var lup = e.deltaY < 0 || e.wheelDelta > 0;
      var lpref = this.mouseButtons.right
        ? this.view.mouseWheelFunction2
        : this.mouseButtons.left
          ? this.view.mouseWheelFunction3
          : this.view.mouseWheelFunction1;
      var lop = ['none', lup ? 'up' : 'down', lup ? 'pgup' : 'pgdn', 'none'][lpref] || 'none';
      if (lop !== 'none') this.listSession.onWheel(lop);
    }
    e.stopPropagation();
    e.preventDefault();
    return;
  }

  // scroll = up/down
  // hold right mouse key + scroll = page up/down
  // hold left mouse key + scroll = thread prev/next
  var mouseWheelActionsUp = [ 'none', 'doArrowUp', 'doPageUp', 'previousThread' ];
  var mouseWheelActionsDown = [ 'none', 'doArrowDown', 'doPageDown', 'nextThread' ];

  if (e.deltaY < 0 || e.wheelDelta > 0) { // scrolling up
    if (this.mouseButtons.right) {
      var action = mouseWheelActionsUp[this.view.mouseWheelFunction2];
      this.setBBSCmd(action);
    } else if (this.mouseButtons.left) {
      var action = mouseWheelActionsUp[this.view.mouseWheelFunction3];
      this.setBBSCmd(action);
    } else {
      var action = mouseWheelActionsUp[this.view.mouseWheelFunction1];
      this.setBBSCmd(action);
    }
  } else { // scrolling down
    if (this.mouseButtons.right) {
      var action = mouseWheelActionsDown[this.view.mouseWheelFunction2];
      this.setBBSCmd(action);
    } else if (this.mouseButtons.left) {
      var action = mouseWheelActionsDown[this.view.mouseWheelFunction3];
      this.setBBSCmd(action);
    } else {
      var action = mouseWheelActionsDown[this.view.mouseWheelFunction1];
      this.setBBSCmd(action);
    }
  }
  

  e.stopPropagation();
  e.preventDefault();

  if (this.mouseButtons.right) //prevent context menu popup
    this.CmdHandler.setAttribute('doDOMMouseScroll','1');
  if (this.mouseButtons.left) {
    if (this.buf.useMouseBrowsing) {
      this.CmdHandler.setAttribute('SkipMouseClick','1');
    }
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
