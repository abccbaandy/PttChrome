// user_data.js 的旗標讀寫契約（架構 review A10 第二步）：讀不到回 false、寫不進去安靜放棄，
// 形狀跟搬家前一樣（開＝'1'，關＝整個移除）。以及旗標類擁有者不再自己碰 localStorage。
import fs from 'node:fs';
import path from 'node:path';
import {
  readFlag,
  writeFlag,
  readJson,
  readRaw,
  writeRaw,
  writeJson,
  removeData,
  isQuotaError,
  QUOTA_EVICT_ORDER,
} from '../../src/js/user_data';
import { setDiagSink } from '../../src/js/diag';
import { STORAGE_KEYS, USER_DATA } from '../../src/js/user_data_keys';

function memStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

const throwing = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
  removeItem() {
    throw new Error('SecurityError');
  },
};

describe('user_data 旗標', () => {
  test('開存 "1"、關整個移除，跟舊資料同形狀', () => {
    const st = memStorage();
    expect(readFlag('followOnly', st)).toBe(false);
    writeFlag('followOnly', true, st);
    expect(st.m.get(STORAGE_KEYS.followOnly)).toBe('1');
    expect(readFlag('followOnly', st)).toBe(true);
    writeFlag('followOnly', false, st);
    expect(st.m.has(STORAGE_KEYS.followOnly)).toBe(false);
    expect(readFlag('followOnly', st)).toBe(false);
  });

  test('舊版留下的 "1" 讀得到；其他值都當關', () => {
    const st = memStorage();
    st.m.set(STORAGE_KEYS.menuBannerExpanded, '1');
    expect(readFlag('menuBannerExpanded', st)).toBe(true);
    st.m.set(STORAGE_KEYS.menuBannerExpanded, 'true');
    expect(readFlag('menuBannerExpanded', st)).toBe(false);
  });

  test('沒有 storage／存取丟例外：讀回 false、寫不炸', () => {
    expect(readFlag('splitReaderCollapsed', null)).toBe(false);
    expect(() => writeFlag('splitReaderCollapsed', true, null)).not.toThrow();
    expect(readFlag('splitReaderCollapsed', throwing)).toBe(false);
    expect(() => writeFlag('splitReaderCollapsed', true, throwing)).not.toThrow();
    expect(() => writeFlag('splitReaderCollapsed', false, throwing)).not.toThrow();
  });

  test('總表沒有的 id 直接丟（程式寫錯，不是使用者環境問題）', () => {
    expect(() => readFlag(/** @type {any} */ ('nope'), memStorage())).toThrow(/總表沒有/);
  });

  test('JSON：讀寫來回、沒有這筆／壞 JSON／拿不到 storage 都回 null', () => {
    const st = memStorage();
    expect(readJson('searchHistory', st)).toBe(null);
    expect(writeJson('searchHistory', { title: ['a'] }, st)).toBe(true);
    expect(st.m.get(STORAGE_KEYS.searchHistory)).toBe('{"title":["a"]}');
    expect(readJson('searchHistory', st)).toEqual({ title: ['a'] });
    st.m.set(STORAGE_KEYS.searchHistory, '{oops');
    expect(readJson('searchHistory', st)).toBe(null);
    expect(readJson('searchHistory', null)).toBe(null);
    expect(readJson('searchHistory', throwing)).toBe(null);
    removeData('searchHistory', st);
    expect(st.m.has(STORAGE_KEYS.searchHistory)).toBe(false);
  });

  test('原文：照原樣回字串（不解析），沒有／拿不到回 null', () => {
    const st = memStorage();
    expect(readRaw('newComments', st)).toBe(null);
    st.m.set(STORAGE_KEYS.newComments, '{oops');
    expect(readRaw('newComments', st)).toBe('{oops');
    expect(readRaw('newComments', null)).toBe(null);
    expect(readRaw('newComments', throwing)).toBe(null);
  });

  test('新推文標記走 readRaw（列表徽章拿原文當快取鍵）＋writeJson，不再自己碰 localStorage', () => {
    const e = USER_DATA.find((x) => x.id === 'newComments');
    const code = fs.readFileSync(path.join(process.cwd(), e.owner), 'utf8');
    expect(code).toMatch(/readRaw\(\s*['"]newComments['"]/);
    expect(code).toMatch(/writeJson\(\s*['"]newComments['"]/);
    expect(code).not.toMatch(/\.(getItem|setItem|removeItem)\(/);
  });

  test('長推文草稿存原文字串（舊資料不是 JSON）：走 readRaw／writeRaw／removeData，不再自己碰 localStorage', () => {
    const e = USER_DATA.find((x) => x.id === 'longPushDraft');
    const code = fs.readFileSync(path.join(process.cwd(), e.owner), 'utf8');
    expect(code).toMatch(/readRaw\(\s*['"]longPushDraft['"]/);
    expect(code).toMatch(/writeRaw\(\s*['"]longPushDraft['"]/);
    expect(code).toMatch(/removeData\(\s*['"]longPushDraft['"]/);
    expect(code).not.toMatch(/\.(getItem|setItem|removeItem)\(/);
  });

  test('最近讀過／稍後閱讀拿原文當快取鍵（別的分頁寫的也認得）：走 readRaw／writeRaw，不再自己碰 localStorage', () => {
    for (const id of ['recentArticles', 'readLater']) {
      const e = USER_DATA.find((x) => x.id === id);
      const code = fs.readFileSync(path.join(process.cwd(), e.owner), 'utf8');
      expect(code, `${e.owner} 的 ${id} 要走 readRaw`).toMatch(new RegExp(`readRaw\\(\\s*['"]${id}['"]`));
      expect(code, `${e.owner} 的 ${id} 要走 writeRaw`).toMatch(new RegExp(`writeRaw\\(\\s*['"]${id}['"]`));
      expect(code, `${e.owner} 不該再直接 getItem/setItem`).not.toMatch(/\.(getItem|setItem|removeItem)\(/);
    }
  });

  test('設定本身走 readJson／writeJson（形狀 {values} 不變），pref_storage 不再自己碰 localStorage', () => {
    const e = USER_DATA.find((x) => x.id === 'prefs');
    const code = fs.readFileSync(path.join(process.cwd(), e.owner), 'utf8');
    expect(code).toMatch(/readJson\(\s*['"]prefs['"]/);
    expect(code).toMatch(/writeJson\(\s*['"]prefs['"]/);
    expect(code).not.toMatch(/\.(getItem|setItem|removeItem)\(/);
  });

  test('原文字串：寫得回來、寫不進去回 false 不炸', () => {
    const st = memStorage();
    expect(writeRaw('longPushDraft', '打到一半', st)).toBe(true);
    expect(readRaw('longPushDraft', st)).toBe('打到一半');
    expect(writeRaw('longPushDraft', 'x', null)).toBe(false);
    expect(writeRaw('longPushDraft', 'x', throwing)).toBe(false);
  });

  test('JSON：寫不進去回 false、不炸（容量滿、隱私模式）', () => {
    expect(writeJson('uploadHistory', [1], null)).toBe(false);
    expect(writeJson('uploadHistory', [1], throwing)).toBe(false);
    expect(() => removeData('uploadHistory', throwing)).not.toThrow();
  });

  test('已搬到共用讀寫的 JSON 擁有者不再自己碰 localStorage', () => {
    for (const id of ['uploadHistory', 'searchHistory', 'whatsNewSeen', 'boardTabs', 'homeFavorites', 'homeRecentBoards', 'rendererResume', 'floatToolsPos']) {
      const e = USER_DATA.find((x) => x.id === id);
      const code = fs.readFileSync(path.join(process.cwd(), e.owner), 'utf8');
      expect(code, `${e.owner} 的 ${id} 要走 readJson`).toMatch(new RegExp(`readJson\\(\\s*['"]${id}['"]`));
      expect(code, `${e.owner} 的 ${id} 要走 writeJson`).toMatch(new RegExp(`writeJson\\(\\s*['"]${id}['"]`));
      expect(code, `${e.owner} 不該再直接 getItem/setItem`).not.toMatch(/\.(getItem|setItem|removeItem)\(/);
    }
  });

  test('旗標類的擁有者不再自己碰 localStorage', () => {
    const flags = USER_DATA.filter((e) => e.limit === '一個旗標');
    expect(flags.map((e) => e.id).sort()).toEqual(
      ['articleToolsCollapsed', 'followOnly', 'menuBannerExpanded', 'prefSyncEnabled', 'splitReaderCollapsed'].sort(),
    );
    for (const e of flags) {
      const code = fs.readFileSync(path.join(process.cwd(), e.owner), 'utf8');
      expect(code, `${e.owner} 的 ${e.id} 要走 readFlag／writeFlag`).toMatch(
        new RegExp(`readFlag\\(\\s*['"]${e.id}['"]`),
      );
      expect(code, `${e.owner} 的 ${e.id} 要走 readFlag／writeFlag`).toMatch(
        new RegExp(`writeFlag\\(\\s*['"]${e.id}['"]`),
      );
      expect(code, `${e.owner} 不該再直接 getItem/setItem`).not.toMatch(/\.(getItem|setItem|removeItem)\(/);
    }
  });
});

// 容量有上限的假 storage：總字數超過 budget 就丟瀏覽器的 QuotaExceededError（name＋舊 code 22）。
function quotaStorage(budget) {
  const st = memStorage();
  const used = () => [...st.m.entries()].reduce((n, [k, v]) => n + k.length + v.length, 0);
  st.setItem = (k, v) => {
    const old = st.m.has(k) ? k.length + st.m.get(k).length : 0;
    if (used() - old + k.length + String(v).length > budget) {
      const e = new Error('quota');
      e.name = 'QuotaExceededError';
      // @ts-ignore 瀏覽器的 DOMException 帶 code
      e.code = 22;
      throw e;
    }
    st.m.set(k, String(v));
  };
  return st;
}

describe('user_data 容量滿（A10 第二步）', () => {
  afterEach(() => setDiagSink(null));

  test('認得三家瀏覽器的容量滿；SecurityError／一般錯誤不算', () => {
    expect(isQuotaError({ name: 'QuotaExceededError' })).toBe(true);
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
    expect(isQuotaError({ code: 1014 })).toBe(true);
    expect(isQuotaError({ name: 'SecurityError', code: 18 })).toBe(false);
    expect(isQuotaError(new Error('x'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });

  test('容量滿：先清掉可重抓的快取（我的最愛快取）再寫，紀錄類一筆都不動', () => {
    const big = 'x'.repeat(400);
    const st = quotaStorage(1000);
    st.m.set(STORAGE_KEYS.homeFavorites, big);
    st.m.set(STORAGE_KEYS.recentArticles, big);
    const logs = [];
    setDiagSink((tag, info) => logs.push([tag, info]));
    expect(writeJson('searchHistory', { q: 'y'.repeat(300) }, st)).toBe(true);
    expect(st.m.has(STORAGE_KEYS.homeFavorites)).toBe(false);
    expect(st.m.get(STORAGE_KEYS.recentArticles)).toBe(big);
    expect(readJson('searchHistory', st)).toEqual({ q: 'y'.repeat(300) });
    expect(logs).toEqual([['userData.quota', expect.objectContaining({ id: 'searchHistory', evicted: ['homeFavorites'], ok: true })]]);
  });

  test('清完還是放不下：回 false、記一筆放棄，原有資料不被動到（除了清掉的快取）', () => {
    const st = quotaStorage(600);
    st.m.set(STORAGE_KEYS.recentArticles, 'r'.repeat(400));
    const logs = [];
    setDiagSink((tag, info) => logs.push([tag, info]));
    expect(writeRaw('longPushDraft', 'd'.repeat(500), st)).toBe(false);
    expect(st.m.get(STORAGE_KEYS.recentArticles)).toBe('r'.repeat(400));
    expect(st.m.has(STORAGE_KEYS.longPushDraft)).toBe(false);
    expect(logs).toEqual([['userData.quota', expect.objectContaining({ id: 'longPushDraft', evicted: [], ok: false })]]);
  });

  test('寫的就是快取本身時不清自己；旗標也走同一條', () => {
    const st = quotaStorage(70);
    st.m.set(STORAGE_KEYS.homeFavorites, 'f'.repeat(30));
    expect(writeJson('homeFavorites', 'g'.repeat(60), st)).toBe(false);
    expect(st.m.get(STORAGE_KEYS.homeFavorites)).toBe('f'.repeat(30));
    writeFlag('followOnly', true, st);
    expect(readFlag('followOnly', st)).toBe(true);
    expect(st.m.has(STORAGE_KEYS.homeFavorites)).toBe(false);
  });

  test('不是容量滿的錯誤不清任何資料（隱私模式／被封鎖的 storage 照舊安靜放棄）', () => {
    const st = memStorage();
    st.m.set(STORAGE_KEYS.homeFavorites, 'keep');
    st.setItem = () => {
      const e = new Error('denied');
      e.name = 'SecurityError';
      throw e;
    };
    expect(writeJson('boardTabs', [1], st)).toBe(false);
    expect(st.m.get(STORAGE_KEYS.homeFavorites)).toBe('keep');
  });

  test('可清清單只放可以重抓的快取（斷線回原處快照重抓不回來，不清）', () => {
    for (const id of QUOTA_EVICT_ORDER) {
      expect(USER_DATA.find((e) => e.id === id)?.kind, id).toBe('cache');
    }
    expect(QUOTA_EVICT_ORDER).not.toContain('rendererResume');
  });
});
