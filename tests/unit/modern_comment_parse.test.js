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
    expect(parseModernCommentHeader(H1)).toEqual({ seq: 1, userid: 'someuser', idCol: 4 });
    expect(parseModernCommentHeader(header(123, 'Abc12', '10/16/2026 13:45'))).toEqual({
      seq: 123,
      userid: 'abc12',
      idCol: 6,
    });
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

  test('黑名單：標頭與其後的 │ 內容列一起藏，遇到非內容列就停', () => {
    const ctx = ctxOf();
    const rows = [H2_IP, '│第一行', '│第二行', H1, '│別人的內容', ''];
    const anns = rows.map((t) => annotateComment(t, ctx));
    expect(anns[0]).toMatchObject({ hidden: true, userid: 'badguy' });
    expect(anns[1]).toEqual({ hidden: true, modernBody: true });
    expect(anns[2]).toEqual({ hidden: true, modernBody: true });
    expect(anns[3]).toMatchObject({ hidden: false, userid: 'someuser' });
    expect(anns[4]).toBeNull();
    expect(anns[5]).toBeNull();
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
