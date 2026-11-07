// 新格式推文（post.svc）與舊格式（推/噓/→ 單列）並存的解析。
//
// 依據（CONFIRMED @ pttbbs 908bb063，PTT 端是否已全面上線未知 ⇒ 新舊一律兩種都吃）：
//   service/post/storage/engine.go#RenderFullPostText
//     "[%d] %s %s\n"（Sequence, Author, creation） ＋ 每行內容 "  <content>"
//     creation ＝ `[<IP> ]` ＋ `01/02/2006 15:04`
//   mbbsd/pmore.c#mf_display_comment_header
//     `[N] ` ＋ id ＋ 右靠 creation；內容列前 2 格空白換成 `│`；只在最後一個「※ 」
//     列之後（comments_start）。
// 畫面列文字照上面的規則手組（不是從被測程式反推）。
import {
  parseComment,
  parseModernCommentHeader,
  annotateComment,
  ModernCommentThread,
  FloorCounter,
} from '../../src/js/comment_parse';
import { groupSameAuthorRuns } from '../../src/js/comment_merge';
import { parseArticleLines } from '../../src/js/agent_parse';

// pmore 的右靠：headerw 78（80 欄），creation 靠右貼齊 col 77。
function header(n, id, creation) {
  const left = '[' + n + '] ' + id;
  return left + ' '.repeat(78 - left.length - creation.length) + creation;
}
const H1 = header(1, 'someuser', '10/16/2026 13:45');
const H2_IP = header(2, 'badguy', '1.2.3.4 10/16/2026 13:46');
const LEGACY = '推 olduser: 舊格式推文                                         10/16 13:40';

describe('parseModernCommentHeader', () => {
  test('標頭列：樓號、id（小寫）、id 起始欄', () => {
    expect(parseModernCommentHeader(H1)).toEqual({ seq: 1, userid: 'someuser', user: 'someuser', idCol: 4 });
    expect(parseModernCommentHeader(header(123, 'Abc12', '10/16/2026 13:45'))).toEqual({
      seq: 123,
      userid: 'abc12',
      user: 'Abc12',
      idCol: 6,
    });
  });

  // 典雅邊框主題（comments.c#comment_themes）：標頭前多「╭ 」（第一則）／「├ 」（其他），
  // id 與 creation 之間用 ─ 填。upstream 原始碼產的實畫面另由 ptt_src_screens.test.js 守。
  test('典雅邊框：「╭ 」「├ 」前綴、─ 填充也認，id 欄往右 3 格', () => {
    expect(parseModernCommentHeader('╭ [1] alice ──────── 1.2.3.4 10/28/2026 12:00')).toEqual({
      seq: 1,
      userid: 'alice',
      user: 'alice',
      idCol: 7,
    });
    expect(parseModernCommentHeader('├ [12] Bob ──────────── 10/28/2026 12:01')).toMatchObject({ seq: 12, userid: 'bob', idCol: 8 });
    expect(parseModernCommentHeader('╰ [1] alice ──── 10/28/2026 12:00')).toBeNull();
  });

  // 刪除的推文（engine.go#RenderFullPostText）：單列、沒有 creation。
  test('刪除的推文：「留言已刪除」「留言不顯示 (原因)」兩種都認，帶 deleted', () => {
    expect(parseModernCommentHeader('[4] carol 留言已刪除')).toEqual({
      seq: 4,
      userid: 'carol',
      user: 'carol',
      idCol: 4,
      deleted: '留言已刪除',
    });
    expect(parseModernCommentHeader('├ [5] dave 留言不顯示 (廣告)')).toMatchObject({ userid: 'dave', deleted: '留言不顯示 (廣告)' });
    // 內文裡長得像但不是整列的
    expect(parseModernCommentHeader('[4] carol 留言已刪除了')).toBeNull();
    expect(parseModernCommentHeader('[4] carol 說他的留言已刪除')).toBeNull();
  });

  test('帶 IP 的 creation 也認', () => {
    expect(parseModernCommentHeader(H2_IP)).toMatchObject({ seq: 2, userid: 'badguy' });
  });

  test('內文裡的「[1] 某某 …」沒有列尾 creation ⇒ 不認', () => {
    expect(parseModernCommentHeader('[1] someone 說的那段話')).toBeNull();
    expect(parseModernCommentHeader('[1] someone 10/16 13:45')).toBeNull();
  });

  test('id 不合 is_validuserid 形狀 ⇒ 不認（fail-safe）', () => {
    expect(parseModernCommentHeader(header(1, '1abc', '10/16/2026 13:45'))).toBeNull();
    expect(parseModernCommentHeader(header(1, 'a', '10/16/2026 13:45'))).toBeNull();
    expect(parseModernCommentHeader(header(1, 'abcdefghijklm', '10/16/2026 13:45'))).toBeNull();
  });

  test('舊格式推文不受影響、也不被誤認成新格式', () => {
    expect(parseComment(LEGACY)).toMatchObject({ type: '推', userid: 'olduser' });
    expect(parseModernCommentHeader(LEGACY)).toBeNull();
    expect(parseComment(H1)).toBeNull();
  });
});

