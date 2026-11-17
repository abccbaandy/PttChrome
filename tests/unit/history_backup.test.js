// 設定備份「閱讀紀錄」（P98；src/js/history_backup.js、docs/user-data.md「設定備份」）：
// 匯出哪幾種、匯入＝跟這台合併不蓋掉、壞檔案拒絕、壞的單筆丟掉、網址只收 http(s)。
import {
  HISTORY_BACKUP_IDS,
  buildHistoryExport,
  importHistory,
  historyFileName,
} from '../../src/js/history_backup';
import { STORAGE_KEYS, USER_DATA } from '../../src/js/user_data_keys';
import { RECENT_ARTICLES_LIMIT } from '../../src/js/recent_articles';
import { BOARD_TABS_MAX } from '../../src/js/board_tabs';
import { RECENT_LIMIT } from '../../src/js/home_dashboard';

function memStorage(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [STORAGE_KEYS[k], JSON.stringify(v)]));
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
const read = (s, id) => JSON.parse(s.getItem(STORAGE_KEYS[id]));
const NOW = Date.UTC(2026, 10, 18);
const art = (board, aid, at, extra) => Object.assign({ board, aid, title: board + aid, at }, extra);
const later = (board, aid, at, mt, del) =>
  Object.assign({ board, aid, title: 't', at, mt }, del ? { del: true } : {});
const lk = (board, aid) => board.toLowerCase() + ':' + aid;

function exportOf(storage) {
  return JSON.stringify(buildHistoryExport(storage, new Date(NOW)).payload);
}

describe('涵蓋範圍', () => {
  test('匯出的種類＝USER_DATA 裡 backup 為 true 的紀錄（除了設定本身）', () => {
    // 設定本身走 pref_backup.js、離線文章（IndexedDB）走 saved_articles.js，各自一區。
    const backed = USER_DATA.filter((e) => e.backup && e.id !== 'prefs' && e.store === 'localStorage').map((e) => e.id);
    expect([...HISTORY_BACKUP_IDS].sort()).toEqual(backed.sort());
    for (const id of HISTORY_BACKUP_IDS) expect(USER_DATA.find((e) => e.id === id).kind).toBe('history');
  });
  test('檔名帶日期', () => {
    expect(historyFileName(new Date(2026, 0, 5))).toBe('pttchrome-history-20260105.json');
  });
});

describe('匯出', () => {
  test('只放有東西的種類，total＝總筆數；沒有任何紀錄 ⇒ total 0', () => {
    expect(buildHistoryExport(memStorage()).total).toBe(0);
    const s = memStorage({
      recentArticles: { recent: [art('Test', 'AAAAAAAA', 5)] },
      homeRecentBoards: ['Test', 'Stock'],
      searchHistory: { title: ['x'], author: [], push: [], board: [] },
    });
    const { payload, total } = buildHistoryExport(s, new Date(NOW));
    expect(total).toBe(4);
    expect(payload).toMatchObject({ app: 'pttchrome', kind: 'history', schemaVersion: 1 });
    expect(Object.keys(payload.data).sort()).toEqual(['homeRecentBoards', 'recentArticles', 'searchHistory']);
    expect(payload.data.recentArticles.recent[0].aid).toBe('AAAAAAAA');
  });
  test('稍後閱讀的墓碑不算筆數，但整份帶走（另一台照同步規則合併）', () => {
    const s = memStorage({
      readLater: { [lk('Test', 'AAAAAAAA')]: later('Test', 'AAAAAAAA', 1, 1), [lk('Test', 'BBBBBBBB')]: later('Test', 'BBBBBBBB', 1, 2, true) },
    });
    const { payload, total } = buildHistoryExport(s, new Date(NOW));
    expect(total).toBe(1);
    expect(Object.keys(payload.data.readLater)).toHaveLength(2);
  });
});

