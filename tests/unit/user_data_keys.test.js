// 使用者資料鍵名總表（src/js/user_data_keys.js，架構 review A10 第一步）三邊對得起來：
// STORAGE_KEYS／INDEXED_DB_NAMES ↔ USER_DATA 每一列 ↔ docs/user-data.md 的表。
// 「其他檔案不准自己寫 `pttchrome.` 鍵名」由 lint 規則 pttchrome/no-storage-key-literal 擋
// （tests/unit/lint_rules.test.js 守規則本身）。
import fs from 'node:fs';
import path from 'node:path';
import { STORAGE_KEYS, INDEXED_DB_NAMES, USER_DATA } from '../../src/js/user_data_keys';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const DOC = read('docs/user-data.md');

const allNames = { ...STORAGE_KEYS, ...INDEXED_DB_NAMES };

describe('user_data_keys 總表', () => {
  test('鍵名不重複、都掛在 pttchrome 底下', () => {
    const values = Object.values(allNames);
    expect(new Set(values).size).toBe(values.length);
    for (const v of Object.values(STORAGE_KEYS)) expect(v).toMatch(/^pttchrome\.[A-Za-z]/);
    for (const v of Object.values(INDEXED_DB_NAMES)) expect(v).toMatch(/^pttchrome-/);
  });

  test('每個鍵在 USER_DATA 剛好一列，store 對得上', () => {
    const ids = USER_DATA.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(Object.keys(allNames).sort());
    for (const e of USER_DATA) {
      expect(e.store, e.id).toBe(e.id in STORAGE_KEYS ? 'localStorage' : 'indexedDB');
    }
  });

  test('擁有者檔案存在，而且真的從總表拿這個鍵', () => {
    for (const e of USER_DATA) {
      const ns = e.store === 'indexedDB' ? 'INDEXED_DB_NAMES' : 'STORAGE_KEYS';
      expect(fs.existsSync(path.join(root, e.owner)), e.owner).toBe(true);
      expect(read(e.owner), `${e.owner} 要用 ${ns}.${e.id}`).toContain(`${ns}.${e.id}`);
    }
  });

  test('欄位值都在允許的集合裡', () => {
    for (const e of USER_DATA) {
      expect(['prefs', 'history', 'cache', 'draft', 'ui'], e.id).toContain(e.kind);
      expect(['prefSync', 'readLaterSync', 'none'], e.id).toContain(e.cloud);
      expect(typeof e.backup, e.id).toBe('boolean');
      expect(e.limit, e.id).toBeTruthy();
    }
  });

  test('docs/user-data.md 的表每個鍵都有一行', () => {
    for (const [id, name] of Object.entries(allNames)) {
      expect(DOC, `docs/user-data.md 缺 ${id}（${name}）`).toContain('`' + name + '`');
    }
  });
});