describe('annotateComment：新格式', () => {
  const ctxOf = (o = {}) => ({
    blacklist: new Set(['badguy']),
    showFloorNumbers: true,
    floorCounter: new FloorCounter(),
    highlightAuthor: true,
    articleAuthor: 'someuser',
    modernThread: new ModernCommentThread(),
    ...o,
  });

  test('標頭列：推文者、原PO 高亮欄，不編本地樓層（[N] 就是樓號）', () => {
    const a = annotateComment(H1, ctxOf());
    expect(a).toMatchObject({ modern: true, userid: 'someuser', pusher: 'someuser', hidden: false });
    expect(a.floor).toBeUndefined();
    expect([a.authorIdStart, a.authorIdEnd]).toEqual([4, 12]);
  });

  test('自己的推文（新格式標頭）⇒ authorIdKind self，同一個 id 欄', () => {
    const a = annotateComment(H1, ctxOf({ articleAuthor: 'other', selfId: 'someuser' }));
    expect([a.authorIdStart, a.authorIdEnd, a.authorIdKind]).toEqual([4, 12, 'self']);
  });

  test('提到我（新格式）：標在含那段字的 │ 內容列；自己那一則的內容不算', () => {
    const ctx = ctxOf({ selfId: 'meuser' });
    const rows = [H1, '│第一行沒有', '│第二行 @MeUser 看這', ''];
    const anns = rows.map((t) => annotateComment(t, ctx));
    expect(anns[0].mentionsSelf).toBeUndefined();
    // 續行一律標 modernBody（P60 手機卡片從 modernBodyCol 讀內容：「│」2 格，後面沒有空白）。
    expect(anns[1]).toEqual({ hidden: false, modernBody: true, modernBodyCol: 2 });
    expect(anns[2]).toEqual({ hidden: false, modernBody: true, modernBodyCol: 2, mentionsSelf: true });
    const own = ctxOf({ selfId: 'someuser' });
    expect([H1, '│someuser 自己'].map((t) => annotateComment(t, own))[1].mentionsSelf).toBeUndefined();
  });

  test('黑名單：標頭與其後的 │ 內容列一起藏，遇到非內容列就停', () => {
    const ctx = ctxOf();
    const rows = [H2_IP, '│第一行', '│第二行', H1, '│別人的內容', ''];
    const anns = rows.map((t) => annotateComment(t, ctx));
    expect(anns[0]).toMatchObject({ hidden: true, userid: 'badguy' });
    expect(anns[1]).toEqual({ hidden: true, modernBody: true });
    expect(anns[2]).toEqual({ hidden: true, modernBody: true });
    expect(anns[3]).toMatchObject({ hidden: false, userid: 'someuser' });
    expect(anns[4]).toEqual({ hidden: false, modernBody: true, modernBodyCol: 2 });
    expect(anns[5]).toBeNull();
  });

  test('「│ 」後面的一格空白算縮排：內容從第 3 格起', () => {
    const ctx = ctxOf();
    expect([H1, '│ 內容'].map((t) => annotateComment(t, ctx))[1]).toMatchObject({ modernBodyCol: 3 });
  });

  test('標頭之前就出現的 │ 列（一般內文）不受影響', () => {
    const ctx = ctxOf();
    expect(annotateComment('│表格線', ctx)).toBeNull();
  });

  test('沒有 thread（反向讀取 tail）：標頭照認、內容列不標', () => {
    const ctx = ctxOf({ modernThread: undefined });
    expect(annotateComment(H2_IP, ctx)).toMatchObject({ hidden: true });
    expect(annotateComment('│內容', ctx)).toBeNull();
  });

  test('新舊並存：舊格式照編樓層、新格式不吃樓層，夾在中間的舊推文結束新格式那一則', () => {
    const ctx = ctxOf();
    const meta = '※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4';
    const rows = [meta, LEGACY, H2_IP, '│藏起來', LEGACY, '│這列不是任何一則的內容'];
    const anns = rows.map((t) => annotateComment(t, ctx));
    expect(anns[1].floor).toMatchObject({ seq: 1 });
    expect(anns[2]).toMatchObject({ modern: true, hidden: true });
    expect(anns[3]).toMatchObject({ hidden: true });
    expect(anns[4].floor).toMatchObject({ seq: 2 });
    expect(anns[5]).toBeNull();
  });
});

