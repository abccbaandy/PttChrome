// 設定頁關閉時的存檔合併（src/js/pref_merge.js）。
// 症狀：設定頁開著的期間，別的分頁或雲端同步（別台裝置）改了設定、寫進 localStorage；
// 關閉設定頁時把「打開那一刻的整份表單」原封寫回 ⇒ 那些改動被蓋掉，而且還上傳到雲端、
// 把別台裝置的設定也改回去。連一格都沒動、只是開了又關也會發生。
// 修法：只寫回使用者在設定頁裡真的改過的那幾格，其餘以儲存裡現在的值為準。
import { editedPrefKeys, mergeEditedPrefs } from '../../src/js/pref_merge';

const base = { a: 1, list: 'x', nested: { k: [1, 2] }, flag: true };

describe('mergeEditedPrefs', () => {
  test('沒動任何一格：完全沿用儲存裡現在的值（別處的改動不被蓋掉）', () => {
    const fresh = { ...base, list: 'x\ny', a: 2 };
    expect(mergeEditedPrefs(fresh, base, { ...base })).toEqual(fresh);
    expect(editedPrefKeys(base, { ...base })).toEqual([]);
  });

  test('只動了一格：那一格用表單的值，別處改的其他格保留', () => {
    const fresh = { ...base, list: 'x\ny' };
    const edited = { ...base, flag: false };
    expect(mergeEditedPrefs(fresh, base, edited)).toEqual({ ...base, list: 'x\ny', flag: false });
  });

  test('兩邊改到同一格：使用者在設定頁按下去的為準', () => {
    const fresh = { ...base, a: 5 };
    expect(mergeEditedPrefs(fresh, base, { ...base, a: 9 })).toEqual({ ...base, a: 9 });
  });

  test('巢狀值用內容比，不是用參照比', () => {
    expect(editedPrefKeys(base, { ...base, nested: { k: [1, 2] } })).toEqual([]);
    expect(editedPrefKeys(base, { ...base, nested: { k: [1, 3] } })).toEqual(['nested']);
  });

  test('表單多出的新鍵也算改過', () => {
    expect(editedPrefKeys(base, { ...base, extra: 1 })).toEqual(['extra']);
  });
});
