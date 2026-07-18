// Terminal Screen Buffer, displayed by TermView

import { Event } from './event';
import { ColorState } from './term_ui';
import { u2b, b2u, parseStatusRow, parseListRow } from './string_util';
import { cjkUrlExtension } from './url_cjk';
import cursorBack from '../cursor/back.png';
import cursorPageUp from '../cursor/pageup.png';
import cursorPageDown from '../cursor/pagedown.png';
import cursorHome from '../cursor/home.png';
import cursorEnd from '../cursor/end.png';
import cursorPrevious from '../cursor/prevous.png';
import cursorNext from '../cursor/next.png';
import cursorFirst from '../cursor/first.png';
import cursorRefresh from '../cursor/refresh.png';
import cursorLast from '../cursor/last.png';

// Quiet period (ms) after the last redraw window before pageState is promoted to
// `settledPageState`. Must exceed the 30ms notify debounce so a transient
// half-painted frame (empty last row → pageState 0) re-arms the timer instead of
// settling: while data keeps arriving every ~30ms the timer never fires, so it
// only captures the final stable value once PTT stops sending. See
// docs/easy-reading.md (settle 後判斷). Tunable; raise if slow links premature-settle.
const SETTLE_MS = 50;

const termColors = [
  // dark
  '#000000', // black
  '#800000', // red
  '#008000', // green
  '#808000', // yellow
  '#000080', // blue
  '#800080', // magenta
  '#008080', // cyan
  '#c0c0c0', // light gray
  // bright
  '#808080', // gray
  '#ff0000', // red
  '#00ff00', // green
  '#ffff00', // yellow
  '#0000ff', // blue
  '#ff00ff', // magenta
  '#00ffff', // cyan
  '#ffffff'  // white
];

export const termInvColors = [
  // dark
  '#FFFFFF', // black
  '#7FFFFF', // red
  '#FF7FFF', // green
  '#7F7FFF', // yellow
  '#FFFF7F', // blue
  '#7FFF7F', // magenta
  '#FF7F7F', // cyan
  '#3F3F3F', // light gray
  // bright
  '#7F7F7F', // gray
  '#00FFFF', // red
  '#FF00FF', // green
  '#0000FF', // yellow
  '#FFFF00', // blue
  '#00FF00', // magenta
  '#FF0000', // cyan
  '#000000'  // white
];

const mouseCursorMap = [
  'auto',                                               // 0
  `url(${cursorBack} 0 6,auto`,      // 1
  `url(${cursorPageUp} 6 0,auto`,    // 2
  `url(${cursorPageDown} 6 21,auto`, // 3
  `url(${cursorHome} 0 0,auto`,      // 4
  `url(${cursorEnd} 0 0,auto`,       // 5
  'pointer',                         // 6
  'default',                         // 7
  `url(${cursorPrevious} 6 0,auto`,  // 8
  `url(${cursorNext} 6 0,auto`,      // 9
  `url(${cursorFirst} 0 0,auto`,     // 10
  'auto',                            // 11
  `url(${cursorRefresh} 0 0,auto`,   // 12
  `url(${cursorLast} 0 0,auto`,      // 13
  `url(${cursorLast} 0 0,auto`       // 14
];

function TermChar(ch) {
  this.ch = ch;
  this.resetAttr();
  this.needUpdate = false;
  this.isLeadByte = false;
  this.startOfURL = false;
  this.endOfURL = false;
  this.partOfURL = false;
  this.partOfKeyWord = false;
  this.keyWordColor = '#ff0000';
  this.fullurl = '';
}

// static variable for all TermChar objects
TermChar.defaultFg = 7;
TermChar.defaultBg = 0;

TermChar.prototype = {

  assignParams: function(params) {
    params.forEach(v => {    
      switch (v) {
      case 0: // reset
        this.resetAttr();
        break;
      case 1: // bright
        this.bright=true;
        break;
      case 4:
        this.underLine=true;
        break;
      case 5: // blink
      case 6:
        this.blink=true;
        break;
      case 7: // invert
        this.invert=true;
        break;
      case 8:
        // invisible is not supported
        break;
      /*
      case 22: // normal, or not bright
        this.bright=false;
        break;
      case 24: // not underlined
        this.underLine=false;
        break;
      case 25: // steady, or not blink
        this.blink=false;
        break;
      case 27: // positive, or not invert
        this.invert=false;
        break;
      */
      default:
        if (v <= 37) {
          if (v >= 30) { // fg
            this.fg = v - 30;
          }
        } else if (v >= 40) {
          if (v<=47) { //bg
            this.bg = v - 40;
          }
        }
        break;
      }
    })
  },

  copyFromNewChar: function() {
    this.ch = TermChar.newChar.ch;
    this.isLeadByte = TermChar.newChar.isLeadByte;
    this.resetAttr();
  },

  copyAttr: function(attr) {
    this.fg = attr.fg;
    this.bg = attr.bg;
    this.bright = attr.bright;
    this.invert = attr.invert;
    this.blink = attr.blink;
    this.underLine = attr.underLine;
  },

  resetAttr: function() {
    this.fg = 7;
    this.bg = 0;
    this.bright = false;
    this.invert = false;
    this.blink = false;
    this.underLine = false;
  },
  
  getFg: function() {
    if (this.invert)
      return this.bright ? (this.bg + 8) : this.bg;
    return this.bright ? (this.fg + 8) : this.fg;
  },

  getBg: function() {
    return this.invert ? this.fg : this.bg;
  },

  getColor: function() {
    return new ColorState(this.getFg(), this.getBg(), this.blink);
  },

  isUnderLine: function() {
    return this.underLine;
  },

  isStartOfURL : function() {
    return this.startOfURL;
  },

  isEndOfURL : function() {
    return this.endOfURL;
  },

  isPartOfURL : function() {
    return this.partOfURL;
  },

  isPartOfKeyWord : function() {
    return this.partOfKeyWord;
  },

  getKeyWordColor : function() {
    return this.keyWordColor;
  },

  getFullURL: function() {
    return this.fullurl;
  }
};