describe('同作者推文合併不碰新格式', () => {
  test('連續兩則同作者的新格式標頭不組成 run', () => {
    const a = { userid: 'x', modern: true };
    expect(groupSameAuthorRuns([a, a, a])).toEqual([]);
  });
  test('舊格式照常合併', () => {
    const a = { userid: 'x' };
    expect(groupSameAuthorRuns([a, a])).toEqual([{ userid: 'x', rows: [0, 1] }]);
  });
});

describe('agent_parse.parseArticleLines：新舊推文都收', () => {
  test('新格式標頭＋多列內容合成一則，舊格式照舊', () => {
    const r = parseArticleLines([
      '作者  poster (暱稱) 看板  Test',
      '標題  [測試] 新格式',
      '內文',
      '※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4',
      LEGACY,
      H2_IP,
      '│第一行',
      '│第二行',
    ]);
    expect(r.comments).toHaveLength(2);
    expect(r.comments[0]).toMatchObject({ type: '推', user: 'olduser' });
    expect(r.comments[1]).toEqual({
      type: 'modern',
      seq: 2,
      user: 'badguy',
      content: '第一行\n第二行',
      ip: '1.2.3.4',
      time: '10/16/2026 13:46',
    });
    expect(r.content).not.toContain('第一行');
  });
});

// ── upstream 87c3a1f3 之後的格式（CONFIRMED @ pttbbs 87c3a1f3）────────────────────
//   檔案：service/post/storage/engine.go "|id[!]|第一行|creation|[~]N" ＋ "| 續行"
//   畫面：mbbsd/comments.c#comment_render_modern_header
//     經典醒目／單純易讀：`id: 內容` ＋ 空白填 ＋ meta ＋ ` [N]`，樓號貼齊 col 78（max_width 79）
//     對齊顯示：id 前補空白到 IDLEN（12）格
//     meta 依塞得下的程度：IP 日期 時間 → IP 月/日 時間 → 日期 時間 → 月/日 時間 → 時間 → 不印
//   續行：comment_render_body_prefix 印 cur_header_width（id 寬＋2；對齊顯示 14）格空白再接原文。
// 畫面列文字照上面的規則手組（不是從被測程式反推）；upstream 實際產的畫面另由
// ptt_src_screens.test.js 的 modern_comments 守。
function pipeHeader(id, content, meta, floor, { aligned = false } = {}) {
  const left = (aligned ? ' '.repeat(Math.max(0, 12 - id.length)) : '') + id + ': ' + content;
  const right = (meta ? meta + ' ' : '') + '[' + floor + ']';
  const w = (t) => [...t].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x7f ? 2 : 1), 0);
  return left + ' '.repeat(Math.max(1, 79 - w(left) - w(right))) + right;
}
const P1 = pipeHeader('alice', '第一則推文', '1.2.3.4 10/28/2026 12:00', '1');
const P2 = pipeHeader('badguy', '壞話第一行', '10/28/2026 12:01', '2');
const P2_BODY = ' '.repeat('badguy'.length + 2) + '壞話第二行';

