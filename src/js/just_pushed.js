// 推完文短暫標出自己剛推的那幾則（P42，pref markJustPushed，預設開）。設計見
// docs/long-push.md「剛推的那幾則」。
//
// 長推文一鍵發送（含底部推文列）整段送完、落回文末後，把畫面上自己剛推的那幾則淡淡亮一下
// （約 2 秒，CSS 動畫淡出）。**只看畫面、一個 byte 都不送**；認不出就什麼都不標：
//   - 帳號＝推文輸入列上的 id（LongPushSession._userId），沒有就退回選單底列記下的登入者；
//   - 時間＝推文列尾的 `MM/DD HH:mm`，要落在「開始送出前 1 分鐘」到「現在後 1 分鐘」之內
//     （PTT 寫的是台北時間；本機時鐘差太多 ⇒ 對不上 ⇒ 不標）；
//   - 從畫面最下面往上找，最多標 count（＝這次送出的則數）則。
// 跨列耦合只有「被併進哪一塊」（同作者推文合併 ⇒ 標在塊的第一列），與 applyNewCommentsMark
// 同一種寫法：只寫 result[row]，key 進 annotationsKey（設定、到期各翻一次 ⇒ 那一幀全量重算）。

import { COMMENT_TIME_RE } from './string_util';

// 標多久（ms）。CSS 動畫（main.css .justPushed）同長；到期後清掉狀態重畫一次。
export const JUST_PUSHED_MS = 2000;
// 時間窗的前後寬限（ms）：PTT 的時間只到分、本機時鐘可能差一點。
const SLACK_MS = 60 * 1000;

const TAIPEI_FMT =
  typeof Intl !== 'undefined'
    ? new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Taipei',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      })
    : null;

// ms → 'MM/DD HH:mm'（台北時間）。
export function taipeiMinute(ms) {
  if (!TAIPEI_FMT) return null;
  const p = {};
  for (const part of TAIPEI_FMT.formatToParts(new Date(ms))) p[part.type] = part.value;
  return p.month + '/' + p.day + ' ' + p.hour + ':' + p.minute;
}

// [since − 1 分, now + 1 分] 之間每一分鐘的 'MM/DD HH:mm'。送很久（冷卻等待）也只是多幾格。
export function justPushedMinutes(since, now) {
  const out = [];
  const end = now + SLACK_MS;
  for (let t = since - SLACK_MS; t <= end; t += 60 * 1000) {
    const m = taipeiMinute(t);
    if (m && out[out.length - 1] !== m) out.push(m);
  }
  const last = taipeiMinute(end);
  if (last && out[out.length - 1] !== last) out.push(last);
  return out;
}

// 推文列尾的時間 → 'MM/DD HH:mm'（月份補成兩位）；不是推文列尾就 null。
export function commentMinute(text) {
  const t = typeof text === 'string' && text.match(COMMENT_TIME_RE);
  if (!t) return null;
  const m = t[0].trim().match(/^(\d{1,2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  return (m[1].length === 1 ? '0' + m[1] : m[1]) + '/' + m[2] + ' ' + m[3] + ':' + m[4];
}

// enhance.justPushed ＝ { key, userid, count, minutes }（term_view.justPushedEnhance）。
export function applyJustPushedMark(result, texts, enhance) {
  const jp = enhance && enhance.justPushed;
  if (!jp || !jp.userid || !(jp.count > 0) || !jp.minutes || !jp.minutes.length) return;
  let left = jp.count;
  for (let r = result.length - 1; r >= 0 && left > 0; --r) {
    const a = result[r];
    if (!a || a.userid !== jp.userid || a.hidden || a.type == null) continue;
    const minute = commentMinute(texts && texts[r]);
    if (!minute || jp.minutes.indexOf(minute) < 0) continue;
    --left;
    const row = a.mergedIntoComment != null ? a.mergedIntoComment : r;
    if (result[row] && !result[row].justPushed) result[row] = { ...result[row], justPushed: true };
  }
}
