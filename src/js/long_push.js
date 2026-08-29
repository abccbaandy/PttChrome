// 長推文一鍵發送的**送出端**純邏輯（無 DOM／無網路，unit 守護：
// tests/unit/long_push_split.test.js）。
//
// 一次打一大段話 → 依 PTT 單則推文的 Big5 byte 上限自動分段 → 由
// long_push_session.js 逐則送出。這裡只負責「算得出來」的部分：字元過濾、
// 長度上限、分段。
//
// **讀畫面的那一半在 push_screen.js**（classifyPushScreen／detectIpLogged 等）：
// 那是「server 這一幀在等什麼」的通用知識，圖片上傳（image_upload.js 決定網址
// 要送進推文列還是只複製）也在用，不是長推文專屬。
//
// 詳見 docs/long-push.md 與 docs/pttbbs-screen-protocol.md §11.3。

import { u2b } from './string_util';

// 型別選單的按鍵（bbs.c:2996-3010：vkey() 取一個 byte，'1'..'3' → RECTYPE_GOOD/
// BAD/ARROW，非數字一律 RECTYPE_DEFAULT ＝ 推）。
export const PUSH_TYPE_KEY = { push: '1', boo: '2', arrow: '3' };

// ---------------------------------------------------------------------------
// 字元過濾
// ---------------------------------------------------------------------------

// u2b（string_util.js:103）對轉不出 Big5 的字元回 '\xFF\xFD'（emoji 是最常見的
// 來源）。0xFF 的 telnet IAC 問題**已在傳輸層修掉**（telnet.js#_sendEscaped 對
// 資料路徑加倍，守護 tests/unit/telnet_iac.test.js），所以這裡過濾的理由只剩
// 顯示：那些字 PTT 畫不出來，而使用者不會知道自己打的字被吃了 ⇒ 送出前先濾掉，
// 並把濾掉了什麼告訴使用者。
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