TermChar.newChar = new TermChar(' ')

export function TermBuf(cols, rows) {
  this.cols = cols;
  this.rows = rows;
  this.view = null;
  this.cur_x = 0;
  this.cur_y = 0;
  this.cur_x_sav = -1;
  this.cur_y_sav = -1;
  this.scrollStart = 0;
  this.scrollEnd = rows-1;
  this._nowHighlight = -1;
  Object.defineProperty(this, 'nowHighlight', {
    set: this.setHighlight.bind(this),
    get: function() { return this._nowHighlight; }.bind(this)
  });
  this.tempMouseCol = 0;
  this.tempMouseRow = 0;
  this.mouseCursor = 0;
  this.highlightCursor = true;
  this.useMouseBrowsing = true;
  //this.scrollingTop=0;
  //this.scrollingBottom=23;
  this.attr = new TermChar(' ');
  this.disableLinefeed = false;
  this.altScreen = '';
  this.changed = false;
  this.posChanged = false;
  this.pageState = 0;
  this.forceFullWidth = false;

  this.startedEasyReading = false;
  this.easyReadingShowReplyText = false;
  this.easyReadingShowPushInitText = false;
  this.prevPageState = 0;
  // Debounced pageState: updated only once the screen has been quiet for
  // SETTLE_MS, so transient half-painted frames never pollute it. EasyReading's
  // auto re-enable keys off the clean 2 (list) -> 3 (article) settled transition.
  this.settledPageState = 0;
  this.prevSettledPageState = 0;
  this._settleTimer = null;

  this.lines = new Array(rows);

  this.pageLines = [];

  this.lineChangeds = new Array(rows);

  // Per-settle-window accumulation of the rows the SERVER wrote (puts/clear/
  // erase/scroll — see _touchRows call sites), frozen into settleSnapshot when
  // the settle timer fires (_armSettleTimer). Deliberately NOT derived from
  // lineChangeds/needUpdate: those flags are never cleared per window (needUpdate
  // is sticky, updateCharAttr re-marks every ever-touched row on each notify), so
  // they cannot tell "this response's dirty rows" apart — which is exactly what
  // list-session burst classification needs. Local forced repaints
  // (lineChangeds.fill(true)) never feed it either.
  this._settleChangedRows = new Set();
  this.settleSnapshot = null;
  // True iff the SERVER produced activity (content write or cursor escape) since
  // the settle timer was last (re-)armed. notify() re-arms the timer only when
  // this is set: purely LOCAL repaints (list easy reading's _forceRedraw on every
  // held-down nav key ~30ms apart) must not keep postponing a pending settle, or
  // the CommandQueue expects starve and prefetch wedges while a key is held.
  this._serverActivity = false;
  // True iff a server cursor escape moved the cursor during the current settle
  // window. Frozen into settleSnapshot.cursorMoved: a response whose content
  // window and final cursor-park window straddle a >SETTLE_MS gap settles
  // TWICE, and the second (cursor-only, zero content rows) settle must still
  // reach the ListSession/CommandQueue — its screen is the complete response.
  this._settleCursorMoved = false;

  this.viewBufferTimer = 30;

  while (--rows >= 0) {
    var line = new Array(cols);
    var c = cols;
    while (--c >= 0) {
      line[c] = new TermChar(' ');
    }
    this.lines[rows] = line;
    //this.keyWordLine[rows]=false;
  }
  this.BBSWin = document.getElementById('BBSWindow');
}

