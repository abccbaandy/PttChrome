// user_data.js 的旗標讀寫契約（架構 review A10 第二步）：讀不到回 false、寫不進去安靜放棄，
// 形狀跟搬家前一樣（開＝'1'，關＝整個移除）。以及旗標類擁有者不再自己碰 localStorage。
import fs from 'node:fs';
import path from 'node:path';
import { readFlag, writeFlag } from '../../src/js/user_data';
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
