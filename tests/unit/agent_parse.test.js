import {
  parseListEntry,
  listEntriesFromScreen,
  parseCommentLine,
  parseArticleLines,
} from '../../src/js/agent_parse';

// 列形取自 2026-10 live 八卦板畫面（帳號換成假的；欄位格數不變）。
const ROW = ' 780297 + 110/14 someuser1    □ [問卦] 三千替代役中第一人守得住街亭嗎？';
const ROW_2DIGIT = ' 780295 +1610/14 someuser2    □ [新聞] 標題文字';
const ROW_REPLY = ' 780291 + 110/14 someuser3    R: [新聞]淡江電機所僅1人上課';
const ROW_CURSOR = '>780296 + 110/14 someuser4    □ [問卦] 游標所在列';
const PIN_BOOM = '    ★  m爆 7/30 boardmod     □ [公告] 禁止張貼一年';
const PIN_PLAIN = '    ★  !   2/21 boardmod     □ [公告] 八卦板板規(2026.02.21)';
const PIN_CURSOR = '>   ★  M2510/14 someuser5    □ [協尋] 置底文';
const DELETED = ' 780290 +  10/14 -            □ (本文已被刪除) [someuser6]';

describe('parseListEntry', () => {
  test('一般文章列：編號、推文數、日期、作者、標題（去掉 □）', () => {
    expect(parseListEntry(ROW)).toEqual({
      num: 780297,
      pinned: false,
      deleted: false,
      locked: false,
      recommend: '1',
      date: '10/14',
      author: 'someuser1',
      title: '[問卦] 三千替代役中第一人守得住街亭嗎？',
      cursor: false,
    });
  });

  test('兩位數推文數與 R: 回文標記', () => {
    expect(parseListEntry(ROW_2DIGIT)).toMatchObject({ num: 780295, recommend: '16', date: '10/14' });
    expect(parseListEntry(ROW_REPLY).title).toBe('R: [新聞]淡江電機所僅1人上課');
  });

  test('新式 > 游標列照樣讀得出編號', () => {
    expect(parseListEntry(ROW_CURSOR)).toMatchObject({ num: 780296, cursor: true, author: 'someuser4' });
  });

  test('置底列：沒有編號、全形 ★／爆 不會讓後面的欄位錯位', () => {
    expect(parseListEntry(PIN_BOOM)).toMatchObject({
      num: null,
      pinned: true,
      recommend: '爆',
      date: '7/30',
      author: 'boardmod',
      title: '[公告] 禁止張貼一年',
    });
    expect(parseListEntry(PIN_PLAIN)).toMatchObject({ pinned: true, recommend: '', date: '2/21' });
    expect(parseListEntry(PIN_CURSOR)).toMatchObject({
      pinned: true,
      cursor: true,
      recommend: '25',
      date: '10/14',
      author: 'someuser5',
    });
  });

  test('刪除文標記 deleted', () => {
    expect(parseListEntry(DELETED)).toMatchObject({ num: 780290, deleted: true });
  });

  test('表頭、說明列、空白列都不是條目', () => {
    expect(parseListEntry('   編號    日 期 作  者       文  章  標  題                          人氣:4347')).toBe(null);
    expect(parseListEntry('[←]離開 [→]閱讀 [Ctrl-P]發表文章 [d]刪除 [z]精華區 [i]看板資訊/設定 [h]說明')).toBe(null);
    expect(parseListEntry('')).toBe(null);
  });
});

test('listEntriesFromScreen 只掃條目區（跳過前三列與底列）', () => {
  const rows = [
    '【板主:mod】[八卦] 標語    看板《Gossiping》',
    '[←]離開 [→]閱讀',
    '   編號    日 期 作  者       文  章  標  題',
    ROW_2DIGIT,
    ROW,
    PIN_CURSOR,
    '',
    ' 文章選讀  (y)回應(X)推文',
  ];
  expect(listEntriesFromScreen(rows).map((e) => e.num)).toEqual([780295, 780297, null]);
});

describe('parseCommentLine', () => {
  test('推文：型別、原始大小寫帳號、內容、IP、時間', () => {
    expect(parseCommentLine('推 SomeUser: 好文推推                                  1.2.3.4 10/14 21:05')).toEqual({
      type: '推',
      user: 'SomeUser',
      content: '好文推推',
      ip: '1.2.3.4',
      time: '10/14 21:05',
    });
  });

  test('沒有 IP 欄的板', () => {
    expect(parseCommentLine('→ abc123: 補充一下                                         10/14 21:06')).toMatchObject({
      type: '→',
      content: '補充一下',
      ip: null,
    });
  });

  test('非推文列回 null', () => {
    expect(parseCommentLine('這是內文')).toBe(null);
  });
});

describe('parseArticleLines', () => {
  test('檔頭、內文、推文分開；檔頭分隔線不進內文', () => {
    const lines = [
      ' 作者  someuser (暱稱)                                       看板  Gossiping',
      ' 標題  [問卦] 測試標題',
      ' 時間  Wed Oct 14 21:00:00 2026',
      '───────────────────────────────────────',
      '',
      '內文第一行',
      '內文第二行',
      '',
      '--',
      '※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4 (臺灣)',
      '※ 文章網址: https://www.ptt.cc/bbs/Gossiping/M.1760446800.A.123.html',
      '推 user1: 推                                                       10/14 21:01',
      '噓 user2: 噓                                                       10/14 21:02',
      '',
    ];
    const a = parseArticleLines(lines);
    expect(a).toMatchObject({
      author: 'someuser',
      board: 'Gossiping',
      title: '[問卦] 測試標題',
      time: 'Wed Oct 14 21:00:00 2026',
    });
    expect(a.content.split('\n')[1]).toBe('內文第一行');
    expect(a.content).toContain('※ 文章網址');
    expect(a.content).not.toContain('作者');
    expect(a.comments.map((c) => [c.type, c.user])).toEqual([
      ['推', 'user1'],
      ['噓', 'user2'],
    ]);
  });

  test('沒有檔頭的特殊文章：各欄 null，全部當內文', () => {
    const a = parseArticleLines(['系統公告', '內容']);
    expect(a).toMatchObject({ author: null, title: null, content: '系統公告\n內容', comments: [] });
  });
});
