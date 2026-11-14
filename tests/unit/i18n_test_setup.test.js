// tests/unit/setup.js 要先 setupI18n()：沒有的話畫面上的按鈕字、aria-label 全是空的（golden 快照
// 把空字當成正確答案），每次 i18n() 還印一行「missing i18n」把 CI log 洗掉幾百行。

import { i18n } from '../../src/js/i18n';

test('unit 環境已載入語系：存在的 key 回字串、不印 missing i18n', () => {
  const log = vi.spyOn(console, 'log');
  expect(typeof i18n('floatTools_toggle')).toBe('string');
  expect(i18n('floatTools_toggle')).not.toBe('');
  expect(log).not.toHaveBeenCalled();
  log.mockRestore();
});
