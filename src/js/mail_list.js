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

// 欄位標題列是第幾列（卡片模式收起它）；沒有回 -1。
export function mailHeaderRow(rowTexts) {
  if (!Array.isArray(rowTexts)) return -1;
  for (let y = 0; y <= HEADER_MAX_ROW && y < rowTexts.length; ++y)
    if (MAIL_HEADER_RE.test(rowTexts[y])) return y;
  return -1;
}
