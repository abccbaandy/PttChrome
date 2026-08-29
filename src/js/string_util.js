

/**
 * Only support caret notations (^C, ^H, ^U, ^[, ^?, ...)
 * If you want to show \ and ^, use \\ and \^ respectively
 */ 
export function unescapeStr(it) {
  var result = '';

  for (var i = 0; i < it.length; ++i) {
    var curChar = it.charAt(i);
    var nextChar = it.charAt(i+1);
    
    if (i == it.length - 1) {
      result += curChar;
      break;
    }

    if (curChar == '\\' && (nextChar == '\\' || nextChar == '^')) {
      result += nextChar;
      i++; // 逸出對是兩個字元，第二個不可再被當成獨立字元處理
    } else if (curChar == '^') {
      if ('@' <= nextChar && nextChar <= '_') {
        var code = it.charCodeAt(i+1) - 64;
        result += String.fromCharCode(code);
        i++;
      } else if (nextChar == '?') {
        result += '\x7f';
        i++;
      } else {
        result += '^';
      }
    } else {
      result += curChar;
    }
  }
  return result;
};

// Wrap text within maxLen without hyphenating English words,
// where the maxLen is generally the screen width.
export function wrapText(it, maxLen, enterChar) {
  // Divide string into non-hyphenated groups
  // classified as \r, \n, single full-width character, an English word,
  // and space characters in the beginning of original line. (indent)
  // Spaces next to a word group are merged into that group
  // to ensure the start of each wrapped line is a word.
  // The optional punctuation after a full-width char covers the CJK closers too
  // (，。、；：？！）」』】〉》): they are non-ASCII, so without them in the class each
  // one forms its OWN group and can be pushed to the start of the next line.
  // KNOWN boundary (deliberate): the mirror rule — full-width OPENERS （「『【 must
  // not end a line — is not handled; that needs lookahead to regroup, and every
  // caller here is paste normalization where a stray opener is merely ugly.
  var pattern = /\r|\n|([^\x00-\x7f][,.?!:;，。、；：？！）」』】〉》]?[\t ]*)|([\x00-\x08\x0b\x0c\x0e-\x1f\x21-\x7f]+[\t ]*)|[\t ]+/g;
  var splited = it.match(pattern);

  var result = '';
  var len = 0;
  for (var i = 0; i < splited.length; ++i) {
    // Convert special characters to spaces with the same width
    // and then we can get the width by the length of the converted string
    var grouplen = splited[i].replace(/[^\x00-\x7f]/g,"  ")
                             .replace(/\t/g,"    ")
                             .replace(/\r|\n/g,"")
                             .length;

    if (splited[i] == '\r' || splited[i] == '\n')
      len = 0;
    if (len + grouplen > maxLen) {
      result += enterChar;
      len = 0;
    }
    result += splited[i];
    len += grouplen;
  }
  return result;
};

// Paste normalization, shared by EVERY paste route so they all put the same
// bytes on the wire. Two callers today:
//   - TermView.onTextInput(text, /*isPasting*/true) — the native path,
//   - ListSession.onPaste — list easy reading's serialized T3 passthrough,
// which sends through CommandQueue (raw conn.send) instead of convSend and so
// has to do the u2b/ansiHalfColorConv itself. Duplicating the rules here would
// mean "paste in easy reading" and "paste in native" quietly diverging.
//
// ENTER_CHAR: every newline flavour collapses to a single \r — a pasted line
// that ends in a newline therefore SUBMITS whatever PTT prompt is open (native
// terminal behaviour, deliberately preserved).
// ESC_CHAR: \x1b would put PTT's vgetstring into an escape sequence, so it is
// mapped to Ctrl-U (\x15). That mapping is also what closed the upstream FIXME
// "stop user from pasting DBCS words with 2-color": colored text copied off the
// screen carries its attributes as ESC sequences, and with every \x1b rewritten
// there is no way for them to reach PTT as attributes at all.
export const PASTE_ENTER_CHAR = '\r';
export const PASTE_ESC_CHAR = '\x15'; // Ctrl-U