describe('parseModernCommentHeader：87c3a1f3 之後（id: 內容 … [N]）', () => {
  test('經典／單純：id 從第 0 欄、內容、IP、時間、樓號、續行起始欄', () => {
    expect(parseModernCommentHeader(P1)).toEqual({
      seq: 1,
      userid: 'alice',
      user: 'alice',
      idCol: 0,
      bodyCol: 7,
      content: '第一則推文',
      ip: '1.2.3.4',
      time: '10/28/2026 12:00',
    });
  });

  test('對齊顯示：id 靠右補到 12 格，id 欄與續行欄跟著右移', () => {
    const h = parseModernCommentHeader(pipeHeader('nina', '原PO回覆', '10/28/2026 12:05', '3', { aligned: true }));
    expect(h).toMatchObject({ seq: 3, userid: 'nina', idCol: 8, bodyCol: 14, content: '原PO回覆', ip: null });
    // 補的空白不是補到 12 格 ⇒ 不是 pmore 畫的
    expect(parseModernCommentHeader('  ' + P1)).toBeNull();
  });

  test('改過的樓號 [~N]、刪除的兩種內容', () => {
    expect(parseModernCommentHeader(pipeHeader('erin', '最後一則', '10/28/2026 12:10', '~6'))).toMatchObject({ seq: 6 });
    expect(parseModernCommentHeader(pipeHeader('carol', '留言已刪除', '10/28/2026 12:06', '4'))).toMatchObject({
      deleted: '留言已刪除',
    });
    expect(parseModernCommentHeader(pipeHeader('dave', '留言已隱藏 (廣告)', '10/28/2026 12:07', '5'))).toMatchObject({
      deleted: '留言已隱藏 (廣告)',
    });
    expect(parseModernCommentHeader(P1).deleted).toBeUndefined();
  });

  test('meta 塞不下時退成短日期或只剩時間也認；連時間都沒有就不認（fail-safe）', () => {
    expect(parseModernCommentHeader(pipeHeader('alice', '長', '1.2.3.4 10/28 12:00', '1'))).toMatchObject({
      ip: '1.2.3.4',
      time: '10/28 12:00',
    });
    expect(parseModernCommentHeader(pipeHeader('alice', '長', '12:00', '1'))).toMatchObject({ ip: null, time: '12:00' });
    expect(parseModernCommentHeader(pipeHeader('alice', '很長很長', '', '1'))).toBeNull();
  });

  test('內文裡的「someone: 某句話」或結尾剛好有 [N] 但沒有時間 ⇒ 不認', () => {
    expect(parseModernCommentHeader('someone: 我覺得這樣不行')).toBeNull();
    expect(parseModernCommentHeader('note: 參考資料 [1]')).toBeNull();
    expect(parseModernCommentHeader('1abc: 內容 10/28/2026 12:00 [1]')).toBeNull();
  });

  test('舊格式推文不會被認成新格式，新格式也不會被認成舊格式', () => {
    expect(parseModernCommentHeader(LEGACY)).toBeNull();
    expect(parseComment(P1)).toBeNull();
  });
});

