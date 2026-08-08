import { App } from '../../src/js/pttchrome';

// App.setModalOpen 的純狀態機部分（不 boot 整個 app，用 Object.create 掛 prototype）。
//
// 為什麼要具名來源集合：modalShown 是終端機鍵盤／焦點的總閘門，過去由各個事件處理器
// 手動兩邊維護 —— 一條路徑漏掉復位，就會「畫面上還有對話框、app 卻以為沒有」→
// keyup/mouseover/mouseup 永久把焦點搶回隱藏 input #t，整頁只能重整。
// 症狀層守護：tests/e2e/offline/connect_failure.offline.spec.js。
describe('App.setModalOpen', () => {
  const makeApp = () => {
    const app = Object.create(App.prototype);
    app._openModals = new Set();
    app.modalShown = false;
    app.setInputAreaFocus = vi.fn();
    return app;
  };

  test('開一個來源 → modalShown=true，且不還焦點給終端機', () => {
    const app = makeApp();
    app.setModalOpen('settings', true);
    expect(app.modalShown).toBe(true);
    expect(app.setInputAreaFocus).not.toHaveBeenCalled();
  });

  test('關掉唯一來源 → modalShown=false，並把焦點還給終端機', () => {
    const app = makeApp();
    app.setModalOpen('settings', true);
    app.setModalOpen('settings', false);
    expect(app.modalShown).toBe(false);
    expect(app.setInputAreaFocus).toHaveBeenCalledTimes(1);
  });

  test('兩個來源交錯：關掉其中一個不會誤放行終端機', () => {
    const app = makeApp();
    app.setModalOpen('settings', true);
    app.setModalOpen('pasteAlert', true);

    app.setModalOpen('settings', false);
    expect(app.modalShown).toBe(true);
    expect(app.setInputAreaFocus).not.toHaveBeenCalled();

    app.setModalOpen('pasteAlert', false);
    expect(app.modalShown).toBe(false);
    expect(app.setInputAreaFocus).toHaveBeenCalledTimes(1);
  });

  test('冪等：同一來源重複開／重複關不會重複觸發還焦點', () => {
    const app = makeApp();
    app.setModalOpen('settings', true);
    app.setModalOpen('settings', true);
    expect(app.modalShown).toBe(true);

    app.setModalOpen('settings', false);
    app.setModalOpen('settings', false);
    expect(app.modalShown).toBe(false);
    expect(app.setInputAreaFocus).toHaveBeenCalledTimes(1);
  });

  test('關掉從沒開過的來源 → 不改變狀態', () => {
    const app = makeApp();
    app.setModalOpen('nobody', false);
    expect(app.modalShown).toBe(false);
    expect(app.setInputAreaFocus).not.toHaveBeenCalled();
  });
});
