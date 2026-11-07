// 手機信件列表卡片（P31，docs/mobile.md「信件列表卡片」）的畫面判讀：純函式。
//
// 依據 mbbsd/mail.c#maildoent／mail_coldefs（PSB 欄位）：
//   編號欄 `%5d %c `（第 7 格是狀態：'+' 未讀、'M'／'m' 標記、'R'／'r' 已回、'D' 待刪、
//          空白＝已讀；大寫＝未讀）、日期欄 `%-6s`（ent->date，" 9/27"／"10/01"）、
//          作者欄 15 格、標題欄＝`◇`／`R:`／`轉` ＋空白＋標題。欄間 padding 1，左邊 1 格
//          給游標（`>`／`●`）。
// 真 PTT 跑私有 commit，欄寬可能不同 ⇒ 不靠欄位位置，用「編號 狀態? 日期 作者 標題」的
// 順序認；任一要素失配 ⇒ null（該列照舊畫格線）。整個畫面的指紋＝底列 caption 是信件
// 列表（screen_captions.MAIL_LIST_CAPTIONS）＋前幾列有「編號 日期 作者 標題」欄位標題列；
// 認不出 ⇒ 整個畫面照舊格線（認不出 ⇒ 原生）。
import { footerCaption, MAIL_LIST_CAPTIONS } from './screen_captions';

// 欄位標題列（「編號   日 期 作 者          信  件  標  題」，新舊版的空白數不同）。
export const MAIL_HEADER_RE = /編號\s+日\s*期\s+作\s*者\s+信\s*件\s*標\s*題/;
// 欄位標題列最多出現在第幾列（標題列、按鍵說明列之後；舊版少一列也吃）。
const HEADER_MAX_ROW = 3;
// 指紋要看的上方列數（term_buf 只解這幾列＋底列）。
export const MAIL_HEADER_SCAN_ROWS = HEADER_MAX_ROW + 1;

const MAIL_ROW_RE = /^([>●])?\s*(\d+)\s(?:([+MmRrD])\s)?\s*(\d{1,2}\/\d{2})\s+(\S+)\s+(\S.*?)\s*$/;
const UNREAD_MARKS = '+MR';

// 一列信件 → { num, mark, unread, date, author, kind, title, cursor }；不是信件列回 null。
// kind：'normal'（◇）｜'reply'（R:）｜'forward'（轉）；title 已去掉 ◇（R:／轉 保留在 kind）。
export function parseMailRow(text) {
  if (typeof text !== 'string') return null;
  const m = MAIL_ROW_RE.exec(text);
  if (!m) return null;
  let rest = m[6];
  let kind = null;
  if (/^◇\s/.test(rest)) kind = 'normal';
  else if (/^R:\s/.test(rest)) kind = 'reply';
  else if (/^轉\s/.test(rest)) kind = 'forward';
  if (!kind) return null;
  rest = rest.replace(/^(◇|R:|轉)\s+/, '');
  const mark = m[3] || ' ';
  return {
    num: Number(m[2]),
    mark: mark,
    unread: UNREAD_MARKS.indexOf(mark) >= 0,
    date: m[4],
    author: m[5],
    kind: kind,
    title: rest,
    cursor: !!m[1]
  };
}

// 底列是不是信件列表的 caption（便宜的第一關，term_buf 每幀先問它）。
export function isMailListFooter(lastRowText) {
  return MAIL_LIST_CAPTIONS.indexOf(footerCaption(lastRowText)) >= 0;
}

// 這個畫面是不是信件列表（rowTexts：每列文字）。
export function isMailListRows(rowTexts) {
  if (!Array.isArray(rowTexts) || rowTexts.length < 4) return false;
  if (!isMailListFooter(rowTexts[rowTexts.length - 1])) return false;
  for (let y = 0; y <= HEADER_MAX_ROW && y < rowTexts.length; ++y)
    if (MAIL_HEADER_RE.test(rowTexts[y])) return true;
  return false;
}

// 信箱超過上限的 vmsg（mail.c#chkmailbox「您保存信件數目 %d 超出上限 %d, 請整理」、
// #chkmailbox_tidy_limit「…遠超出上限…」）。出現在登入時（check_mailbox_quota）與郵件選單
// 按 ←（menu.c#menu_cmd_left：超額時 ← 不離開，只 vmsg 後把游標移到 (R)ead）⇒ 程式化的
// 「一路 ← 退回主功能表」在這裡永遠退不出去。兩個數字＋「請整理」都要對上才算。
const MAILBOX_OVER_LIMIT_RE = /您保存信件數目\s*\d+\s*遠?超出上限\s*\d+\s*,\s*請整理/;

export function isMailboxOverLimitNotice(lastRowText) {
  return typeof lastRowText === 'string' && MAILBOX_OVER_LIMIT_RE.test(lastRowText);
}

export const MAILBOX_OVER_LIMIT_HINT = '信箱超過上限，PTT 要先整理信件才能離開信箱';

// 信件列表上方的按鍵說明列（「[→]讀信 [z]信件夾 [~]資源回收筒 [/]搜尋 [a]找作者 …」，
// mail.c#mail_comms 的 CMD_PRIO_NORM 項目由 psb 畫成「[鍵]名稱」）。P59 手機卡片模式收起它
// （動作改在底部導覽）。只看這一列自己：整列都是「[鍵]名稱」、至少 3 項、出現在欄位標題列能出現
// 的範圍內（第 1～HEADER_MAX_ROW 列）。認不出 ⇒ 照舊縮小格線。
const KEY_HINT_ITEM_RE = /\[[^\s\]]{1,8}\]\S+|\[\]\]\S+/g;
export function isMailKeyHintRow(text, row) {
  if (typeof text !== 'string') return false;
  if (!(row >= 1 && row <= HEADER_MAX_ROW)) return false;
  const t = text.trim();
  if (!t || MAIL_HEADER_RE.test(t) || parseMailRow(text)) return false;
  const items = t.match(KEY_HINT_ITEM_RE) || [];
  if (items.length < 3) return false;
  return t.replace(KEY_HINT_ITEM_RE, '').trim() === '';
}

// 欄位標題列是第幾列（卡片模式收起它）；沒有回 -1。
export function mailHeaderRow(rowTexts) {
  if (!Array.isArray(rowTexts)) return -1;
  for (let y = 0; y <= HEADER_MAX_ROW && y < rowTexts.length; ++y)
    if (MAIL_HEADER_RE.test(rowTexts[y])) return y;
  return -1;
}
