// user_data.js 的旗標讀寫契約（架構 review A10 第二步）：讀不到回 false、寫不進去安靜放棄，
// 形狀跟搬家前一樣（開＝'1'，關＝整個移除）。以及旗標類擁有者不再自己碰 localStorage。
import fs from 'node:fs';
import path from 'node:path';
import { readFlag, writeFlag, readJson, writeJson, removeData } from '../../src/js/user_data';
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

  test('JSON：寫不進去回 false、不炸（容量滿、隱私模式）', () => {
    expect(writeJson('uploadHistory', [1], null)).toBe(false);
    expect(writeJson('uploadHistory', [1], throwing)).toBe(false);
    expect(() => removeData('uploadHistory', throwing)).not.toThrow();
  });

  test('已搬到共用讀寫的 JSON 擁有者不再自己碰 localStorage', () => {
    for (const id of ['uploadHistory', 'searchHistory', 'whatsNewSeen', 'boardTabs', 'homeFavorites', 'homeRecentBoards']) {
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
