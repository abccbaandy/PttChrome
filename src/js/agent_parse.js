// agent 工具（agent_tools.js）的純解析：原生畫面文字 → 結構化資料。無 DOM、無網路。
//
// 列表欄位依 pttbbs mbbsd/bbs.c#readdoent（欄位表見 comment_parse.js 的 LIST_* 註解）：
//   cells 0-6 編號（置底列印 ★）、8 已讀標記、9-10 推文數、11-15 日期、17-28 作者、
//   29 起 mark＋標題。畫面字串一個全形字只佔一個 char 卻佔兩格 ⇒ 先展成「格」再切欄。

import {
  isListShapedRow,
  isDeletedListRow,
  isLockedListRow,
  parseListArticleNum,
  parseArticleHeader,
  parseArticleTitle,
  parseComment,
  parseModernCommentHeader,
  MODERN_COMMENT_BODY_MARK,
} from './comment_parse';
import { COMMENT_TIME_RE } from './string_util';

// 字串 → 每格一個元素（全形字後補一個空字串佔第二格）。Big5 來的畫面字元 >0x7F 一律雙寬。
function toCells(text) {
  const cells = [];
  for (const ch of text) {
    cells.push(ch);
    if (ch.charCodeAt(0) > 0x7f) cells.push('');
  }
  return cells;
}

const cellSlice = (cells, a, b) => cells.slice(a, b).join('');

// 看板文章列表的一列 → { num, pinned, deleted, locked, recommend, date, author, title, cursor }；
// 不是文章列 ⇒ null（判準沿用 isListShapedRow，表頭／說明列／空白列都不算）。
export function parseListEntry(text) {
  if (!isListShapedRow(text)) return null;
  const cells = toCells(text);
  const num = parseListArticleNum(text);
  const head = cellSlice(cells, 0, 7);
  return {
    num,
    pinned: num == null && head.indexOf('★') >= 0,
    deleted: isDeletedListRow(text),
    locked: isLockedListRow(text),
    recommend: cellSlice(cells, 9, 11).trim(),
    date: cellSlice(cells, 11, 16).trim(),
    author: cellSlice(cells, 17, 29).trim(),
    // mark 欄（□／R:／轉／鎖）留在標題前：R: 與轉 本身就是標題語意的一部分。
    title: cellSlice(cells, 29, cells.length).trim().replace(/^□\s*/, ''),
    cursor: /^>/.test(text),
  };
}

// 整張列表畫面 → 條目陣列（只掃條目區 rows 3..rows-2，表頭兩列與底列不碰）。
export function listEntriesFromScreen(rowTexts) {
  const out = [];
  for (let r = 3; r < rowTexts.length - 1; r++) {
    const e = parseListEntry(rowTexts[r]);
    if (e) out.push(e);
  }
  return out;
}

const TIME_HEADER_RE = /^\s*時間[:：]?\s+(\S.*?)\s*$/;
const HEADER_RULE_RE = /^\s*─+\s*$/;
const IP_TAIL_RE = /\s(\d{1,3}(?:\.\d{1,3}){3})\s*$/;

// 推文列 → { type, user, content, ip, time }；不是推文 ⇒ null。型別與帳號由
// comment_parse.parseComment 判（推/噓/→ 的版面在那邊已對過 pttbbs）。
export function parseCommentLine(text) {
  const c = parseComment(text);
  if (!c) return null;
  const m = text.match(/^\s*\S+\s+([^\s:]+)\s*:/);
  let rest = m ? text.slice(m[0].length) : text;
  let time = null;
  const t = rest.match(COMMENT_TIME_RE);
  if (t) {
    time = t[0].trim();
    rest = rest.slice(0, t.index);
  }
  let ip = null;
  const ipm = rest.match(IP_TAIL_RE);
  if (ipm) {
    ip = ipm[1];
    rest = rest.slice(0, ipm.index);
  }
  return {
    type: c.type,
    user: m ? m[1] : c.userid,
    content: rest.trim(),
    ip,
    time,
  };
}

// 新格式推文（post.svc，見 comment_parse.parseModernCommentHeader）的標頭列 →
// { type: 'modern', seq, user, content: '', ip, time }；內容由呼叫端把緊接的 `│` 列接上。
// 時間是 creation 原樣（`MM/DD/YYYY HH:MM`），與舊格式的 `MM/DD HH:MM` 不同形。
const MODERN_TAIL_RE = /(?:\s(\d{1,3}(?:\.\d{1,3}){3}))?\s+(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})\s*$/;
export function parseModernCommentLine(text) {
  const h = parseModernCommentHeader(text);
  if (!h) return null;
  const m = text.match(/^\[\d+\] (\S+)/);
  const t = text.match(MODERN_TAIL_RE);
  return {
    type: 'modern',
    seq: h.seq,
    user: m[1],
    content: '',
    ip: t && t[1] ? t[1] : null,
    time: t ? t[2] : null,
  };
}

// 文章全文（每列一個字串）→ { author, board, title, time, content, comments }。
// 檔頭只在前幾列（pmore 從第 1 行畫起）；沒有檔頭的特殊文章各欄回 null。
// content＝推文以外的所有列（去掉檔頭與其下的分隔線），保留原本的換行。
export function parseArticleLines(lines) {
  let i = 0;
  let author = null;
  let board = null;
  let title = null;
  let time = null;
  const h = parseArticleHeader(lines[0] || '');
  if (h) {
    const m = (lines[0] || '').match(/^\s*作者[:：]?\s+(\S+)/);
    author = m ? m[1] : h.author;
    board = h.board;
    i = 1;
    const t = parseArticleTitle(lines[1] || '');
    if (t != null) {
      title = t;
      i = 2;
    }
    const tm = (lines[i] || '').match(TIME_HEADER_RE);
    if (tm) {
      time = tm[1];
      i++;
    }
    if (HEADER_RULE_RE.test(lines[i] || '')) i++;
  }
  const body = [];
  const comments = [];
  let modern = null; // 新格式推文：目前這一則（後面的 `│` 列是它的內容）
  for (; i < lines.length; i++) {
    const text = lines[i];
    if (modern && text.charAt(0) === MODERN_COMMENT_BODY_MARK) {
      const part = text.slice(1).trimEnd();
      modern.content = modern.content ? modern.content + '\n' + part : part;
      continue;
    }
    modern = parseModernCommentLine(text);
    if (modern) {
      comments.push(modern);
      continue;
    }
    const c = parseCommentLine(text);
    if (c) comments.push(c);
    else body.push(text);
  }
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return { author, board, title, time, content: body.join('\n'), comments };
}
