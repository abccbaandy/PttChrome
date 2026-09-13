// Parser for ANSI escape sequence

export function AnsiParser(termbuf) {
  this.termbuf = termbuf;
  this.state = AnsiParser.STATE_TEXT;
  this.esc = '';
};

AnsiParser.STATE_TEXT = 0;
AnsiParser.STATE_ESC = 1;
AnsiParser.STATE_CSI = 2;
AnsiParser.STATE_C1 = 3;

// DECSET(`h`, set=true) / DECRST(`l`, set=false) 的私有模式分派。
// 逐個掃 params：`ESC[?1000;1006h` 這種一次設多個模式的形式是合法的（PTT 目前
// 一條一條送，但別依賴那個）。認不得的模式安靜略過。
// `term.beginSyncUpdate?.()` 用 optional call：unit test 常餵精簡的 termbuf stub。
AnsiParser.prototype._decPrivate = function(term, params, set) {
  for (var i = 0; i < params.length; ++i) {
    switch (params[i]) {
    case 2026: // Synchronized Output: BSU / ESU
      if (set) term.beginSyncUpdate?.();
      else term.endSyncUpdate?.();
      break;
    case 1000: // XTerm mouse tracking: normal（點擊）
    case 1002: //                       button-event（拖曳）
    case 1003: //                       any-event（含 hover motion）
    case 1006: //                       SGR 編碼
      if (set) term.handleDECSET?.(params[i]);
      else term.handleDECRST?.(params[i]);
      break;
    default: // 其餘一律安靜忽略
    }
  }
};

