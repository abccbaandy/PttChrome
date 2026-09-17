// Handle Telnet Connections according to RFC 854

import { Event } from './event';
import { u2b, ansiHalfColorConv } from './string_util';
import { VK_NORMAL, guardEscSequence } from './vtkbd_send_state';

// 真鍵盤／IME 路徑的守門模式（見 sendUserKey）。模組層常數，省得每次送鍵配一個物件。
const USER_KEY = { userKey: true };

// Telnet commands
const SE = '\xf0';
const NOP = '\xf1';
const DATA_MARK = '\xf2';
const BREAK = '\xf3';
const INTERRUPT_PROCESS = '\xf4';
const ABORT_OUTPUT = '\xf5';
const ARE_YOU_THERE = '\xf6';
const ERASE_CHARACTER = '\xf7';
const ERASE_LINE = '\xf8';
const GO_AHEAD  = '\xf9';
const SB = '\xfa';

// Option commands
const WILL  = '\xfb';
const WONT  = '\xfc';
const DO = '\xfd';
const DONT = '\xfe';
const IAC = '\xff';

// Telnet options
const ECHO  = '\x01';
const SUPRESS_GO_AHEAD = '\x03';
const TERM_TYPE = '\x18';
const IS = '\x00';
const SEND = '\x01';
const NAWS = '\x1f';

// state
const STATE_DATA=0;
const STATE_IAC=1;
const STATE_WILL=2;
const STATE_WONT=3;
const STATE_DO=4;
const STATE_DONT=5;
const STATE_SB=6;

export function TelnetConnection(socket) {
  this.socket = socket;
  this.socket.addEventListener('open', this._onOpen.bind(this));
  this.socket.addEventListener('data', this._onDataAvailable.bind(this));
  this.socket.addEventListener('close', this._onClose.bind(this));

  this.state = STATE_DATA;
  this.iac_sb = '';

  // server 端 vtkbd 的按鍵解析狀態（我們送了什麼就推算成什麼）。每條連線各自一份，
  // 重連自然重置。用途見 vtkbd_send_state.js 檔頭。
  this._vkState = VK_NORMAL;
  // 上一次送出**之前**的狀態，只給 debug recorder 讀（見 _sendEscaped）。
  this._vkStatePrev = VK_NORMAL;

  this.termType = 'VT100';
}

Event.mixin(TelnetConnection.prototype);

TelnetConnection.prototype._onOpen = function(e) {
  this.dispatchEvent(new CustomEvent('open'));
};

TelnetConnection.prototype._onClose = function(e) {
  this.dispatchEvent(new CustomEvent('close'));
};

TelnetConnection.prototype._onDataAvailable = function(e) {
  var str = e.detail.data;
  var data='';
  var count = str.length;
  while (count > 0) {
    var s = str;
    count -= s.length;
    var n = s.length;
    for (var i = 0; i < n; ++i) {
      var ch = s[i];
      switch (this.state) {
      case STATE_DATA:
        if( ch == IAC ) {
          if (data) {
            this._dispatchData(data);
            data='';
          }
          this.state = STATE_IAC;
        } else {
          data += ch;
        }
        break;
      case STATE_IAC:
        switch (ch) {
        // RFC 854：資料流裡的 0xFF 由對方加倍送出，收到 IAC IAC 就是「一個
        // 0xFF 資料位元組」。舊碼掉進 default 把它當未知命令吃掉，於是那個
        // byte 會靜默消失（PTT 是 Big5、不含 0xFF，所以一直沒症狀，但送出端
        // 現在會跳脫 → 接收端必須對稱）。
        case IAC:
          data += IAC;
          this.state = STATE_DATA;
          break;
        case WILL:
          this.state=STATE_WILL;
          break;
        case WONT:
          this.state=STATE_WONT;
          break;
        case DO:
          this.state=STATE_DO;
          break;
        case DONT:
          this.state=STATE_DONT;
          break;
        case SB:
          this.state=STATE_SB;
          break;
        default:
          this.state=STATE_DATA;
        }
        break;
      case STATE_WILL:
        switch (ch) {
        case ECHO:
        case SUPRESS_GO_AHEAD:
          this._sendRaw( IAC + DO + ch );
          break;
        default:
          this._sendRaw( IAC + DONT + ch );
        }
        this.state = STATE_DATA;
        break;
      case STATE_DO:
        switch (ch) {
        case TERM_TYPE:
          this._sendRaw( IAC + WILL + ch );
          break;
        case NAWS:
          this.dispatchEvent(new CustomEvent('doNaws'));
          break;
        default:
          this._sendRaw( IAC + WONT + ch );
        }
        this.state = STATE_DATA;
        break;
      case STATE_DONT:
      case STATE_WONT:
        this.state = STATE_DATA;
        break;
      case STATE_SB: // sub negotiation
        this.iac_sb += ch;
        if ( this.iac_sb.slice(-2) == IAC + SE ) {
          // end of sub negotiation
          switch (this.iac_sb[0]) {
          case TERM_TYPE:
            // 固定回報建構時設的 termType（'VT100'）。上游在這裡留過一條
            // 「支援其他終端機類型」的 FIXME 與一行 this.app.__prefs__.TermType，
            // 但那個 pref 從來不存在，而 PTT 只吃 VT100 ⇒ 沒有第二種值要回報。
            var rep = IAC + SB + TERM_TYPE + IS + this.termType + IAC + SE;
            this._sendRaw( rep );
            break;
          }
          this.state = STATE_DATA;
          this.iac_sb = '';
          break;
        }
      }
    }
    if (data) {
      this._dispatchData(data);
      data='';
    }
  }
};