export function normalizePasteText(text, lineWrap) {
  let out = String(text)
    .replace(/\r\n/g, '\r')
    .replace(/\n/g, '\r')
    .replace(/\r/g, PASTE_ENTER_CHAR);

  if (out.indexOf('\x1b') < 0 && lineWrap > 0)
    out = wrapText(out, lineWrap, PASTE_ENTER_CHAR);

  return out.replace(/\x1b/g, PASTE_ESC_CHAR);
}

export function u2b(it) {
  var data = '';
  for (var i = 0; i < it.length; ++i) {
    if (it.charAt(i) < '\x80') {
      data += it.charAt(i);
      continue;
    }
    var pos = it.charCodeAt(i);
    var hi = lib.u2bArray[2*pos], lo = lib.u2bArray[2*pos+1];
    if (hi || lo)
      data += String.fromCharCode(hi) + String.fromCharCode(lo);
    else // Not a big5 char
      data += '\xFF\xFD';
  }
  return data;
};

export function b2u(it) {
  var str = '';
  for (var i = 0; i < it.length; ++i) {
    if (it.charAt(i) < '\x80' || i == it.length-1) {
      str += it.charAt(i);
      continue;
    }

    var pos = it.charCodeAt(i) << 8 | it.charCodeAt(i+1);
    var code = lib.b2uArray[2*pos] << 8 | lib.b2uArray[2*pos+1];
    if (code) {
      str += String.fromCharCode(code);
      ++i;
    } else { // Not a big5 char
      str += it.charAt(i);
    }
  }
  return str;
};

export function isDBCSLead(ch) {
  let code = ch.charCodeAt(0);
  return code >= 0x81 && code <= 0xfe;
};

// Clipboard text normalization for doCopy: BBS-style line endings (\r) and no
// trailing spaces before a break. ANSI text (contains \x1b) is passed through
// untouched so colored copies keep their exact byte sequence.
export function normalizeCopyText(it) {
  if (it.indexOf('\x1b') >= 0) return it;
  return it
    .replace(/\r\n/g, '\r')
    .replace(/\n/g, '\r')
    .replace(/ +\r/g, '\r');
};

// Trailing PTT comment timestamp " MM/DD HH:MM" (right-aligned at the end of the
// row, always preceded by whitespace). A finished comment row ends with it; body
// text written in comment shape, the "→ id:" input prompt, and "※ 編輯: … ,
// MM/DD/YYYY HH:MM:SS" (different format) do NOT. Shared by parseComment (in
// comment_parse.js) and long_push.js#classifyPushScreen to tell real comments
// apart from the row you can type into.
export const COMMENT_TIME_RE = /\s\d{1,2}\/\d{2}\s+\d{2}:\d{2}\s*$/;

// 推文底列（型別選單／輸入列／確認列／擋人橫幅）的分類一律用
// long_push.js#classifyPushScreen（已逐字對過 bbs.c#recommend）。此處曾有一個
// parsePushInitText 只認 '→ id:'，跟不上推／噓 兩種型別符 ⇒ 圖片上傳在推文
// 列被判成「不在推文框」而改走剪貼簿；已移除，勿再在這裡另寫一套。

