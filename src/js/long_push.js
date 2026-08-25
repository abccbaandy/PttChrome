// 長推文一鍵發送的純邏輯（無 DOM／無網路，unit 守護：tests/unit/long_push_*.test.js）。
//
// 一次打一大段話 → 依 PTT 單則推文的 Big5 byte 上限自動分段 → 由
// long_push_session.js 逐則送出。這裡只負責「算得出來」的部分：字元過濾、長度上限、
// 分段、以及把 server 吐的畫面分類成狀態機看得懂的事件。
//
// ---- PTT 推文互動序列（反查 3rd_script/pttbbs，逐字比對 Big5 原始碼）----
// 進入點 mbbsd/bbs.c:4591 `{1, recommend} // 'X'`（'%' 同）；文章內按 X 走
// more.c:91-93 → RET_DORECOMMEND → bbs.c:2467 recommend()。畫面序列（底列＝b_lines）：
//
//   0  擋人橫幅   vmsg/vmsgf → " ◆ <訊息>" ＋右靠 " [按任意鍵繼續]"
//                 （include/vtuikit.h:41-42 VMSG_MSG_PREFIX / VMSG_MSG_FLOAT）
//                 vtuikit.c:439-455 的 vmsg 會等一個按鍵才消失。
//   1a 型別選單   "您覺得這篇文章 1.值得推薦 2.給它噓聲 3.只加→註解 [1]? "
//                 （bbs.c:2981-2994；禁噓板 BRD_NOBOO 不印 "2."，"3." 仍是 3）
//                 bbs.c:2996 是 vkey() ⇒ **送單一 byte，絕不可帶 Enter**
//                 （Enter 會被下一個 getdata 吃掉 → 空內容 → 整則靜默取消）。
//   1b 作者本人   row b_lines-1 "作者本人, 使用 → 加註方式"（bbs.c:2957-2961）
//   1c 時間太近   row b_lines-1 "時間太近, 使用 → 加註方式"（bbs.c:2968-2974，
//                 now - lastrecommend < 90，寫死 90 秒）
//                 1a/1b/1c 是 if/else if/else **互斥**：1b/1c 沒有型別選單，
//                 這時送 "1" 會直接變成推文內容。第 2 段起 90 秒內一定走 1c。
//   2  警告橫幅   匿名板／特殊列表模式（bbs.c:3016-3038），不需輸入。
//   2.5 小天使    "要使用小天使匿名推文嗎？ [Y/n]: "（bbs.c:3055，vans → 要 Enter，
//                 **空 Enter ＝ 匿名 YES**，所以要明確送 n）。
//   3  內容輸入   "推 <id>:" ＋ maxlength 格反白欄（bbs.c:3079-3086）。
//                 送 Big5 內容 ＋ Enter；空字串 ＝ 取消整則。
//   4  確認       "… 確定[y/N]:"（bbs.c:3094）。sizeof(ans)==2 ⇒ 只吃一個字元，
//                 送 y ＋ Enter。（原始碼的 :w / zz 分支打不進去，是死碼。）
//   5  寫檔後 return FULLUPDATE（bbs.c:2467 的 caller 也是）⇒ 回文章列表。
//      **但 term.ptt.cc 有私有 commit**（docs/pttbbs-screen-protocol.md §12），
//      落地也可能仍在文章 —— 兩者都可以直接再按 X 推同一篇（列表按 X 推的是
//      游標所在文章，recommend 不移動游標），所以狀態機對兩種落地都免疫。
//
// 詳見 docs/long-push.md 與 docs/pttbbs-screen-protocol.md §11.3。

import { u2b, COMMENT_TIME_RE } from './string_util';

// 型別選單的按鍵（bbs.c:2996-3010：vkey() 取一個 byte，'1'..'3' → RECTYPE_GOOD/
// BAD/ARROW，非數字一律 RECTYPE_DEFAULT ＝ 推）。
export const PUSH_TYPE_KEY = { push: '1', boo: '2', arrow: '3' };

// vmsg 橫幅的前綴／後綴（include/vtuikit.h:41-42）。
const VMSG_PREFIX = '◆';
const VMSG_FLOAT = '[按任意鍵繼續]';