describe('匯入：跟這台合併，不蓋掉', () => {
  test('最近讀過：同一篇取 at 新的（位置缺的用另一筆補），整份由新到舊、照上限截', () => {
    const local = memStorage({
      recentArticles: { recent: [art('Test', 'AAAAAAAA', 10, { line: 42 }), art('Test', 'CCCCCCCC', 3)] },
    });
    const file = memStorage({
      recentArticles: { recent: [art('Test', 'AAAAAAAA', 20, { title: '' }), art('Stock', 'BBBBBBBB', 15)] },
    });
    expect(importHistory(exportOf(file), local, NOW)).toMatchObject({ ok: true, imported: 2, kinds: 1, failed: 0 });
    const rec = read(local, 'recentArticles').recent;
    expect(rec.map((e) => e.aid)).toEqual(['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC']);
    expect(rec[0]).toMatchObject({ at: 20, line: 42, title: 'TestAAAAAAAA' });

    const many = memStorage({
      recentArticles: { recent: Array.from({ length: 40 }, (_, i) => art('B' + i, 'AAAAAAAA', 100 + i)) },
    });
    importHistory(exportOf(many), local, NOW);
    expect(read(local, 'recentArticles').recent).toHaveLength(RECENT_ARTICLES_LIMIT);
  });

  test('最近讀過：舊版 v1 的 later 還在本機 ⇒ 照留（之後照常遷移），稍後閱讀匯入時也算進本機那份', () => {
    const local = memStorage({ recentArticles: { recent: [], later: [art('Test', 'LLLLLLLL', 7)] } });
    const file = memStorage({
      recentArticles: { recent: [art('Test', 'AAAAAAAA', 5)] },
      readLater: { [lk('Stock', 'BBBBBBBB')]: later('Stock', 'BBBBBBBB', 9, 9) },
    });
    importHistory(exportOf(file), local, NOW);
    expect(read(local, 'recentArticles').later).toHaveLength(1);
    expect(Object.keys(read(local, 'readLater')).sort()).toEqual([lk('Stock', 'BBBBBBBB'), lk('Test', 'LLLLLLLL')]);
  });

  test('稍後閱讀：逐篇 mt 新的贏（匯入檔裡的墓碑比較新 ⇒ 這台的也刪）', () => {
    // 時間要靠近 NOW：太舊的墓碑會被 trimReadLater 回收。
    const t = NOW - 1000;
    const local = memStorage({
      readLater: { [lk('Test', 'AAAAAAAA')]: later('Test', 'AAAAAAAA', t, t + 1), [lk('Test', 'CCCCCCCC')]: later('Test', 'CCCCCCCC', t, t + 5) },
    });
    const file = memStorage({
      readLater: { [lk('Test', 'AAAAAAAA')]: later('Test', 'AAAAAAAA', t, t + 3, true), [lk('Test', 'CCCCCCCC')]: later('Test', 'CCCCCCCC', t, t + 2, true) },
    });
    // 匯出檔要有至少一篇活的才算有東西：另外放一篇。
    const data = JSON.parse(exportOf(memStorage({ readLater: { [lk('Test', 'DDDDDDDD')]: later('Test', 'DDDDDDDD', t, t) } })));
    Object.assign(data.data.readLater, read(file, 'readLater'));
    importHistory(JSON.stringify(data), local, NOW);
    const m = read(local, 'readLater');
    expect(m[lk('Test', 'AAAAAAAA')].del).toBe(true);
    expect(m[lk('Test', 'CCCCCCCC')].del).toBeUndefined();
    expect(m[lk('Test', 'DDDDDDDD')]).toBeTruthy();
  });

  test('新推文標記：同一篇取比較新的那次', () => {
    const local = memStorage({ newComments: { 'test/AAAAAAAA': [10, 100], 'test/CCCCCCCC': [1, 1] } });
    const file = memStorage({ newComments: { 'test/AAAAAAAA': [5, 50], 'test/BBBBBBBB': [7, 70, 3, 'someone', '標題'] } });
    importHistory(exportOf(file), local, NOW);
    expect(read(local, 'newComments')).toEqual({
      'test/AAAAAAAA': [10, 100],
      'test/BBBBBBBB': [7, 70, 3, 'someone', '標題'],
      'test/CCCCCCCC': [1, 1],
    });
  });

  test('看板分頁：這台的位置不動、新板接在後面、超過上限丟最久沒去的', () => {
    const local = memStorage({ boardTabs: [{ name: 'Test', at: 5 }, { name: 'Stock', at: 50 }] });
    const names = ['A1', 'A2', 'A3', 'A4', 'A5'];
    const file = memStorage({ boardTabs: [{ name: 'test', at: 60 }].concat(names.map((name, i) => ({ name, at: 11 + i }))) });
    importHistory(exportOf(file), local, NOW);
    const tabs = read(local, 'boardTabs');
    expect(tabs).toHaveLength(BOARD_TABS_MAX);
    expect(tabs[0]).toEqual({ name: 'Test', at: 60 }); // 同一個板取比較新的時間、保留這台的寫法
    expect(tabs.map((t) => t.name)).toEqual(['Test', 'Stock', 'A2', 'A3', 'A4', 'A5']);
  });

  test('最近看板、搜尋紀錄：這台的在前、匯入的補後面、去重、照上限', () => {
    const local = memStorage({
      homeRecentBoards: ['Stock', 'Test'],
      searchHistory: { title: ['a', 'b'], author: [], push: [], board: [] },
    });
    const file = memStorage({
      homeRecentBoards: ['test', 'Gossiping', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
      searchHistory: { title: ['b', 'c'], author: ['someone'], push: [], board: [] },
    });
    importHistory(exportOf(file), local, NOW);
    expect(read(local, 'homeRecentBoards')).toEqual(['Stock', 'Test', 'Gossiping', 'C1', 'C2', 'C3', 'C4', 'C5'].slice(0, RECENT_LIMIT));
    expect(read(local, 'searchHistory')).toEqual({ title: ['a', 'b', 'c'], author: ['someone'], push: [], board: [] });
  });

  test('上傳紀錄：同網址留這台的、整份照時間由新到舊', () => {
    const local = memStorage({ uploadHistory: [{ url: 'https://i.example/a.png', at: 5, filename: 'mine' }] });
    const file = memStorage({
      uploadHistory: [
        { url: 'https://i.example/a.png', at: 9, filename: 'theirs' },
        { url: 'https://i.example/b.png', at: 7 },
      ],
    });
    importHistory(exportOf(file), local, NOW);
    expect(read(local, 'uploadHistory').map((e) => [e.url, e.filename])).toEqual([
      ['https://i.example/b.png', undefined],
      ['https://i.example/a.png', 'mine'],
    ]);
  });
});

describe('匯入檔不可信', () => {
  test.each([
    ['不是 JSON', '{', 'badJson'],
    ['不是這種匯出檔（設定備份）', JSON.stringify({ app: 'pttchrome', kind: 'prefs', schemaVersion: 1, prefs: {} }), 'badFormat'],
    ['版本比這版新', JSON.stringify({ app: 'pttchrome', kind: 'history', schemaVersion: 99, data: {} }), 'badFormat'],
    ['版本 0', JSON.stringify({ app: 'pttchrome', kind: 'history', schemaVersion: 0, data: {} }), 'badFormat'],
    ['版本不是整數', JSON.stringify({ app: 'pttchrome', kind: 'history', schemaVersion: 1.5, data: {} }), 'badFormat'],
    ['沒有 data', JSON.stringify({ app: 'pttchrome', kind: 'history', schemaVersion: 1 }), 'badFormat'],
  ])('%s ⇒ 整份拒絕、不動本機', (_, text, reason) => {
    const s = memStorage({ homeRecentBoards: ['Test'] });
    expect(importHistory(text, s, NOW)).toEqual({ ok: false, reason });
    expect(read(s, 'homeRecentBoards')).toEqual(['Test']);
  });

  test('壞的單筆丟掉；網址欄位只收 http(s)；不認得的種類不寫', () => {
    const text = JSON.stringify({
      app: 'pttchrome',
      kind: 'history',
      schemaVersion: 1,
      data: {
        homeRecentBoards: ['Test', 'bad name', 42, '<script>'],
        uploadHistory: [
          { url: 'javascript:alert(1)', at: 1 },
          { url: 'https://i.example/ok.png', at: 2, deleteUrl: 'javascript:x', previewUrl: 'https://i.example/p.png' },
        ],
        newComments: {
          'test/AAAAAAAA': ['x', 1],
          'nope': [1, 1],
          'test/BBBBBBBB': [3, 4],
          // 列表用的欄位形狀不對（標題是數字）⇒ 只留推文數與時間。
          'test/CCCCCCCC': [5, 6, 1, 'someone', 42],
          'test/DDDDDDDD': [7, 8, 2, 'someone', '標題', '9/01'],
        },
        prefs: { autoLoginUser: 'x' },
        longPushDraft: 'hi',
      },
    });
    const s = memStorage();
    const res = importHistory(text, s, NOW);
    expect(res).toMatchObject({ ok: true, imported: 5 });
    expect(read(s, 'homeRecentBoards')).toEqual(['Test']);
    expect(read(s, 'uploadHistory')).toEqual([{ url: 'https://i.example/ok.png', at: 2, previewUrl: 'https://i.example/p.png' }]);
    expect(read(s, 'newComments')).toEqual({
      'test/BBBBBBBB': [3, 4],
      'test/CCCCCCCC': [5, 6],
      'test/DDDDDDDD': [7, 8, 2, 'someone', '標題', '9/01'],
    });
    expect(s.getItem(STORAGE_KEYS.prefs)).toBeNull();
    expect(s.getItem(STORAGE_KEYS.longPushDraft)).toBeNull();
  });

  test('匯出 → 匯入到空的一台 ⇒ 每種都一樣', () => {
    const src = memStorage({
      recentArticles: { recent: [art('Test', 'AAAAAAAA', 5, { line: 3 })] },
      readLater: { [lk('Test', 'AAAAAAAA')]: later('Test', 'AAAAAAAA', 1, 1) },
      newComments: { 'test/AAAAAAAA': [1, 2] },
      boardTabs: [{ name: 'Test', at: 1 }],
      homeRecentBoards: ['Test'],
      searchHistory: { title: ['x'], author: [], push: [], board: [] },
      uploadHistory: [{ url: 'https://i.example/a.png', at: 1 }],
    });
    const dst = memStorage();
    expect(importHistory(exportOf(src), dst, NOW)).toMatchObject({ ok: true, kinds: 7, failed: 0 });
    for (const id of HISTORY_BACKUP_IDS) expect(read(dst, id), id).toEqual(read(src, id));
  });
});