// pmore 底部狀態列＝「這頁是文章」的決定性指紋（pageState 3 / classifyListScreen
// 'article' 都靠它）。官方 mbbsd/pmore.c#mf_display_footer 三段拼接：
//
//   part1 SUMMARY  "  瀏覽 第 %1d/%1d 頁 (%3d%%) "   allpages >= 0
//                  "  瀏覽 第 %1d 頁 (%3d%%) "        allpages <  0（總頁未知）
//   part2 DETAIL   " 目前顯示: 第 %02d~%02d 行"                mf.xpos == 0
//                  " 顯示範圍: %d~%d 欄位, %02d~%02d 行"       mf.xpos >  0（左右捲動中）
//   part3 HELP     mbbsd/more.c#common_pmore_footer_handler 依剩餘寬度五選一：
//                  "(y)回信 (h)說明 (←/q)離開 "（RMAIL）/ "(y)回應(X%)推文(h)說明(←)離開 "
//                  / "(y)回應(X/%)推文 (←)離開 " / "(h)說明 (←/q)離開 " / "(←q)離開 "
//                  ——**或一種都不印**（見下）
//
// part1 尾 1 空格 ＋ part2 首 1 空格 ⇒ 「%)」與 part2 之間恰 2 空格。
// 頁碼/百分比用 %1d/%3d，**沒有位數上限**（實錄 stock-end 已見 540/540），所以
// 不可寫成 \d{1,3}。part2 兩個分支的行號欄位形狀相同（" S~E 行"），共用同一組
// capture；「顯示範圍」分支若不支援，使用者一按 `.`/`>` 右捲長行就掉出文章判定。
//
// **part3 完全不比對（2026-08 反查 efc21a30）**：它會整段消失，兩層來源——
//   1. pmore.c#mf_display_footer 印完 part2 後 `if (avail <= 0) return;`
//      （連 footer_handler 都不呼叫）；
//   2. more.c#common_pmore_footer_handler:461 最後 `else while (width-- > w) outc(' ');`
//      （連 FOOTERMSG_VERYSHORT 都塞不下時只填空白）。
// 觸發條件是 part1+part2 太寬（多位數頁碼／六位數行號／xpos 的「顯示範圍」分支）。
// 要求 part3 的代價不是少一個欄位，而是**整列失配** → term_buf.setPageState 判不出
// pageState 3 → term_view.redraw 落到 native 分支 → hideEasyReadingOverlays() 清空
// buf.pageLines（好讀累積頁整個消失）。part1+part2 本身已是唯一的畫面指紋，足夠。
const STATUS_ROW_RE =
  /  瀏覽 第 (\d+)(?:\/(\d+))? 頁 *\( *(\d+)%\)  (?:目前顯示: 第|顯示範圍: \d+~\d+ 欄位,) 0*(\d+)~0*(\d+) 行/;

// 同一列 part3（HELP）反推 pmore 當下的 `currstat` ——「這個畫面按 s / # 有沒有用」。
// mbbsd/more.c:102-112：pager 的 `s`(RET_SELECTBRD) 與 `#`(RET_SELECTAID) 都寫死
//   if (!HasUserPerm(PERM_BASIC) || currstat != READING) break;
// 站內信是 currstat == RMAIL → 兩鍵都是 DONOTHING，送出的 "s<板名>\r" 會被 pager
// **逐鍵當快捷鍵吃掉**（Y=回信給所有人 / X,%=推文 / T=改標題 / E=編輯…）＝誤觸。
// part3 正好是 currstat 的直接投影（more.c#common_pmore_footer_handler:406-454）：
//   currstat == RMAIL   → FOOTERMSG_MAIL_LONG  "(y)回信 (h)說明 (←/q)離開 "
//   currstat == READING → FOOTERMSG_READ_LONG  "(y)回應(X%)推文(h)說明(←)離開 "
//                       / FOOTERMSG_READ_MID   "(y)回應(X/%)推文 (←)離開 "
//   其餘（精華區 more()、進板畫面…）→ FOOTERMSG_SHORT / VERYSHORT（兩者都沒有「回應」）
//
// **推論只能單向**：含「回應」⇒ READING（RMAIL 分支排在最前面，不可能印出「回應」）。
// 反向不成立——上面 part3 那段已寫明它會**整段消失**（avail <= 0 / 塞不下只填空白），
// 所以「沒有回應」只代表**不確定**，呼叫端一律要降級到不依賴 s/# 的安全路徑。
// 'mail' 只用來挑失敗訊息的措辭，永遠不可拿它當唯一判準。
export function parsePagerFooterContext(lastRowText) {
  var str = lastRowText || '';
  if (str.indexOf('回應') >= 0) return 'reading';
  if (str.indexOf('回信') >= 0) return 'mail';
  return 'unknown';
}