// 「等冷卻就會過」的訊息。秒數一律由 parseCooldownSeconds 從訊息本文取，
// 這裡只決定「這是可以等的」還是「等了也沒用」。
const COOLDOWN_RE = [
  /本板禁止快速連續推文/, // bbs.c:2894  板主可設 5-240 秒
  /本文已過長, ?禁止快速連續推文/, // bbs.c:2927  >100KiB 文章固定 10 秒
  /冷靜一下吧/, // bbs.c:4351  check_cooldown BRD_COOLDOWN
  /間隔太近囉/ // bbs.c:4365  check_cooldown REJECT_FLOOD_POST
];

// 有秒數但**等完照樣擋**（posttimesof == 0xf 是懲罰狀態，bbs.c:4356），
// 以及使用者定案要中止的「同一分鐘 >60 則」（bbs.c:2909）。
const FATAL_WITH_TIME_RE = [/您被設退文/, /系統禁止短時間內大量推文/];

// 內容輸入列／確認列的共同前綴：型別符 ＋ 空白 ＋ id ＋（可選補空白）＋ ':'。
// id 規則同 comment_parse.js 的 COMMENT_RE（common/bbs/names.c#is_validuserid：
// 首字 isalpha、其餘 isalnum、長度 2..IDLEN(12)）。
const PUSH_PROMPT_RE = /^(推|噓|→) ([A-Za-z][0-9A-Za-z]{1,11}) *:/;

// 確認列（bbs.c:3094，注意 "確定" 前面那個空白是格式的一部分）。
const CONFIRM_TEXT = ' 確定[y/N]:';

// 已完成的推文列（判 IP 記錄板用）。時間戳前若有一個獨立的 IPv4 token，
// 這塊看板就是 BRD_IPLOGRECMD（或使用者是 guest）——欄位知識同
// comment_merge.js#commentContentCells，那邊逐格掃 TermChar，這裡只看純文字。
const DONE_COMMENT_RE =
  /^(?:推|噓|→) [A-Za-z][0-9A-Za-z]{1,11} *:.*?(?:\s(\d{1,3}(?:\.\d{1,3}){3}))?\s\d{1,2}\/\d{2} \d{2}:\d{2}\s*$/;

// ---------------------------------------------------------------------------
// 字元過濾
// ---------------------------------------------------------------------------

// u2b（string_util.js:103）對轉不出 Big5 的字元回 '\xFF\xFD'，而 telnet.js:170
// 自己註明 `XXX Should do escape on IAC.` —— 0xFF 就是 telnet IAC，送出去會被
// server 當成 telnet 命令而不是文字（emoji 是最常見的來源）。所以送出前一定要先
// 濾掉，並把濾掉了什麼告訴使用者。
export function stripNonBig5(text) {
  const src = String(text == null ? '' : text);
  let out = '';
  const dropped = [];
  for (let i = 0; i < src.length; ++i) {
    const ch = src.charAt(i);
    // 換行留給分段當強制斷點，其餘控制字元一律丟（ESC 進 vgetstring 會變成
    // escape sequence，見 string_util.PASTE_ESC_CHAR 的說明）。
    if (ch === '\n' || ch === '\r') {
      out += '\n';
      continue;
    }
    if (ch < ' ' || ch === '\x7f') {
      dropped.push(ch);
      continue;
    }
    if (ch < '\x80') {
      out += ch;
      continue;
    }
    // surrogate pair（emoji）：兩個 code unit 都轉不出 Big5，各自被丟掉一次，
    // 但對使用者只是「一個字不見了」——合成回原字再記錄。
    const code = src.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      dropped.push(src.substr(i, 2));
      ++i;
      continue;
    }
    if (u2b(ch) === '\xff\xfd') {
      dropped.push(ch);
      continue;
    }
    out += ch;
  }
  return { text: out, dropped };
}

// stripNonBig5 之後，非 ASCII 的字元一定是 Big5 雙 byte 字 ⇒ 不必再查表。
export function big5ByteLength(text) {
  let n = 0;
  for (let i = 0; i < text.length; ++i) n += text.charAt(i) < '\x80' ? 1 : 2;
  return n;
}

// ---------------------------------------------------------------------------
// 長度上限
// ---------------------------------------------------------------------------

