// Terminal Screen Buffer, displayed by TermView

import { Event } from './event';
import { ColorState } from './term_ui';
import { u2b, b2u, parseStatusRow, parseListRow } from './string_util';
import { cjkUrlExtension } from './url_cjk';
import { ringBell } from './bell';
import cursorBack from '../cursor/back.png';
import {
  ACT_NONE,
  ACT_EXIT_ARTICLE,
  CUR_BACK,
  resolveMouseRegion,
  cursorCss
} from './mouse_regions';

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


// 白底黑字（PTT 的反白）。getFg/getBg 已把 invert 攤平 ⇒ 兩種編碼（ESC[0;7m 與
// 直接送 fg=0/bg=7）都認得。isCursorOnInputField 用它認輸入欄。
function isReversedCell(ch) {
  return !!ch && ch.getFg() === 0 && ch.getBg() === 7;
}

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
  // 滑鼠停在哪一格代表什麼動作（mouse_regions 的 ACT_*）與它的目標列。
  // 改版前是 0..14 的 mouseCursor 數字，同時兼任「長什麼樣」與「點了做什麼」。
  this.mouseAction = ACT_NONE;
  this.mouseActionRow = -1;
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
  this.prevPageState = 0;
  // Debounced pageState: updated only once the screen has been quiet for
  // SETTLE_MS, so transient half-painted frames never pollute it. EasyReading's
  // auto re-enable keys off the clean 2 (list) -> 3 (article) settled transition.
  this.settledPageState = 0;
  this.prevSettledPageState = 0;
  this._settleTimer = null;

  this.lines = new Array(rows);

  this.pageLines = [];

  // 逐列 dirty 旗標：updateCharAttr 升起（由 ch.needUpdate 聚合）、term_view.redraw
  // 是**唯一**的清除點。初值全 true ＝ 首幀必須整份畫一次；redraw 用嚴格
  // `=== false` 判定，別把它退回 new Array(rows)（undefined 恰好也能過，但語意
  // 從此靠巧合成立）。
  this.lineChangeds = new Array(rows).fill(true);

  // Per-settle-window accumulation of the rows the SERVER wrote (puts/clear/
  // erase/scroll — see _touchRows call sites), frozen into settleSnapshot when
  // the settle timer fires (_armSettleTimer).
  //
  // **Deliberately NOT derived from lineChangeds** (docs/easy-reading-list.md
  // invariant 2). needUpdate stopped being sticky in 2026-08 (updateCharAttr now
  // clears it per row), so lineChangeds IS a real dirty set today — but its window
  // and its semantics are still the wrong ones here:
  //   - window: lineChangeds is cleared by term_view.redraw, so ONE settle window
  //     can span several redraws and lose earlier rows.
  //   - semantics: local forced repaints (lineChangeds.fill(true) in
  //     easy_reading._forceRepaint / list_session._forceRedraw) feed lineChangeds
  //     but must NEVER feed this set — burst classification asks "which rows did
  //     the SERVER write in this response", and mixing local paints in is exactly
  //     invariant 2b (holding a nav key would starve the settle forever).
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
    // 換行列數之後全列重畫：App.setTermSize 之後沒有任何強制重繪，而新增的 slot
    // 是 undefined、新建的 TermChar 是 needUpdate = false ⇒ 不補這一行的話新列
    // 永遠不會被畫出來。
    this.lineChangeds.fill(true);
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
        // BEL。pttbbs 的 bell()（mbbsd/term.c）在 captcha／棋類／水球等處會送。
        // 只出聲，不做視覺提示：畫面通知在這裡分不出「哪件事在叫」，反而會誤導。
        // ringBell 自己吃掉所有錯誤並節流，這條熱路徑上不需要任何守門。
        ringBell();
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

  // 每次 notify 的 changed 分支跑一次：重算 DBCS lead byte、把逐格的 needUpdate
  // 聚合成 lineChangeds[row]、對變動的列重掃 URI。
  //
  // KNOWN（既有瑕疵，與去 sticky 無關、sticky 下也修不好，本次不處理）：
  // copyFromNewChar() 不清 startOfURL/endOfURL/partOfURL/fullurl，也不清
  // line.uris；insert/del 的列內 splice 又會讓 line.uris 的欄位座標與實際 cell
  // 錯開 ⇒ 舊 URL 旗標可能殘留。只影響 PTT 編輯器畫面（pageState 6），那裡不走
  // 增強渲染。
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
        // Big5 模式下 isFullWidth() 就是「位元組 > 0x7f」（見本檔 isFullWidth）。
        // 這是近似而非判準——Big5 的 trail byte 同樣落在 0x81..0xFE，單看一格分不出
        // 頭尾。之所以還是對的，是因為這裡**每一列都從 col 0 起逐對配對**：認出頭就
        // ++col 跳過尾，所以只要該列的高位元組成雙就不會錯。
        // 失效條件（無法在這一層修）：列內出現奇數個高位元組時（半個全形字被覆蓋、
        // 或全形字被畫面右緣切斷），其後的配對整個位移一格。cell-based 的終端機沒有
        // byte-stream 狀態可以回推，PTT server 端的 pfterm 也受同樣限制。
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
        }
        // 這裡曾有一段 `else if (ch.isleadbyte && ...) line[col+1].needUpdate = true`
        // ——欄位名大小寫打錯（正確是 isLeadByte），條件恆為 undefined，2014 年寫下後
        // 從未執行過。已刪：它要保證的「全形字的頭被半形字蓋掉時，被孤立的尾格也要
        // 重畫」，puts() 在寫入當下就給了（`if (ch2.isLeadByte) line[cur_x].needUpdate
        // = true`）。守護 tests/unit/term_buf_dirty_rows.test.js「覆蓋全形字的 lead
        // byte」。別把它加回來。
        ch.isLeadByte = false;
      }

      if (needUpdate) { // this line has been changed
        this.lineChangeds[row] = true;
        // perform URI detection again
        // remove all previously cached uri positions
        if (line.uris) {
          var uris = line.uris;
          var nuris = uris.length;

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
        // ---- 去 sticky（2026-08）----
        // needUpdate 的語意是「上一次 notify 之後 server 寫過這一格」，消費完
        // （lineChangeds 已升起、URI 已重掃）就該清掉。以前從來不清 ⇒ 任何寫過
        // 一次的列永遠是 dirty ⇒ term_view.redraw 的逐列 continue 幾乎永不生效，
        // 逐列 patch 也就無從談起。
        // **必須排在 URI 偵測之後**：上面的 teardown 與 fix-link 還會再設一批 true。
        // **lineChangeds 不在這裡清**（唯一清除點是 term_view.redraw），所以
        // 「notify 了但沒 redraw」的幀不會漏畫，easy_reading._forceRepaint /
        // list_session._forceRedraw 的 lineChangeds.fill(true) 也活得下來。
        for (var uc = 0; uc < cols; ++uc)
          line[uc].needUpdate = false;
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

    // 閃爍游標抑制（autoHideBlinkCursor）：changed / posChanged 兩個分支各有 early
    // return，notify 是兩者唯一的共同匯流點，所以在這裡每幀無條件重算一次。
    if (this.view) this.view.refreshCursorVisibility();

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

  // Adopt the CURRENT per-frame pageState as the settled one, without producing a
  // settle edge (prev == settled). For callers that already know, from a user action,
  // what screen we are on and must not let a stale snapshot speak for it later.
  //
  // Why this is needed: the settle snapshot only advances when the screen goes quiet
  // for SETTLE_MS. Easy reading's auto page-down keeps the screen busy every ~30-40ms
  // for the WHOLE article, so a long post can be read start to finish without a single
  // settle — `settledPageState` then still says LIST(2) from before the post was even
  // opened. The next quiet moment (e.g. the ^L repaint after switching back to native)
  // fires a settle that reads as a brand new "list(2) -> article(3)" edge, and
  // EasyReading.nextEasyReadingState re-enables easy reading against the user's
  // explicit choice. See EasyReading.exitEasyReading (its only caller) and
  // docs/easy-reading.md.
  syncSettledPageState: function() {
    this.prevSettledPageState = this.pageState;
    this.settledPageState = this.pageState;
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

  // 這個畫面是不是**正在等使用者輸入**（PTT 的輸入框）。
  //
  // 依據 mbbsd/vtuikit.c#vgetstring（1211-1240）：輸入欄一律是
  //   outs(VCLR_INPUT_FIELD)  // include/vtuikit.h:37 → ANSI_COLOR(0;7) = ESC[0;7m
  //   vfill(len, 0, buf)      // 填滿 len 格（實測 term.ptt.cc：看板名輸入欄 13 格
  //                           //  ＝ IDLEN+1，與 namecomplete 的 len 相符）
  //   outs(ANSI_RESET)
  //   move(line_ansi, col_ansi + rt.icurr)   // 游標**必定**落在那條反白欄內
  // ⇒「游標所在格是白底黑字」＝所有 PTT 輸入框（推文／搜尋／跳頁／y-N）的共通指紋。
  //
  // **判斷用 getFg/getBg（實際顯色）而不是 ch.invert**：畫面不是由 mbbsd 直接吐 ANSI，
  // 中間隔了 pfterm 這層 framebuffer（mbbsd/pfterm.c 自己算最省的輸出），實測 2026-08
  // term.ptt.cc 的輸入欄送的是 fg=0/bg=7，`invert` 旗標根本不會被設起來。
  //
  // 第二個條件擋掉「整列反白」的狀態列／標題列／列表表頭（實測 revCount=79）：
  // vgetstring 前面一定先 outs(prompt)，輸入欄不可能從 col 0 開始。
  //
  // 為什麼需要它：setPageState 沒有 reset 分支，而列表上叫出的 prompt 只重畫
  // row 0/1（mbbsd/board.c#search_local_board 只 move(0,0)+clrtoeol）⇒ pageState
  // 黏在 2，游標底色與滑鼠可點區都還以為自己在列表上。消費端見 cursor_highlight
  // .resolveHighlightRow 與 mouse_regions.resolveMouseRegion 的 inputPrompt。
  isCursorOnInputField: function() {
    var line = this.lines[this.cur_y];
    if (!line) return false;
    return isReversedCell(line[this.cur_x]) && !isReversedCell(line[0]);
  },

  // 滑鼠移到 (tcol, trow)：算出這一格的語意、更新游標底色列、換滑鼠指標、開關
  // 文章左側的退出提示帶。決策本身在純函式 mouse_regions.resolveMouseRegion
  // （逐格的行為表與依據見那裡與 docs/mouse.md），這裡只負責套用。
  //
  // 這裡**只管原生 24 列畫面**。列表好讀模式畫的是 ListSession 的虛擬視窗，座標
  // 與 server 的真實 24 列並不對應，一律由 term_view.onListMouseMove 處理
  // （App.onMouse_move 分流）；這裡再擋一次，涵蓋 resetMousePos 這類不經 App 的
  // 呼叫者。
  onMouse_move: function(tcol, trow){
    if (this.listRenderMode === 'buffer' || this.listRenderMode === 'frozen')
      return;
    this.tempMouseCol = tcol;
    this.tempMouseRow = trow;

    // 空列判斷只有列表用得到，其餘畫面不必掃 80 格。
    var lineEmpty = (this.pageState === 2 || this.pageState === 4) ?
      this.isLineEmpty(trow) : false;

    var region = resolveMouseRegion({
      pageState: this.pageState,
      col: tcol,
      row: trow,
      rows: this.rows,
      lineEmpty: lineEmpty,
      // 防誤觸（可點區＝底色區的起始欄）跟著總開關走，見 resolveMouseGates。
      misclickGuard: !!(
        this.useMouseBrowsing && this.view && this.view.mouseMisclickGuard
      ),
      // PTT 開著輸入框 ⇒ 這一幀什麼都不能點也不上色（見 resolveMouseRegion）。
      inputPrompt: this.isCursorOnInputField()
    });

    this.mouseAction = region.action;
    this.mouseActionRow = region.row;
    // setter 會轉呼叫 view.applyCursorHighlight（唯一套用入口）。
    this.nowHighlight = region.highlightRow;

    // 指標圖示與左側提示帶都是「這裡點下去會做什麼」的提示 ⇒ 跟著左鍵開關走，
    // 與底色（滑鼠移動）各自獨立。
    var affordance =
      !!(this.useMouseBrowsing && this.view && this.view.mouseLeftClick);
    if (this.BBSWin) {
      this.BBSWin.style.cursor = cursorCss(region.cursor, {
        backUrl: cursorBack,
        iconsEnabled: affordance
      });
    }
    if (this.view && this.view.setExitAffordance) {
      // 用 **cursor** 當單一真相（不逐一列舉 action）：文章與列表／選單的退出帶
      // 是同一個手勢、同一個 back 指標，日後再多一種退出 action 也不會漏列舉。
      this.view.setExitAffordance(affordance && region.cursor === CUR_BACK);
    }
  },

  resetMousePos: function() {
    if (this.useMouseBrowsing) {
      this.onMouse_move(this.tempMouseCol, this.tempMouseRow);
    }
  },

  // nowHighlight 的 setter（見建構子的 defineProperty）＝「滑鼠停在哪一列」。
  // 實際上不上色由 view 決定：鍵盤游標也可能是來源，且列表好讀模式用的是另一組
  // 座標，故一律轉交唯一入口 applyCursorHighlight（見 js/cursor_highlight.js）。
  //
  // row >= 0 才算「滑鼠移動」（讓滑鼠重新取得底色優先權）：row < 0 是 clearHighlight，
  // 而 notify 每個重畫幀都會呼叫它，把那個也當成滑鼠移動會讓鍵盤永遠搶不到底色。
  setHighlight: function(row) {
    this._nowHighlight = row;
    if (this.view) this.view.applyCursorHighlight(row >= 0 ? 'mouse' : undefined);
  },

  clearHighlight: function(){
    this.nowHighlight = -1;
    this.mouseAction = ACT_NONE;
    this.mouseActionRow = -1;
    if (this.view && this.view.setExitAffordance) this.view.setExitAffordance(false);
  }
};

Event.mixin(TermBuf.prototype);