export function parseStatusRow(str) {
  var result = STATUS_ROW_RE.exec(str);

  if (result && result.length === 6) {
    return {
      pageIndex:     parseInt(result[1]),
      pageTotal:     parseInt(result[2]),
      pagePercent:   parseInt(result[3]),
      rowIndexStart: parseInt(result[4]),
      rowIndexEnd:   parseInt(result[5])
    };
  }

  return null;
};

// 選單畫面底部狀態列＝ MENU 指紋（term_buf.setPageState / classifyListScreen）。
// 官方 mbbsd/menu.c#show_status，經 vbarf（\t 之後靠右對齊）組出：
//   "[%d/%d 星期%c%c %d:%02d]" "%-14s" " 線上" "%d" "人, 我是" "%s" "\t[呼叫器]" "%s "
// 兩個必須照著寫的細節：
//  1. 「]」後**緊接** SHM->today_is（%-14s 左對齊）——不保證有空格，舊版寫成
//     "\] " 會在 today_is 首字非空白時整條失配。
//  2. 呼叫器狀態取自 mbbsd/var.c#str_pager_modes[PAGER_MODES]，共五種；舊版只認
//     前兩種，使用者設成拔掉／防水／好友時主選單就認不出來（離板交易的 expect
//     永不完成 → 卡住）。
const PAGER_MODES = ['關閉', '打開', '拔掉', '防水', '好友']; // str_pager_modes
const LIST_ROW_RE = new RegExp(
  /\[\d{1,2}\/\d{1,2} +星期. +\d{1,2}:\d{2}\].* 線上\d+人, 我是\w+ +\[呼叫器\]/.source +
  '(?:' + PAGER_MODES.join('|') + ') '
);

export function parseListRow(str) {
  return LIST_ROW_RE.test(str);
};