AnsiParser.prototype.feed = function(data) {
  var term = this.termbuf;
  if (!term)
    return;
  var s = '';
  var n = data.length;
  for (var i = 0; i < n; ++i) {
    var ch = data[i];
    switch (this.state) {
    case AnsiParser.STATE_TEXT:
      switch (ch) {
      case '\x1b':
        if (s) {
          term.puts(s);
          s = '';
        }
        this.state = AnsiParser.STATE_ESC;
        break;
      default:
        s += ch;
      }
      break;
    case AnsiParser.STATE_CSI:
      // ECMA-48 的 CSI final byte ＝ 0x40..0x7E。fork 原版寫成
      // (ch >= '`' && ch <= 'z') || (ch >= '@' && ch <= 'Z')，漏掉 0x5B-0x5F
      // （[ \ ] ^ _）與 0x7B-0x7E（{ | } ~）⇒ 以那九個字元結尾的 CSI **永不終結**，
      // 後續畫面全被累積進 this.esc，直到某個落在舊範圍的字元「假結束」並被當成
      // 該序列的指令執行（'H' ⇒ 游標跳原點、'J' ⇒ 清畫面）。一條沒實作的序列
      // 因此不是安靜的 no-op，而是「畫面從此壞掉」。
      // PTT 2026-09 起送 DEC private control sequence 並預告還會再加別的，
      // 公告明說「不用實作內容，只要讀到 sequence 不會壞掉即可」⇒ 範圍必須判對。
      // 守護：tests/unit/ansi_parser_csi_final.test.js
      if ( ch >= '@' && ch <= '~' ) {
        // if(ch != 'm')
        //    dump('CSI: ' + this.esc + ch + '\n');
        var params=this.esc.split(';');
        var firstChar = '';
        if (params[0]) {
          if (params[0].charAt(0)<'0' || params[0].charAt(0)>'9') {
            firstChar = params[0].charAt(0);
            params[0] = params[0].slice(1);
          }
        }
        if (firstChar && ch != 'h' && ch != 'l') { // unknown CSI
          //dump('unknown CSI: ' + this.esc + ch + '\n');
          this.state = AnsiParser.STATE_TEXT;
          this.esc = '';
          break;
        }
        for (var j=0; j<params.length; ++j) {
          if ( params[j] )
            params[j] = parseInt(params[j], 10);
          else
            params[j] = 0;
        }
        switch (ch) {
        case 'm':
          term.assignParamsToAttrs(params);
          break;
        case '@':
          term.insert(params[0]>0 ? params[0] : 1);
          break;
        case 'A':
          term.gotoPos(term.cur_x, term.cur_y-(params[0]?params[0]:1));
          break;
        case 'B':
        case 'e':
          term.gotoPos(term.cur_x, term.cur_y+(params[0]?params[0]:1));
          break;
        case 'C':
        case 'e':
          term.gotoPos(term.cur_x+(params[0]?params[0]:1), term.cur_y);
          break;
        case 'D':
          term.gotoPos(term.cur_x-(params[0]?params[0]:1), term.cur_y);
          break;
        case 'E':
          term.gotoPos(0, term.cur_y+(params[0]?params[0]:1));
          break;
        case 'F':
          term.gotoPos(0, term.cur_y-(params[0]?params[0]:1));
          break;
        case 'G':
        case '`':
          term.gotoPos(params[0]>0?params[0]-1:0, term.cur_y);
          break;
        case 'I':
          term.tab(params[0]>0 ? params[0] : 1);
          break;
        case 'd':
          term.gotoPos(term.cur_x, params[0]>0?params[0]-1:0);
          break;
        // DECSET / DECRST。目前只認 DEC 2026（Synchronized Output）：
        // `ESC[?2026h` = BSU（幀開始）、`ESC[?2026l` = ESU（幀結束）。
        // 其餘 DEC 私有模式（含 PTT 之後會送的滑鼠 1000/1002/1003/1006）一律安靜
        // 忽略——PTT 公告要求的相容性就是「讀到不會壞掉」，不必實作內容。
        // 守護：tests/unit/ansi_parser_dec_private.test.js
        case 'h':
          if (firstChar == '?') this._decPrivate(term, params, true);
          break;
        case 'l':
          if (firstChar == '?') this._decPrivate(term, params, false);
          break;
        /*
        以下 alt-screen（47/1047/1048/1049）與 cursorAppMode（1）是 fork 來的舊碼，
        **刻意維持註解**：它們讀 `term.view.conn.listener`，那條路在本專案早已不存在
        （view.conn 只在 App.onConnect 被設，且沒有 listener 這個成員），解開會直接炸。
        PTT 也從來不送這些序列（pttbbs 全 repo 只吐 2026/1000/1002/1003/1006 十條）。
        case 'h':
          if (firstChar == '?') {
            var mainobj = term.view.conn.listener;
            switch(params[0]) {
            case 1:
              term.view.cursorAppMode = true;
              break;
            case 1048:
            case 1049:
              term.cur_x_sav = term.cur_x;
              term.cur_y_sav = term.cur_y;
              if (params[0] != 1049) break; // 1049 fall through
            case 47:
            case 1047:
              mainobj.selAll(true); // skipRedraw
              term.altScreen=mainobj.ansiCopy(true); // external buffer
              term.altScreen+=term.ansiCmp(TermChar.newChar, term.attr);
              term.clear(2);
              term.attr.resetAttr();
              break;
            default:
            }
          }
          break;
        case 'l':
          if (firstChar == '?') {
            switch (params[0]) {
            case 1:
              term.view.cursorAppMode = false;
              break;
            case 47:
            case 1047:
            case 1049:
              term.clear(2);
              term.attr.resetAttr();
              if (term.altScreen) {
                this.state = AnsiParser.STATE_TEXT;
                this.esc = '';
                this.feed(term.altScreen.replace(/(\r\n)+$/g, '\r\n'));
              }
              term.altScreen='';
              if (params[0] != 1049) break; // 1049 fall through
            case 1048:
              if (term.cur_x_sav<0 || term.cur_y_sav<0) break;
              term.cur_x = term.cur_x_sav;
              term.cur_y = term.cur_y_sav;
              break;
            default:
            }
          }
          break;
        */
        case 'J':
          term.clear(params ? params[0] : 0);
          break;
        case 'H':
        case 'f':
          if (params.length < 2) {
            term.gotoPos(0, 0);
          } else {
            if (params[0] > 0)
              --params[0];
            if (params[1] > 0)
              --params[1];
            term.gotoPos(params[1], params[0]);
          }
          break;
        case 'K':
          term.eraseLine(params? params[0] : 0);
          break;
        case 'L':
          term.insertLine(params[0]>0 ? params[0] : 1);
          break;
        case 'M':
          term.deleteLine(params[0]>0 ? params[0] : 1);
          break;
        case 'P':
          term.del(params[0]>0 ? params[0] : 1);
          break;
        // DECSTBM（設捲動範圍）。PTT 走的是 pfterm，它從不發這個序列——整份
        // pfterm.c 只吐 [2J / [K / [H / [J 與 ESC D（IND）／ESC M（RI），而唯一會發
        // DECSTBM 的 change_scroll_range()（mbbsd/screen.c）整份包在
        // #if !defined(USE_PFTERM) 裡。⇒ 實務上 scrollStart/scrollEnd 恆為 0..rows-1，
        // 真正用到它們的是下面 C1 分支的 ESC D / ESC M → term.scroll()。
        // 這條留著只是通用 VT100 相容；不必為它補「DECSTBM 應同時 home 游標」那半段。
        case 'r':
          if (params.length < 2) {
            term.scrollStart=0;
            term.scrollEnd=term.rows-1;
          } else {
            if (params[0] > 0)
              --params[0];
            if (params[1] > 0)
              --params[1];
            term.scrollStart=params[0];
            term.scrollEnd=params[1];
          }
          break;
        case 's':
          term.cur_x_sav=term.cur_x;
          term.cur_y_sav=term.cur_y;
          break;
        case 'u':
          if (term.cur_x_sav<0 || term.cur_y_sav<0) break;
          term.cur_x = term.cur_x_sav;
          term.cur_y = term.cur_y_sav;
          break;
        case 'S':
          term.scroll(false, (params[0]>0 ? params[0] : 1));
          break;
        case 'T':
          term.scroll(true, (params[0]>0 ? params[0] : 1));
          break;
        case 'X':
          term.eraseChar(params[0]>0 ? params[0] : 1);
          break;
        case 'Z':
          term.backTab(params[0]>0 ? params[0] : 1);
          break;
        default:
          //dump('unknown CSI: ' + this.esc + ch + '\n');
        }
        this.state = AnsiParser.STATE_TEXT;
        this.esc = '';
      } else {
        this.esc += ch;
      }
      break;
    case AnsiParser.STATE_C1:
      var C1_End = true;
      var C1_Char = [' ', '#', '%', '(', ')', '*', '+', '-', '.', '/'];
      if (this.esc) { // multi-char is not supported now
        for (var j = 0; j < C1_Char.length; ++j)
          if (this.esc == C1_Char[j]) C1_End = false;
        if (C1_End) --i;
        else this.esc += ch;
        //dump('UNKNOWN C1 CONTROL CHAR IS FOUND: ' + this.esc + '\n');
        this.esc = '';
        this.state = AnsiParser.STATE_TEXT;
        break;
      }
      switch (ch) {
      case '7':
        term.cur_x_sav = term.cur_x;
        term.cur_y_sav = term.cur_y;
        break;
      case '8':
        if (term.cur_x_sav<0 || term.cur_y_sav<0) break;
        term.cur_x = term.cur_x_sav;
        term.cur_y = term.cur_y_sav;
        break;
      case 'D':
        term.scroll(false,1);
        break;
      case 'E':
        term.lineFeed();
        term.carriageReturn();
        break;
      case 'M':
        term.scroll(true,1);
        break;
      /*
      case '=':
          term.view.keypadAppMode = true;
          break;
      case '>':
          term.view.keypadAppMode = false;
          break;
      */
      default:
        this.esc += ch;
        C1_End=false;
      }
      if (!C1_End) break;
      this.esc = '';
      this.state = AnsiParser.STATE_TEXT;
      break;
    case AnsiParser.STATE_ESC:
      if (ch == '[')
        this.state=AnsiParser.STATE_CSI;
      else {
        this.state=AnsiParser.STATE_C1;
        --i;
      }
      break;
    }
  }
  if (s) {
      term.puts(s);
      s = '';
  }
};
