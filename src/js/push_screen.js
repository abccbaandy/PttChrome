// PTT 推文流程的**畫面判讀**（無 DOM／無網路，unit 守護：tests/unit/push_screen.test.js）。
//
// 「server 這一幀在等我們做什麼」——把 24 列純文字分類成呼叫端看得懂的事件。
// 消費者兩個，刻意共用同一套判斷（**不要在任何一邊另寫 regex**）：
//   long_push_session.js  逐則送出時決定下一步送什麼鍵
//   image_upload.js       上傳完的網址要送進推文輸入列，還是只複製到剪貼簿
// 分歧的代價實錄（2026-08-28）：image_upload 當年自己判「推文列」時只認 '→ id:'，
// 而 prompt 的型別符有 推／噓／→ 三種 ⇒ 最常按的 1.值得推薦 一律判不到，症狀是
// 「上傳完都說不在推文框」。
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

import { COMMENT_TIME_RE } from './string_util';

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
  // 列，不是可以打字的地方——舊的 parsePushInitText（已移除）當年漏了這條，把第一則 → 推文
  // 誤認成輸入列）。
  const m = PUSH_PROMPT_RE.exec(last);
  if (m && !COMMENT_TIME_RE.test(last))
    return { kind: 'inputPrompt', type: m[1], userId: m[2] };

  return { kind: 'other' };
}