// bbs.c:3043-3078
//   maxlength = 78 - 3(lead) - 6(date) - 1(space) - 6(time)      = 62
//               [- 15 if (BRD_IPLOGRECMD || isGuest)]            → 47
//               - strlen(myid)
// term.ptt.cc 的私有版本在 ':' 後多一格空白，實測比上游少一格
// （docs/pttbbs-screen-protocol.md §11.1／§12）⇒ 61 / 46。
// vgetstring 的 size check 是 `iend+1 >= len → bell()`（vtuikit.c:1399）
// ⇒ 真正打得進去的是 maxlength - 1 bytes。
export function pushMaxBytes(opts) {
  const o = opts || {};
  const idLen = (o.userId || '').length || 12; // 拿不到 id 就用 IDLEN 保守估
  const base = o.ipLogged === false ? 61 : 46; // 判不出來時當 IP 板（較短＝安全）
  return Math.max(1, base - idLen - 1);
}

// 掃畫面上已完成的推文列，判斷這塊看板記不記 IP。
// 回 true/false；一列都認不出來回 null（呼叫端保守當 true）。
export function detectIpLogged(rowTexts) {
  if (!rowTexts) return null;
  let seen = null;
  for (let i = 0; i < rowTexts.length; ++i) {
    const m = DONE_COMMENT_RE.exec(rowTexts[i] || '');
    if (!m) continue;
    if (m[1]) return true; // 看到一列有 IP 就確定了
    seen = false;
  }
  return seen;
}

// ---------------------------------------------------------------------------
// 分段
// ---------------------------------------------------------------------------

// 優先在這些字元「之後」斷（使用者定案：優先標點／空白斷，不加 (1/3) 序號）。
const BREAK_AFTER_RE = /[\s,.;:!?)\]}，、。；：！？）」』】》〉…]/;
// 回退找斷點時最多讓一段短掉幾成——找太遠會切出一堆碎段。
const MAX_BACKTRACK_RATIO = 0.35;

// text（已過 stripNonBig5）→ 每則推文 { text, end }，end ＝「原文消費到哪個 index」
// （exclusive）。狀態機拿它推進位移，所以「尚未送出的內容」永遠是**原文的一段
// slice**——中途取消時複製給使用者的就是他原本打的字，不是被切開又接回去的版本；
// 長度上限中途變動（long_push_session 會用畫面校正它）時，也只要拿剩下那段重切，
// 段落不會愈接愈碎。
//
// maxBytes ＝ pushMaxBytes()。段末若是全形字會再自動少收 1 byte：vgetstring 的
// DBCS 保護是 `c > 0x80 && vkey_is_ready() && len - iend < 3 → vkey_purge()`
// （vtuikit.c:1404-1411）——Big5 的第二個 byte 常常也 > 0x80，一旦踩到，purge 會把
// 後面那個 Enter 一起清掉 ⇒ 推文停在輸入列，整條序列卡死。少收一個 byte 換免疫。
export function splitPushSpans(text, maxBytes) {
  const limit = Math.max(2, maxBytes | 0);
  const src = String(text == null ? '' : text);
  const out = [];
  let pos = 0;
  for (;;) {
    const nl = src.indexOf('\n', pos);
    const lineEnd = nl < 0 ? src.length : nl;
    let cursor = pos;
    while (cursor < lineEnd) {
      const line = src.slice(cursor, lineEnd);
      // 1. 先吃到「不超過上限」為止。
      let bytes = 0;
      let end = 0;
      while (end < line.length) {
        const w = line.charAt(end) < '\x80' ? 1 : 2;
        if (bytes + w > limit) break;
        bytes += w;
        ++end;
      }
      // 2. 段末是全形字時保留 1 byte 餘裕（見上面的 vkey_purge 說明）。
      if (end < line.length && bytes === limit && line.charAt(end - 1) >= '\x80')
        --end;
      // 3. 還有剩 → 往回找標點／空白斷點，切在它後面。
      if (end < line.length) {
        const floor = Math.max(1, Math.ceil(end * (1 - MAX_BACKTRACK_RATIO)));
        for (let k = end; k >= floor; --k) {
          if (BREAK_AFTER_RE.test(line.charAt(k - 1))) {
            end = k;
            break;
          }
        }
      }
      if (end <= 0) end = 1; // 保底：單一字元就比上限長時也要前進
      const seg = line.slice(0, end).trim();
      // 斷點後的空白是分隔符，跟著上一段一起消費掉。
      let next = cursor + end;
      while (
        next < lineEnd &&
        (src.charAt(next) === ' ' || src.charAt(next) === '\t')
      )
        ++next;
      if (seg) out.push({ text: seg, end: next });
      cursor = next;
    }
    if (nl < 0) break;
    pos = lineEnd + 1;
  }
  return out;
}

