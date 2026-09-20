// Parser for ANSI escape sequence

export function AnsiParser(termbuf) {
  this.termbuf = termbuf;
  this.state = AnsiParser.STATE_TEXT;
  this.esc = '';        // CSI 的參數位元組區（0x30-0x3F）
  this.escInter = '';   // CSI 的中間位元組區（0x20-0x2F）
  this.escDrop = false; // 這條 CSI 已判定要丟棄，但還要吃到終結字元
};

AnsiParser.STATE_TEXT = 0;
AnsiParser.STATE_ESC = 1;
AnsiParser.STATE_CSI = 2;
AnsiParser.STATE_C1 = 3;
// OSC / DCS / APC / PM / SOS：ECMA-48 的「控制字串」，payload 是任意文字，
// 必須吃到終止子為止（見 STATE_STRING 分支）。
AnsiParser.STATE_STRING = 4;

// CSI 參數區的保險絲。防的不是「序列太長」而是**終結字元永遠不來**：沒有上限時
// 一條壞掉的序列會把後續整個畫面累積進 `this.esc`。取 128（server 端 vtkbd.c 的
// 上限是 64，放寬一倍仍遠大於任何真實序列）。
//
// STATE_STRING **刻意沒有對應的上限**：那條路徑只吞不存，沒有東西會溢位，而
// 「中途放棄」的唯一效果是把控制字串剩下的位元組印成畫面上的垃圾字 —— 嚴格劣於
// 繼續吞。真的遇到沒有終止子的字串時，下一個 ESC 就會救回來，而 PTT 每一幀都以
// `ESC[?2026h` 開頭。
const CSI_MAX = 128;

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
      // ECMA-48 的 CSI ＝ `CSI P...P I...I F`：參數位元組 P ＝ 0x30-0x3F、
      // 中間位元組 I ＝ 0x20-0x2F、終結字元 F ＝ 0x40-0x7E（公告給的 regex
      // `\x1B\[[0-?]*[ -/]*[@-~]` 就是這個）。fork 原版把三者全塞進同一個
      // `this.esc` 再 split(';')，靠「第一個字元不是數字就當私有前綴」的啟發式
      // 勉強擋住 —— 下面改成逐 byte 分流，並補上中止規則。
      //
      // 中止規則**照抄 server 端**（common/sys/vtkbd.c:230-256），理由是兩邊
      // 對「被截斷的序列」要有同一套認知：
      //   ESC       → 重啟成 STATE_ESC（新序列打斷舊的，不執行舊的）
      //   CAN / SUB → ECMA-48 的中止字元，整條丟棄
      //   其餘 C0 與 DEL → 中止並**退回重新處理**（\r \n 不該被序列吃掉）
      //   >= 0x80   → 不可能出現在 CSI 裡，丟棄（vtkbd 同樣回 KEY_UNKNOWN）
      // 沒有這一段時，被切斷的 CSI 會併吞下一條：`ESC[3` + `ESC[2J` 會變成
      // esc = "3\x1b[2"、final = 'J' ⇒ parseInt 得 3 ⇒ term.clear(3)。
      if (ch == '\x1b') {
        this.state = AnsiParser.STATE_ESC;
        this.esc = '';
        this.escInter = '';
        this.escDrop = false;
        break;
      }
      if (ch == '\x18' || ch == '\x1a') { // CAN / SUB
        this.state = AnsiParser.STATE_TEXT;
        this.esc = '';
        this.escInter = '';
        this.escDrop = false;
        break;
      }
      if (ch < '\x20' || ch == '\x7f') {
        this.state = AnsiParser.STATE_TEXT;
        this.esc = '';
        this.escInter = '';
        this.escDrop = false;
        --i; // 退回 STATE_TEXT 當一般控制字元處理
        break;
      }
      if (ch > '\x7e') { // 0x80-0xFF：CSI 裡不合法
        this.state = AnsiParser.STATE_TEXT;
        this.esc = '';
        this.escInter = '';
        this.escDrop = false;
        break;
      }
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

        // 含中間位元組的序列一律安靜丟棄：本專案沒有任何一條要用它，PTT 也不送。
        // 這條把 `ESC[?2026$p`（DECRQM 查詢）、`ESC[!p`（DECSTR）、`ESC[0 q`
        // （DECSCUSR）收進同一條明確的丟棄路徑 —— 舊碼是靠「final 字元剛好沒命中
        // 任何 case」才沒出事，那是巧合不是設計。
        // `escDrop` 是「參數區超長」的結果：那條序列已經放棄，但仍必須在這裡
        // **吃掉終結字元**才算讀完 —— 中途放棄會讓剩下的位元組變成畫面上的垃圾字。
        if (this.escInter || this.escDrop) {
          this.state = AnsiParser.STATE_TEXT;
          this.esc = '';
          this.escInter = '';
          this.escDrop = false;
          break;
        }

        var params=this.esc.split(';');
        // 私有前綴＝參數區第一個位元組落在 0x3C-0x3F（`<` `=` `>` `?`）。
        // 分流之後參數區只可能是 0x30-0x3F，所以這裡可以寫成明確的範圍判定，
        // 不必再用「不是數字就是前綴」反推。
        var firstChar = '';
        if (params[0] && params[0].charAt(0) >= '<' && params[0].charAt(0) <= '?') {
          firstChar = params[0].charAt(0);
          params[0] = params[0].slice(1);
        }
        if (firstChar && ch != 'h' && ch != 'l') { // unknown CSI
          //dump('unknown CSI: ' + this.esc + ch + '\n');
          this.state = AnsiParser.STATE_TEXT;
          this.esc = '';
          this.escInter = '';
          this.escDrop = false;
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
        // DSR（Device Status Report）。**刻意不回應**，包含 `ESC[6n`（CPR）。
        //
        // PTT 2026-09 起在連線當下送 `\r \xc3\xa2 ESC[6n`（daemon/logind/logind.c
        // #login_ctx_activate）來偵測 client 的編碼：`\xc3\xa2` 在 UTF-8 下是一個
        // 字（游標停在 col 2）、在 Big5 下是一個雙位元組字（col 3）。回應的解析在
        // logind.c#login_conn_handle_terminal —— **只有第二個參數 == 2 時**才會把
        // `ctx.encoding` 切成 `CONV_UTF8` 並重畫登入畫面；其餘值與「完全不回應」
        // 一樣留在 `LOGIND_INITIAL_ENCODING`（0 ＝ Big5）。
        //
        // 本專案 `term_view.js` 寫死 `charset = 'big5'`（全 repo 無第二個寫入點），
        // 所以正確答案永遠是「留在 Big5」，而**不回應**就是零風險地達成它。
        // 反過來說，哪天有人「順手把 CPR 實作起來」而欄位算錯成 2，代價是 server
        // 切成 UTF-8 ⇒ 整站變亂碼。公告原文也明說「如果程式不想實作此命令可以忽略，
        // 但請注意測試不要當掉」。守護：tests/unit/ansi_parser_cpr.test.js
        case 'n':
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
        this.escInter = '';
      } else if (this.escDrop) {
        // 已放棄：只吞不存，等上面的終結字元分支收尾。
      } else if (ch <= '/') { // 0x20-0x2F 中間位元組
        this.escInter += ch;
      } else {                // 0x30-0x3F 參數位元組
        this.esc += ch;
      }
      // 保險絲：超長就**放棄內容但留在 CSI 態**，等終結字元來了再一起丟掉。
      // 留在 CSI 態是重點——直接跳回 TEXT 會把序列剩下的位元組印到畫面上。
      if (this.esc.length + this.escInter.length > CSI_MAX) {
        this.escDrop = true;
        this.esc = '';
        this.escInter = '';
      }
      break;
    case AnsiParser.STATE_STRING:
      // OSC / DCS / APC / PM / SOS 的 payload。**唯一的工作是吃到終止子**，
      // 內容一律丟棄（PTT 目前不送，但公告明說「預計未來會不定期增加輸出的
      // 控制碼類形」）。沒有這個狀態時 `ESC ] 0;title BEL` 會變成：`]` 被 C1
      // 吞掉、`0;title` 當文字印到畫面上、BEL 還會響一聲。
      //
      // 終止子三種：
      //   BEL(0x07)        —— xterm 的 OSC 慣例
      //   CAN(0x18)/SUB(0x1a) —— ECMA-48 的中止字元
      //   ESC(0x1b)        —— 一律結束並**退回重新處理**。正規的 ST 是 `ESC \`，
      //                       退回後 ESC 重開序列、`\` 落進 C1 被吃掉一個位元組，
      //                       結果等效；順便也處理了「字串被新的 CSI 打斷」。
      // **不可以認 8-bit ST（0x9C）**：這條資料流是 latin1 位元組，0x9C 落在
      // Big5 的 trail byte 範圍內，正文會誤命中而把後面的序列全部吞掉。
      if (ch == '\x1b') {
        this.state = AnsiParser.STATE_TEXT;
        --i;
      } else if (ch == '\x07' || ch == '\x18' || ch == '\x1a') {
        this.state = AnsiParser.STATE_TEXT;
      }
      // 其餘一律吞掉，不累積也不設上限（理由見檔頭 CSI_MAX 的註解）。
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
      if (ch == '[') {
        this.state=AnsiParser.STATE_CSI;
        this.esc = '';
        this.escInter = '';
        this.escDrop = false;
      } else if (ch == ']' || ch == 'P' || ch == '_' || ch == '^' || ch == 'X') {
        // OSC(]) / DCS(P) / APC(_) / PM(^) / SOS(X)：後面接的是任意長度的
        // payload，要吃到終止子為止，不能像 C1 那樣只吞一個位元組。
        this.state=AnsiParser.STATE_STRING;
      } else {
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
