import { keyEventPredatesModalClose } from '../../src/js/modal_key_gate';
import { App } from '../../src/js/pttchrome';

// 關掉 modal 的那一下按鍵不可以漏到終端機（錄製檔 ptt-debug-20260919-010054.json：
// 長推文輸入框用 Esc 取消 ⇒ 一個裸 ESC 上線、好讀待還原的閱讀位置被清掉；點「取消」
// 則不會）。Mantine 的 Escape handler 掛在 window capture，比 term_view 先跑，
// modalShown 在 term_view 看到時已經是 false ⇒ 只能比「事件產生的時間」。
describe('keyEventPredatesModalClose', () => {
  test('關閉之前產生的事件 ⇒ 屬於 modal，不給終端機', () => {
    expect(keyEventPredatesModalClose(100, 150)).toBe(true);
  });

  test('同一時刻也算（timeStamp 精度會被粗化）', () => {
    expect(keyEventPredatesModalClose(150, 150)).toBe(true);
  });

  test('關閉之後才按的鍵 ⇒ 合法終端機輸入', () => {
    expect(keyEventPredatesModalClose(151, 150)).toBe(false);
  });

  test('從沒關過 modal（初值 -Infinity）⇒ 一律放行', () => {
    expect(keyEventPredatesModalClose(0, -Infinity)).toBe(false);
  });

  test('拿不到 timeStamp ⇒ 放行（不可以把鍵盤整個鎖死）', () => {
    expect(keyEventPredatesModalClose(undefined, 150)).toBe(false);
    expect(keyEventPredatesModalClose(NaN, 150)).toBe(false);
  });
});

describe('App.setModalOpen 記 modalClosedAt', () => {
  const makeApp = () => {
    const app = Object.create(App.prototype);
    app._openModals = new Set();
    app.modalShown = false;
    app.modalClosedAt = -Infinity;
    app.setInputAreaFocus = vi.fn();
    return app;
  };

  test('最後一個來源關閉時才記時間', () => {
    const app = makeApp();
    app.setModalOpen('contextMenu', true);
    expect(app.modalClosedAt).toBe(-Infinity);
    const before = performance.now();
    app.setModalOpen('contextMenu', false);
    expect(app.modalClosedAt).toBeGreaterThanOrEqual(before);
  });

  test('交錯開關：還有來源開著就不記', () => {
    const app = makeApp();
    app.setModalOpen('contextMenu', true);
    app.setModalOpen('imageUpload', true);
    app.setModalOpen('contextMenu', false);
    expect(app.modalClosedAt).toBe(-Infinity);
  });
});
