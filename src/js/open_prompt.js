// 開文的 ⏎ 送出後，PTT 沒有開文、而是先在底列問使用者一個問題。
//
// 已知的一種（upstream pttbbs f1a32e2，more.c#live_check_repeat）：同一篇連續開
// LIVE_AUTO_PROMPT_REPEAT（10）次後，第 11 次開文前 vans「要直接進入實況模式看新推文嗎？ [Y/n]: 」，
// 畫在列表殘影的底列（還沒 clear）。答案不是 n 就跳過 pmore 直接進實況（pmore.c#_pmore2 的
// start_live；實況只認 q 離開，離開回到文章列表）。我們自己的重新整理（AID 重開）、列表好讀開文、
// AID 跳文都會算進這個次數。
//
// 這題只有使用者能答 ⇒ 開文的交易一看到「游標在輸入欄」（term_buf.isPromptPending，本幀事實）
// 就馬上停手、切原生把問題畫出來，**一個鍵都不替使用者送**（Y 是預設，任何鍵＋⏎ 都會進實況）。
// 不停的話：開文步驟等到逾時（列表好讀 1.2 秒、AID 跳文 3 秒）期間凍著畫面、吞掉使用者的鍵，
// 最後報成「開啟文章失敗」。認法刻意通用（不比字樣）：開文回應是任何輸入欄都是在問使用者，
// 字樣只用來把提示寫清楚。

import { parseActivityAlert, activityAlertHint, isActivityAlertHint } from './activity_alert';

// 開文的回應是不是一個等使用者回答的 prompt；是 ⇒ 回提示字，否則 null。
// 只認**底列**的輸入欄（vans／getdata(b_lines…)）：開文途中慢網路切出來的半幀，游標可能剛好停在
// 檔頭反白標籤上，那不是問題（底列的 pmore 狀態列已由 isCursorOnInputField 排除）。
//
// 另一種只有使用者能處理的回應：PTT 的「使用限制」整頁（activity_alert.js；upstream f369626a 起
// 開文前可能先畫「限速中」通知）。它是 pressanykey 不是輸入欄，但一樣要停手、不替使用者按掉
// ⇒ 回 activityAlertHint 的整句（openPromptHint 原樣轉出）。
export function openPromptText(buf) {
  if (!buf || typeof buf.isPromptPending !== 'function') return null;
  const alert = activityAlertOn(buf);
  if (alert) return activityAlertHint(alert);
  if (buf.cur_y !== buf.rows - 1 || !buf.isPromptPending()) return null;
  const text = typeof buf.inputPromptText === 'function' ? buf.inputPromptText() : '';
  return String(text || '').trim() || '?';
}

function activityAlertOn(buf) {
  if (typeof buf.getRowText !== 'function' || !buf.rows) return null;
  const rowTexts = [];
  for (let y = 0; y < buf.rows; ++y) rowTexts.push(buf.getRowText(y, 0, buf.cols));
  return parseActivityAlert(rowTexts, buf.rows);
}

// 底列是不是 live_check_repeat 那一題（「要直接進入實況模式看新推文嗎？ [Y/n]: 」）。
// 只比字樣的前半：[Y/n] 與後面的游標欄是 vans 的固定格式，字樣本身才是指紋。
export function isLiveRepeatPrompt(lastRowText) {
  return /要直接進入實況模式看新推文嗎/.test(String(lastRowText || ''));
}

// 婉拒的答案。vans 是 vgets(buf, 3, VGET_LOWERCASE)：要帶 ⏎ 才送出，答案不是 'n' 就進實況。
//
// **只有「⏎ 是我們替使用者按、目的就是回到文章」的交易才可以替他答 n**（長推文的重開文章：
// 每段推文都要開回去一次，使用者推個幾段就撞上這題，而他從頭到尾都沒有要進實況）。
// 使用者自己的開文（列表好讀、AID 跳文／重新整理）仍照上面的規則停手讓他答。
export const LIVE_REPEAT_DECLINE = 'n\r';

// 給使用者看的提示。
export function openPromptHint(text) {
  if (isActivityAlertHint(text)) return text;
  if (/實況模式/.test(text)) return 'PTT 問你要不要直接進入實況模式（同一篇連開多次），請直接回答';
  return 'PTT 開文前在問：' + text + ' 請直接回答';
}
