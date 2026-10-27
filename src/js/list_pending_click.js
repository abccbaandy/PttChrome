// 列表忙的時候點的那一下（P47，pref queueListClickWhenBusy，預設開）：列表正在跑到底／跳號／
// 補頁接合／原地重整這類凍結交易時點文章，原本只閃「處理中」就吞掉，要等交易結束再點一次。
// 現在記住**最後點的那一篇**，交易一結束、那篇還在列表上（同一個編號、同作者同主題、同一板）
// 就替使用者開，跟自己再點一次走同一條開文交易。對不上、等太久、交易收成原生／離開列表、
// 使用者在這期間按了別的鍵 ⇒ 作廢，一個 byte 都不送。設計見 docs/easy-reading-list.md
// 「忙時點的那一下」。純邏輯，tests/unit/list_pending_click.test.js 守。

import { subjectMatches } from './long_push_anchor';

// 從點下去到交易結束的上限。凍結交易的 watchdog 本身在幾秒內收尾；超過這個時間使用者早就
// 不記得點過了，替他開文只會嚇到人。
export const PENDING_CLICK_MS = 8000;

// 這一下能不能先記著：只有「還在這個列表上、只是畫面凍著」的交易才記。開文中（opening）、
// 讀文章中（suspended）、原生鏡像（native）不記：那些不是很快就會回到同一份列表。
export function canQueueListClick(state, renderMode) {
  if (renderMode === 'native') return false;
  return state === 'functionMode' || state === 'active';
}

// 每次可能是交易出口的時候問一次（settle、讀取中收掉）：
//   'none'  沒有記著的
//   'wait'  交易還沒結束
//   'open'  替使用者開（rowIdentity 是同一個編號那一列**現在**的身分）
//   'drop'  作廢（reason：expired／left＝收成原生或離開列表／board／moved＝那篇不在原處）
export function pendingClickDecision({ pending, state, renderMode, now, board, rowIdentity }) {
  if (!pending) return { action: 'none' };
  if (now - pending.at > PENDING_CLICK_MS) return { action: 'drop', reason: 'expired' };
  if (state === 'active' && renderMode === 'buffer') {
    if (board == null || board !== pending.board) return { action: 'drop', reason: 'board' };
    const id = pending.identity;
    if (!rowIdentity || !id || rowIdentity.author !== id.author || !subjectMatches(rowIdentity.subject, id.subject))
      return { action: 'drop', reason: 'moved' };
    return { action: 'open' };
  }
  if (canQueueListClick(state, renderMode)) return { action: 'wait' };
  return { action: 'drop', reason: 'left' };
}