TermBuf.prototype = {

  resize: function(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.lineChangeds.length = rows;
    this.scrollEnd = rows - 1;
    this.lines.length = rows;
    for (let r = 0; r < rows; r++) {
      if (!this.lines[r]) {
        this.lines[r] = new Array(cols);
      }
      this.lines[r].length = cols;
      for (let c = 0; c < cols; c++){
        if (!this.lines[r][c]) {
          this.lines[r][c] = new TermChar(' ');
        }
      }
    }
  },

  timerUpdate: null,

  uriRegEx: /((ftp|http|https|telnet):\/\/([A-Za-z0-9_]+:{0,1}[A-Za-z0-9_]*@)?([A-Za-z0-9_#!:.?+=&%@!\-\/\$\^,;|*~'()]+)(:[0-9]+)?(\/|\/([A-Za-z0-9_#!:.?+=&%@!\-\/]))?)|(pid:\/\/(\d{1,10}))/ig,

  setView: function(view) {
    this.view = view;
  },

  assignParamsToAttrs: function(params) {
    this.attr.assignParams(params)
  },

  puts: function(str) {
    if (!str)
      return;
    var cols = this.cols;
    var rows = this.rows;
    var lines = this.lines;
    var n = str.length;
    var line = lines[this.cur_y];
    for (var i = 0; i < n; ++i) {
      var ch = str[i];
      switch (ch) {
      case '\x07':
        // FIXME: beep (1)Sound (2)AlertNotification (3)change icon
        // should only play sound
        continue;
      case '\b':
        this.back();
        continue;
      case '\r':
        this.carriageReturn();
        continue;
      case '\n':
      case '\f':
      case '\v':
        this.lineFeed();
        line = lines[this.cur_y];
        continue;
      case '\0':
          continue;
      }
      //if( ch < ' ')
      //    //dump('Unhandled invisible char' + ch.charCodeAt(0)+ '\n');

      if (this.cur_x >= cols) {
        // next line
        if(!this.disableLinefeed) this.lineFeed();
        this.cur_x=0;
        line = lines[this.cur_y];
        this.posChanged=true;
      }

      switch (ch) {
      case '\t':
        this.tab();
        break;
      default:
        var ch2 = line[this.cur_x];
        ch2.ch=ch;
        ch2.copyAttr(this.attr);
        ch2.needUpdate=true;
        ++this.cur_x;
        if (ch2.isLeadByte) // previous state before this function
          line[this.cur_x].needUpdate=true;
        if (this.view.charset == 'UTF-8' && this.isFullWidth(ch) && this.cur_x < cols) {
          ch2 = line[this.cur_x];
          ch2.ch = '';
          ch2.copyAttr(this.attr);
          ch2.needUpdate = true;
          ++this.cur_x;
          // assume server will handle mouse moving on full-width char
        }
        this._touchRows(this.cur_y, this.cur_y);
        this.changed = true;
        this.posChanged = true;
      }
    }
    this.queueUpdate();
  },

  updateCharAttr: function() {
    var cols = this.cols;
    var rows = this.rows;
    var lines = this.lines;
    for (var row = 0; row < rows; ++row) {
      var line = lines[row];
      var needUpdate = false;
      for (var col = 0; col < cols; ++col) {
        var ch = line[col];
        if (ch.needUpdate)
            needUpdate=true;
        // all chars > ASCII code are regarded as lead byte of DBCS.
        // FIXME: this is not correct, but works most of the times.
        if ( this.isFullWidth(ch.ch) && (col + 1) < cols ) {
          ch.isLeadByte = true;
          ++col;
          var ch0 = ch;
          ch = line[col];
          if (ch.needUpdate)
            needUpdate = true;
          // ensure simutaneous redraw of both bytes
          if ( ch0.needUpdate != ch.needUpdate ) {
            ch0.needUpdate = ch.needUpdate = true;
          }
        } else if (ch.isleadbyte && (col+1) < cols) {
          var ch2 = line[col+1];
          ch2.needUpdate = true;
        }
        ch.isLeadByte = false;
      }

      if (needUpdate) { // this line has been changed
        this.lineChangeds[row] = true;
        // perform URI detection again
        // remove all previously cached uri positions
        if (line.uris) {
          var uris = line.uris;
          var nuris = uris.length;

          // FIXME: this is inefficient
          for (var iuri = 0; iuri < nuris; ++iuri) {
            var uri = uris[iuri];
            line[uri[0]].startOfURL = false;
            line[uri[0]].endOfURL = false;
            line[uri[0]].fullurl = '';
            line[uri[1]-1].startOfURL = false;
            line[uri[1]-1].endOfURL = false;
            line[uri[1]-1].fullurl = '';
            for (var col=uri[0]; col < uri[1]; ++col) {
              line[col].partOfURL = false;
              line[col].needUpdate = true;
            }
          }
          line.uris=null;
        }
        var s = '';
        for (var col = 0; col < cols; ++col)
            s += line[col].ch;
        if (this.view.charset != 'UTF-8')
          s = s.replace(/[^\x00-\x7f]./g,'\xab\xcd');
        else {
          var str = '';
          for (var i = 0; i < s.length; ++i) {
            str += s.charAt(i);
            if (this.isFullWidth(s.charAt(i)))
              str += s.charAt(i);
          }
          s = str;
        }
        var res;
        var uris = null;
        // pairs of URI start and end positions are stored in line.uri.
        while ( (res = this.uriRegEx.exec(s)) !== null ) {
          if (!uris)   uris = [];
          var uriEnd = res.index + res[0].length;
          var cjkExt = '';
          // CJK path extension (Big5 branch only: non-ASCII byte pairs were
          // replaced by \xab\xcd above, so uriRegEx always stops right before
          // a Chinese char — e.g. /wiki/戈黛娃夫人). Decode the raw tail and
          // let url_cjk.js decide how far the URL really extends.
          if (this.view.charset != 'UTF-8' && s.substr(uriEnd, 2) === '\xab\xcd') {
            var rawTail = '';
            for (var tc = uriEnd; tc < cols; ++tc)
              rawTail += line[tc].ch;
            cjkExt = cjkUrlExtension(s.charAt(uriEnd - 1), b2u(rawTail));
            if (cjkExt)
              uriEnd += u2b(cjkExt).length; // byte count == column count
          }
          var uri = [res.index, uriEnd, cjkExt];
          uris.push(uri);
          // dump('found URI: ' + res[0] + '\n');
        }

        if (uris) {
          line.uris = uris;
          // dump(line.uris.length + "uris found\n");
        }
        //
        if (line.uris) {
          var uris = line.uris;
          var nuris = uris.length;
          for (var iuri = 0; iuri < nuris; ++iuri) {
            var uri = uris[iuri];
            var urlTemp = '';

            for (var col = uri[0]; col < uri[1]; ++col) {
              urlTemp += line[col].ch;
              line[col].partOfURL = true;
              line[col].needUpdate = true; //fix link bug
            }
            var u;
            if (this.view.charset != 'UTF-8')
              u = urlTemp;//this.conv.convertStringToUTF8(urlTemp, this.view.charset,  true);
            else {
              var str = '';
              for (var i = 0; i < urlTemp.length; ++i) {
                str += urlTemp.charAt(i);
                if (this.isFullWidth(urlTemp.charAt(i)))
                  str += urlTemp.charAt(i);
              }
              u = str;
            }
            var urlTemp2 = urlTemp.toLowerCase();
            line[uri[0]].startOfURL = true;
            if (urlTemp2.substr(0,6) == 'pid://') {
              line[uri[0]].fullurl='http://www.pixiv.net/member_illust.php?mode=big&illust_id='+urlTemp2.substr(6,15);
            } else {
              // CJK extension: urlTemp's tail is raw Big5 bytes — swap it for
              // the percent-encoded Unicode form so the link actually opens.
              if (uri[2])
                u = urlTemp.slice(0, urlTemp.length - u2b(uri[2]).length) +
                    encodeURI(uri[2]);
              line[uri[0]].fullurl = u;
            }
            line[uri[1]-1].endOfURL = true;
            //line[uri[1]-1].needUpdate = true; //fix link bug, some wee need update 2 byte(this byte and prevous byte)
            //for (var col = uri[0]; col < uri[1]; ++col)
            //  line[col].fullurl = g;
          }
        }
        //
      }
    }
  },

  clear: function(param) {
    var rows = this.rows;
    var cols = this.cols;
    var lines = this.lines;

    switch (param) {
    case 0:
      this._touchRows(this.cur_y, this.rows - 1);
      var line = lines[this.cur_y];
      var col, row;
      for (col = this.cur_x; col < cols; ++col) {
        line[col].copyFromNewChar();
        line[col].needUpdate = true;
      }
      for (row = this.cur_y; row < rows; ++row) {
        line = lines[row];
        for (col = 0; col < cols; ++col) {
          line[col].copyFromNewChar();
          line[col].needUpdate = true;
        }
      }
      break;
    case 1:
      this._touchRows(0, this.cur_y);
      var line;
      var col, row;
      for (row = 0; row < this.cur_y; ++row) {
        line = lines[row];
        for (col = 0; col < cols; ++col) {
          line[col].copyFromNewChar();
          line[col].needUpdate = true;
        }
      }
      line = lines[this.cur_y];
      for (col = 0; col < this.cur_x; ++col) {
        line[col].copyFromNewChar();
        line[col].needUpdate = true;
      }
      break;
    case 2:
      this._touchRows(0, this.rows - 1);
      while (--rows >= 0) {
        var col = cols;
        var line = lines[rows];
        while (--col >= 0) {
          line[col].copyFromNewChar();
          line[col].needUpdate = true;
        }
      }
      break;
    }
    this.changed = true;
    this.gotoPos(0, 0);
    this.queueUpdate();
  },

  back: function() {
    if (this.cur_x > 0) {
      --this.cur_x;
      this.posChanged = true;
      this.queueUpdate();
    }
  },

  tab: function(param) {
    var mod = this.cur_x % 4;
    this.cur_x += 4 - mod;
    if (param > 1) this.cur_x += 4 * (param-1);
    if (this.cur_x >= this.cols)
      this.cur_x = this.cols-1;
    this.posChanged = true;
    this.queueUpdate();
  },

  backTab: function(param) {
    var mod = this.cur_x % 4;
    this.cur_x -= (mod > 0 ? mod : 4);
    if (param > 1) this.cur_x -= 4 * (param-1);
    if (this.cur_x < 0)
      this.cur_x = 0;
    this.posChanged = true;
    this.queueUpdate();
  },

  insert: function(param) {
    var line = this.lines[this.cur_y];
    var cols = this.cols;
    var cur_x = this.cur_x;
    if (cur_x > 0 && line[cur_x-1].isLeadByte) ++cur_x;
    if (cur_x == cols) return;
    if (cur_x + param >= cols) {
      for(var col = cur_x; col < cols; ++col) {
        line[col].copyFromNewChar();
        line[col].needUpdate = true;
      }
    } else {
      while (--param >= 0) {
        var ch = line.pop();
        line.splice(cur_x, 0, ch);
        ch.copyFromNewChar();
      }
      for (var col = cur_x; col < cols; ++col)
        line[col].needUpdate = true;
    }
    this._touchRows(this.cur_y, this.cur_y);
    this.changed = true;
    this.queueUpdate();
  },

  del: function(param) {
    var line = this.lines[this.cur_y];
    var cols = this.cols;
    var cur_x = this.cur_x;
    if (cur_x > 0 && line[cur_x-1].isLeadByte) ++cur_x;
    if (cur_x == cols) return;
    if (cur_x + param >= cols) {
      for (var col = cur_x; col < cols; ++col) {
        line[col].copyFromNewChar();
        line[col].needUpdate = true;
      }
    } else {
      var n = cols - cur_x - param;
      while (--n >= 0)
        line.splice(cur_x, 0, line.pop());
      for (var col = cols - param; col < cols; ++col)
        line[col].copyFromNewChar();
      for (var col = cur_x; col < cols; ++col)
        line[col].needUpdate = true;
    }
    this._touchRows(this.cur_y, this.cur_y);
    this.changed = true;
    this.queueUpdate();
  },

  eraseChar: function(param) {
    var line = this.lines[this.cur_y];
    var cols = this.cols;
    var cur_x = this.cur_x;
    if (cur_x > 0 && line[cur_x-1].isLeadByte) ++cur_x;
    if (cur_x == cols) return;
    var n = (cur_x + param > cols) ? cols : cur_x + param;
    for (var col = cur_x; col < n; ++col) {
      line[col].copyFromNewChar();
      line[col].needUpdate = true;
    }
    this._touchRows(this.cur_y, this.cur_y);
    this.changed = true;
    this.queueUpdate();
  },

  eraseLine: function(param) {
    var line = this.lines[this.cur_y];
    var cols = this.cols;
    switch (param) {
    case 0: // erase to rigth
      for (var col = this.cur_x; col < cols; ++col) {
        line[col].copyFromNewChar();
        line[col].needUpdate = true;
      }
      break;
    case 1: //erase to left
      var cur_x = this.cur_x;
      for (var col = 0; col < cur_x; ++col) {
        line[col].copyFromNewChar();
        line[col].needUpdate=true;
      }
      break;
    case 2: //erase all
      for (var col = 0; col < cols; ++col) {
        line[col].copyFromNewChar();
        line[col].needUpdate = true;
      }
      break;
    default:
      return;
    }
    this._touchRows(this.cur_y, this.cur_y);
    this.changed = true;
    this.queueUpdate();
  },

  deleteLine: function(param) {
    var scrollStart = this.scrollStart;
    this.scrollStart = this.cur_y;
    this.scroll(false, param);
    this.scrollStart = scrollStart;
    this.changed = true;
    this.queueUpdate();
  },

  insertLine: function(param) {
    var scrollStart = this.scrollStart;
    if (this.cur_y < this.scrollEnd) {
      this.scrollStart=this.cur_y;
      this.scroll(true, param);
    }
    this.scrollStart = scrollStart;
    this.changed = true;
    this.queueUpdate();
  },

  scroll: function(up, n) {
    var scrollStart=this.scrollStart;
    var scrollEnd=this.scrollEnd;
    if(scrollEnd<=scrollStart) {
      scrollStart=0;
      if(scrollEnd<1) scrollEnd=this.rows-1;
    }
    if(n>=this.rows) // scroll more than 1 page = clear
      this.clear(2);
    else if(n >= scrollEnd-scrollStart+1) {
      var lines = this.lines;
      var cols = this.cols;
      for(var row=scrollStart; row <= scrollEnd; ++row) {
        for(var col=0; col< cols; ++col) {
          lines[row][col].copyFromNewChar();
          lines[row][col].needUpdate=true;
        }
      }
    } else {
      var lines = this.lines;
      var rows = this.rows;
      var cols = this.cols;

      if (up) { // move lines down
        for (var i = 0; i < rows-1-scrollEnd; ++i)
          lines.unshift(lines.pop());
        while (--n >= 0) {
          var line = lines.pop();
          lines.splice(rows-1-scrollEnd+scrollStart, 0, line);
          for (var col = 0; col < cols; ++col)
            line[col].copyFromNewChar();
        }
        for (var i = 0; i < rows-1-scrollEnd; ++i)
          lines.push(lines.shift());
      } else { // move lines up
        for (var i = 0; i < scrollStart; ++i)
          lines.push(lines.shift());
        while (--n >= 0) {
          var line = lines.shift();
          lines.splice(scrollEnd-scrollStart, 0, line);
          for (var col = 0; col < cols; ++col) // clear the line
            line[col].copyFromNewChar();
        }
        for (var i = 0; i < scrollStart; ++i)
          lines.unshift(lines.pop());
      }

      // update the whole screen within scroll region
      for (var row = scrollStart; row <= scrollEnd; ++row) {
        var line = lines[row];
        for (var col = 0; col < cols; ++col) {
          line[col].needUpdate = true;
        }
      }
    }
    this._touchRows(scrollStart, scrollEnd);
    this.changed = true;
    this.queueUpdate();
  },

  gotoPos: function(x,y) {
    // dump('gotoPos: ' + x + ', ' + y + '\n');
    if (x >= this.cols) x = this.cols-1;
    if (y >= this.rows) y = this.rows-1;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    this.cur_x = x;
    this.cur_y = y;
    this.posChanged = true;
    this.queueUpdate();
  },

  carriageReturn: function() {
    this.cur_x = 0;
    this.posChanged = true;
    this.queueUpdate();
  },

  lineFeed: function() {
    if (this.cur_y < this.scrollEnd) {
      ++this.cur_y;
      this.posChanged = true;
      this.queueUpdate();
    } else { // at bottom of screen
      this.scroll(false, 1);
    }
  },

  queueUpdate: function(directupdate) {
    if (this.timerUpdate)
      return;

    var _this = this;
    var func = function() {
      _this.notify();
    };
    if (directupdate)
      this.timerUpdate = setTimeout(func, 1);
    else
      this.timerUpdate = setTimeout(func, 30);
  },

  notify: function(timer) {
    clearTimeout(this.timerUpdate);
    this.timerUpdate = null;

    if (this.changed) { // content changed
      this.updateCharAttr();

      this.setPageState();
      // Re-arm the settle timer only when the SERVER wrote in this window. A
      // purely local repaint (list easy reading _forceRedraw: lineChangeds.fill
      // + changed=true, no _touchRows / no cursor escape) must not postpone a
      // pending settle — holding a nav key repaints every ~30ms and would
      // starve the CommandQueue expects forever. The posChanged branch below
      // stays unconditional: posChanged is only ever set by server cursor
      // escapes, never by local paints.
      if (this._serverActivity) {
        this._serverActivity = false;
        this._armSettleTimer();
      }
      if (this.useMouseBrowsing) {
        // clear highlight and reset cursor on page change
        // without the redraw being called here
        this.clearHighlight();
      }

      this.dispatchEvent(new CustomEvent('change'));

      if (this.view) {
        this.view.update();
      }
      this.changed = false;

      this.dispatchEvent(new CustomEvent('viewUpdate'));
    }

    if (this.posChanged) { // cursor pos changed
      if (this.view) {
        this.view.updateCursorPos();
      }
      this.posChanged=false;
      this._settleCursorMoved = true;
      // Cursor-only frames re-arm the settle timer too: PTT parks the cursor on the
      // bottom status row as a SEPARATE escape (posChanged, NOT changed) that can land
      // in its own notify window. "Quiet" must mean content AND cursor have both
      // stopped, otherwise the settle fires before the cursor is parked and the
      // easy-reading page-down recovery (EasyReading._onScreenSettled) reads a stale
      // cursor. See docs/easy-reading.md.
      this._armSettleTimer();
    }

    if (this.view.blinkOn) {
      this.view.blinkOn = false;

      document.body.classList.toggle('blink--active')
    }
  },

  // Mark rows [start, end] as server-written for the current settle window
  // (see the _settleChangedRows comment in the constructor).
  _touchRows: function(start, end) {
    for (var r = start; r <= end; ++r) this._settleChangedRows.add(r);
    this._serverActivity = true;
  },

  // Re-arm the quiet-period timer. Called on every changed OR cursor-only redraw
  // window: while data/cursor keep arriving (~30ms apart) it keeps resetting and
  // never fires; SETTLE_MS after the LAST window — i.e. once the screen is truly
  // quiet — it (a) promotes the current pageState to settledPageState and dispatches
  // 'pageStateSettled' ONLY on an actual state change (auto-enable edge, see
  // EasyReading.nextEasyReadingState), and (b) ALWAYS dispatches 'screenSettled' so
  // mid-article consumers (the easy-reading page-down recovery) get a "screen is
  // stable now" signal even while pageState stays 3. Transient half-painted frames
  // never settle because a later window always re-arms the timer.
  _armSettleTimer: function() {
    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null;
      // Freeze the settle snapshot BEFORE dispatching: a listener may send keys /
      // force repaints that start filling the NEXT window's set — swapping first
      // keeps each snapshot scoped to exactly one quiet period. The screen is
      // quiet here (content AND cursor stopped), so cur_x/cur_y are the server's
      // final cursor park position for this response.
      this.settleSnapshot = {
        changedRows: this._settleChangedRows,
        cursorMoved: this._settleCursorMoved,
        curX: this.cur_x,
        curY: this.cur_y,
        pageState: this.pageState
      };
      this._settleChangedRows = new Set();
      this._settleCursorMoved = false;
      if (this.pageState !== this.settledPageState) {
        this.prevSettledPageState = this.settledPageState;
        this.settledPageState = this.pageState;
        this.dispatchEvent(new CustomEvent('pageStateSettled'));
      }
      this.dispatchEvent(new CustomEvent('screenSettled'));
    }, SETTLE_MS);
  },

  getText: function(row, colStart, colEnd, color, isutf8, reset, lines) {
    var text = '';
    if (lines) {
      text = lines[row];
    } else {
      text = this.lines[row];
    }
    // always start from leadByte, and end at second-byte of DBCS.
    // Note: this might change colStart and colEnd. But currently we don't return these changes.
    if (colStart == this.cols) return '';

    if ( colStart > 0 ) {
      if ( !text[colStart].isLeadByte && text[colStart-1].isLeadByte ) colStart--;
    } else colStart = 0;

    if ( colEnd > 0 ){
      if ( text[colEnd-1].isLeadByte ) colEnd++;
    } else colEnd = this.cols;

    if (colStart >= colEnd) return '';

    if (!this.view) return;

    var charset = this.view.charset;

    // generate texts with ansi color
    if (color) {
      var output = this.ansiCmp(TermChar.newChar, text[colStart], reset);
      for (var col = colStart; col < colEnd-1; ++col) {
        if (isutf8 && text[col].isLeadByte && this.ansiCmp(text[col], text[col+1]))
          output += this.ansiCmp(text[col], text[col+1]).replace(/m$/g, ';50m') + text[col].ch;
        else
          output += text[col].ch + this.ansiCmp(text[col], text[col+1]);
      }
      output += text[colEnd-1].ch + this.ansiCmp(text[colEnd-1], TermChar.newChar);
      return (isutf8 && charset != 'UTF-8' ? b2u(output) : output);
    }

    text = text.slice(colStart, colEnd);
    return text.map( function(c, col, line) {
      if (!c.isLeadByte) {
        if (col >=1 && line[col-1].isLeadByte) { // second byte of DBCS char
          var prevC = line[col-1];
          var b5 = prevC.ch + c.ch;
          if ((this.view && this.view.charset == 'UTF-8') || b5.length == 1)
            return b5;
          else
            return b2u(b5);
        } else
          return c.ch;
      }
    }).join('');
  },

  getRowText: function(row, colStart, colEnd, lines) {

    var text = '';
    if (lines) {
      text = lines[row];
    } else {
      text = this.lines[row];
    }
    // always start from leadByte, and end at second-byte of DBCS.
    // Note: this might change colStart and colEnd. But currently we don't return these changes.
    if ( colStart > 0 ){
      if ( !text[colStart].isLeadByte && text[colStart-1].isLeadByte ) colStart--;
    } else colStart = 0;

    if ( colEnd < this.cols ){
      if ( text[colEnd].isLeadByte ) colEnd++;
    } else colEnd = this.cols;

    text = text.slice(colStart, colEnd);
    var charset = this.view.charset;
    let that = this;
    return text.map( function(c, col, line) {
      if (!c.isLeadByte) {
        if (col >= 1 && line[col-1].isLeadByte) { // second byte of DBCS char
          var prevC = line[col-1];
          var b5 = prevC.ch + c.ch;
          if ((that.view && that.view.charset == 'UTF-8') || b5.length == 1)
            return b5;
          else
            return b2u(b5);
        } else
          return c.ch;
      }
    }).join('');

  },

  ansiCmp: function(preChar, thisChar, forceReset) {
    var text = '';
    var reset = forceReset;
    if ((preChar.bright && !thisChar.bright) ||
        (preChar.underLine && !thisChar.underLine) ||
        (preChar.blink && !thisChar.blink) ||
        (preChar.invert && !thisChar.invert)) reset = true;
    if (reset) text = ';';
    if ((reset || !preChar.bright) && thisChar.bright) text += '1;';
    if ((reset || !preChar.underLine) && thisChar.underLine) text += '4;';
    if ((reset || !preChar.blink) && thisChar.blink) text += '5;';
    if ((reset || !preChar.invert) && thisChar.invert) text += '7;';
    var DeFg = TermChar.defaultFg;
    var DeBg = TermChar.defaultBg;
    var thisFg = (thisChar.fg == -1) ? DeFg : thisChar.fg;
    var preFg = (preChar.fg == -1) ? DeFg : preChar.fg;
    var thisBg = (thisChar.bg == -1) ? DeBg : thisChar.bg;
    var preBg = (preChar.bg == -1) ? DeBg : preChar.bg;
    if (reset ? (thisFg != DeFg) : (preFg != thisFg))
      text += '3' + thisFg + ';';
    if (reset ? (thisBg != DeBg) : (preBg != thisBg))
      text += '4' + thisBg + ';';
    if (!text) return '';
    else return ('\x1b[' + text.substr(0,text.length-1) + 'm');
  },

  isFullWidth: function(str) {
    var code = str.charCodeAt(0);
    if (this.view.charset != 'UTF-8' || this.forceFullWidth) { // PTT support
      if (code > 0x7f) return true;
      else return false;
    }
    if ((code >= 0x1100 && code <= 0x115f) || 
        (code >= 0x2329 && code <= 0x232a) || 
        (code >= 0x2e80 && code <= 0x303e) || 
        (code >= 0x3040 && code <= 0xa4cf) || 
        (code >= 0xac00 && code <= 0xd7a3) || 
        (code >= 0xf900 && code <= 0xfaff) || 
        (code >= 0xfe30 && code <= 0xfe6f) || 
        (code >= 0xff00 && code <= 0xff60) || 
        (code >= 0xffe0 && code <= 0xffe6)) {
      return true;
    } else {
      return false;
    }
  },

  // NOTE: no longer called — the easy-reading cross-page de-dup switched from
  // wrapped-line arithmetic to pure content comparison (comment_parse.findPageOverlap).
  // Kept for now in case other logic needs wrapped-row detection.
  isTextWrappedRow: function(row) {
    // determine whether it is wrapped by looking for the ending "\"
    var rowText = this.getRowText(row, 0, this.cols);
    var slashIndex = rowText.lastIndexOf('\\');
    if (slashIndex > 0 ) {
      var col = u2b(rowText.substr(0, slashIndex)).length;
      if (col != 77 && col != 78) return false;
      // check the color
      var ch = this.lines[row][col];
      if (ch.fg == 7 && ch.bg === 0 && ch.bright)
        return true;
    }
    return false;
  },

  setPageState: function() {
    let lastRowNum = this.rows - 1;
    let cols = this.cols;
    //this.pageState = 0; //NORMAL
    var lastRowText = this.getRowText(lastRowNum, 0, cols);
    if (lastRowText.indexOf('請按任意鍵繼續') > 0 || lastRowText.indexOf('請按 空白鍵 繼續') > 0) {
      //console.log('pageState = 5 (PASS)');
      this.pageState = 5; // some ansi drawing screen to pass
      return;
    }
    if (lastRowText.indexOf(' 編輯文章  (^Z/F1)說明 (^P/^G)插入符號/範本 (^X/^Q)離開') === 0) {
      this.pageState = 6;
      return;
    }
    if (parseStatusRow(lastRowText)) {
      this.pageState = 3; // READING
      return;
    }

    var firstRowText = this.getRowText(0, 0, cols);

    if ( this.isUnicolor(0, 0, 29) && this.isUnicolor(0, cols-20, cols-10) ) {
      var main = firstRowText.indexOf('【主功能表】');
      var classList = firstRowText.indexOf('【分類看板】');
      var archiveList = firstRowText.indexOf('【精華文章】');
      if (main === 0 || classList === 0 || archiveList === 0 ||
        parseListRow(lastRowText)) {
        //console.log('pageState = 1 (MENU)');
        this.pageState = 1; // MENU
      } else if (this.isUnicolor(2, 0, cols-10) && !this.isLineEmpty(1) && (this.cur_x < 19 || this.cur_y == lastRowNum)) {
        //console.log('pageState = 2 (LIST)');
        this.pageState = 2; // LIST
      }
    } else if ( this.isUnicolor(lastRowNum, 28, 53) && this.cur_y == lastRowNum && this.cur_x == cols-1) {
      //console.log('pageState = 5 (PASS)');
      this.pageState = 5; // some ansi drawing screen to pass
    }
    if (this.pageState != 1 && this.isLineEmpty(lastRowNum)) {
      //console.log('pageState = 0 (NORMAL)');
      this.pageState = 0;
    }
  },

  isUnicolor: function(lineindex, start, end){
    var lines = this.lines;
    var line = lines[lineindex];
    var clr = line[start].getBg();

    // a dirty hacking, because of the difference between maple and firebird bbs.
    for (var i = start; i < end; i++) {
      var clr1 = line[i].getBg();
      if (clr1 != clr || clr1 === 0)
        return false;
    }
    return true;
  },

  isLineEmpty: function(iLine){
    var rows = this.rows;
    var lines = this.lines;
    var line = lines[iLine];

    for ( var col = 0; col < this.cols; col++ )
      if ( line[col].ch != ' ' || line[col].getBg() )
        return false;
    return true;
  },

  onMouse_move: function(tcol, trow, doRefresh){
    this.tempMouseCol = tcol;
    this.tempMouseRow = trow;

    if (this.nowHighlight != trow || doRefresh) {
      this.clearHighlight();
    }

    let lastRowNum = this.rows - 1;
    let cols = this.cols;

    switch( this.pageState ) {
    case 0: //NORMAL
      //SetCursor(m_ArrowCursor);
      //m_CursorState = 0;
      this.mouseCursor = 0;
      break;

    case 4: //LIST
      if (trow>1 && trow < lastRowNum-1) {              //m_pTermData->m_RowsPerPage-1
        if ( tcol <= 6 ) {
          this.mouseCursor = 1;
          this.clearHighlight();
          //SetCursor(m_ExitCursor);m_CursorState=1;
        } else if ( tcol >= cols-16 ) {            //m_pTermData->m_ColsPerPage-16
          if ( trow > 12 )
            this.mouseCursor = 3;
          else
            this.mouseCursor = 2;
          this.clearHighlight();
        } else {
          if (!this.isLineEmpty(trow)) {
            this.mouseCursor = 6;
            this.nowHighlight = trow;
          } else {
            this.mouseCursor = 11;
          }
        }
      } else if ( trow == 1 || trow == 2 ) {
        this.mouseCursor = 2;
      } else if ( trow === 0 ) {
        this.mouseCursor = 4;
      } else { // if ( trow == 23)
        this.mouseCursor = 5;
      }
      break;

    case 2: //LIST
      if (trow > 2 && trow < lastRowNum) {              //m_pTermData->m_RowsPerPage-1
        if ( tcol <= 6 ) {
          this.mouseCursor = 1;
          this.clearHighlight();
          //SetCursor(m_ExitCursor);m_CursorState=1;
        } else if ( tcol >= cols-16 ) {            //m_pTermData->m_ColsPerPage-16
          if ( trow > 12 )
            this.mouseCursor = 3;
          else
            this.mouseCursor = 2;
          this.clearHighlight();
        } else {
          if (!this.isLineEmpty(trow)) {
            this.mouseCursor = 6;
            this.nowHighlight = trow;
          } else {
            this.mouseCursor = 11;
          }
        }
      } else if ( trow == 1 || trow == 2 ) {
        if ( tcol < 2 )//[
          this.mouseCursor = 8;
        else if ( tcol > cols-5 )//]
          this.mouseCursor = 9;
        else
          this.mouseCursor = 2;
      } else if ( trow === 0 ) {
        if ( tcol < 2 )//=
          this.mouseCursor = 10;
        else if ( tcol > cols-5 )//]
          this.mouseCursor = 9;
        else
          this.mouseCursor = 4;
      } else { // if ( trow == 23)
        if ( tcol < 2 )
          this.mouseCursor = 12;
        else if ( tcol > cols-5 )
          this.mouseCursor = 13;
        else
          this.mouseCursor = 5;
      }
      break;

    case 3: //READING
      if ( trow == lastRowNum) {
        if ( tcol < 2 )//]
          this.mouseCursor = 12;
        else if ( tcol > cols-5 )
          this.mouseCursor = 14;
        else
          this.mouseCursor = 5;
      } else if ( trow === 0) {
        if (tcol < 2)//=
          this.mouseCursor = 10;
        else if ( tcol > cols-5 )//]
          this.mouseCursor = 9;
        else if ( tcol < 7 )
          this.mouseCursor = 1;
        else
          this.mouseCursor = 2;
      } else if ( trow == 1 || trow == 2) {
        if (tcol < 2)//[
          this.mouseCursor = 8;
        else if ( tcol > cols-5 )//]
          this.mouseCursor = 9;
        else if ( tcol < 7 )
          this.mouseCursor = 1;
        else
          this.mouseCursor = 2;
      } else if ( tcol < 7 )
        this.mouseCursor = 1;
      else if ( trow < 12)
        this.mouseCursor = 2;
      else
        this.mouseCursor = 3;
      break;

    case 1: //MENU
      if ( trow>0 && trow < lastRowNum ) {
        if (tcol > 7)
          this.mouseCursor = 7;
        else
          this.mouseCursor = 1;
      } else {
        this.mouseCursor = 0;
        //SetCursor(m_ArrowCursor);m_CursorState=0;
      }
      break;

    default:
      this.mouseCursor = 0;
      break;
    }

    this.BBSWin.style.cursor = mouseCursorMap[this.mouseCursor];
  },

  resetMousePos: function() {
    if (this.useMouseBrowsing) {
      this.onMouse_move(this.tempMouseCol, this.tempMouseRow, true);
    }
  },

  setHighlight: function(row) {
    this._nowHighlight = row;
    this.view.setHighlightedRow(row);
  },

  clearHighlight: function(){
    this.nowHighlight = -1;
    this.mouseCursor = 0;
  }
};

Event.mixin(TermBuf.prototype);
