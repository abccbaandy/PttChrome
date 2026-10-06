import { observerOrigin, isResizeObserverLoopMessage } from '../e2e/helpers/resize_observer_guard';

// offline e2e 的 RO loop 守護靠這支分類「誰的 observer 沒送到」：分錯成 own ⇒ Mantine 的良性
// 訊息讓整片 spec 紅；分錯成 library/other ⇒ 我們自己的真迴圈被放過。
describe('observerOrigin', () => {
  test('本專案原始碼（dev server /src/）→ own', () => {
    expect(observerOrigin('at ensureSizeObserver (http://localhost:8080/src/render/inline_preview_slot.js:220:18)')).toBe('own');
    expect(observerOrigin('at engage (http://[::1]:8080/src/js/bottom_stick.js?t=1712:29:12)')).toBe('own');
  });

  test('Vite 預打包的依賴 → library（即使路徑裡出現 src 字樣）', () => {
    expect(
      observerOrigin('at Object.autoUpdate [as current] (http://localhost:8080/node_modules/.vite/deps/@mantine_core.js?v=e19b2f98:8184:20)'),
    ).toBe('library');
    expect(observerOrigin('at http://localhost:8080/node_modules/some-lib/src/index.js:1:1')).toBe('library');
  });

  test('測試自己 page.evaluate 建的、空字串 → other', () => {
    expect(observerOrigin('at eval (eval at evaluate (:311:30), <anonymous>:3:5)')).toBe('other');
    expect(observerOrigin('')).toBe('other');
    expect(observerOrigin(undefined)).toBe('other');
  });
});

describe('isResizeObserverLoopMessage', () => {
  test('Chromium 與舊版訊息都認得，其他錯誤不誤認', () => {
    expect(isResizeObserverLoopMessage('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isResizeObserverLoopMessage('ResizeObserver loop limit exceeded')).toBe(true);
    expect(isResizeObserverLoopMessage('cn.indexOf is not a function')).toBe(false);
    expect(isResizeObserverLoopMessage(undefined)).toBe(false);
  });
});