// \u6c34\u7403\uff0f\u5ee3\u64ad\u3002\u5403\u7684\u662f b2u(\u539f\u59cb WS bytes)\uff08pttchrome.jsx\uff09\uff0c\u4e0d\u662f\u6e32\u67d3\u5f8c\u7684\u756b\u9762\u3002
// \u5b98\u65b9 mbbsd/mbbsd.c#show_call_in \u2192 mbbsd/kaede.c#outmsg\uff1a
//   \u4e00\u822c        ANSI_COLOR(1;33;46) "\u2605%s" ANSI_COLOR(37;45) " %s " ANSI_RESET
//   PLAY_ANGEL  ANSI_COLOR(1;37;46) "\u2605%s" ANSI_COLOR(37;45) " %s " ANSI_RESET
//
// **\u91cd\u8981\uff1awire \u4e0a\u7684 ANSI \u4e0d\u662f source \u7684\u5b57\u9762\u5e8f\u5217\u3002** PTT \u7528 pfterm\uff08mbbsd/Makefile
// \u7684 USE_PFTERM \u5206\u652f\u7de8 pfterm.o\uff09\uff0c\u5b83\u628a\u756b\u9762\u5b58\u6210 attribute \u9663\u5217\uff0c\u8f38\u51fa\u6642\u7531
// mbbsd/pfterm.c#fterm_chattr **\u91cd\u65b0\u7522\u751f**\u6700\u77ed\u5e8f\u5217\uff0c\u683c\u5f0f\u56fa\u5b9a\u70ba
//   ESC "[" [0;] [1;] [5;] [3<fg>;] [4<bg>] "m"
// \u5176\u4e2d "0" \u53ea\u5728\u300cbold/blink \u7531\u958b\u8f49\u95dc\u300d\u6216\u300cfg/bg \u8b8a\u56de\u9810\u8a2d\u300d\u6642\u51fa\u73fe\uff0c\u4e14
// FTCONF_WORKAROUND_BOLD \u6703\u5728 fg==\u9810\u8a2d(7) \u6642\u5f37\u5236\u88dc\u5370 "37"\u3002
// \u64da\u6b64\u63a8\u5c0e\u672c\u5217\uff1a\u9810\u8a2d attr \u2192 1;33;46 \u5f97 ESC[1;33;46m\uff08bold 0\u21921\u3001fg 3\u3001bg 6\uff09\uff1b
// \u63a5\u8457\u5207\u5230 bold+fg7+bg5 \u6642\uff0c\u56e0 fg \u56de\u5230\u9810\u8a2d\u503c\u800c\u89f8\u767c reset\uff0c\u5f97 ESC[0;1;37;45m
// \u2014\u2014 \u6b63\u662f\u7dda\u4e0a\u5be6\u969b\u89c0\u5bdf\u5230\u7684\u5e8f\u5217\u3002
// \u76f8\u5c0d\u820a\u7248\u653e\u5bec\u4e09\u8655\uff1a
//   - \u958b\u982d 1;33;46\uff08\u4e00\u822c\uff09\uff0f1;37;46\uff08\u5c0f\u5929\u4f7f\uff09
//   - \u4e2d\u6bb5\u6536 "37;45"\uff08upstream \u5b57\u9762\uff09\u8207 "0;1;37;45"\uff08\u7dda\u4e0a pfterm \u7522\u7269\uff09\u5169\u7a2e
//   - \u5c3e\u7aef ESC "[K"\uff08\u6e05\u5230\u884c\u5c3e\uff09\u53ea\u6709\u65b0\u8a0a\u606f\u6bd4\u524d\u4e00\u5247\u77ed\u6642\u624d\u6703\u9001\uff0c\u820a\u7248\u5f37\u5236\u8981\u6c42\u5b83
//     \u2192 \u8a0a\u606f\u8b8a\u9577\u7684\u90a3\u4e00\u5247\u6574\u500b\u6f0f\u6293
const WATERBALL_RE =
  /\x1b\[1;3[37];46m\u2605(\w+)\x1b\[(?:0;1;)?37;45m (.+?) \x1b\[m/;
// \u5ee3\u64ad\uff0f\u7cfb\u7d71\u8a0a\u606f\uff1adoupdate \u7684 rel_move \u5148\u628a\u6e38\u6a19\u5b9a\u4f4d\u5230\u5e95\u5217\u518d\u4e0a\u8272\u3002
const BROADCAST_RE =
  /\x1b\[24;\d{2}H\x1b\[1;37;45m([^\x1b]+)(?:\x1b\[24;18H)?\x1b\[m/;

export function parseWaterball(str) {
  var result = WATERBALL_RE.exec(str);
  if (result && result.length == 3) {
    return { userId: result[1], message: result[2] };
  } else {
    result = BROADCAST_RE.exec(str);
    if (result && result.length == 2) {
      return { message: result[1] };
    }
  }

  return null;
};

export function ansiHalfColorConv(it) {
  var str = '';
  var regex = new RegExp('\x15\\[(([0-9]+)?;)+50m', 'g');
  var result = null;
  var indices = [];
  while ((result = regex.exec(it))) {
    indices.push(result.index + result[0].length - 4);
  }

  if (indices.length === 0) {
    return it;
  }

  var curInd = 0;
  for (var i = 0; i < indices.length; ++i) {
    var ind = indices[i];
    var preEscInd = it.substring(curInd, ind).lastIndexOf('\x15') + curInd;
    str += it.substring(curInd, preEscInd) + '\x00' + it.substring(ind+4, ind+5) + it.substring(preEscInd, ind) + 'm';
    curInd = ind+5;
  }
  str += it.substring(curInd);
  return str;
};