TelnetConnection.prototype._dispatchData = function(data) {
  this.dispatchEvent(new CustomEvent('data', {
    detail: {
      data: data
    }
  }));
};

// 機器送出（CommandQueue／App.setBBSCmd／anti-idle／App.sendData）：懸空的 ESC 態
// 一律化解。ESC 組合鍵的保護只留給 sendUserKey/convSendUserKey ——
// 界線是**送出入口**，不是位元組內容，完整推導見 vtkbd_send_state.js 檔頭。
TelnetConnection.prototype.send = function(str) {
  this._sendEscaped(str);
};

// 真鍵盤／IME 專用（**只有 term_view._send / _convSend 可以叫**，守護
// tests/unit/user_key_send_wiring.test.js）：保留使用者的 ESC 組合鍵。
TelnetConnection.prototype.sendUserKey = function(str) {
  this._sendEscaped(str, USER_KEY);
};

TelnetConnection.prototype.convSendUserKey = function(unicode_str) {
  this._convSendEscaped(unicode_str, USER_KEY);
};

// 資料路徑專用（send / convSend）：RFC 854 要求資料流裡的 0xFF 加倍，否則
// server 會把它當命令起頭並吃掉後面的位元組。可觸發的來源是 string_util.u2b
// —— 轉不出 Big5 的字元（emoji 最常見）回 '\xFF\xFD'，而貼上／輸入一路走
// term_view.onTextInput → _convSend → convSend。
//
// **協商路徑不可以走這裡**：IAC DO/WILL/SB… 的 0xFF 本來就是命令，加倍會讓
// server 讀成資料。那些一律直接用 _sendRaw。
//
// 這裡同時是「裸 ESC 守門」的唯一掛點：send/convSend 都收斂到這裡，而協商位元組
// 被 server 的 telnet 層吃掉、進不了 vtkbd ⇒ _sendRaw 不該套。**守門要在 IAC 加倍
// 之前**：vtkbd 看到的是解 IAC 之後的資料流。理由見 vtkbd_send_state.js 檔頭。
TelnetConnection.prototype._sendEscaped = function(str, opts) {
  if (!str) return;
  const guarded = guardEscSequence(this._vkState, str, opts);
  // 送出**之前**的狀態：debug recorder 要錄的是這個（send 那一列的 snapshotState
  // 在 _sendRaw 裡才跑，那時 _vkState 已經被下一行覆寫）。要證實「這個鍵有沒有被
  // 懸空的 ESC 吃掉」看的就是它。
  this._vkStatePrev = this._vkState;
  this._vkState = guarded.state;
  const data = guarded.data;
  this._sendRaw(data.indexOf(IAC) < 0 ? data : data.split(IAC).join(IAC + IAC));
};

TelnetConnection.prototype._sendRaw = function(data) {
  if (data) {
    this.socket.send(data);
  }
}

TelnetConnection.prototype.convSend = function(unicode_str) {
  this._convSendEscaped(unicode_str);
};

TelnetConnection.prototype._convSendEscaped = function(unicode_str, opts) {
  // supports UAO
  // when converting unicode to big5, use UAO.

  var s = u2b(unicode_str);
  // detect ;50m (half color) and then convert accordingly
  if (s) {
    s = ansiHalfColorConv(s);
    // u2b 對非 Big5 字元回 '\xFF\xFD' ⇒ 這條路徑最常帶 IAC，必須跳脫。
    this._sendEscaped(s, opts);
  }
};

TelnetConnection.prototype.sendWillNaws = function(cols, rows) {
  this._sendRaw(IAC + WILL + NAWS);
};

TelnetConnection.prototype.sendNaws = function(cols, rows) {
  var nawsStr = String.fromCharCode(Math.floor(cols/256), cols%256, Math.floor(rows/256), rows%256).replace(/(\xff)/g,'\xff\xff');
  var rep = IAC + SB + NAWS + nawsStr + IAC + SE;
  this._sendRaw( rep );
};