describe('annotateComment：87c3a1f3 之後', () => {
  const ctxOf = (o = {}) => ({
    blacklist: new Set(['badguy']),
    showFloorNumbers: true,
    floorCounter: new FloorCounter(),
    highlightAuthor: true,
    articleAuthor: 'alice',
    modernThread: new ModernCommentThread(),
    ...o,
  });

  test('黑名單：標頭與縮到內容欄的續行一起藏；縮排對不上的列不算續行', () => {
    const ctx = ctxOf();
    const rows = [P2, P2_BODY, P1, ' '.repeat(7) + '別人的續行', '   縮排不對', ''];
    const anns = rows.map((t) => annotateComment(t, ctx));
    expect(anns[0]).toMatchObject({ modern: true, hidden: true, userid: 'badguy' });
    expect(anns[1]).toEqual({ hidden: true, modernBody: true });
    expect(anns[2]).toMatchObject({ hidden: false, userid: 'alice' });
    expect(anns[2].floor).toBeUndefined();
    expect(anns[3]).toEqual({ hidden: false, modernBody: true, modernBodyCol: 7 });
    expect(anns[4]).toBeNull();
    expect(anns[5]).toBeNull();
  });

  test('黑名單那一則的續行之後接到不同縮排的列 ⇒ 停止藏', () => {
    const ctx = ctxOf();
    const anns = [P2, P2_BODY, ' '.repeat(7) + '縮到別人的欄'].map((t) => annotateComment(t, ctx));
    expect(anns[2]).toBeNull();
  });

  test('原PO 高亮落在 id 那幾格（對齊顯示右移）', () => {
    const a = annotateComment(pipeHeader('alice', '嗨', '10/28/2026 12:00', '1', { aligned: true }), ctxOf());
    expect([a.authorIdStart, a.authorIdEnd]).toEqual([7, 12]);
  });

  test('提到我：內容在標頭列上就標標頭列，在續行就標續行；自己的不算', () => {
    const ctx = ctxOf({ selfId: 'meuser' });
    const head = pipeHeader('bob', '找 @meuser', '10/28/2026 12:00', '3');
    expect(annotateComment(head, ctx)).toMatchObject({ mentionsSelf: true });
    const ctx2 = ctxOf({ selfId: 'meuser' });
    const anns = [pipeHeader('bob', '第一行', '10/28/2026 12:00', '3'), '     MeUser 看這'].map((t) => annotateComment(t, ctx2));
    expect(anns[0].mentionsSelf).toBeUndefined();
    expect(anns[1]).toEqual({ hidden: false, modernBody: true, modernBodyCol: 5, mentionsSelf: true });
    const own = ctxOf({ selfId: 'bob' });
    expect(annotateComment(head.replace('@meuser', '@bob'), own).mentionsSelf).toBeUndefined();
  });
});

describe('agent_parse.parseArticleLines：87c3a1f3 之後', () => {
  test('標頭列的內容＋續行合成一則，刪除的帶 deleted、後面不接續行', () => {
    const r = parseArticleLines([
      '作者  poster (暱稱) 看板  Test',
      '標題  [測試] 新格式',
      '內文',
      '※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4',
      P2,
      P2_BODY,
      pipeHeader('carol', '留言已刪除', '10/28/2026 12:06', '4'),
      P1,
    ]);
    expect(r.comments).toEqual([
      { type: 'modern', seq: 2, user: 'badguy', content: '壞話第一行\n壞話第二行', ip: null, time: '10/28/2026 12:01' },
      { type: 'modern', seq: 4, user: 'carol', content: '留言已刪除', ip: null, time: '10/28/2026 12:06', deleted: true },
      { type: 'modern', seq: 1, user: 'alice', content: '第一則推文', ip: '1.2.3.4', time: '10/28/2026 12:00' },
    ]);
    expect(r.content).not.toContain('壞話');
  });
});