// 只要內容、不要位移時的便利包裝。
export function splitPushSegments(text, maxBytes) {
  return splitPushSpans(text, maxBytes).map((s) => s.text);
}

// ---------------------------------------------------------------------------
// 畫面分類
// ---------------------------------------------------------------------------

// " ◆ 訊息 …            [按任意鍵繼續]" → "訊息"；不是 vmsg 橫幅回 null。
export function parseVmsgText(rowText) {
  const raw = String(rowText == null ? '' : rowText);
  const at = raw.indexOf(VMSG_PREFIX);
  if (at < 0 || raw.slice(0, at).trim() !== '') return null;
  let msg = raw.slice(at + VMSG_PREFIX.length);
  const floatAt = msg.indexOf(VMSG_FLOAT);
  if (floatAt >= 0) msg = msg.slice(0, floatAt);
  return msg.trim();
}

// "請再等 N 秒"（bbs.c:2894 / 2927）與 "(限制 M 分 S 秒)"（bbs.c:4351 等）
// 兩種寫法 → 秒數；認不出來回 null。
export function parseCooldownSeconds(msg) {
  const s = String(msg == null ? '' : msg);
  let m = /請再等\s*(\d+)\s*秒/.exec(s);
  if (m) return parseInt(m[1], 10);
  m = /限制\s*(\d+)\s*分\s*(\d+)\s*秒/.exec(s);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return null;
}

// server 這一幀在等我們做什麼？rowTexts ＝ 原生 24 列的純文字（facts.rowTexts）。
// 回 { kind, ... }：
//   'typeMenu'    型別選單（booAllowed ＝ 這塊板讓不讓噓）
//   'inputPrompt' 內容輸入列（userId ＝ 從 prompt 讀到的自己的帳號）
//   'confirm'     確定[y/N]
//   'angel'       小天使匿名詢問
//   'cooldown'    可以等的冷卻（waitSec / message）
//   'fatal'       等了也沒用的擋人訊息（message）
//   'other'       都不是（呼叫端自行判斷是不是已經回到文章／列表）
export function classifyPushScreen(rowTexts, rows) {
  const n = rows == null ? (rowTexts ? rowTexts.length : 0) : rows;
  const last = String((rowTexts && rowTexts[n - 1]) || '');

  const vmsg = parseVmsgText(last);
  if (vmsg !== null) {
    const fatalTimed = FATAL_WITH_TIME_RE.some((re) => re.test(vmsg));
    const waitSec = fatalTimed ? null : parseCooldownSeconds(vmsg);
    if (!fatalTimed && COOLDOWN_RE.some((re) => re.test(vmsg)))
      return {
        kind: 'cooldown',
        waitSec: waitSec == null ? 10 : waitSec,
        message: vmsg
      };
    // 未知的 ◆ 訊息一律當致命：亂猜著繼續送鍵比停下來危險得多。
    return { kind: 'fatal', message: vmsg };
  }

  if (last.indexOf('您覺得這篇文章 ') === 0)
    return { kind: 'typeMenu', booAllowed: last.indexOf('2.') >= 0 };

  if (last.indexOf('要使用小天使匿名推文嗎？') >= 0) return { kind: 'angel' };

  if (last.indexOf(CONFIRM_TEXT) >= 0) return { kind: 'confirm' };

  // 內容輸入列：型別符 + id + ':' 且**沒有行尾時間戳**（有時間戳的是已完成的推文
  // 列，不是可以打字的地方——parsePushInitText 當年就是漏了這條才把第一則 → 推文
  // 誤認成輸入列）。
  const m = PUSH_PROMPT_RE.exec(last);
  if (m && !COMMENT_TIME_RE.test(last))
    return { kind: 'inputPrompt', type: m[1], userId: m[2] };

  return { kind: 'other' };
}
